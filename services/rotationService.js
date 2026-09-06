/*
 * services/rotationService.js
 *
 * Activation engine for the snippet rotation system.
 * Handles all 4 deployment patterns:
 *
 *   ce_folder         — uploads snippet as a named file in the mission ce/ directory
 *   cfggameplay_array — patches cfgGameplay.json to add/remove a file path from an array
 *   location_bundle   — deploys an object spawner JSON (cfggameplay_array) AND injects
 *                       the companion mapgrouppos XML block; both in one atomic operation
 *   xml_patch         — downloads a target XML file, injects/strips a managed block, re-uploads
 *   file_swap         — replaces a file outright; backs up the original on first activation
 *
 * All Nitrado file I/O goes through the two-step token-based API:
 *   Download: GET /file_server/download → GET {url}
 *   Upload:   POST /file_server/upload  → POST {url} with raw content
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const axios = require('../utils/nitradoHttp');
const { assertMissionPathComponent, assertNitradoSuccess, getNitradoTransferToken, getNitradoTextBody, resolveMissionBasePath } = require('../utils/nitradoHttp');
const nitradoService = require('./nitradoService');
const { acquireProviderMutationLock, createFileMutationJournal } = require('./shopFileService');
const { decryptToken } = require('../utils/encryption');

// ── Nitrado file I/O helpers ──────────────────────────────────────────────────

/**
 * Downloads a file from Nitrado and returns its text content, or null on 404/error.
 */
async function rawDownloadFile(token, platformServerId, filePath) {
  try {
    const res = await axios.get(
      `https://api.nitrado.net/services/${platformServerId}/gameservers/file_server/download`,
      {
        params: { file: filePath },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000
      }
    );
    const { url } = getNitradoTransferToken(res);

    const fileRes = await axios.get(url, { responseType: 'text', timeout: 20000 });
    return getNitradoTextBody(fileRes);
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Uploads content to a Nitrado file path (two-step: get upload token, then PUT raw content).
 * @param {string} token           Nitrado API token
 * @param {string} platformServerId
 * @param {string} dirPath         Provider-derived mission directory path
 * @param {string} fileName        Filename only (e.g. rotation_types.xml)
 * @param {string} content         Raw text content
 */
async function rawUploadFile(token, platformServerId, dirPath, fileName, content) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('path', dirPath);
  form.append('file', fileName);

  const tokenRes = await axios.post(
    `https://api.nitrado.net/services/${platformServerId}/gameservers/file_server/upload`,
    form,
    { headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() }, timeout: 15000 }
  );

  const { url: uploadUrl, token: uploadToken } = getNitradoTransferToken(tokenRes, { requireToken: true });

  await axios.post(uploadUrl, content, {
    headers: { token: uploadToken, 'Content-Type': 'application/octet-stream' },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 30000
  });

  console.log(`📤 Uploaded ${fileName} → ${dirPath}`);
}

/**
 * Deletes a file from the Nitrado file server.
 * Returns true on success, false if file wasn't found.
 */
async function rawDeleteFile(token, platformServerId, filePath) {
  try {
    const response = await axios.delete(
      `https://api.nitrado.net/services/${platformServerId}/gameservers/file_server/delete`,
      {
        data: { path: filePath },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      }
    );
    assertNitradoSuccess(response, 'Nitrado returned an invalid delete response');
    console.log(`🗑️  Deleted ${filePath}`);
    return true;
  } catch (err) {
    if (err.response?.status === 404) return false;
    throw err;
  }
}

const rotationMutationStorage = new AsyncLocalStorage();
const rawRotationFileService = {
  downloadFileFromServer: (serverId, filePath, token) => rawDownloadFile(token, serverId, filePath),
  uploadFileToServer: (serverId, dirPath, fileName, content, token) =>
    rawUploadFile(token, serverId, dirPath, fileName, content),
  deleteFileFromServer: (serverId, filePath, token) => rawDeleteFile(token, serverId, filePath),
};

async function downloadFile(token, platformServerId, filePath) {
  const journal = rotationMutationStorage.getStore();
  if (journal) return journal.downloadFileFromServer(platformServerId, filePath, token);
  return rawDownloadFile(token, platformServerId, filePath);
}

async function uploadFile(token, platformServerId, dirPath, fileName, content) {
  const journal = rotationMutationStorage.getStore();
  if (journal) {
    return journal.uploadFileToServer(platformServerId, dirPath, fileName, content, token);
  }
  return rawUploadFile(token, platformServerId, dirPath, fileName, content);
}

async function deleteFile(token, platformServerId, filePath) {
  const journal = rotationMutationStorage.getStore();
  if (journal) return journal.deleteFileFromServer(platformServerId, filePath, token);
  return rawDeleteFile(token, platformServerId, filePath);
}

// ── Server context helpers ────────────────────────────────────────────────────

/**
 * Loads the Nitrado token and platform server ID for a dashboard server row.
 */
async function getServerCredentials(db, serverId) {
  const row = await db.get(
    `SELECT s.platform_server_id, s.platform, gt.token_hash
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     JOIN guild_tokens gt ON gt.guild_id = s.guild_id AND gt.token_type = 'nitrado'
     WHERE s.id = ?
       AND s.status = 'active'
       AND g.status = 'approved'
       AND gt.nitrado_user_id IS NOT NULL
     FOR NO KEY UPDATE OF s, g, gt`,
    [serverId]
  );
  if (!row) throw new Error(`No Nitrado credentials found for server ${serverId}`);
  return {
    token: decryptToken(row.token_hash),
    platformServerId: row.platform_server_id,
    platform: row.platform
  };
}

/**
 * Fetches the mission base path from Nitrado gameserver data.
 * Returns the full provider-derived path to the active mission folder.
 */
async function resolveMissionPath(token, platformServerId) {
  const gs = await nitradoService.getRawGameserver(token, platformServerId);
  const mission = gs?.settings?.config?.mission || gs?.game_specific?.mission || gs?.query?.map;
  if (!mission) throw new Error('Could not resolve mission path from Nitrado');
  assertMissionPathComponent(mission);
  return `${resolveMissionBasePath(gs)}/${mission}`;
}

// ── Managed block markers ─────────────────────────────────────────────────────

/**
 * Wraps snippet XML content in sentinel comment markers so we can reliably
 * find and remove it later during deactivation.
 */
function wrapWithMarkers(snippetId, content) {
  return `<!-- ROTATION_SNIPPET_START:${snippetId} -->\n${content.trim()}\n<!-- ROTATION_SNIPPET_END:${snippetId} -->`;
}

/** Strips all managed blocks for the given snippetId from an XML string. */
function stripManagedBlock(xml, snippetId) {
  const startMarker = `<!-- ROTATION_SNIPPET_START:${snippetId} -->`;
  const endMarker   = `<!-- ROTATION_SNIPPET_END:${snippetId} -->`;
  const start = xml.indexOf(startMarker);
  const end   = xml.indexOf(endMarker);
  if (start === -1 || end === -1) return xml;
  return xml.slice(0, start).trimEnd() + '\n' + xml.slice(end + endMarker.length).trimStart();
}

// ── Activation pattern implementations ───────────────────────────────────────

/**
 * Pattern: ce_folder
 * Uploads snippet content as ce/rotation_{ce_type}.xml in the mission folder.
 * cfgeconomycore.xml must already reference this filename (done by setup wizard).
 */
async function activateCeFolder(token, platformServerId, missionPath, snippet) {
  const fileName = `rotation_${snippet.ce_type}.xml`;
  const dirPath  = `${missionPath}/ce`;
  await uploadFile(token, platformServerId, dirPath, fileName, snippet.content);
}

async function deactivateCeFolder(token, platformServerId, missionPath, snippet) {
  const filePath = `${missionPath}/ce/rotation_${snippet.ce_type}.xml`;
  await deleteFile(token, platformServerId, filePath);
}

/**
 * Pattern: cfggameplay_array
 * Downloads cfgGameplay.json, adds/removes the snippet's deploy_path from the target array, re-uploads.
 * Also uploads the snippet's content JSON to deploy_path.
 */
async function activateCfgGameplayArray(token, platformServerId, missionPath, snippet) {
  // Upload the JSON file content to its deploy path
  const fullDeployPath = snippet.deploy_path.startsWith('/')
    ? snippet.deploy_path
    : `${missionPath}/${snippet.deploy_path}`;

  const lastSlash = fullDeployPath.lastIndexOf('/');
  const deployDir  = fullDeployPath.slice(0, lastSlash);
  const deployFile = fullDeployPath.slice(lastSlash + 1);
  await uploadFile(token, platformServerId, deployDir, deployFile, snippet.content);

  // Patch cfgGameplay.json
  await patchCfgGameplayArray(token, platformServerId, missionPath, snippet.cfggameplay_array, snippet.deploy_path, 'add');
}

async function deactivateCfgGameplayArray(token, platformServerId, missionPath, snippet) {
  await patchCfgGameplayArray(token, platformServerId, missionPath, snippet.cfggameplay_array, snippet.deploy_path, 'remove');
  // Optionally delete the deployed file
  const fullPath = snippet.deploy_path.startsWith('/')
    ? snippet.deploy_path
    : `${missionPath}/${snippet.deploy_path}`;
  await deleteFile(token, platformServerId, fullPath);
}

async function patchCfgGameplayArray(token, platformServerId, missionPath, arrayName, filePath, action) {
  const cfgPath = `${missionPath}/cfgGameplay.json`;
  const raw = await downloadFile(token, platformServerId, cfgPath);
  if (!raw) throw new Error('cfgGameplay.json not found on server');

  let cfg;
  try { cfg = JSON.parse(raw); } catch { throw new Error('cfgGameplay.json is not valid JSON'); }

  if (!Array.isArray(cfg[arrayName])) cfg[arrayName] = [];

  if (action === 'add') {
    if (!cfg[arrayName].includes(filePath)) cfg[arrayName].push(filePath);
  } else {
    cfg[arrayName] = cfg[arrayName].filter(p => p !== filePath);
  }

  const updated = JSON.stringify(cfg, null, 2);
  const lastSlash = cfgPath.lastIndexOf('/');
  await uploadFile(token, platformServerId, cfgPath.slice(0, lastSlash), 'cfgGameplay.json', updated);
}

/**
 * Pattern: location_bundle
 * Deploys both the object spawner JSON (via cfgGameplay.json objectSpawnersArr)
 * AND the companion mapgrouppos.xml block in one operation.
 */
async function activateLocationBundle(token, platformServerId, missionPath, snippet) {
  // 1. Deploy the object spawner JSON
  await activateCfgGameplayArray(token, platformServerId, missionPath, {
    content: snippet.content,
    deploy_path: snippet.deploy_path,
    cfggameplay_array: 'objectSpawnersArr'
  });

  // 2. Inject mapgrouppos block
  if (snippet.mapgrouppos_content) {
    await injectXmlBlock(token, platformServerId, missionPath, 'mapgrouppos.xml', snippet.id, snippet.mapgrouppos_content);
  }

  // 3. Optional ce/ additions
  if (snippet.types_content) {
    await uploadFile(token, platformServerId, `${missionPath}/ce`, `rotation_bundle_${snippet.id}_types.xml`, snippet.types_content);
  }
  if (snippet.spawnabletypes_content) {
    await uploadFile(token, platformServerId, `${missionPath}/ce`, `rotation_bundle_${snippet.id}_spawnabletypes.xml`, snippet.spawnabletypes_content);
  }
}

async function deactivateLocationBundle(token, platformServerId, missionPath, snippet) {
  // Remove spawner from cfgGameplay.json + delete file
  await deactivateCfgGameplayArray(token, platformServerId, missionPath, {
    deploy_path: snippet.deploy_path,
    cfggameplay_array: 'objectSpawnersArr'
  });

  // Strip mapgrouppos block
  if (snippet.mapgrouppos_content) {
    await stripXmlBlock(token, platformServerId, missionPath, 'mapgrouppos.xml', snippet.id);
  }

  // Remove ce/ additions
  if (snippet.types_content) {
    await deleteFile(token, platformServerId, `${missionPath}/ce/rotation_bundle_${snippet.id}_types.xml`);
  }
  if (snippet.spawnabletypes_content) {
    await deleteFile(token, platformServerId, `${missionPath}/ce/rotation_bundle_${snippet.id}_spawnabletypes.xml`);
  }
}

/**
 * Pattern: xml_patch
 * Downloads target XML file, injects marked block inside the root element, re-uploads.
 */
async function activateXmlPatch(token, platformServerId, missionPath, snippet) {
  await injectXmlBlock(token, platformServerId, missionPath, snippet.target_file, snippet.id, snippet.content);
}

async function deactivateXmlPatch(token, platformServerId, missionPath, snippet) {
  await stripXmlBlock(token, platformServerId, missionPath, snippet.target_file, snippet.id);
}

async function injectXmlBlock(token, platformServerId, missionPath, targetFile, snippetId, blockContent) {
  const filePath = `${missionPath}/${targetFile}`;
  const xml = await downloadFile(token, platformServerId, filePath);
  if (!xml) throw new Error(`${targetFile} not found on server`);

  // Strip any existing managed block for this snippet first (idempotent)
  const stripped = stripManagedBlock(xml, snippetId);

  // Inject before the closing root tag
  const marker = wrapWithMarkers(snippetId, blockContent);
  const closingTagMatch = stripped.match(/<\/[^>]+>\s*$/);
  let updated;
  if (closingTagMatch) {
    const insertAt = stripped.lastIndexOf(closingTagMatch[0]);
    updated = stripped.slice(0, insertAt) + '\n' + marker + '\n' + stripped.slice(insertAt);
  } else {
    updated = stripped + '\n' + marker;
  }

  const lastSlash = filePath.lastIndexOf('/');
  await uploadFile(token, platformServerId, filePath.slice(0, lastSlash), targetFile, updated);
}

async function stripXmlBlock(token, platformServerId, missionPath, targetFile, snippetId) {
  const filePath = `${missionPath}/${targetFile}`;
  const xml = await downloadFile(token, platformServerId, filePath);
  if (!xml) return; // File gone, nothing to do

  const updated = stripManagedBlock(xml, snippetId);
  if (updated === xml) return; // Block wasn't there

  const lastSlash = filePath.lastIndexOf('/');
  await uploadFile(token, platformServerId, filePath.slice(0, lastSlash), targetFile, updated);
}

/**
 * Pattern: file_swap
 * Refreshes the backup from current provider state on every activation,
 * then uploads snippet content. Deactivation restores and consumes the backup.
 */
async function activateFileSwap(db, token, platformServerId, missionPath, snippet, serverId) {
  const filePath = snippet.target_path;
  const original = await downloadFile(token, platformServerId, filePath);
  await db.run(
    `INSERT INTO rotation_file_backups
       (snippet_id, server_id, file_path, original_exists, content, backed_up_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (snippet_id, server_id) DO UPDATE
       SET file_path = EXCLUDED.file_path,
           original_exists = EXCLUDED.original_exists,
           content = EXCLUDED.content,
           backed_up_at = CURRENT_TIMESTAMP`,
    [snippet.id, serverId, filePath, original !== null && original !== undefined, original ?? null]
  );
  console.log(`💾 Backed up ${filePath} before file_swap`);

  const lastSlash = filePath.lastIndexOf('/');
  await uploadFile(token, platformServerId, filePath.slice(0, lastSlash), filePath.slice(lastSlash + 1), snippet.content);
}

async function deactivateFileSwap(db, token, platformServerId, missionPath, snippet, serverId) {
  const preparedBackup = Object.prototype.hasOwnProperty.call(snippet, 'backup_file_path')
    ? {
      content: snippet.backup_content,
      file_path: snippet.backup_file_path,
      original_exists: snippet.backup_original_exists,
    }
    : null;
  const backup = preparedBackup || await db.get(
    `SELECT content, file_path, original_exists
     FROM rotation_file_backups WHERE snippet_id = ? AND server_id = ?`,
    [snippet.id, serverId]
  );

  if (!backup) {
    throw new Error(`No backup found for file_swap snippet ${snippet.id} on server ${serverId}`);
  }

  const filePath = backup.file_path;
  if (backup.original_exists) {
    const lastSlash = filePath.lastIndexOf('/');
    await uploadFile(
      token,
      platformServerId,
      filePath.slice(0, lastSlash),
      filePath.slice(lastSlash + 1),
      backup.content
    );
  } else {
    await deleteFile(token, platformServerId, filePath);
  }
  await db.run(
    'DELETE FROM rotation_file_backups WHERE snippet_id = ? AND server_id = ?',
    [snippet.id, serverId]
  );
  console.log(`♻️  Restored ${filePath} from backup`);
}

// ── Public API ────────────────────────────────────────────────────────────────

async function resolvePreparedFileSwapSnippets(db, snippets, serverId, action) {
  if (action !== 'deactivate') return snippets;
  const resolved = [];
  for (const snippet of snippets) {
    if (snippet.pattern !== 'file_swap') {
      resolved.push(snippet);
      continue;
    }
    const backup = await db.get(
      `SELECT content, file_path, original_exists
       FROM rotation_file_backups WHERE snippet_id = ? AND server_id = ?`,
      [snippet.id, serverId]
    );
    if (!backup) {
      throw new Error(`No backup found for file_swap snippet ${snippet.id} on server ${serverId}`);
    }
    resolved.push({
      ...snippet,
      backup_file_path: backup.file_path,
      backup_content: backup.content,
      backup_original_exists: backup.original_exists,
    });
  }
  return resolved;
}

function collectPresetFilePaths(missionPath, snippets, action = 'activate') {
  const paths = new Set();
  for (const snippet of snippets) {
    const deployPath = snippet.deploy_path
      ? (snippet.deploy_path.startsWith('/') ? snippet.deploy_path : `${missionPath}/${snippet.deploy_path}`)
      : null;
    switch (snippet.pattern) {
      case 'ce_folder':
        paths.add(`${missionPath}/ce/rotation_${snippet.ce_type}.xml`);
        break;
      case 'cfggameplay_array':
        paths.add(`${missionPath}/cfgGameplay.json`);
        if (deployPath) paths.add(deployPath);
        break;
      case 'location_bundle':
        paths.add(`${missionPath}/cfgGameplay.json`);
        if (deployPath) paths.add(deployPath);
        if (snippet.mapgrouppos_content) paths.add(`${missionPath}/mapgrouppos.xml`);
        if (snippet.types_content) {
          paths.add(`${missionPath}/ce/rotation_bundle_${snippet.id}_types.xml`);
        }
        if (snippet.spawnabletypes_content) {
          paths.add(`${missionPath}/ce/rotation_bundle_${snippet.id}_spawnabletypes.xml`);
        }
        break;
      case 'xml_patch':
        paths.add(`${missionPath}/${snippet.target_file}`);
        break;
      case 'file_swap':
        paths.add(action === 'deactivate' ? snippet.backup_file_path : snippet.target_path);
        break;
      default:
        throw new Error(`Unknown rotation pattern: ${snippet.pattern}`);
    }
  }
  return [...paths];
}

async function assertNoUnresolvedRotationMutation(db, serverId) {
  const unresolved = await db.get(
    `SELECT id, status FROM provider_mutations
     WHERE server_id = ? AND status IN ('prepared', 'recovery_pending')
     ORDER BY created_at LIMIT 1`,
    [serverId]
  );
  if (!unresolved) return;
  const error = new Error(`Rotation provider recovery is pending for operation ${unresolved.id}`);
  error.code = 'ROTATION_RECOVERY_PENDING';
  error.status = 409;
  throw error;
}

function assertPresetLifecycleState(preset, action) {
  const active = preset.active === true || preset.active === 1;
  if (action === 'activate' && active) {
    const error = new Error(`Preset ${preset.id} is already active`);
    error.code = 'ROTATION_PRESET_ALREADY_ACTIVE';
    error.status = 409;
    throw error;
  }
  if (action === 'deactivate' && !active) {
    const error = new Error(`Preset ${preset.id} is already inactive`);
    error.code = 'ROTATION_PRESET_ALREADY_INACTIVE';
    error.status = 409;
    throw error;
  }
}

async function preparePresetMutation(db, transactionDb, presetId, serverId, action, triggeredBy) {
  await assertNoUnresolvedRotationMutation(transactionDb, serverId);
    const preset = await transactionDb.get(
      'SELECT * FROM rotation_presets WHERE id = ? AND server_id = ? FOR UPDATE',
      [presetId, serverId]
    );
    if (!preset) throw new Error(`Preset ${presetId} not found`);
    assertPresetLifecycleState(preset, action);
    const loadedSnippets = await transactionDb.query(
      `SELECT rs.* FROM rotation_snippets rs
       JOIN rotation_preset_snippets rps ON rps.snippet_id = rs.id
       JOIN rotation_presets rp ON rp.id = rps.preset_id
       JOIN servers s ON s.id = rp.server_id
       WHERE rps.preset_id = ? AND rs.server_id = rp.server_id
       ORDER BY rps.sort_order ${action === 'deactivate' ? 'DESC' : 'ASC'}`,
      [presetId]
    );
    const snippets = await resolvePreparedFileSwapSnippets(
      transactionDb, loadedSnippets, serverId, action
    );
    const invalidAttachment = await transactionDb.get(
      `SELECT 1 FROM rotation_preset_snippets rps
       JOIN rotation_presets rp ON rp.id = rps.preset_id
       JOIN rotation_snippets rs ON rs.id = rps.snippet_id
       WHERE rps.preset_id = ? AND rs.server_id <> rp.server_id
       LIMIT 1`,
      [presetId]
    );
    if (invalidAttachment) throw new Error('Preset contains a snippet assigned to another server');
    const { token, platformServerId } = await getServerCredentials(transactionDb, serverId);
    const missionPath = await resolveMissionPath(token, platformServerId);
    const snapshots = new Map();
    for (const filePath of collectPresetFilePaths(missionPath, snippets, action)) {
      snapshots.set(filePath, await rawDownloadFile(token, platformServerId, filePath));
    }
    const operationId = await db.independentTransaction(durableDb => persistPreparedMutation(durableDb, {
      serverId,
      providerServiceId: platformServerId,
      presetId,
      action,
      triggeredBy,
      plan: { presetId, presetName: preset.name, action, missionPath, snippets },
      snapshots,
    }));
    return { operationId, preset, snippets, token, platformServerId, missionPath, snapshots };
}

async function prepareCeSetupMutation(db, transactionDb, serverId, triggeredBy) {
  await assertNoUnresolvedRotationMutation(transactionDb, serverId);
    const { token, platformServerId } = await getServerCredentials(transactionDb, serverId);
    const missionPath = await resolveMissionPath(token, platformServerId);
    const coreFilePath = `${missionPath}/cfgeconomycore.xml`;
    const originalContent = await rawDownloadFile(token, platformServerId, coreFilePath);
    const snapshots = new Map([[coreFilePath, originalContent]]);
    const operationId = await db.independentTransaction(durableDb => persistPreparedMutation(durableDb, {
      serverId,
      providerServiceId: platformServerId,
      presetId: null,
      action: 'ce_setup',
      triggeredBy,
      plan: {
        action: 'ce_setup',
        missionPath,
        ceTypes: ['types', 'spawnabletypes', 'events', 'randompresets', 'globals', 'messages'],
      },
      snapshots,
    }));
    return { operationId, token, platformServerId, missionPath, snapshots };
}

async function verifyPreparedSnapshots(prepared) {
  for (const [filePath, originalContent] of prepared.snapshots) {
    const current = await rawDownloadFile(prepared.token, prepared.platformServerId, filePath);
    if (current !== originalContent) {
      throw new Error(`Concurrent provider edit detected for ${filePath}`);
    }
  }
}

async function persistPreparedMutation(db, {
  serverId, providerServiceId, presetId, action, triggeredBy, plan, snapshots,
}) {
  if (providerServiceId === null || providerServiceId === undefined || !String(providerServiceId).trim()) {
    throw new Error('Rotation provider service identity is required');
  }
  if (!plan || typeof plan !== 'object') throw new Error('Rotation provider mutation plan is required');
  if (!(snapshots instanceof Map) || snapshots.size === 0) {
    throw new Error('Rotation provider mutation snapshots are required');
  }
  const durablePlan = { ...plan, filePaths: [...snapshots.keys()] };
  const operation = await db.get(
    `INSERT INTO provider_mutations
     (server_id, provider_service_id, workflow, action, context_type, context_id,
      plan_json, status, triggered_by)
     VALUES (?, ?, 'rotation', ?, ?, ?, ?::jsonb, 'prepared', ?)
     RETURNING id`,
    [serverId, String(providerServiceId), action, presetId === null ? null : 'rotation_preset',
      presetId === null ? null : String(presetId), JSON.stringify(durablePlan), triggeredBy]
  );
  if (!operation) throw new Error('Failed to create rotation provider recovery record');
  for (const [filePath, originalContent] of snapshots) {
    await db.run(
      `INSERT INTO provider_mutation_files
       (mutation_id, file_path, original_exists, original_content)
       VALUES (?, ?, ?, ?)`,
      [operation.id, filePath, originalContent !== null && originalContent !== undefined,
        originalContent ?? null]
    );
  }
  return operation.id;
}

async function updatePreparedMutationStatus(db, operationId, status, errorSummary) {
  const result = await db.run(
    `UPDATE provider_mutations
     SET status = ?, error_summary = ?,
         finished_at = CASE WHEN ? = 'recovery_pending' THEN NULL ELSE NOW() END
     WHERE id = ? AND status = 'prepared'`,
    [status, errorSummary || null, status, operationId]
  );
  if (result.changes !== 1) throw new Error('Rotation provider recovery status conflict');
}

async function executeRecoverableMutation({ db, operationId, mutate }) {
  const result = await mutate();
  await updatePreparedMutationStatus(db, operationId, 'completed', null);
  const outcome = { success: true, recoveryPending: false, error: null };
  if (result !== undefined) outcome.result = result;
  return outcome;
}

/**
 * Activates a preset: applies all its snippets in order.
 * Logs the result to rotation_history.
 * Throws if any snippet fails (partial rollback is NOT automatic — caller handles recovery).
 */
async function activatePresetLocked(db, presetId, serverId, triggeredBy = 'scheduler', prepared = null) {
  const preset = prepared?.preset || await db.get(
    'SELECT * FROM rotation_presets WHERE id = ? AND server_id = ?',
    [presetId, serverId]
  );
  if (!preset) throw new Error(`Preset ${presetId} not found`);

  const credentials = prepared ? null : await getServerCredentials(db, serverId);
  const token = prepared?.token || credentials.token;
  const platformServerId = prepared?.platformServerId || credentials.platformServerId;
  const missionPath = prepared?.missionPath || await resolveMissionPath(token, platformServerId);

  const snippets = prepared?.snippets || await db.query(
    `SELECT rs.* FROM rotation_snippets rs
     JOIN rotation_preset_snippets rps ON rps.snippet_id = rs.id
     JOIN rotation_presets rp ON rp.id = rps.preset_id
     JOIN servers s ON s.id = rp.server_id
     WHERE rps.preset_id = ? AND rs.server_id = rp.server_id
     ORDER BY rps.sort_order`,
    [presetId]
  );

  console.log(`▶️  Activating preset "${preset.name}" (${snippets.length} snippets)`);
  const errors = [];

  for (const snippet of snippets) {
    try {
      switch (snippet.pattern) {
        case 'ce_folder':
          await activateCeFolder(token, platformServerId, missionPath, snippet);
          break;
        case 'cfggameplay_array':
          await activateCfgGameplayArray(token, platformServerId, missionPath, snippet);
          break;
        case 'location_bundle':
          await activateLocationBundle(token, platformServerId, missionPath, snippet);
          break;
        case 'xml_patch':
          await activateXmlPatch(token, platformServerId, missionPath, snippet);
          break;
        case 'file_swap':
          await activateFileSwap(db, token, platformServerId, missionPath, snippet, serverId);
          break;
        default:
          console.warn(`⚠️  Unknown pattern: ${snippet.pattern} for snippet ${snippet.id}`);
      }
      console.log(`  ✅ Snippet "${snippet.name}" (${snippet.pattern}) applied`);
    } catch (err) {
      console.error(`  ❌ Snippet "${snippet.name}" failed:`, err.message);
      errors.push(`${snippet.name}: ${err.message}`);
    }
  }

  const success = errors.length === 0;
  await db.run(
    `INSERT INTO rotation_history (preset_id, preset_name, server_id, action, triggered_by, result)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [presetId, preset.name, serverId, success ? 'activated' : 'failed', triggeredBy, success ? 'OK' : errors.join('; ')]
  );

  if (!success) throw new Error(`Preset activation had errors: ${errors.join('; ')}`);

  await db.run('UPDATE rotation_presets SET active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [presetId]);
  console.log(`✅ Preset "${preset.name}" activated`);
}

/**
 * Deactivates a preset: reverses all its snippets.
 */
async function deactivatePresetLocked(db, presetId, serverId, triggeredBy = 'scheduler', prepared = null) {
  const preset = prepared?.preset || await db.get(
    'SELECT * FROM rotation_presets WHERE id = ? AND server_id = ?',
    [presetId, serverId]
  );
  if (!preset) throw new Error(`Preset ${presetId} not found`);

  const credentials = prepared ? null : await getServerCredentials(db, serverId);
  const token = prepared?.token || credentials.token;
  const platformServerId = prepared?.platformServerId || credentials.platformServerId;
  const missionPath = prepared?.missionPath || await resolveMissionPath(token, platformServerId);

  const snippets = prepared?.snippets || await db.query(
    `SELECT rs.* FROM rotation_snippets rs
     JOIN rotation_preset_snippets rps ON rps.snippet_id = rs.id
     JOIN rotation_presets rp ON rp.id = rps.preset_id
     JOIN servers s ON s.id = rp.server_id
     WHERE rps.preset_id = ? AND rs.server_id = rp.server_id
     ORDER BY rps.sort_order DESC`,  // reverse order on deactivation
    [presetId]
  );

  console.log(`⏹  Deactivating preset "${preset.name}" (${snippets.length} snippets)`);
  const errors = [];

  for (const snippet of snippets) {
    try {
      switch (snippet.pattern) {
        case 'ce_folder':
          await deactivateCeFolder(token, platformServerId, missionPath, snippet);
          break;
        case 'cfggameplay_array':
          await deactivateCfgGameplayArray(token, platformServerId, missionPath, snippet);
          break;
        case 'location_bundle':
          await deactivateLocationBundle(token, platformServerId, missionPath, snippet);
          break;
        case 'xml_patch':
          await deactivateXmlPatch(token, platformServerId, missionPath, snippet);
          break;
        case 'file_swap':
          await deactivateFileSwap(db, token, platformServerId, missionPath, snippet, serverId);
          break;
      }
      console.log(`  ✅ Snippet "${snippet.name}" (${snippet.pattern}) reversed`);
    } catch (err) {
      console.error(`  ❌ Snippet "${snippet.name}" deactivate failed:`, err.message);
      errors.push(`${snippet.name}: ${err.message}`);
    }
  }

  const success = errors.length === 0;
  await db.run(
    `INSERT INTO rotation_history (preset_id, preset_name, server_id, action, triggered_by, result)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [presetId, preset.name, serverId, success ? 'deactivated' : 'failed', triggeredBy, success ? 'OK' : errors.join('; ')]
  );

  if (!success) throw new Error(`Preset deactivation had errors: ${errors.join('; ')}`);

  await db.run('UPDATE rotation_presets SET active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [presetId]);
  console.log(`✅ Preset "${preset.name}" deactivated`);
}

/**
 * One-time setup: patches cfgeconomycore.xml to register the 6 rotation_*.xml
 * placeholder filenames. Safe to call multiple times (checks for existing entries).
 */
async function runCeSetupLocked(db, serverId, userId, prepared = null) {
  const credentials = prepared ? null : await getServerCredentials(db, serverId);
  const token = prepared?.token || credentials.token;
  const platformServerId = prepared?.platformServerId || credentials.platformServerId;
  const missionPath = prepared?.missionPath || await resolveMissionPath(token, platformServerId);

  const ceTypes = ['types', 'spawnabletypes', 'events', 'randompresets', 'globals', 'messages'];
  const coreFilePath = `${missionPath}/cfgeconomycore.xml`;

  let xml = await downloadFile(token, platformServerId, coreFilePath);
  if (!xml) throw new Error('cfgeconomycore.xml not found — is the server set up correctly?');

  let modified = false;
  for (const ceType of ceTypes) {
    const fileName = `rotation_${ceType}.xml`;
    if (xml.includes(fileName)) continue; // already registered

    // Insert before the closing </economycore> or </ce> tag
    const ceCloseMatch = xml.match(/<\/ce>/);
    const coreCloseMatch = xml.match(/<\/economycore>/);

    const insertLine = `    <file name="${fileName}" type="${ceType}"/>`;

    if (ceCloseMatch) {
      xml = xml.replace('</ce>', insertLine + '\n  </ce>');
    } else if (coreCloseMatch) {
      // No <ce> block yet — wrap in one
      xml = xml.replace('</economycore>',
        `  <ce folder="ce">\n${insertLine}\n  </ce>\n</economycore>`
      );
    } else {
      throw new Error('Could not find insertion point in cfgeconomycore.xml');
    }
    modified = true;
    console.log(`  ➕ Registered ${fileName} in cfgeconomycore.xml`);
  }

  if (modified) {
    const lastSlash = coreFilePath.lastIndexOf('/');
    await uploadFile(token, platformServerId, coreFilePath.slice(0, lastSlash), 'cfgeconomycore.xml', xml);
    console.log('📄 cfgeconomycore.xml updated with rotation placeholders');
  }

  await db.run(
    `INSERT INTO rotation_setup (server_id, ce_setup_done, ce_setup_at, setup_by)
     VALUES (?, TRUE, CURRENT_TIMESTAMP, ?)
     ON CONFLICT (server_id) DO UPDATE SET ce_setup_done = TRUE, ce_setup_at = CURRENT_TIMESTAMP, setup_by = ?`,
    [serverId, userId, userId]
  );

  return { modified, ceTypes };
}

async function markPreparedMutationAfterOuterFailure(db, operationId, error) {
  const recoveryPending = /rollback compensation failed|compensation was deferred/i.test(error.message);
  return db.transaction(async transactionDb => {
    const operation = await transactionDb.get(
      'SELECT status FROM provider_mutations WHERE id = ? FOR UPDATE',
      [operationId]
    );
    if (!operation) throw new Error('Prepared rotation mutation record is missing');
    if (operation.status !== 'prepared') return operation.status;
    const status = recoveryPending ? 'recovery_pending' : 'compensated';
    await updatePreparedMutationStatus(transactionDb, operationId, status, error.message);
    return status;
  });
}

async function runPreparedRotationMutation(db, serverId, prepare, mutate, authorize = null) {
  let outcome;
  let prepared;
  try {
    outcome = await db.transaction(async transactionDb => {
      await acquireProviderMutationLock(transactionDb, serverId);
      if (authorize) await authorize(transactionDb);
      prepared = await prepare(transactionDb);
      const journal = createFileMutationJournal(
        prepared.platformServerId,
        prepared.token,
        rawRotationFileService,
        prepared.snapshots
      );
      if (typeof transactionDb.onTransactionRollback === 'function') {
        transactionDb.onTransactionRollback(
          () => journal.rollback(),
          {
            committed: async query => {
              const result = await query(
                'SELECT status FROM provider_mutations WHERE id = $1',
                [prepared.operationId]
              );
              return result.rows?.[0]?.status === 'completed';
            },
          }
        );
      }
      return executeRecoverableMutation({
        db: transactionDb,
        operationId: prepared.operationId,
        journal,
        mutate: async () => {
          await verifyPreparedSnapshots(prepared);
          return rotationMutationStorage.run(journal, () => mutate(transactionDb, prepared));
        },
      });
    });
  } catch (error) {
    if (!prepared) throw error;
    const terminalStatus = await markPreparedMutationAfterOuterFailure(
      db, prepared.operationId, error
    );
    if (terminalStatus === 'completed') {
      return { success: true, recoveryPending: false, recoveredCommit: true };
    }
    if (terminalStatus === 'recovery_pending') {
      error.code = 'ROTATION_RECOVERY_PENDING';
      error.status = 409;
    }
    throw error;
  }

  if (!outcome.success) {
    const error = new Error(outcome.error);
    error.code = outcome.recoveryPending ? 'ROTATION_RECOVERY_PENDING' : 'ROTATION_MUTATION_FAILED';
    error.status = outcome.recoveryPending ? 409 : 502;
    throw error;
  }
  return outcome;
}

async function runPresetMutation(db, presetId, serverId, triggeredBy, action, authorize = null) {
  return runPreparedRotationMutation(
    db,
    serverId,
    transactionDb => preparePresetMutation(
      db, transactionDb, presetId, serverId, action, triggeredBy
    ),
    (transactionDb, prepared) => action === 'activate'
      ? activatePresetLocked(transactionDb, presetId, serverId, triggeredBy, prepared)
      : deactivatePresetLocked(transactionDb, presetId, serverId, triggeredBy, prepared),
    authorize
  );
}

async function activatePreset(db, presetId, serverId, triggeredBy = 'scheduler', authorize = null) {
  return runPresetMutation(db, presetId, serverId, triggeredBy, 'activate', authorize);
}

async function deactivatePreset(db, presetId, serverId, triggeredBy = 'scheduler', authorize = null) {
  return runPresetMutation(db, presetId, serverId, triggeredBy, 'deactivate', authorize);
}

async function runCeSetup(db, serverId, userId, authorize = null) {
  const triggeredBy = `user:${userId}`;
  const outcome = await runPreparedRotationMutation(
    db,
    serverId,
    transactionDb => prepareCeSetupMutation(db, transactionDb, serverId, triggeredBy),
    (transactionDb, prepared) => runCeSetupLocked(transactionDb, serverId, userId, prepared),
    authorize
  );
  return outcome.result || { modified: false, recoveredCommit: true };
}

module.exports = {
  activatePreset,
  deactivatePreset,
  runCeSetup,
  // Exposed for testing/direct use
  downloadFile,
  uploadFile,
  resolveMissionPath,
  _test: {
    collectPresetFilePaths,
    resolvePreparedFileSwapSnippets,
    assertPresetLifecycleState,
    persistPreparedMutation,
    executeRecoverableMutation,
  },
};
