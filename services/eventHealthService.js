'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { XMLParser } = require('fast-xml-parser');

const healthCache = new Map();
const healthInFlight = new Map();
const CACHE_TTL_MS = 30 * 1000;
const WORKER_TIMEOUT_MS = 30 * 1000;
const MAX_RPT_BYTES = 64 * 1024 * 1024;
const MAX_RPT_LINE_BYTES = 256 * 1024;
const MAX_MISSION_XML_BYTES = 8 * 1024 * 1024;
const MAX_MISSION_EVENTS = 512;
const MAX_POSITIONS_PER_EVENT = 4096;
const MAX_CACHE_ENTRIES = 16;
const MAX_CONCURRENT_WORKERS = 2;
const MAX_EVENT_RESULTS = 512;
const MAX_DIAGNOSTICS_PER_EVENT = 8;
const MAX_CORRELATIONS = 4096;
const MAX_EVIDENCE_TEXT_LENGTH = 512;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_GROUPS_PER_EVENT = 64;
const RPT_CLOCK_MATCH_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function parseClockMilliseconds(value) {
  const match = String(value || '').match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number((match[4] || '').padEnd(3, '0'));
  if (minutes > 59 || seconds > 59 || !Number.isFinite(milliseconds)) return null;
  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function parseRptStartMilliseconds(fileName) {
  const match = String(fileName || '').match(/_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.RPT$/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const value = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(value);
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
  ) return null;
  return value;
}

function resolveAuthoritativeRptStartMs(fileName, candidate) {
  const localClockMs = parseRptStartMilliseconds(fileName);
  const candidateMs = candidate instanceof Date
    ? candidate.getTime()
    : (typeof candidate === 'number' ? candidate : Date.parse(candidate));
  if (localClockMs === null || !Number.isFinite(candidateMs)) return null;
  const difference = candidateMs - localClockMs;
  const timezoneHours = Math.round(difference / HOUR_MS);
  return Math.abs(timezoneHours) <= 14 &&
    Math.abs(difference - timezoneHours * HOUR_MS) <= RPT_CLOCK_MATCH_MS
    ? localClockMs + timezoneHours * HOUR_MS
    : null;
}

function observation(fileName, lineNumber, clock, details = {}, sessionStartedAtMs = null) {
  const parsedStart = parseRptStartMilliseconds(fileName);
  const start = Number.isFinite(sessionStartedAtMs) ? sessionStartedAtMs : parsedStart;
  const elapsed = parseClockMilliseconds(clock);
  return {
    ...details,
    sourceFile: fileName || null,
    sourceLine: lineNumber,
    clock: clock || null,
    observedAt: start !== null && elapsed !== null
      ? new Date(start + elapsed).toISOString()
      : null,
  };
}

function normalizeEvidenceIdentifier(value) {
  const identifier = String(value || '');
  if (identifier.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`RPT evidence identifier limit of ${MAX_IDENTIFIER_LENGTH} exceeded`);
  }
  return identifier;
}

function createEvent(config = {}) {
  const groups = Array.isArray(config.groups)
    ? [...new Set(config.groups.filter(Boolean).map(normalizeEvidenceIdentifier))]
      .slice(0, MAX_GROUPS_PER_EVENT)
    : (config.group ? [normalizeEvidenceIdentifier(config.group)] : []);
  return {
    name: normalizeEvidenceIdentifier(config.name),
    group: groups[0] || null,
    groups,
    configured: Boolean(config.configured !== false),
    configurationEvidence: config.configured === false ? 'none' : 'spawn_positions_only',
    positions: Number(config.positions) || 0,
    attempts: 0,
    successfulInstances: 0,
    spawnedChildren: 0,
    refusals: 0,
    failures: 0,
    cleanupObservations: 0,
    diagnostics: [],
    lastAttempt: null,
    lastSuccess: null,
    lastRefusal: null,
    lastFailure: null,
    lastCleanup: null,
    status: config.configured === false ? 'observed' : 'positioned',
    presence: 'unknown',
  };
}

function classifyEvent(event) {
  const hasErrorDiagnostic = event.diagnostics.some(item => item.severity === 'error');
  if ((event.failures > 0 || event.refusals > 0 || hasErrorDiagnostic) && event.successfulInstances > 0) return 'degraded';
  if (event.failures > 0 || hasErrorDiagnostic) return 'error';
  if (event.successfulInstances > 0) return 'spawned';
  if (event.refusals > 0) return 'warning';
  if (event.attempts > 0) return 'attempted';
  if (event.diagnostics.length > 0) return 'warning';
  return event.configured ? 'positioned' : 'observed';
}

function parseEventHealthLines(lines, options = {}) {
  const fileName = options.fileName || null;
  const sessionStartedAtMs = resolveAuthoritativeRptStartMs(fileName, options.sessionStartedAtMs);
  const makeObservation = (lineNumber, clock, details = {}) => observation(
    fileName,
    lineNumber,
    clock,
    details,
    sessionStartedAtMs
  );
  const eventMap = new Map();
  const groupToEvents = new Map();
  for (const config of options.configuredEvents || []) {
    if (!config || !config.name) continue;
    if (eventMap.size >= MAX_EVENT_RESULTS) {
      throw new Error(`RPT event limit of ${MAX_EVENT_RESULTS} exceeded`);
    }
    const event = createEvent(config);
    eventMap.set(event.name, event);
    for (const group of event.groups) {
      const names = groupToEvents.get(group) || [];
      names.push(event.name);
      groupToEvents.set(group, names);
    }
  }

  const getEvent = name => {
    if (!eventMap.has(name)) {
      if (eventMap.size >= MAX_EVENT_RESULTS) {
        throw new Error(`RPT event limit of ${MAX_EVENT_RESULTS} exceeded`);
      }
      eventMap.set(name, createEvent({ name, configured: false }));
    }
    return eventMap.get(name);
  };
  const addDiagnostic = (event, diagnostic) => {
    event.diagnostics.push(diagnostic);
    if (event.diagnostics.length > MAX_DIAGNOSTICS_PER_EVENT) event.diagnostics.shift();
  };
  const correlations = new Map();
  let latestAttempt = null;
  let initializingDone = false;
  let initSequenceFinished = false;

  const attemptPattern = /^\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)\s+\[CE\]\[DE\]\s+\[([^\]]+)\]\s+Spawning:\s+EventID:\[(\d+)\]\s+CurrentID:\[(\d+)\]\s+at\s+\[(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]\s+a:\s*(-?[\d.]+)/i;
  const spawnedPattern = /^\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)\s+\(?(?:child|group)\)?\s+Spawned\s+(\S+)\s+EventID:\[(\d+)\]\s+CurrentID:\[(\d+)\]\s+at\s+\[(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/i;
  const failurePattern = /^\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)\s+!!!\s+\[CE\]\[[^\]]*Respawner\].*Respawning:\s*"([^"]+)"\s*-\s*Failed to spawn the requested amount\s*\((\d+)\s*<\s*(\d+)\)\s*within\s*(\d+)\s*attempts/i;
  const cleanupPattern = /^\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)\s+<cleanup>\s+(?:Depleted|Remove):"([^"]+)"\s+at\s+\[(\d+),(\d+)\].*\bDE="([^"]+)"/i;
  const groupDiagnosticPattern = /^\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)\s+!!!\s+\[CE\]\[DE\]\[GROUPS\]\s+\(([^)]+)\).*\[(WARNING|ERROR)\]\s*::\s*(.*)$/i;
  const eventDiagnosticPattern = /^\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)\s+!!!\s+\[CE\]\[DE\]\s+\[([^\]]+)\].*\b(WARNING|ERROR)\b[:\s-]*(.*)$/i;

  let lineNumber = 0;
  for (const line of lines) {
    lineNumber += 1;
    if (latestAttempt && lineNumber > latestAttempt.lineNumber + 1) latestAttempt = null;
    if (line.includes('Initializing of spawners done')) initializingDone = true;
    if (line.includes('Init sequence finished')) initSequenceFinished = true;

    let match = line.match(attemptPattern);
    if (match) {
      const [, clock, name, eventId, currentId, x, y, z, angle] = match;
      const event = getEvent(name);
      event.attempts += 1;
      event.lastAttempt = makeObservation(lineNumber, clock, {
        eventId: Number(eventId), currentId: Number(currentId),
        x: Number(x), y: Number(y), z: Number(z), angle: Number(angle),
      });
      latestAttempt = { name: event.name, correlation: `${eventId}:${currentId}`, lineNumber };
      correlations.set(latestAttempt.correlation, { name: event.name, successful: false });
      while (correlations.size > MAX_CORRELATIONS) correlations.delete(correlations.keys().next().value);
      continue;
    }

    match = line.match(spawnedPattern);
    if (match) {
      const [, clock, itemClass, eventId, currentId, x, y, z] = match;
      const correlated = correlations.get(`${eventId}:${currentId}`);
      if (!correlated) continue;
      const event = getEvent(correlated.name);
      event.spawnedChildren += 1;
      if (!correlated.successful) {
        event.successfulInstances += 1;
        correlated.successful = true;
      }
      event.lastSuccess = makeObservation(lineNumber, clock, {
        eventId: Number(eventId), currentId: Number(currentId),
        itemClass: itemClass.slice(0, MAX_EVIDENCE_TEXT_LENGTH),
        x: Number(x), y: Number(y), z: Number(z),
      });
      latestAttempt = null;
      continue;
    }

    match = line.match(failurePattern);
    if (match) {
      const [, clock, name, spawned, requested, attempts] = match;
      const event = getEvent(name);
      event.failures += 1;
      event.lastFailure = makeObservation(lineNumber, clock, {
        spawned: Number(spawned), requested: Number(requested), attempts: Number(attempts),
        message: 'Failed to spawn the requested amount',
      });
      latestAttempt = null;
      continue;
    }

    if (/spawn refused/i.test(line) && latestAttempt) {
      const event = getEvent(latestAttempt.name);
      const refusalClock = line.match(/^\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/)?.[1] || null;
      event.refusals += 1;
      event.lastRefusal = makeObservation(lineNumber, refusalClock, {
        message: line.trim().slice(0, MAX_EVIDENCE_TEXT_LENGTH),
      });
      latestAttempt = null;
      continue;
    }

    match = line.match(cleanupPattern);
    if (match) {
      const [, clock, itemClass, x, z, name] = match;
      const event = getEvent(name);
      event.cleanupObservations += 1;
      event.lastCleanup = makeObservation(lineNumber, clock, {
        itemClass: itemClass.slice(0, MAX_EVIDENCE_TEXT_LENGTH),
        x: Number(x),
        z: Number(z),
      });
      continue;
    }

    match = line.match(groupDiagnosticPattern);
    if (match) {
      const [, clock, group, severity, message] = match;
      for (const name of groupToEvents.get(group) || []) {
        addDiagnostic(getEvent(name), makeObservation(lineNumber, clock, {
          severity: severity.toLowerCase(),
          message: message.trim().slice(0, MAX_EVIDENCE_TEXT_LENGTH),
          group: group.slice(0, MAX_EVIDENCE_TEXT_LENGTH),
        }));
      }
      continue;
    }

    match = line.match(eventDiagnosticPattern);
    if (match) {
      const [, clock, name, severity, message] = match;
      addDiagnostic(getEvent(name), makeObservation(lineNumber, clock, {
        severity: severity.toLowerCase(),
        message: message.trim().slice(0, MAX_EVIDENCE_TEXT_LENGTH),
      }));
    }
  }

  const events = [...eventMap.values()]
    .map(event => ({ ...event, status: classifyEvent(event) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    sourceFile: fileName,
    startupComplete: initializingDone && initSequenceFinished,
    initialization: { spawnersDone: initializingDone, initSequenceFinished },
    events,
  };
}

function parseEventHealthText(text, options = {}) {
  return parseEventHealthLines(String(text || '').split(/\r?\n/), options);
}

function regularFileStat(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

function readVerifiedRegularFile(filePath, expectedStat, expectedRoot) {
  if (!expectedStat) throw new Error('Mission configuration changed before reading');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino ||
        stat.size !== expectedStat.size) {
      throw new Error('Mission configuration changed before reading');
    }
    const descriptorPath = fs.realpathSync(`/proc/self/fd/${fd}`);
    if (descriptorPath !== expectedRoot && !descriptorPath.startsWith(expectedRoot + path.sep)) {
      throw new Error('Mission configuration resolved outside the server download directory');
    }
    if (stat.size > MAX_MISSION_XML_BYTES) {
      throw new Error(`Mission configuration exceeds the ${MAX_MISSION_XML_BYTES} byte limit`);
    }
    const buffer = Buffer.allocUnsafe(stat.size);
    let position = 0;
    while (position < expectedStat.size) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        position,
        expectedStat.size - position,
        position
      );
      if (bytesRead === 0) throw new Error('Mission configuration changed before reading');
      position += bytesRead;
    }
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function assertSafeServerPath(serverPath) {
  const resolvedPath = path.resolve(serverPath);
  let stat;
  let realPath;
  try {
    stat = fs.lstatSync(resolvedPath);
    realPath = fs.realpathSync(resolvedPath);
  } catch {
    throw new Error('Unsafe server download directory');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realPath !== resolvedPath) {
    throw new Error('Unsafe server download directory');
  }
  return resolvedPath;
}

function findMissionEventSpawns(serverPath, mapName, missionSubdirs) {
  const roots = [serverPath, ...missionSubdirs.map(directory => path.join(serverPath, directory))];
  const candidates = [];
  for (const root of roots) {
    let entries;
    try {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const match = entry.name.match(/\.([a-z0-9]+)$/i);
      if (!match || match[1].toLowerCase() !== mapName) continue;
      const candidate = path.join(root, entry.name, 'cfgeventspawns.xml');
      if (regularFileStat(candidate)) candidates.push(candidate);
    }
  }
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length > 1) {
    return {
      filePath: null,
      error: `Multiple mission configurations match map ${mapName}; spawn-position evidence is omitted.`,
    };
  }
  return { filePath: uniqueCandidates[0] || null, error: null };
}

function readMissionEventEntries(filePath, expectedStat, expectedRoot) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(readVerifiedRegularFile(filePath, expectedStat, expectedRoot));
  const rawEvents = parsed?.eventposdef?.event;
  const events = Array.isArray(rawEvents) ? rawEvents : (rawEvents ? [rawEvents] : []);
  if (events.length > MAX_MISSION_EVENTS) {
    throw new Error(`Mission configuration event limit of ${MAX_MISSION_EVENTS} exceeded`);
  }
  for (const event of events) {
    const positions = Array.isArray(event?.pos) ? event.pos : (event?.pos ? [event.pos] : []);
    if (positions.length > MAX_POSITIONS_PER_EVENT) {
      throw new Error(`Mission configuration position limit of ${MAX_POSITIONS_PER_EVENT} exceeded`);
    }
  }
  return events;
}

function readConfiguredEvents(filePath, expectedStat, expectedRoot) {
  if (!filePath) return [];
  const events = readMissionEventEntries(filePath, expectedStat, expectedRoot);
  return events.filter(event => event && event['@_name']).map(event => {
    const positionEntries = Array.isArray(event.pos) ? event.pos : (event.pos ? [event.pos] : []);
    const groups = [...new Set(positionEntries
      .map(position => position && position['@_group'])
      .filter(Boolean)
      .map(String))];
    if (event['@_group']) groups.unshift(String(event['@_group']));
    const boundedGroups = [...new Set(groups)]
      .slice(0, MAX_GROUPS_PER_EVENT)
      .map(normalizeEvidenceIdentifier);
    return {
      name: normalizeEvidenceIdentifier(event['@_name']),
      group: boundedGroups[0] || null,
      groups: boundedGroups,
      positions: positionEntries.length,
      configured: true,
    };
  });
}

function getEventSpawnLocations(serverPath, requestedMapName, options = {}) {
  const mapName = String(requestedMapName || '').toLowerCase();
  if (!/^[a-z0-9]+$/.test(mapName)) throw new Error('Invalid map name');
  const safeServerPath = assertSafeServerPath(serverPath);
  const missionConfiguration = findMissionEventSpawns(
    safeServerPath,
    mapName,
    options.missionSubdirs || []
  );
  if (!missionConfiguration.filePath) {
    return {
      events: [],
      totalSpawns: 0,
      eventSpawnsFileFound: false,
      configurationError: missionConfiguration.error,
    };
  }

  const expectedStat = regularFileStat(missionConfiguration.filePath);
  const rawEvents = readMissionEventEntries(
    missionConfiguration.filePath,
    expectedStat,
    safeServerPath
  );
  const events = rawEvents
    .filter(event => event && event['@_name'])
    .map(event => {
      const rawPositions = Array.isArray(event.pos) ? event.pos : (event.pos ? [event.pos] : []);
      const positions = rawPositions.map(position => ({
        x: Number(position?.['@_x']),
        z: Number(position?.['@_z']),
        a: Number(position?.['@_a']),
      }));
      return {
        name: normalizeEvidenceIdentifier(event['@_name']),
        positions,
        count: positions.length,
      };
    });
  return {
    events,
    totalSpawns: events.reduce((sum, event) => sum + event.count, 0),
    eventSpawnsFileFound: true,
    configurationError: null,
  };
}

function findNewestRpt(serverPath) {
  const configPath = path.join(serverPath, 'config');
  let entries;
  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    entries = fs.readdirSync(configPath);
  } catch {
    return null;
  }
  return entries.filter(name => /\.RPT$/i.test(name)).map(name => {
    const fullPath = path.join(configPath, name);
    const stat = regularFileStat(fullPath);
    if (!stat) return null;
    return {
      name,
      fullPath,
      stat,
      start: parseRptStartMilliseconds(name),
    };
  }).filter(Boolean).sort((a, b) => {
    const aTime = a.start === null ? a.stat.mtimeMs : a.start;
    const bTime = b.start === null ? b.stat.mtimeMs : b.start;
    return bTime - aTime || b.name.localeCompare(a.name);
  })[0] || null;
}

function parseRptInWorker(rpt, configuredEvents, sessionStartedAtMs = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'eventHealthWorker.js'), {
      workerData: {
        filePath: rpt.fullPath,
        fileName: rpt.name,
        expectedStat: { dev: rpt.stat.dev, ino: rpt.stat.ino, size: rpt.stat.size },
        expectedRoot: rpt.expectedRoot,
        maxBytes: MAX_RPT_BYTES,
        maxLineBytes: MAX_RPT_LINE_BYTES,
        configuredEvents,
        sessionStartedAtMs,
      },
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error('RPT event-health parsing timed out'));
    }, WORKER_TIMEOUT_MS);
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    worker.once('message', finish(message => {
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    }));
    worker.once('error', finish(reject));
    worker.once('exit', code => {
      if (!settled) finish(reject)(new Error(`RPT parser worker exited without a result (code ${code})`));
    });
  });
}

async function getEventHealth(serverPath, requestedMapName, options = {}) {
  const mapName = String(requestedMapName || '').toLowerCase();
  if (!/^[a-z0-9]+$/.test(mapName)) throw new Error('Invalid map name');
  const safeServerPath = assertSafeServerPath(serverPath);
  const missionSubdirs = options.missionSubdirs || [];
  const missionConfiguration = findMissionEventSpawns(safeServerPath, mapName, missionSubdirs);
  const eventSpawnsPath = missionConfiguration.filePath;
  const eventSpawnsStat = eventSpawnsPath ? regularFileStat(eventSpawnsPath) : null;
  const configuredEvents = readConfiguredEvents(eventSpawnsPath, eventSpawnsStat, safeServerPath);
  const rpt = findNewestRpt(safeServerPath);
  const expectedSourceFile = options.expectedSourceFile
    ? path.basename(String(options.expectedSourceFile))
    : null;
  const sourceMatchesRestart = rpt && expectedSourceFile
    ? rpt.name === expectedSourceFile
    : true;
  const sessionStartedAtMs = rpt && sourceMatchesRestart
    ? resolveAuthoritativeRptStartMs(rpt.name, options.sessionStartedAt)
    : null;

  if (!rpt) {
    return {
      sourceFile: null,
      sourceUpdatedAt: null,
      chronologyVerified: false,
      startupComplete: false,
      initialization: { spawnersDone: false, initSequenceFinished: false },
      events: configuredEvents.map(createEvent),
      error: 'No retained RPT log is available for this server.',
      configurationError: missionConfiguration.error,
      presenceLimitation: 'DayZ logs do not prove that a spawned event is still present.',
      runtimeEvidenceLimitation: 'The newest retained RPT does not prove which mission/map produced it; runtime and selected-map configuration evidence are shown separately.',
    };
  }

  const signature = [
    rpt.fullPath, rpt.stat.dev, rpt.stat.ino, rpt.stat.size, rpt.stat.mtimeMs,
    eventSpawnsPath || '', eventSpawnsStat?.dev || 0, eventSpawnsStat?.ino || 0,
    eventSpawnsStat?.size || 0, eventSpawnsStat?.mtimeMs || 0,
    missionConfiguration.error || '', sessionStartedAtMs || 0,
  ].join(':');
  const cacheKey = `${safeServerPath}:${signature}`;
  const cached = healthCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  if (healthInFlight.has(cacheKey)) return healthInFlight.get(cacheKey);
  if (rpt.stat.size > MAX_RPT_BYTES) {
    throw new Error(`Newest retained RPT exceeds the ${MAX_RPT_BYTES} byte event-health limit`);
  }
  if (healthInFlight.size >= MAX_CONCURRENT_WORKERS) {
    throw new Error('Event health parsing is busy; retry shortly');
  }

  rpt.expectedRoot = safeServerPath;

  const pending = parseRptInWorker(rpt, configuredEvents, sessionStartedAtMs).then(result => {
    result.sourceUpdatedAt = rpt.stat.mtime.toISOString();
    result.chronologyVerified = sessionStartedAtMs !== null;
    result.eventSpawnsFileFound = Boolean(eventSpawnsPath);
    result.configurationError = missionConfiguration.error;
    result.presenceLimitation = 'DayZ logs do not prove that a spawned event is still present.';
    result.runtimeEvidenceLimitation = 'The newest retained RPT does not prove which mission/map produced it; runtime and selected-map configuration evidence are shown separately.';
    healthCache.set(cacheKey, { signature, cachedAt: Date.now(), data: result });
    while (healthCache.size > MAX_CACHE_ENTRIES) {
      healthCache.delete(healthCache.keys().next().value);
    }
    return result;
  }).finally(() => {
    healthInFlight.delete(cacheKey);
  });
  healthInFlight.set(cacheKey, pending);
  return pending;
}

module.exports = {
  parseClockMilliseconds,
  parseRptStartMilliseconds,
  parseEventHealthLines,
  parseEventHealthText,
  getEventSpawnLocations,
  getEventHealth,
};
