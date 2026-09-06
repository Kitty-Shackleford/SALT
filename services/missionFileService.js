const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('../utils/nitradoHttp');
const { assertMissionPathComponent, assertNitradoSuccess, getNitradoFileEntries, getNitradoTransferToken, getNitradoTextBody, resolveMissionBasePath } = require('../utils/nitradoHttp');
const { ensureContainedDirectorySync, readContainedFileSync, writeContainedFileSync } = require('../utils/safePath');
const nitradoService = require('./nitradoService');
const xml2js = require('xml2js');
const crypto = require('crypto');

class MissionFileService {
  constructor() {
    this.locks = new Map();
    this.lockTimeout = 300000; // 5 minutes
    this.backupEnabled = true;
  }

  getEditableFiles() {
    return {
      'cfgweather.xml': { description: 'Weather configuration', type: 'xml', root: 'weather' },
      'cfgenvironment.xml': { description: 'Environment settings (time acceleration, night length)', type: 'xml', root: 'variables' },
      'cfgplayerspawnpoints.xml': { description: 'Player spawn locations', type: 'xml', root: 'spawnpoints' },
      'mapgroupproto.xml': { description: 'Dynamic event group prototypes', type: 'xml', root: 'group' },
      'mapgrouppos.xml': { description: 'Dynamic event group positions', type: 'xml', root: 'map' },
      'messages.xml': { description: 'Server messages', type: 'xml', root: 'messages' },
      'globals.xml': { description: 'Global economy variables', type: 'xml', root: 'variables' }
    };
  }

  async acquireLock(serverId, fileName, lockHolder = 'dashboard', timeoutMs = null) {
    const lockKey = serverId + '_' + fileName;
    const existingLock = this.locks.get(lockKey);

    if (existingLock) {
      const now = Date.now();

      if (existingLock.expiresAt > now) {
        if (existingLock.holder === lockHolder) {
          existingLock.expiresAt = now + (timeoutMs || this.lockTimeout);
          console.log('🔄 Extended lock on ' + fileName + ' for ' + lockHolder);
          return { success: true, lockId: existingLock.lockId, message: 'Lock extended' };
        } else {
          const remainingMs = existingLock.expiresAt - now;
          console.log('🔒 Lock denied on ' + fileName + ' - held by ' + existingLock.holder);
          return {
            success: false,
            error: 'File is locked by another process',
            lockedBy: existingLock.holder,
            expiresIn: Math.ceil(remainingMs / 1000)
          };
        }
      } else {
        console.log('⏰ Lock expired on ' + fileName);
        this.locks.delete(lockKey);
      }
    }

    const lockId = crypto.randomBytes(16).toString('hex');
    const lock = {
      lockId,
      serverId,
      fileName,
      holder: lockHolder,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + (timeoutMs || this.lockTimeout)
    };

    this.locks.set(lockKey, lock);
    console.log('🔓 Lock acquired on ' + fileName + ' by ' + lockHolder + ' (expires in ' + ((timeoutMs || this.lockTimeout) / 1000) + 's)');

    return { success: true, lockId, expiresAt: lock.expiresAt, message: 'Lock acquired' };
  }

  async releaseLock(serverId, fileName, lockId) {
    const lockKey = serverId + '_' + fileName;
    const existingLock = this.locks.get(lockKey);

    if (!existingLock) return { success: false, error: 'No lock found' };
    if (existingLock.lockId !== lockId) return { success: false, error: 'Invalid lock ID' };

    this.locks.delete(lockKey);
    console.log('🔓 Lock released on ' + fileName);
    return { success: true, message: 'Lock released' };
  }

  checkLock(serverId, fileName) {
    const lockKey = serverId + '_' + fileName;
    const lock = this.locks.get(lockKey);

    if (!lock) return { locked: false, message: 'File is not locked' };

    const now = Date.now();
    if (lock.expiresAt < now) {
      this.locks.delete(lockKey);
      return { locked: false, message: 'Lock expired' };
    }

    return {
      locked: true,
      holder: lock.holder,
      acquiredAt: lock.acquiredAt,
      expiresAt: lock.expiresAt,
      remainingMs: lock.expiresAt - now
    };
  }

  ownsLock(serverId, fileName, lockId) {
    const lockKey = serverId + '_' + fileName;
    const lock = this.locks.get(lockKey);
    if (!lock || lock.expiresAt < Date.now()) {
      if (lock) this.locks.delete(lockKey);
      return false;
    }
    return typeof lockId === 'string' && lock.lockId === lockId;
  }

  releaseAllLocks(serverId = null) {
    if (serverId) {
      const keysToDelete = [];
      for (const [key, lock] of this.locks) {
        if (lock.serverId === serverId) keysToDelete.push(key);
      }
      keysToDelete.forEach(key => this.locks.delete(key));
      console.log('🔓 Released ' + keysToDelete.length + ' locks for server ' + serverId);
      return { released: keysToDelete.length };
    } else {
      const count = this.locks.size;
      this.locks.clear();
      console.log('🔓 Released all locks (' + count + ')');
      return { released: count };
    }
  }

  getActiveLocks(serverId = null) {
    const now = Date.now();
    const activeLocks = [];

    for (const [key, lock] of this.locks) {
      if (lock.expiresAt > now) {
        if (!serverId || lock.serverId === serverId) {
          activeLocks.push({
            serverId: lock.serverId,
            fileName: lock.fileName,
            holder: lock.holder,
            acquiredAt: lock.acquiredAt,
            expiresAt: lock.expiresAt,
            remainingMs: lock.expiresAt - now
          });
        }
      } else {
        this.locks.delete(key);
      }
    }

    return activeLocks;
  }

  /**
   * Read a mission file from the server
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} fileName - Mission file name
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<Object>} File content and metadata
   */
  async readMissionFile(serverId, fileName, nitradoToken) {
    try {
      console.log('📖 Reading mission file:', fileName, 'from server:', serverId);

      const missionData = await this.getActiveMission(serverId, nitradoToken);
      if (!missionData) return { success: false, error: 'No active mission found' };

      const filePath = `${missionData.missionPath}/${fileName}`;
      console.log('   File path:', filePath);

      const content = await this.downloadFileFromServer(serverId, filePath, nitradoToken);

      if (!content) return { success: false, error: 'File not found' };

      const fileConfig = this.getEditableFiles()[fileName];
      let parsedData = null;

      if (fileConfig && fileConfig.type === 'xml') {
        const parser = new xml2js.Parser();
        parsedData = await parser.parseStringPromise(content);
      }

      const hash = this.calculateHash(content);

      return {
        success: true,
        fileName,
        content,
        parsedData,
        hash,
        filePath,
        mapName: missionData.mapName
      };
    } catch (error) {
      console.error('Failed to read mission file:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Write a mission file to the server
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} fileName - Mission file name
   * @param {string} content - File content to write
   * @param {string} lockId - Lock ID from acquireLock()
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @param {boolean} createBackup - Whether to create backup (default: true)
   * @returns {Promise<Object>} Write result with success status and backup path
   */
  async writeMissionFile(serverId, fileName, content, lockId, nitradoToken, createBackup = true) {
    try {
      const lockCheck = this.checkLock(serverId, fileName);

      if (!lockCheck.locked) return { success: false, error: 'File is not locked. Acquire a lock before writing.' };
      if (!this.ownsLock(serverId, fileName, lockId)) {
        return { success: false, error: 'Invalid lock ID. You do not own this lock.' };
      }

      const missionData = await this.getActiveMission(serverId, nitradoToken);
      if (!missionData) return { success: false, error: 'No active mission found' };

      const filePath = `${missionData.missionPath}/${fileName}`;

      let backupPath = null;
      if (createBackup && this.backupEnabled) {
        const currentContent = await this.downloadFileFromServer(serverId, filePath, nitradoToken);
        if (currentContent) {
          backupPath = await this.createBackup(serverId, fileName, currentContent, missionData.mapName);
        }
      }

      await this.uploadFileToServer(serverId, path.dirname(filePath), path.basename(filePath), content, nitradoToken);

      console.log('✅ Updated ' + fileName + ' for server ' + serverId);

      return {
        success: true,
        message: 'File ' + fileName + ' updated successfully',
        fileName,
        backupPath,
        hash: this.calculateHash(content)
      };
    } catch (error) {
      console.error('Failed to write mission file:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update a mission file (acquire lock, write, release lock)
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} fileName - Mission file name
   * @param {string} content - File content to write
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @param {string} lockHolder - Lock holder identifier (default: 'dashboard')
   * @returns {Promise<Object>} Update result with success status
   */
  async updateMissionFile(serverId, fileName, content, nitradoToken, lockHolder = 'dashboard') {
    try {
      const lockResult = await this.acquireLock(serverId, fileName, lockHolder);
      if (!lockResult.success) return lockResult;

      const writeResult = await this.writeMissionFile(serverId, fileName, content, lockResult.lockId, nitradoToken);
      await this.releaseLock(serverId, fileName, lockResult.lockId);

      return writeResult;
    } catch (error) {
      console.error('Failed to update mission file:', error.message);
      return { success: false, error: error.message };
    }
  }

  async createBackup(serverId, fileName, content, mapName) {
    try {
      const timestamp = Date.now();
      const backupRoot = path.join(__dirname, '..', 'data', 'backups');
      if (!fsSync.existsSync(backupRoot)) fsSync.mkdirSync(backupRoot, { recursive: true });
      const backupDir = path.join(backupRoot, serverId.toString(), assertMissionPathComponent(mapName));
      ensureContainedDirectorySync(backupRoot, path.relative(backupRoot, backupDir));

      const backupFileName = fileName.replace(/[\\/]/g, '_') + '.' + timestamp + '.backup';
      const backupPath = path.join(backupDir, backupFileName);

      writeContainedFileSync(backupRoot, path.relative(backupRoot, backupPath), content, 'utf8');
      console.log('💾 Created backup: ' + backupPath);

      return backupPath;
    } catch (error) {
      console.error('Failed to create backup:', error.message);
      return null;
    }
  }

  async listBackups(serverId, fileName, mapName) {
    try {
      const backupDir = path.join(__dirname, '..', 'data', 'backups', serverId.toString(), mapName);
      const files = await fs.readdir(backupDir);

      const backups = files.filter(file => file.startsWith(fileName)).map(file => {
        const match = file.match(/\.(\d+)\.backup$/);
        const timestamp = match ? parseInt(match[1]) : 0;
        return {
          fileName: file,
          timestamp,
          date: new Date(timestamp),
          path: path.join(backupDir, file)
        };
      }).sort((a, b) => b.timestamp - a.timestamp);

      return { success: true, backups };
    } catch (error) {
      if (error.code === 'ENOENT') return { success: true, backups: [] };
      return { success: false, error: error.message };
    }
  }

  /**
   * Restore a mission file from a backup
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} fileName - Mission file name
   * @param {string} backupPath - Path to backup file
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<Object>} Restore result
   */
  async restoreBackup(serverId, fileName, backupPath, nitradoToken) {
    try {
      const serverBackupRoot = path.join(__dirname, '..', 'data', 'backups', serverId.toString());
      const backupContent = readContainedFileSync(serverBackupRoot, backupPath, 'utf8');
      const result = await this.updateMissionFile(serverId, fileName, backupContent, nitradoToken, 'restore-operation');

      if (result.success) console.log('✅ Restored ' + fileName + ' from backup');
      return result;
    } catch (error) {
      console.error('Failed to restore backup:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Detect external changes to a mission file
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} fileName - Mission file name
   * @param {string} expectedHash - Expected file hash
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<Object>} Change detection result
   */
  async detectExternalChanges(serverId, fileName, expectedHash, nitradoToken) {
    try {
      const readResult = await this.readMissionFile(serverId, fileName, nitradoToken);
      if (!readResult.success) return { success: false, error: readResult.error };

      const currentHash = readResult.hash;
      const hasChanged = currentHash !== expectedHash;

      return {
        success: true,
        hasChanged,
        expectedHash,
        currentHash,
        content: hasChanged ? readResult.content : null
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Detect conflicts before saving (checks if file has changed on server)
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} fileName - Mission file name
   * @param {string} expectedHash - Expected file hash from client
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<Object>} Conflict detection result
   */
  async detectConflict(serverId, fileName, expectedHash, nitradoToken) {
    try {
      console.log('🔍 Checking for conflicts on:', fileName);
      console.log('   Expected hash:', expectedHash);

      const currentFile = await this.readMissionFile(serverId, fileName, nitradoToken);

      if (!currentFile.success) {
        return {
          success: false,
          error: 'Could not read current file from server'
        };
      }

      const currentHash = currentFile.hash;
      console.log('   Current hash:', currentHash);

      const hasConflict = expectedHash !== currentHash;

      if (hasConflict) {
        console.log('   ⚠️ CONFLICT DETECTED!');
      } else {
        console.log('   ✅ No conflicts');
      }

      return {
        success: true,
        hasConflict,
        expectedHash,
        currentHash,
        currentContent: hasConflict ? currentFile.content : null,
        serverVersion: currentFile
      };
    } catch (error) {
      console.error('Failed to detect conflicts:', error.message);
      return { success: false, error: error.message };
    }
  }

  calculateHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Upload a file to the Nitrado server
   * @param {string|number} serverId - Nitrado server ID
   * @param {string} fullDirPath - Full directory path on server
   * @param {string} fileName - File name
   * @param {string} content - File content to upload
   * @param {string} nitradoToken - Decrypted Nitrado API token (from guild_tokens)
   * @returns {Promise<void>}
   */
  async uploadFileToServer(serverId, fullDirPath, fileName, content, nitradoToken) {
    try {
      console.log('   🔍 Upload parameters:');
      console.log('      path:', fullDirPath);
      console.log('      file:', fileName);

      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('path', fullDirPath);
      formData.append('file', fileName);

      console.log('   📡 Requesting upload token from Nitrado API...');

      const response = await axios.post(
        `https://api.nitrado.net/services/${serverId}/gameservers/file_server/upload`,
        formData,
        {
          headers: {
            'Authorization': `Bearer ${nitradoToken}`,
            ...formData.getHeaders()
          }
        }
      );

      console.log('   ✅ Upload token received');

      const { url: uploadUrl, token: uploadToken } = getNitradoTransferToken(response, { requireToken: true });

      // Step 2: Upload RAW file content with token header (NOT form-data!)
      console.log('   📤 Uploading file content...');
      console.log('   📦 Content size:', content.length, 'bytes');

      await axios.post(uploadUrl, content, {
        headers: {
          'token': uploadToken,
          'Content-Type': 'application/octet-stream'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      console.log('   ✅ Uploaded:', fileName, 'to', fullDirPath);
    } catch (error) {
      console.error('Failed to upload:', error.message);
      if (error.response) {
        console.error('   Response status:', error.response.status);
      }
      throw error;
    }
  }

  /**
   * Delete a file from the Nitrado server. Used to compensate a failed
   * multi-file shop mutation when the checkout created a new file.
   */
  async deleteFileFromServer(serverId, filePath, nitradoToken) {
    try {
      const response = await axios.delete(
        `https://api.nitrado.net/services/${serverId}/gameservers/file_server/delete`,
        {
          data: new URLSearchParams({ path: filePath }).toString(),
          headers: {
            'Authorization': `Bearer ${nitradoToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 10000,
        }
      );
      assertNitradoSuccess(response, 'Nitrado returned an invalid delete response');
      console.log('   🗑️  Deleted:', filePath);
      return true;
    } catch (error) {
      if (error.response?.status === 404) return false;
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
        'https://api.nitrado.net/services/' + serverId + '/gameservers/file_server/download',
        {
          headers: { 'Authorization': 'Bearer ' + nitradoToken },
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
      if (error.response?.status === 500) {
        // Nitrado reports a missing file as HTTP 500 on some DayZ services.
        // Confirm absence through the parent directory before treating it as
        // creatable; a listed file means this was a real provider failure.
        const directory = path.posix.dirname(filePath);
        const fileName = path.posix.basename(filePath);
        const listResponse = await axios.get(
          'https://api.nitrado.net/services/' + serverId + '/gameservers/file_server/list',
          {
            headers: { 'Authorization': 'Bearer ' + nitradoToken },
            params: { dir: directory }
          }
        );
        const entries = getNitradoFileEntries(listResponse);
        if (!entries.some(entry => entry.name === fileName && entry.type === 'file')) return null;
      }
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
      console.log('📡 Getting active mission for server:', serverId);

      const gameserver = await nitradoService.getRawGameserver(nitradoToken, serverId);

      if (!gameserver) {
        console.error('   ❌ No gameserver data found');
        return null;
      }

      const mission = gameserver.settings?.config?.mission || gameserver.query?.map;

      if (!mission) {
        console.error('   ❌ No mission found in gameserver data');
        return null;
      }
      assertMissionPathComponent(mission);

      let mapName = 'unknown';
      if (mission.includes('enoch')) mapName = 'enoch';
      else if (mission.includes('chernarusplus')) mapName = 'chernarusplus';
      else if (mission.includes('sakhal')) mapName = 'sakhal';
      else if (mission.includes('namalsk')) mapName = 'namalsk';
      else if (mission.includes('takistanplus')) mapName = 'takistanplus';

      console.log('   ✓ Mission:', mission);
      console.log('   ✓ Map:', mapName);

      return { mission, missionPath: `${resolveMissionBasePath(gameserver)}/${mission}`, mapName };
    } catch (error) {
      console.error('Failed to get active mission:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
      }
      return null;
    }
  }
}

module.exports = new MissionFileService();