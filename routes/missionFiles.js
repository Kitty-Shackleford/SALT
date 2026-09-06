const express = require('express');
const router = express.Router();
const missionFileService = require('../services/missionFileService');
const { saveMissionFileVerified } = require('../services/missionEditorSaveService');
const nitradoService = require('../services/nitradoService');
const crypto = require('crypto');
const fsSync = require('fs');
const path = require('path');
const { ensureAuthenticated } = require('../middleware/auth');
const {
  ensureContainedDirectorySync,
  readContainedFileSync,
  resolveContainedPath,
  resolveExistingContainedPath,
  resolveWritableContainedPath,
  writeContainedFileAtomicSync,
  writeContainedFileSync,
} = require('../utils/safePath');
const { resolveMissionBasePath, resolveMissionUploadTarget } = require('../utils/nitradoHttp');
const {
  CAPABILITIES,
  authorizePlatformServer,
  authorizePlatformServerMutation,
} = require('../services/authorizationService');

// Helper to decrypt token
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  try {
    const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    const [ivHex, encrypted] = encryptedText.split(':');
    if (!ivHex || !encrypted) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return null;
  }
}

// Helper: Get guild token for a server (by platformServerId)
async function getGuildTokenForServer(db, accessContext) {
  const row = await db.get(`
    SELECT gt.token_hash
    FROM servers s
    JOIN guilds g ON s.guild_id = g.id
    JOIN guild_tokens gt ON g.id = gt.guild_id
    WHERE s.id = ?
      AND s.guild_id = ?
      AND s.status = 'active'
      AND g.status = 'approved'
      AND gt.token_type = 'nitrado'
      AND gt.nitrado_user_id IS NOT NULL
    LIMIT 1
    FOR NO KEY UPDATE OF s, g, gt
  `, [accessContext.serverDbId, accessContext.guildId]);

  if (!row || !row.token_hash) return null;
  return decrypt(row.token_hash);
}

function getLegacyServerRoots(user, serverId) {
  const userDiscordId = String(user?.discord_id || '');
  const internalUserId = String(user?.id || '');
  const roots = [];

  if (userDiscordId) {
    roots.push(path.join(__dirname, '..', 'downloads', userDiscordId, `server_${serverId}`));
  }
  if (internalUserId) {
    roots.push(path.join(__dirname, '..', 'downloads', internalUserId, `server_${serverId}`));
  }

  return Array.from(new Set(roots));
}

async function getServerAccessContext(
  db,
  user,
  platformServerId,
  authorize = authorizePlatformServer
) {
  const authorization = await authorize(
    db,
    user,
    platformServerId,
    CAPABILITIES.SERVER_MANAGE
  );
  if (!authorization) return null;
  return {
    serverDbId: authorization.server.id,
    platformServerId: authorization.server.platformServerId,
    guildId: authorization.guild.id,
    guildDiscordId: authorization.guild.discordGuildId,
  };
}

async function requireServerFileAccess(req, res, platformServerId) {
  const context = await getServerAccessContext(req.app.locals.db, req.user, platformServerId);
  if (!context) {
    res.status(404).json({ success: false, error: 'Server not found' });
    return null;
  }
  req.missionServerAccess = context;
  return context;
}

async function resolveServerDownloadRoot(db, user, serverId) {
  const context = await getServerAccessContext(db, user, serverId);
  const guildDiscordId = context?.guildDiscordId || null;
  const canonicalRoot = guildDiscordId
    ? path.join(__dirname, '..', 'downloads', String(guildDiscordId), `server_${serverId}`)
    : null;

  const triedRoots = [canonicalRoot, ...getLegacyServerRoots(user, serverId)].filter(Boolean);
  const existingRoot = triedRoots.find((root) => fsSync.existsSync(root));

  return {
    serverRoot: existingRoot || canonicalRoot || null,
    triedRoots
  };
}

async function resolveMissionFilePath(db, user, serverId, fileName) {
  const { serverRoot, triedRoots } = await resolveServerDownloadRoot(db, user, serverId);
  if (!serverRoot) {
    return { filePath: null, triedPaths: [] };
  }

  const candidatePaths = triedRoots.map((root) => resolveContainedPath(root, fileName));
  let existingPath = null;
  for (let index = 0; index < candidatePaths.length; index += 1) {
    if (fsSync.existsSync(candidatePaths[index])) {
      existingPath = resolveExistingContainedPath(triedRoots[index], candidatePaths[index]);
      break;
    }
  }

  return {
    filePath: existingPath || resolveWritableContainedPath(serverRoot, fileName),
    serverRoot,
    triedPaths: candidatePaths
  };
}

// IMPORTANT: Route order matters! Most specific routes FIRST, catch-all routes LAST

// Get all active locks (MOST SPECIFIC - must be first)
router.get('/mission-files/active-locks', ensureAuthenticated, async (req, res) => {
  const { serverId } = req.query;

  console.log('🔍 Getting active locks for server:', serverId);

  try {
    if (!serverId) {
      return res.status(400).json({ success: false, error: 'serverId query parameter is required' });
    }
    if (!await requireServerFileAccess(req, res, serverId)) return;

    const locks = missionFileService.getActiveLocks(serverId);
    res.json({ success: true, locks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get list of editable files (SPECIFIC PATH)
router.get('/mission-files/list/:serverId?', ensureAuthenticated, async (req, res) => {
  const { serverId } = req.params;

  console.log('📁 Mission files list requested for server:', serverId);
  console.log('   User:', req.user.username);

  try {
    const fs = require('fs').promises;

    // If no server ID, list all available servers
    if (!serverId) {
      console.log('   📂 No server ID provided, listing available servers...');

      try {
        const rows = await req.app.locals.db.all(`
              SELECT DISTINCT s.platform_server_id AS server_id
              FROM servers s
              JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
              LEFT JOIN guild_roles gr ON gr.guild_id = s.guild_id AND gr.user_id = ?
              LEFT JOIN server_role_assignments sra
                ON sra.server_id = s.id AND sra.guild_id = s.guild_id AND sra.user_id = ?
              WHERE s.status = 'active'
                AND (gr.role IN ('owner', 'admin') OR (sra.role = 'admin' AND sra.status = 'active'))
              ORDER BY s.platform_server_id
            `, [req.user.id, req.user.id]);

        const servers = [];
        for (const row of rows) {
          const id = String(row.server_id);
          const { serverRoot } = await resolveServerDownloadRoot(req.app.locals.db, req.user, id);
          if (serverRoot && fsSync.existsSync(serverRoot)) {
            servers.push(id);
          }
        }

        console.log('   ✅ Found servers:', servers);

        return res.json({
          success: true,
          availableServers: servers,
          message: 'Please select a server'
        });
      } catch (err) {
        console.log('   ❌ No accessible downloaded server directories found');
        return res.json({
          success: false,
          error: 'No servers found. Please use the "Sync Files" button on the dashboard first.',
          availableServers: []
        });
      }
    }

    // If server ID provided, scan that server's files
    if (!await requireServerFileAccess(req, res, serverId)) return;

    const { serverRoot: downloadPath, triedRoots } = await resolveServerDownloadRoot(req.app.locals.db, req.user, serverId);

    console.log('   📂 Scanning local path:', downloadPath);

    // Check if directory exists
    if (!downloadPath) {
      console.log('   ❌ Could not resolve server download directory');
      return res.json({
        success: false,
        error: 'No files downloaded yet. Please use the "Sync Files" button on the dashboard first.',
        debug: { serverId, triedRoots }
      });
    }

    try {
      await fs.access(downloadPath);
    } catch (err) {
      console.log('   ❌ Download directory not found');
      return res.json({
        success: false,
        error: 'No files downloaded yet. Please use the "Sync Files" button on the dashboard first.',
        debug: { serverId, triedRoots }
      });
    }

    // Recursively scan for XML/JSON files
    const editableFiles = {};

    const scanDirectory = async (dirPath, prefix = '') => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          // Skip excluded directories
          const dirName = entry.name.toLowerCase();
          if (['custom', 'db', 'env', 'pra', '.git', 'node_modules'].includes(dirName)) {
            continue;
          }

          // Recursively scan subdirectories
          await scanDirectory(fullPath, relativePath);
        } else if (entry.isFile()) {
          const fileName = entry.name.toLowerCase();
          const isXml = fileName.endsWith('.xml');
          const isJson = fileName.endsWith('.json');

          if (fileName.startsWith('.')) continue;

          if (isXml || isJson) {
            const stats = await fs.stat(fullPath);
            editableFiles[relativePath] = {
              description: `Mission file: ${relativePath}`,
              type: isXml ? 'xml' : 'json',
              path: fullPath,
              relativePath: relativePath,
              size: stats.size
            };
          }
        }
      }
    }

    await scanDirectory(downloadPath);

    console.log(`   ✅ Found ${Object.keys(editableFiles).length} editable files`);

    res.json({
      success: true,
      files: editableFiles,
      isLocal: true,
      downloadPath: downloadPath
    });

  } catch (error) {
    console.error('Error listing mission files:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Force release all locks (SPECIFIC PATH)
router.post('/mission-files/release-all-locks', ensureAuthenticated, async (req, res) => {
  const { serverId } = req.body;

  console.log('🔓 Force releasing all locks for server:', serverId);

  try {
    if (!serverId) {
      return res.status(400).json({ success: false, error: 'serverId is required' });
    }
    if (!await requireServerFileAccess(req, res, serverId)) return;

    const result = missionFileService.releaseAllLocks(serverId);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Check for conflicts before saving (SPECIFIC ENDING)
router.post('/mission-files/:serverId/:fileName(*)/check-conflict', ensureAuthenticated, async (req, res) => {
  const { serverId, fileName } = req.params;
  const { expectedHash } = req.body;

  console.log('🔍 Checking conflicts for:', fileName);

  if (!expectedHash) {
    return res.status(400).json({ success: false, error: 'Expected hash required' });
  }

  try {
    if (!await requireServerFileAccess(req, res, serverId)) return;

    const fs = require('fs').promises;
    const { filePath } = await resolveMissionFilePath(req.app.locals.db, req.user, serverId, fileName);
    if (!filePath) {
      return res.status(404).json({ success: false, error: 'Server download path not found. Sync files first.' });
    }

    // Read current file
    const currentContent = await fs.readFile(filePath, 'utf8');
    const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');

    const hasConflict = expectedHash !== currentHash;

    if (hasConflict) {
      console.log('   ⚠️ CONFLICT DETECTED!');
    } else {
      console.log('   ✅ No conflicts');
    }

    res.json({
      success: true,
      hasConflict,
      expectedHash,
      currentHash,
      currentContent: hasConflict ? currentContent : null
    });
  } catch (error) {
    console.error('Error checking conflict:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// List backups for a file (SPECIFIC ENDING)
router.get('/mission-files/:serverId/:fileName(*)/backups', ensureAuthenticated, async (req, res) => {
  const { serverId, fileName } = req.params;

  console.log('📂 Listing backups for:', fileName);

  try {
    if (!await requireServerFileAccess(req, res, serverId)) return;

    const userId = req.user.discord_id || req.user.id;
    const fs = require('fs').promises;
    const backupDir = path.join(__dirname, '..', 'data', 'backups', userId.toString(), `server_${serverId}`);

    const sanitizedFileName = fileName.replace(/\//g, '_');

    try {
      const files = await fs.readdir(backupDir);

      const backups = files
        .filter(file => file.startsWith(sanitizedFileName))
        .map(file => {
          const match = file.match(/\.(\d+)\.backup$/);
          const timestamp = match ? parseInt(match[1]) : 0;
          return {
            fileName: file,
            timestamp,
            date: new Date(timestamp),
            path: path.join(backupDir, file)
          };
        })
        .sort((a, b) => b.timestamp - a.timestamp);

      res.json({ success: true, backups });
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.json({ success: true, backups: [] });
      } else {
        throw err;
      }
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Restore from backup (SPECIFIC ENDING)
router.post('/mission-files/:serverId/:fileName(*)/restore', ensureAuthenticated, async (req, res) => {
  const { serverId, fileName } = req.params;
  const { backupPath } = req.body;

  console.log('♻️ Restoring backup for:', fileName);

  if (!backupPath) {
    return res.status(400).json({ success: false, error: 'Backup path required' });
  }

  try {
    if (!await requireServerFileAccess(req, res, serverId)) return;

    const userId = req.user.discord_id || req.user.id;
    const backupDir = path.join(__dirname, '..', 'data', 'backups', userId.toString(), `server_${serverId}`);
    const sanitizedFileName = fileName.replace(/\//g, '_');
    const resolvedBackupPath = resolveExistingContainedPath(backupDir, backupPath);
    const backupFileName = path.basename(resolvedBackupPath);
    if (!backupFileName.startsWith(`${sanitizedFileName}.`) || !/\.\d+\.backup$/.test(backupFileName)) {
      return res.status(400).json({ success: false, error: 'Invalid backup path' });
    }

    // Read backup content
    const backupContent = readContainedFileSync(backupDir, resolvedBackupPath, 'utf8');

    // Write to original file location
    const { filePath, serverRoot } = await resolveMissionFilePath(req.app.locals.db, req.user, serverId, fileName);
    if (!filePath) {
      return res.status(404).json({ success: false, error: 'Server download path not found. Sync files first.' });
    }
    writeContainedFileSync(serverRoot, path.relative(serverRoot, filePath), backupContent, 'utf8');

    console.log('   ✅ Restored from backup');

    res.json({
      success: true,
      message: 'File restored from backup successfully'
    });
  } catch (error) {
    console.error('Error restoring backup:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Check lock status (SPECIFIC ENDING)
router.get('/mission-files/:serverId/:fileName(*)/lock-status', ensureAuthenticated, async (req, res) => {
  const { serverId, fileName } = req.params;

  try {
    if (!await requireServerFileAccess(req, res, serverId)) return;

    const result = missionFileService.checkLock(serverId, fileName);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Acquire lock on a file (SPECIFIC ENDING)
router.post('/mission-files/:serverId/:fileName(*)/lock', ensureAuthenticated, async (req, res) => {
  const { serverId, fileName } = req.params;

  console.log('🔒 Lock requested for:', fileName);

  try {
    if (!await requireServerFileAccess(req, res, serverId)) return;

    const holderSeed = `${req.user.id}:${req.sessionID || ''}`;
    const lockHolder = `editor:${crypto.createHash('sha256').update(holderSeed).digest('hex').slice(0, 16)}`;
    const result = await missionFileService.acquireLock(serverId, fileName, lockHolder, 300000);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Release lock on a file (SPECIFIC ENDING)
router.post('/mission-files/:serverId/:fileName(*)/unlock', ensureAuthenticated, async (req, res) => {
  const { serverId, fileName } = req.params;
  const { lockId } = req.body;

  console.log('🔓 Unlock requested for:', fileName);

  try {
    if (!await requireServerFileAccess(req, res, serverId)) return;

    const result = await missionFileService.releaseLock(serverId, fileName, lockId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Write to a mission file (SPECIFIC METHOD)
router.put('/mission-files/:serverId/:fileName(*)', ensureAuthenticated, async (req, res) => {
  const { serverId, fileName } = req.params;
  const { content, lockId, createBackup, uploadToNitrado, expectedHash } = req.body;

  console.log('💾 Saving file:', fileName, 'for server:', serverId);

  if (!lockId) {
    return res.status(400).json({ success: false, error: 'Lock ID required' });
  }
  if (uploadToNitrado !== true) {
    return res.status(400).json({
      success: false,
      error: 'Mission Editor saves must be uploaded and verified on Nitrado',
    });
  }

  try {
    const accessContext = await requireServerFileAccess(req, res, serverId);
    if (!accessContext) return;

    const { filePath, serverRoot } = await resolveMissionFilePath(
      req.app.locals.db,
      req.user,
      serverId,
      fileName
    );
    if (!filePath) {
      return res.status(404).json({
        success: false,
        error: 'Server download path not found. Sync files first.',
      });
    }

    if (!missionFileService.ownsLock(serverId, fileName, lockId)) {
      return res.status(403).json({ success: false, error: 'Invalid or expired lock' });
    }

    let backupPath = null;
    const result = await saveMissionFileVerified({
      db: req.app.locals.db,
      internalServerId: accessContext.serverDbId,
      expectedHash,
      content,
      fileService: missionFileService,
      triggeredBy: `user:${req.user.id}`,
      resolveProviderContext: async transactionDb => {
        const lockedAccess = await getServerAccessContext(
          transactionDb,
          req.user,
          serverId,
          authorizePlatformServerMutation
        );
        if (!lockedAccess || lockedAccess.serverDbId !== accessContext.serverDbId) {
          const error = new Error('Server access changed before the save completed');
          error.status = 403;
          throw error;
        }
        const token = await getGuildTokenForServer(transactionDb, lockedAccess);
        if (!token) {
          const error = new Error('No Nitrado token configured for this server');
          error.status = 409;
          throw error;
        }
        const gameserver = await nitradoService.getRawGameserver(token, serverId);
        const missionBasePath = resolveMissionBasePath(gameserver);
        const configuredMission = gameserver?.settings?.config?.mission || gameserver?.query?.map;
        const target = resolveMissionUploadTarget(missionBasePath, configuredMission, fileName);
        return {
          platformServerId: lockedAccess.platformServerId,
          token,
          remoteDirectory: target.directory,
          remoteFileName: target.fileName,
        };
      },
      localWriter: (nextContent, previousContent) => {
        const relativeLocalPath = path.relative(serverRoot, filePath);
        const localPreimage = readContainedFileSync(serverRoot, relativeLocalPath, 'utf8');
        if (createBackup) {
          const timestamp = Date.now();
          const userId = req.user.discord_id || req.user.id;
          const backupRoot = path.join(__dirname, '..', 'data', 'backups');
          if (!fsSync.existsSync(backupRoot)) fsSync.mkdirSync(backupRoot, { recursive: true });
          const backupDir = path.join(backupRoot, userId.toString(), `server_${serverId}`);
          ensureContainedDirectorySync(backupRoot, path.relative(backupRoot, backupDir));
          const backupFileName = `${fileName.replace(/\//g, '_')}.${timestamp}.backup`;
          backupPath = path.join(backupDir, backupFileName);
          writeContainedFileSync(
            backupRoot,
            path.relative(backupRoot, backupPath),
            previousContent,
            'utf8'
          );
        }
        writeContainedFileAtomicSync(
          serverRoot,
          relativeLocalPath,
          nextContent,
          'utf8'
        );
        return () => writeContainedFileAtomicSync(
          serverRoot,
          relativeLocalPath,
          localPreimage,
          'utf8'
        );
      },
    });

    res.json({
      success: true,
      message: 'File saved and verified on Nitrado',
      fileName,
      hash: result.hash,
      backupPath,
      uploaded: result.providerUploaded,
      providerUploaded: result.providerUploaded,
      localSaved: result.localSaved,
      isLocal: result.localSaved,
    });
  } catch (error) {
    console.error('Error writing mission file:', error.message);
    const status = error.status || (error.code === 'SHOP_BUSY' ? 409 : 502);
    const message = status < 500 ? error.message : 'Mission file save could not be verified';
    res.status(status).json({
      success: false,
      localSaved: false,
      providerUploaded: false,
      error: message,
    });
  }
});

// Read a mission file (CATCH-ALL - must be LAST)
router.get('/mission-files/:serverId/:fileName(*)', ensureAuthenticated, async (req, res) => {
  const { serverId, fileName } = req.params;

  console.log('📖 Reading file:', fileName, 'from server:', serverId);

  try {
    if (!await requireServerFileAccess(req, res, serverId)) return;

    const fs = require('fs').promises;
    const { filePath } = await resolveMissionFilePath(req.app.locals.db, req.user, serverId, fileName);
    if (!filePath) {
      return res.status(404).json({ success: false, error: 'Server download path not found. Sync files first.' });
    }

    console.log('   📂 Local path:', filePath);

    const content = await fs.readFile(filePath, 'utf8');

    // Calculate hash
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // Parse XML if needed
    let parsedData = null;
    if (fileName.toLowerCase().endsWith('.xml')) {
      const xml2js = require('xml2js');
      const parser = new xml2js.Parser();
      parsedData = await parser.parseStringPromise(content);
    }

    console.log('   ✅ File read successfully, hash:', hash.substring(0, 16) + '...');

    res.json({
      success: true,
      fileName,
      content,
      parsedData,
      hash,
      filePath: fileName,
      isLocal: true
    });

  } catch (error) {
    console.error('Error reading file:', error.message);
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'File not found. Please sync files first.' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

module.exports = router;
