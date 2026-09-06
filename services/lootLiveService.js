/*
 * DayZ Dashboard — Live Loot Service
 * Copyright (C) 2026
 *
 * Parses DayZ server RPT log files for Central Economy LootRespawner events.
 * Extracts RESPAWN CANDIDATE entries (economy health) and live item spawn
 * coordinates ("Adding X at [x,z]") for admin dashboard display.
 *
 * Log file location: bin/dayzxb/config/*.RPT
 */

const path = require('path');
const fs = require('fs');
const { getGuildDownloadPath } = require('./logSyncService');

// Regex patterns for RPT log parsing
const RE_RESPAWN_CANDIDATE = /\[CE\]\[LootRespawner\].*RESPAWN CANDIDATE\]\s+(\S+)\s+missing:(\d+)\s+\[cnt:(\d+),\s*nom:(\d+),\s*min:(\d+)\]/;
const RE_ADDING_ITEM       = /^\s+Adding\s+(\S+)\s+at\s+\[(\d+),(\d+)\]/;
const RE_MAP_STORAGE       = /mpmissions\\dayzOffline\.(\w+)\\/;
const RE_TIMESTAMP         = /^(\d+:\d+:\d+\.\d+)/;

// Simple in-memory cache per exact server/map context.
const liveCache = {};

function getLogDir(guildDiscordId, serverId) {
  return path.join(getGuildDownloadPath(guildDiscordId, serverId), 'config');
}

// ─── RPT File Discovery ───────────────────────────────────────────────────────

/**
 * List all RPT files in the log directory, sorted newest first.
 */
function listRptFiles(logDir) {
  if (!fs.existsSync(logDir)) return [];
  return fs
    .readdirSync(logDir)
    .filter(f => f.endsWith('.RPT'))
    .map(f => ({ name: f, fullPath: path.join(logDir, f) }))
    .sort((a, b) => {
      // Sort by filename (which contains timestamp) descending
      return b.name.localeCompare(a.name);
    });
}

/**
 * Detect which DayZ map a RPT file covers by scanning its header lines
 * for a storage path reference (e.g. "dayzOffline.chernarusplus").
 *
 * Returns the map name (e.g. "chernarusplus") or null if not found.
 */
function detectMapFromRpt(filePath) {
  try {
    // Read first 200 lines to find the storage path
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16384); // 16KB should cover the header
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);

    const header = buffer.slice(0, bytesRead).toString('utf8');
    const match = RE_MAP_STORAGE.exec(header);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Find the most recent RPT file for a given map name.
 * Checks files newest-first and returns the first one matching the map.
 */
function findLatestRptForMap(mapName, logDir) {
  const files = listRptFiles(logDir);
  for (const { fullPath } of files) {
    const detectedMap = detectMapFromRpt(fullPath);
    if (detectedMap === mapName) return fullPath;
  }
  // Fallback: return the latest RPT file if map detection fails
  return files.length > 0 ? files[0].fullPath : null;
}

// ─── RPT Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a full RPT file and extract:
 *   - candidates: items below their nominal count (RESPAWN CANDIDATE entries)
 *   - recentAdds: "Adding X at [x,z]" entries (up to maxAdds most recent)
 *   - summary: overall CE statistics from the initial respawner log line
 *
 * This reads the file in chunks to avoid loading 13MB+ files entirely into memory.
 */
function parseRptFile(filePath, maxAdds = 1000) {
  const candidates = {};
  const allAdds = [];
  let lastCandidate = null;
  let summary = null;

  // Buffer for incomplete lines across chunks
  let remainder = '';
  const CHUNK = 65536; // 64KB per read
  let offset = 0;
  let fd;

  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    while (offset < fileSize) {
      const buf = Buffer.alloc(CHUNK);
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK, offset);
      offset += bytesRead;

      const chunk = remainder + buf.slice(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      remainder = lines.pop(); // Keep incomplete last line for next iteration

      for (const line of lines) {
        // Check for RESPAWN CANDIDATE
        const candidateMatch = RE_RESPAWN_CANDIDATE.exec(line);
        if (candidateMatch) {
          const [, item, missing, cnt, nom, min] = candidateMatch;
          lastCandidate = item;
          candidates[item] = {
            item,
            missing:  parseInt(missing, 10),
            current:  parseInt(cnt, 10),
            nominal:  parseInt(nom, 10),
            min:      parseInt(min, 10),
            healthPct: Math.round((parseInt(cnt, 10) / Math.max(parseInt(nom, 10), 1)) * 100),
          };
          continue;
        }

        // Check for "Adding X at [x,z]" — these follow a RESPAWN CANDIDATE
        const addMatch = RE_ADDING_ITEM.exec(line);
        if (addMatch) {
          const [, item, xStr, zStr] = addMatch;
          const tsMatch = RE_TIMESTAMP.exec(line);
          allAdds.push({
            item: lastCandidate || item,
            x: parseInt(xStr, 10),
            z: parseInt(zStr, 10),
            timestamp: tsMatch ? tsMatch[1] : null,
          });
          continue;
        }

        // Capture initial CE summary (spawned:X, Nominal:Y, Total:Z)
        if (!summary) {
          const sumMatch = /LootRespawner.*Initially.*Nominal:(\d+).*Total in Map:\s*(\d+)/.exec(line);
          if (sumMatch) {
            summary = {
              nominal: parseInt(sumMatch[1], 10),
              totalInMap: parseInt(sumMatch[2], 10),
            };
          }
        }
      }
    }

    // Process any remaining buffered content
    if (remainder.trim()) {
      const candidateMatch = RE_RESPAWN_CANDIDATE.exec(remainder);
      if (candidateMatch) {
        const [, item, missing, cnt, nom, min] = candidateMatch;
        candidates[item] = {
          item,
          missing:  parseInt(missing, 10),
          current:  parseInt(cnt, 10),
          nominal:  parseInt(nom, 10),
          min:      parseInt(min, 10),
          healthPct: Math.round((parseInt(cnt, 10) / Math.max(parseInt(nom, 10), 1)) * 100),
        };
      }
    }
  } catch (err) {
    // Return empty if file can't be read
    return { candidates: [], recentAdds: [], summary: null, error: err.message };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  // Return only the most recent spawn events (tail of allAdds)
  const recentAdds = allAdds.slice(-maxAdds);

  return {
    candidates: Object.values(candidates).sort((a, b) => b.missing - a.missing),
    recentAdds,
    summary,
  };
}

// ─── Economy Health ───────────────────────────────────────────────────────────

/**
 * Compute aggregate economy health from parsed RPT data.
 */
function computeEconomyHealth(parsedData) {
  const { summary, candidates } = parsedData;

  if (summary) {
    return {
      nominal:     summary.nominal,
      totalInMap:  summary.totalInMap,
      healthPct:   Math.round((summary.totalInMap / Math.max(summary.nominal, 1)) * 100),
      itemsBelowNominal: candidates.length,
    };
  }

  // Fallback: compute from candidates if no summary line found
  const totalNominal = candidates.reduce((s, c) => s + c.nominal, 0);
  const totalCurrent = candidates.reduce((s, c) => s + c.current, 0);
  return {
    nominal:     totalNominal,
    totalInMap:  totalCurrent,
    healthPct:   totalNominal > 0 ? Math.round((totalCurrent / totalNominal) * 100) : 100,
    itemsBelowNominal: candidates.length,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get live loot data for a specific map.
 * Reads and parses the latest RPT log that corresponds to that map.
 * Results are cached until the RPT file changes (mtime check).
 *
 * @param {string} mapName - e.g. "chernarusplus", "enoch", "sakhal"
 * @returns {{ candidates, recentAdds, economyHealth, lastUpdated, rptFile, error? }}
 */
async function getLiveSpawns(mapName, guildDiscordId, serverId) {
  const logDir = getLogDir(guildDiscordId, serverId);
  const rptPath = findLatestRptForMap(mapName, logDir);

  if (!rptPath) {
    return {
      candidates: [],
      recentAdds: [],
      economyHealth: null,
      lastUpdated: null,
      rptFile: null,
      error: 'No RPT log file found for this map.',
    };
  }

  // Cache invalidation by mtime
  let currentMtime = 0;
  try { currentMtime = fs.statSync(rptPath).mtimeMs; } catch { /* ignore */ }

  const cacheKey = `${guildDiscordId}:${serverId}:${mapName}`;
  const cached = liveCache[cacheKey];
  if (cached && cached.rptPath === rptPath && cached.mtime === currentMtime) {
    return cached.data;
  }

  // Parse the RPT file
  const parsed = parseRptFile(rptPath);
  const economyHealth = computeEconomyHealth(parsed);

  const result = {
    candidates:    parsed.candidates,
    recentAdds:    parsed.recentAdds,
    economyHealth,
    lastUpdated:   new Date().toISOString(),
    rptFile:       path.basename(rptPath),
    error:         parsed.error || null,
  };

  liveCache[cacheKey] = { rptPath, mtime: currentMtime, data: result };
  return result;
}

/**
 * List all RPT files with their detected maps and timestamps.
 * Useful for the admin UI to know what data is available.
 */
function listAvailableLogs(guildDiscordId, serverId) {
  return listRptFiles(getLogDir(guildDiscordId, serverId)).slice(0, 20).map(({ name, fullPath }) => ({
    file: name,
    map:  detectMapFromRpt(fullPath),
    size: (() => { try { return fs.statSync(fullPath).size; } catch { return 0; } })(),
    mtime: (() => { try { return fs.statSync(fullPath).mtime; } catch { return null; } })(),
  }));
}

module.exports = {
  getLiveSpawns,
  listAvailableLogs,
};
