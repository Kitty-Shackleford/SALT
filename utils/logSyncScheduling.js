'use strict';

function buildScheduledLogSyncPlan(settings = {}) {
  const serverIds = Array.from(new Set(
    (Array.isArray(settings.servers) ? settings.servers : [])
      .map(serverId => String(serverId).trim())
      .filter(Boolean)
  ));
  return { serverIds, parseAfterSync: settings.autoScan === true };
}

function scheduledLogSyncDue(settings = {}, nowMs = Date.now()) {
  const intervalMinutes = Number(settings.interval || 15);
  const intervalMs = (Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 15) * 60 * 1000;
  const timestamps = [settings.lastRun, settings.lastAttempt]
    .map(value => value ? Date.parse(value) : NaN)
    .filter(Number.isFinite);
  if (timestamps.length === 0) return true;
  return Number(nowMs) - Math.max(...timestamps) >= intervalMs;
}

function isLogSyncRunSuccessful({
  syncErrors = [],
  parseErrors = [],
  requiredParseCount = 0,
  parsedCount = 0,
} = {}) {
  return syncErrors.length === 0 && parseErrors.length === 0 && parsedCount === requiredParseCount;
}

function hasUnparsedLogFiles(lastSyncAt, logMtimeValues = []) {
  if (!lastSyncAt) return true;
  const checkpointMs = new Date(lastSyncAt).getTime();
  if (!Number.isFinite(checkpointMs)) return true;
  return logMtimeValues.some(value => Number.isFinite(Number(value)) && Number(value) > checkpointMs);
}

function filterServerIdsWithoutSyncErrors(serverIds, failedServerIds = []) {
  const failed = new Set(Array.from(failedServerIds, String));
  return (serverIds || []).map(String).filter(serverId => !failed.has(serverId));
}

async function captureDatabaseClock(db) {
  const row = await db.get('SELECT clock_timestamp() AS observed_at');
  const observed = new Date(row?.observed_at);
  if (!Number.isFinite(observed.getTime())) {
    throw new Error('Database clock is unavailable');
  }
  return observed.toISOString();
}

async function isLogSourceObservationFresh(db, sourceObservedAt) {
  if (!sourceObservedAt) return false;
  let observationMs;
  if (typeof sourceObservedAt === 'number'
      || (typeof sourceObservedAt === 'string' && /^\d+(?:\.\d+)?$/.test(sourceObservedAt))) {
    const numeric = Number(sourceObservedAt);
    observationMs = Number.isFinite(numeric) && numeric > 0
      ? (numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric))
      : NaN;
  } else {
    observationMs = Date.parse(sourceObservedAt);
  }
  if (!Number.isFinite(observationMs)) {
    throw new Error('Log source observation time is unavailable');
  }
  const observation = new Date(observationMs);
  const validity = await db.get(
    `SELECT ?::timestamptz >= clock_timestamp() - INTERVAL '120 minutes' AS fresh,
            ?::timestamptz <= clock_timestamp() + INTERVAL '5 minutes' AS plausible`,
    [observation.toISOString(), observation.toISOString()]
  );
  if (!validity?.plausible) {
    throw new Error('Log source observation time is implausible');
  }
  return validity.fresh === true;
}

async function markServerLogParseSuccessful(
  db,
  serverId,
  sourceObservedThrough,
  { lifecycleEvidenceReady = false } = {}
) {
  if (!Number.isSafeInteger(serverId) || serverId <= 0) {
    throw new Error('A valid internal server ID is required');
  }
  if (typeof lifecycleEvidenceReady !== 'boolean') {
    throw new Error('Lifecycle evidence readiness must be explicit');
  }
  const watermark = new Date(sourceObservedThrough);
  if (!Number.isFinite(watermark.getTime())) {
    throw new Error('A valid source-observed-through timestamp is required');
  }
  await db.run(
    `UPDATE servers
     SET last_sync_at = CURRENT_TIMESTAMP,
         log_parse_watermark_at = CASE WHEN ? THEN GREATEST(
           COALESCE(log_parse_watermark_at, '-infinity'::timestamptz), ?::timestamptz)
         ELSE log_parse_watermark_at END
     WHERE id = ?`,
    [lifecycleEvidenceReady, watermark.toISOString(), serverId]
  );
}

async function selectServerIdsToParse(serverIds, changedServerIds, needsLogParse) {
  const changed = new Set((changedServerIds || []).map(String));
  const selected = [];
  for (const serverId of serverIds || []) {
    const canonicalId = String(serverId);
    if (changed.has(canonicalId) || await needsLogParse(canonicalId)) {
      selected.push(canonicalId);
    }
  }
  return selected;
}

module.exports = {
  buildScheduledLogSyncPlan,
  captureDatabaseClock,
  filterServerIdsWithoutSyncErrors,
  hasUnparsedLogFiles,
  isLogSourceObservationFresh,
  isLogSyncRunSuccessful,
  markServerLogParseSuccessful,
  scheduledLogSyncDue,
  selectServerIdsToParse,
};
