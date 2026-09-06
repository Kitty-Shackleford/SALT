const axios = require('../utils/nitradoHttp');
const { assertMissionPathComponent, resolveMissionBasePath } = require('../utils/nitradoHttp');
const { assertNitradoSuccess, getNitradoFileEntries, getNitradoTransferToken, getNitradoTextBody } = require('../utils/nitradoHttp');
const nitradoService = require('./nitradoService');
const xml2js = require('xml2js');
const path = require('path');
const missionFileService = require('./missionFileService');
const {
  acquireProviderMutationLock,
  createFileMutationJournal,
} = require('./shopFileService');
const {
  CAPABILITIES,
  authorizeServerMutation,
} = require('./authorizationService');
const {
  DIRECTORY_EXISTS_SNAPSHOT,
  prepareProviderMutation,
  registerProviderMutationRollback,
  updatePreparedProviderMutation,
} = require('./providerMutationRecoveryService');

const OVERRIDE_FILES = [
  { name: 'dashboard_types.xml', type: 'types' },
  { name: 'dashboard_events.xml', type: 'events' },
  { name: 'dashboard_spawnabletypes.xml', type: 'spawnabletypes' },
  { name: 'dashboard_cfgrandompresets.xml', type: 'randompresets' },
  { name: 'bot_types.xml', type: 'types' },
  { name: 'bot_events.xml', type: 'events' },
  { name: 'bot_spawnabletypes.xml', type: 'spawnabletypes' },
  { name: 'bot_cfgrandompresets.xml', type: 'randompresets' },
];

class EconomyOverrideService {
  constructor() {
    this.customFolder = 'custom'; // Single folder for all overrides

    // File prefixes for different sources
    this.dashboardPrefix = 'dashboard_';
    this.botPrefix = 'bot_';
  }

  collectOverridePaths(missionPath) {
    return [
      `${missionPath}/${this.customFolder}/`,
      ...OVERRIDE_FILES.map(file => `${missionPath}/${this.customFolder}/${file.name}`),
      `${missionPath}/cfgeconomycore.xml`,
    ];
  }

  async resolveMutationContext(transactionDb, internalServerId) {
    const numericServerId = Number(internalServerId);
    if (!Number.isSafeInteger(numericServerId) || numericServerId <= 0) {
      throw new Error('Invalid canonical server ID');
    }
    const context = await transactionDb.get(
      `SELECT s.platform_server_id, gt.token_hash
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       JOIN guild_tokens gt ON gt.guild_id = g.id AND gt.token_type = 'nitrado'
       WHERE s.id = ? AND s.status = 'active' AND g.status = 'approved'
         AND gt.nitrado_user_id IS NOT NULL
       FOR NO KEY UPDATE OF s, g, gt`,
      [numericServerId]
    );
    if (!context?.platform_server_id || !context?.token_hash) {
      throw new Error('No authorized Nitrado token found for economy override server');
    }
    const { decryptToken } = require('../utils/encryption');
    return {
      internalServerId: numericServerId,
      platformServerId: context.platform_server_id,
      nitradoToken: decryptToken(context.token_hash),
    };
  }

  async folderExists(platformServerId, folderPath, nitradoToken) {
    const normalized = folderPath.replace(/\/$/, '');
    const parentPath = path.posix.dirname(normalized);
    const folderName = path.posix.basename(normalized);
    const response = await axios.get(
      `https://api.nitrado.net/services/${platformServerId}/gameservers/file_server/list`,
      {
        headers: { 'Authorization': `Bearer ${nitradoToken}` },
        params: { dir: parentPath },
      }
    );
    return getNitradoFileEntries(response).some(
      entry => entry.type === 'dir' && entry.name === folderName
    );
  }

  async deleteFolderFromServer(platformServerId, folderPath, nitradoToken) {
    const normalized = folderPath.replace(/\/$/, '');
    const response = await axios.delete(
      `https://api.nitrado.net/services/${platformServerId}/gameservers/file_server/delete`,
      {
        data: new URLSearchParams({ path: normalized }).toString(),
        headers: {
          'Authorization': `Bearer ${nitradoToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    assertNitradoSuccess(response, 'Nitrado returned an invalid directory-delete response');
    if (await this.folderExists(platformServerId, normalized, nitradoToken)) {
      throw new Error('Provider directory deletion verification failed');
    }
  }

  async snapshotFiles(platformServerId, nitradoToken, filePaths) {
    const snapshots = new Map();
    for (const filePath of filePaths) {
      if (filePath.endsWith('/')) {
        snapshots.set(
          filePath,
          await this.folderExists(platformServerId, filePath, nitradoToken)
            ? DIRECTORY_EXISTS_SNAPSHOT
            : null
        );
        continue;
      }
      snapshots.set(filePath, await missionFileService.downloadFileFromServer(
        platformServerId, filePath, nitradoToken
      ));
    }
    return snapshots;
  }

  createMutationJournal(context, snapshots) {
    const fileJournal = createFileMutationJournal(
      context.platformServerId,
      context.nitradoToken,
      missionFileService,
      snapshots
    );
    const directoryPaths = Array.from(snapshots.keys()).filter(filePath => filePath.endsWith('/'));
    return {
      ...fileJournal,
      rollback: async () => {
        await fileJournal.rollback();
        for (const directoryPath of directoryPaths.slice().reverse()) {
          if (snapshots.get(directoryPath) === DIRECTORY_EXISTS_SNAPSHOT) continue;
          if (await this.folderExists(
            context.platformServerId, directoryPath, context.nitradoToken
          )) {
            await this.deleteFolderFromServer(
              context.platformServerId, directoryPath, context.nitradoToken
            );
          }
        }
      },
    };
  }

  async executeMutation(db, {
    serverId,
    action,
    contextType = null,
    contextId = null,
    actor,
    selectPaths,
    mutate,
  }) {
    if (!db || typeof db.transaction !== 'function') {
      throw new Error('Economy override mutations require a database transaction');
    }
    if (!actor?.id) {
      throw new Error('Economy override mutation actor is required');
    }
    return db.transaction(async transactionDb => {
      await acquireProviderMutationLock(transactionDb, serverId);
      const authorization = await authorizeServerMutation(
        transactionDb,
        actor,
        serverId,
        CAPABILITIES.NITRADO_MANAGE
      );
      if (!authorization || Number(authorization.server.id) !== Number(serverId)) {
        const error = new Error('Economy override mutation authority was revoked');
        error.code = 'SERVER_AUTHORIZATION_MISMATCH';
        error.status = 403;
        throw error;
      }
      const context = await this.resolveMutationContext(transactionDb, serverId);
      const missionData = await this.getActiveMission(context.platformServerId, context.nitradoToken);
      if (!missionData) throw new Error('No active mission found');
      const filePaths = selectPaths(missionData.missionPath);
      const snapshots = await this.snapshotFiles(
        context.platformServerId, context.nitradoToken, filePaths
      );
      const prepared = {
        snapshots,
        operationId: await prepareProviderMutation(db, {
          serverId: context.internalServerId,
          providerServiceId: context.platformServerId,
          workflow: 'economy_override',
          action,
          contextType,
          contextId,
          plan: { filePaths },
          snapshots,
          triggeredBy: `user:${actor.id}`,
        }),
      };
      const journal = this.createMutationJournal(context, prepared.snapshots);
      const operationId = prepared.operationId;
      registerProviderMutationRollback(transactionDb, { operationId, journal });
      const result = await mutate({ context, missionData, journal, snapshots });
      await updatePreparedProviderMutation(transactionDb, operationId, 'completed');
      return result;
    });
  }

  mutationFailure(error) {
    return {
      success: false,
      error: error.message,
      ...(error.code === 'PROVIDER_RECOVERY_PENDING'
        ? { recoveryPending: true, code: error.code }
        : {}),
    };
  }

  /**
   * Initialize dashboard/bot economy overrides in the custom folder.
   * @param {object} db - Database abstraction
   * @param {number} serverId - Canonical internal servers.id
   * @param {string} triggeredBy - Durable actor descriptor
   * @returns {Promise<Object>} Initialization result with folder and files created
   */
  async initializeOverrides(db, serverId, actor) {
    try {
      return await this.executeMutation(db, {
        serverId,
        action: 'initialize',
        actor,
        selectPaths: missionPath => this.collectOverridePaths(missionPath),
        mutate: async ({ context, missionData, journal, snapshots }) => {
          console.log(`🎬 Initializing dashboard/bot overrides for server ${serverId}...`);
          const missionPath = missionData.missionPath;
          const customFolderPath = `${missionPath}/${this.customFolder}`;
          const directorySnapshotPath = `${customFolderPath}/`;
          const expectedFolderExists = snapshots.get(directorySnapshotPath) === DIRECTORY_EXISTS_SNAPSHOT;
          const currentFolderExists = await this.folderExists(
            context.platformServerId, customFolderPath, context.nitradoToken
          );
          if (currentFolderExists !== expectedFolderExists) {
            throw new Error('Concurrent provider edit detected for ' + directorySnapshotPath);
          }
          if (!currentFolderExists) {
            const created = await this.createFolderOnServer(
              context.platformServerId, customFolderPath, context.nitradoToken
            );
            if (!created || !await this.folderExists(
              context.platformServerId, customFolderPath, context.nitradoToken
            )) {
              throw new Error('Provider directory creation verification failed');
            }
          }

          for (const file of OVERRIDE_FILES) {
            const emptyContent = this.generateEmptyOverride(file.type);
            await journal.uploadFileToServer(
              context.platformServerId,
              customFolderPath,
              file.name,
              emptyContent,
              context.nitradoToken
            );
          }

          await this.registerOverridesInOrder(
            context.platformServerId,
            missionPath,
            context.nitradoToken,
            journal
          );

          console.log(`✅ Dashboard/bot overrides initialized for server ${serverId}`);
          return {
            success: true,
            message: 'Dashboard/bot overrides initialized',
            folder: this.customFolder,
            files: OVERRIDE_FILES.map(file => file.name),
            loadOrder: 'Dashboard files registered first, then bot files (highest priority)'
          };
        },
      });
    } catch (error) {
      console.error('Failed to initialize overrides:', error);
      return this.mutationFailure(error);
    }
  }

  /**
   * Register override files in cfgeconomycore.xml
   * Order matters: dashboard files first, then bot files (so bot has highest priority)
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} missionPath - Mission path on server
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<void>}
   */
  async registerOverridesInOrder(serverId, missionPath, nitradoToken, fileService) {
    if (!fileService) throw new Error('Economy override registration requires a durable provider journal');
    const economyCorePath = `${missionPath}/cfgeconomycore.xml`;

    try {
      // Download existing cfgeconomycore.xml
      let economyCoreContent = await this.downloadFileFromServer(
        serverId,
        economyCorePath,
        nitradoToken
      );

      if (!economyCoreContent) {
        throw new Error('cfgeconomycore.xml not found');
      }

      // Parse XML
      const parser = new xml2js.Parser();
      const economyCoreXml = await parser.parseStringPromise(economyCoreContent);

      // Ensure ce array exists
      if (!economyCoreXml.economycore.ce) {
        economyCoreXml.economycore.ce = [];
      }

      // Make sure ce is an array
      if (!Array.isArray(economyCoreXml.economycore.ce)) {
        economyCoreXml.economycore.ce = [economyCoreXml.economycore.ce];
      }

      // Find existing custom folder entry
      let customCeIndex = economyCoreXml.economycore.ce.findIndex(
        ce => ce.$.folder === this.customFolder
      );

      // Define our files in order (dashboard first, bot last)
      const ourFiles = [
        // Dashboard files (loaded first)
        { name: 'dashboard_types.xml', type: 'types' },
        { name: 'dashboard_events.xml', type: 'events' },
        { name: 'dashboard_spawnabletypes.xml', type: 'spawnabletypes' },
        { name: 'dashboard_cfgrandompresets.xml', type: 'randompresets' },
        // Bot files (loaded last - highest priority)
        { name: 'bot_types.xml', type: 'types' },
        { name: 'bot_events.xml', type: 'events' },
        { name: 'bot_spawnabletypes.xml', type: 'spawnabletypes' },
        { name: 'bot_cfgrandompresets.xml', type: 'randompresets' }
      ];

      if (customCeIndex >= 0) {
        // Custom folder already exists - update it
        const existingCe = economyCoreXml.economycore.ce[customCeIndex];

        // Ensure file array exists
        if (!existingCe.file) {
          existingCe.file = [];
        }

        if (!Array.isArray(existingCe.file)) {
          existingCe.file = [existingCe.file];
        }

        // Remove existing dashboard/bot files
        existingCe.file = existingCe.file.filter(
          f => !f.$.name.startsWith(this.dashboardPrefix) && !f.$.name.startsWith(this.botPrefix)
        );

        // Add our files at the end
        ourFiles.forEach(file => {
          existingCe.file.push({ $: { name: file.name, type: file.type } });
        });

      } else {
        // Custom folder doesn't exist - create it
        const customCe = {
          $: { folder: this.customFolder },
          file: ourFiles.map(file => ({ $: { name: file.name, type: file.type } }))
        };

        economyCoreXml.economycore.ce.push(customCe);
      }

      // Build XML with proper formatting
      const builder = new xml2js.Builder({
        xmldec: { version: '1.0', encoding: 'UTF-8', standalone: 'yes' },
        renderOpts: { pretty: true, indent: '  ' }
      });
      const updatedContent = builder.buildObject(economyCoreXml);

      // Upload updated cfgeconomycore.xml through the durable journal.
      await fileService.uploadFileToServer(
        serverId,
        path.posix.dirname(economyCorePath),
        path.posix.basename(economyCorePath),
        updatedContent,
        nitradoToken
      );

      console.log('✅ Registered dashboard/bot override files in cfgeconomycore.xml');
      console.log('   📋 Load order within custom folder:');
      console.log('      1. User files (if any)');
      console.log('      2. dashboard_* files');
      console.log('      3. bot_* files (highest priority)');

    } catch (error) {
      console.error('Failed to register overrides:', error);
      throw error;
    }
  }

  /**
   * Get current load order from cfgeconomycore.xml
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<Object>} Load order information
   */
  async getLoadOrder(serverId, nitradoToken) {
    try {
      const missionData = await this.getActiveMission(serverId, nitradoToken);
      const economyCorePath = `${missionData.missionPath}/cfgeconomycore.xml`;

      const content = await this.downloadFileFromServer(serverId, economyCorePath, nitradoToken);
      if (!content) {
        return { success: false, error: 'cfgeconomycore.xml not found' };
      }

      const parser = new xml2js.Parser();
      const xml = await parser.parseStringPromise(content);

      const ceEntries = xml.economycore.ce || [];

      const loadOrder = (Array.isArray(ceEntries) ? ceEntries : [ceEntries]).map((ce, index) => {
        const files = Array.isArray(ce.file) ? ce.file : [ce.file];

        return {
          position: index + 1,
          folder: ce.$.folder,
          files: files.map(f => ({
            name: f.$.name,
            type: f.$.type,
            isDashboard: f.$.name.startsWith(this.dashboardPrefix),
            isBot: f.$.name.startsWith(this.botPrefix)
          })),
          isCustomFolder: ce.$.folder === this.customFolder
        };
      });

      return {
        success: true,
        loadOrder,
        totalFolders: loadOrder.length
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Verify load order - check that bot files come after dashboard files
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<Object>} Verification result
   */
  async verifyLoadOrder(serverId, nitradoToken) {
    try {
      const orderResult = await this.getLoadOrder(serverId, nitradoToken);

      if (!orderResult.success) {
        return orderResult;
      }

      const customFolder = orderResult.loadOrder.find(entry => entry.isCustomFolder);

      if (!customFolder) {
        return {
          success: false,
          error: 'Custom folder not found in cfgeconomycore.xml'
        };
      }

      const dashboardFiles = customFolder.files.filter(f => f.isDashboard);
      const botFiles = customFolder.files.filter(f => f.isBot);

      if (dashboardFiles.length === 0 || botFiles.length === 0) {
        return {
          success: false,
          isCorrectOrder: false,
          message: '⚠️  Missing dashboard or bot files'
        };
      }

      // Check that all dashboard files come before all bot files
      const lastDashboardIndex = customFolder.files.map(f => f.isDashboard).lastIndexOf(true);
      const firstBotIndex = customFolder.files.findIndex(f => f.isBot);

      const isCorrectOrder = lastDashboardIndex < firstBotIndex;

      return {
        success: true,
        isCorrectOrder,
        message: isCorrectOrder
          ? '✅ Load order is correct (dashboard files → bot files)'
          : '⚠️  Bot files should come after dashboard files',
        customFolder: customFolder.folder,
        dashboardFilesCount: dashboardFiles.length,
        botFilesCount: botFiles.length
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Update dashboard override file
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @param {string} fileType - File type (types, events, spawnabletypes, randompresets)
   * @param {string} itemName - Item name to update
   * @param {Object} itemData - Item data to update
   * @returns {Promise<Object>} Update result
   */
  async updateDashboardOverride(db, serverId, actor, fileType, itemName, itemData) {
    const fileName = this.dashboardPrefix + this.getBaseFileNameForType(fileType);
    return this.updateOverrideFile(
      db, serverId, actor, fileName, fileType, itemName, itemData
    );
  }

  /**
   * Update bot override file (highest priority)
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @param {string} fileType - File type (types, events, spawnabletypes, randompresets)
   * @param {string} itemName - Item name to update
   * @param {Object} itemData - Item data to update
   * @returns {Promise<Object>} Update result
   */
  async updateBotOverride(db, serverId, actor, fileType, itemName, itemData) {
    const fileName = this.botPrefix + this.getBaseFileNameForType(fileType);
    return this.updateOverrideFile(
      db, serverId, actor, fileName, fileType, itemName, itemData
    );
  }

  /**
   * Generic update override file
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @param {string} fileName - Override file name
   * @param {string} fileType - File type (types, events, spawnabletypes, randompresets)
   * @param {string} itemName - Item name to update
   * @param {Object} itemData - Item data to update
   * @returns {Promise<Object>} Update result
   */
  async updateOverrideFile(db, serverId, actor, fileName, fileType, itemName, itemData) {
    try {
      return await this.executeMutation(db, {
        serverId,
        action: 'update',
        contextType: 'economy_override_item',
        contextId: `${fileName}:${itemName}`,
        actor,
        selectPaths: missionPath => [`${missionPath}/${this.customFolder}/${fileName}`],
        mutate: async ({ context, missionData, journal }) => {
          const filePath = `${missionData.missionPath}/${this.customFolder}/${fileName}`;
          let content = await journal.downloadFileFromServer(
            context.platformServerId, filePath, context.nitradoToken
          );
          if (!content) content = this.generateEmptyOverride(fileType);

          const parser = new xml2js.Parser();
          const xmlObj = await parser.parseStringPromise(content);
          const updated = this.updateItemInXml(xmlObj, fileType, itemName, itemData);
          const builder = new xml2js.Builder({
            xmldec: { version: '1.0', encoding: 'UTF-8', standalone: 'yes' },
            renderOpts: { pretty: true, indent: '  ' }
          });
          const updatedContent = builder.buildObject(updated);
          await journal.uploadFileToServer(
            context.platformServerId,
            path.posix.dirname(filePath),
            path.posix.basename(filePath),
            updatedContent,
            context.nitradoToken
          );

          console.log(`✅ Updated "${itemName}" in ${this.customFolder}/${fileName}`);
          return {
            success: true,
            message: `Override updated: ${itemName}`,
            file: fileName,
            folder: this.customFolder
          };
        },
      });
    } catch (error) {
      console.error('Failed to update override:', error);
      return this.mutationFailure(error);
    }
  }

  /**
   * Delete item from dashboard override
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @param {string} fileType - File type (types, events, spawnabletypes, randompresets)
   * @param {string} itemName - Item name to delete
   * @returns {Promise<Object>} Delete result
   */
  async deleteDashboardOverride(db, serverId, actor, fileType, itemName) {
    const fileName = this.dashboardPrefix + this.getBaseFileNameForType(fileType);
    return this.deleteOverrideItem(db, serverId, actor, fileName, fileType, itemName);
  }

  /**
   * Delete item from bot override
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @param {string} fileType - File type (types, events, spawnabletypes, randompresets)
   * @param {string} itemName - Item name to delete
   * @returns {Promise<Object>} Delete result
   */
  async deleteBotOverride(db, serverId, actor, fileType, itemName) {
    const fileName = this.botPrefix + this.getBaseFileNameForType(fileType);
    return this.deleteOverrideItem(db, serverId, actor, fileName, fileType, itemName);
  }

  /**
   * Generic delete override item
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @param {string} fileName - Override file name
   * @param {string} fileType - File type (types, events, spawnabletypes, randompresets)
   * @param {string} itemName - Item name to delete
   * @returns {Promise<Object>} Delete result
   */
  async deleteOverrideItem(db, serverId, actor, fileName, fileType, itemName) {
    try {
      return await this.executeMutation(db, {
        serverId,
        action: 'delete_item',
        contextType: 'economy_override_item',
        contextId: `${fileName}:${itemName}`,
        actor,
        selectPaths: missionPath => [`${missionPath}/${this.customFolder}/${fileName}`],
        mutate: async ({ context, missionData, journal }) => {
          const filePath = `${missionData.missionPath}/${this.customFolder}/${fileName}`;
          const content = await journal.downloadFileFromServer(
            context.platformServerId, filePath, context.nitradoToken
          );
          if (!content) throw new Error('File not found');

          const parser = new xml2js.Parser();
          const xmlObj = await parser.parseStringPromise(content);
          const updated = this.removeItemFromXml(xmlObj, fileType, itemName);
          const builder = new xml2js.Builder({
            xmldec: { version: '1.0', encoding: 'UTF-8', standalone: 'yes' },
            renderOpts: { pretty: true, indent: '  ' }
          });
          const updatedContent = builder.buildObject(updated);
          await journal.uploadFileToServer(
            context.platformServerId,
            path.posix.dirname(filePath),
            path.posix.basename(filePath),
            updatedContent,
            context.nitradoToken
          );

          console.log(`✅ Deleted "${itemName}" from ${this.customFolder}/${fileName}`);
          return {
            success: true,
            message: `Override deleted: ${itemName}`,
            file: fileName
          };
        },
      });
    } catch (error) {
      return this.mutationFailure(error);
    }
  }

  // Helper methods

  getBaseFileNameForType(fileType) {
    switch (fileType) {
      case 'types': return 'types.xml';
      case 'events': return 'events.xml';
      case 'spawnabletypes': return 'spawnabletypes.xml';
      case 'randompresets': return 'cfgrandompresets.xml';
      default: throw new Error(`Unknown file type: ${fileType}`);
    }
  }

  updateItemInXml(xmlObj, fileType, itemName, itemData) {
    const rootKey = this.getRootKeyForType(fileType);
    const itemKey = this.getItemKeyForType(fileType);

    if (!xmlObj[rootKey][itemKey]) {
      xmlObj[rootKey][itemKey] = [];
    }

    const items = Array.isArray(xmlObj[rootKey][itemKey])
      ? xmlObj[rootKey][itemKey]
      : [xmlObj[rootKey][itemKey]];

    const existingIndex = items.findIndex(item => item.$.name === itemName);

    if (existingIndex >= 0) {
      items[existingIndex] = itemData;
    } else {
      items.push(itemData);
    }

    xmlObj[rootKey][itemKey] = items;

    return xmlObj;
  }

  removeItemFromXml(xmlObj, fileType, itemName) {
    const rootKey = this.getRootKeyForType(fileType);
    const itemKey = this.getItemKeyForType(fileType);

    if (!xmlObj[rootKey][itemKey]) {
      return xmlObj;
    }

    xmlObj[rootKey][itemKey] = (Array.isArray(xmlObj[rootKey][itemKey])
      ? xmlObj[rootKey][itemKey]
      : [xmlObj[rootKey][itemKey]]
    ).filter(item => item.$.name !== itemName);

    return xmlObj;
  }

  getRootKeyForType(fileType) {
    switch (fileType) {
      case 'types': return 'types';
      case 'events': return 'eventposdef';
      case 'spawnabletypes': return 'spawnabletypes';
      case 'randompresets': return 'randompresets';
      default: throw new Error(`Unknown file type: ${fileType}`);
    }
  }

  getItemKeyForType(fileType) {
    switch (fileType) {
      case 'types': return 'type';
      case 'events': return 'event';
      case 'spawnabletypes': return 'type';
      case 'randompresets': return 'cargo';
      default: throw new Error(`Unknown file type: ${fileType}`);
    }
  }

  generateEmptyOverride(type) {
    switch (type) {
      case 'types':
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<types>
  <!-- Dashboard/Bot managed types -->
  <!-- These will override any previous definitions -->
</types>`;

      case 'events':
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<eventposdef>
  <!-- Dashboard/Bot managed events -->
  <!-- These will override any previous definitions -->
</eventposdef>`;

      case 'spawnabletypes':
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<spawnabletypes>
  <!-- Dashboard/Bot managed spawnable types -->
  <!-- These will override any previous definitions -->
</spawnabletypes>`;

      case 'randompresets':
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<randompresets>
  <!-- Dashboard/Bot managed random presets -->
  <!-- These control loot in random containers -->
</randompresets>`;

      default:
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<root>
</root>`;
    }
  }

  /**
   * Create a folder on the Nitrado server
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} folderPath - Full folder path on server
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<void>}
   */
  async createFolderOnServer(serverId, folderPath, nitradoToken) {
    try {
      const response = await axios.post(
        `https://api.nitrado.net/services/${serverId}/gameservers/file_server/mkdir`,
        { path: path.dirname(folderPath), name: path.basename(folderPath) },
        {
          headers: {
            'Authorization': `Bearer ${nitradoToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      assertNitradoSuccess(response, 'Nitrado returned an invalid create-directory response');
      console.log(`✅ Created folder: ${folderPath}`);
      return true;
    } catch (error) {
      if (error.response?.status === 409) {
        console.log(`⚠️  Folder already exists: ${folderPath}`);
        return false;
      } else {
        throw error;
      }
    }
  }

  /**
   * Upload a file to the Nitrado server
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} filePath - Full file path on server
   * @param {string} content - File content to upload
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<void>}
   */
  async uploadFileToServer(serverId, filePath, content, nitradoToken) {
    try {
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('path', path.dirname(filePath));
      formData.append('file', path.basename(filePath));
      const response = await axios.post(
        `https://api.nitrado.net/services/${serverId}/gameservers/file_server/upload`,
        formData,
        {
          headers: { 'Authorization': `Bearer ${nitradoToken}`, ...formData.getHeaders() }
        }
      );

      const { url: uploadUrl, token: uploadToken } = getNitradoTransferToken(response, { requireToken: true });
      await axios.post(uploadUrl, content, {
        headers: { 'token': uploadToken, 'Content-Type': 'application/octet-stream' },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30000
      });

      console.log(`✅ Uploaded: ${filePath}`);
    } catch (error) {
      console.error(`Failed to upload ${filePath}:`, error.message);
      throw error;
    }
  }

  /**
   * Download a file from the Nitrado server
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} filePath - Full file path on server
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<string|null>} File content or null if not found
   */
  async downloadFileFromServer(serverId, filePath, nitradoToken) {
    try {
      const response = await axios.get(
        `https://api.nitrado.net/services/${serverId}/gameservers/file_server/download`,
        {
          headers: { 'Authorization': `Bearer ${nitradoToken}` },
          params: { file: filePath }
        }
      );

      const { url: downloadUrl } = getNitradoTransferToken(response);
      const fileResponse = await axios.get(downloadUrl, {
        responseType: 'text'
      });

      return getNitradoTextBody(fileResponse);
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  /**
   * Get the active mission for a server
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<Object|null>} Mission data with mission name and map name, or null
   */
  async getActiveMission(serverId, nitradoToken) {
    try {
      const gameserver = await nitradoService.getRawGameserver(nitradoToken, serverId);
      const mission = gameserver.settings?.config?.mission;
      if (!mission) return null;
      assertMissionPathComponent(mission);

      let mapName = 'unknown';
      if (mission.includes('enoch')) mapName = 'enoch';
      else if (mission.includes('chernarusplus')) mapName = 'chernarusplus';
      else if (mission.includes('sakhal')) mapName = 'sakhal';
      else if (mission.includes('namalsk')) mapName = 'namalsk';
      else if (mission.includes('takistanplus')) mapName = 'takistanplus';

      return { mission, missionPath: `${resolveMissionBasePath(gameserver)}/${mission}`, mapName };
    } catch (error) {
      console.error('Failed to get active mission:', error);
      return null;
    }
  }
}

module.exports = new EconomyOverrideService();