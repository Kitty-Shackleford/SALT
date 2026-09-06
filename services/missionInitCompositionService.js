'use strict';

const crypto = require('crypto');
const { generateTeamInitFragment } = require('./missionInitTeamService');

const STARTING_EQUIP_SIGNATURE = /^[ \t]*override[ \t\r\n]+void[ \t\r\n]+StartingEquipSetup[ \t\r\n]*\([ \t\r\n]*PlayerBase[ \t\r\n]+player[ \t\r\n]*,[ \t\r\n]*bool[ \t\r\n]+clothesChosen[ \t\r\n]*\)/gm;
const CUSTOM_MISSION_CLASS = /^[ \t]*class[ \t]+CustomMission[ \t]*:[ \t]*MissionServer[ \t]*$/gm;
const MANAGED_BEGIN_PREFIX = '// DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN';
const MANAGED_BEGIN = `${MANAGED_BEGIN_PREFIX} `;
const MANAGED_END = '// DAYZ_DASHBOARD_TEAM_CONFIG_END';
const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024;

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function markerIndexes(source, marker) {
  const indexes = [];
  let cursor = 0;
  while (cursor <= source.length) {
    const index = source.indexOf(marker, cursor);
    if (index < 0) break;
    indexes.push(index);
    cursor = index + marker.length;
  }
  return indexes;
}

function findExactManagedMarkerLines(source) {
  const beginLines = [];
  const endLines = [];
  let state = 'code';
  let lineStart = 0;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'code';
        lineStart = index + 1;
      }
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        state = 'code';
        index += 1;
      } else if (current === '\n') {
        lineStart = index + 1;
      }
      continue;
    }
    if (state === 'string' || state === 'character') {
      if (current === '\\') {
        index += 1;
      } else if ((state === 'string' && current === '"') ||
          (state === 'character' && current === "'")) {
        state = 'code';
      } else if (current === '\n') {
        lineStart = index + 1;
      }
      continue;
    }
    if (current === '/' && next === '/') {
      const lineFeed = source.indexOf('\n', index);
      const lineEnd = lineFeed < 0 ? source.length : lineFeed;
      const contentEnd = source[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
      const prefix = source.slice(lineStart, index);
      const comment = source.slice(index, contentEnd);
      if (/^[ \t]*$/.test(prefix)) {
        const beginMatch = comment.match(/^\/\/ DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN ([a-f0-9]{64})$/);
        if (beginMatch) {
          beginLines.push({
            markerIndex: index,
            start: lineStart,
            end: lineFeed < 0 ? lineEnd : lineEnd + 1,
          });
        } else if (comment === MANAGED_END) {
          endLines.push({
            markerIndex: index,
            start: lineStart,
            end: lineFeed < 0 ? lineEnd : lineEnd + 1,
          });
        }
      }
      state = 'line-comment';
      index += 1;
    } else if (current === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
    } else if (current === '"') {
      state = 'string';
    } else if (current === "'") {
      state = 'character';
    } else if (current === '\n') {
      lineStart = index + 1;
    }
  }

  return { beginLines, endLines };
}

function findMatchingBrace(source, openingBrace) {
  let depth = 0;
  let state = 'code';
  for (let index = openingBrace; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (current === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'string' || state === 'character') {
      if (current === '\\') {
        index += 1;
      } else if ((state === 'string' && current === '"') ||
          (state === 'character' && current === "'")) {
        state = 'code';
      }
      continue;
    }
    if (current === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
    } else if (current === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
    } else if (current === '"') {
      state = 'string';
    } else if (current === "'") {
      state = 'character';
    } else if (current === '{') {
      depth += 1;
    } else if (current === '}') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) break;
    }
  }
  throw new Error('StartingEquipSetup body is malformed');
}

function maskNonCode(source) {
  const masked = source.split('');
  let state = 'code';

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'code';
      } else {
        masked[index] = ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        state = 'code';
        index += 1;
      } else if (current !== '\n' && current !== '\r') {
        masked[index] = ' ';
      }
      continue;
    }
    if (state === 'string' || state === 'character') {
      if (current === '\n' || current === '\r') {
        throw new Error('Mission init source has malformed lexical structure');
      }
      masked[index] = ' ';
      if (current === '\\') {
        if (next === '\n' || next === '\r') {
          throw new Error('Mission init source has malformed lexical structure');
        }
        if (index + 1 < source.length) masked[index + 1] = ' ';
        index += 1;
      } else if ((state === 'string' && current === '"') ||
          (state === 'character' && current === "'")) {
        state = 'code';
      }
      continue;
    }
    if (current === '/' && next === '/') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      state = 'line-comment';
      index += 1;
    } else if (current === '/' && next === '*') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      state = 'block-comment';
      index += 1;
    } else if (current === '"') {
      masked[index] = ' ';
      state = 'string';
    } else if (current === "'") {
      masked[index] = ' ';
      state = 'character';
    }
  }

  if (state !== 'code' && state !== 'line-comment') {
    throw new Error('Mission init source has malformed lexical structure');
  }
  return masked.join('');
}

function assertBalancedBraces(codeOnlySource) {
  let depth = 0;
  for (const character of codeOnlySource) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth < 0) throw new Error('Mission init source has malformed brace structure');
  }
  if (depth !== 0) throw new Error('Mission init source has malformed brace structure');
}

function braceDepthBefore(codeOnlySource, endIndex, startIndex = 0) {
  let depth = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    if (codeOnlySource[index] === '{') depth += 1;
    if (codeOnlySource[index] === '}') depth -= 1;
  }
  return depth;
}

function previousActiveCharacter(codeOnlySource, startIndex, endIndex) {
  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    if (!/[ \t\r\n]/.test(codeOnlySource[index])) return codeOnlySource[index];
  }
  return '{';
}

function findStartingEquipBody(source) {
  const codeOnlySource = maskNonCode(source);
  if (codeOnlySource.includes('#')) {
    throw new Error('Mission init source with preprocessor directives requires unsupported structural evaluation');
  }
  assertBalancedBraces(codeOnlySource);

  const classMatches = Array.from(codeOnlySource.matchAll(CUSTOM_MISSION_CLASS));
  if (classMatches.length !== 1 ||
      braceDepthBefore(codeOnlySource, classMatches[0]?.index ?? 0) !== 0 ||
      !/[{};]/.test(previousActiveCharacter(codeOnlySource, 0, classMatches[0]?.index ?? 0))) {
    throw new Error('Mission init source must contain exactly one top-level CustomMission class extending MissionServer');
  }
  const classSignatureEnd = classMatches[0].index + classMatches[0][0].length;
  const classOpeningBrace = codeOnlySource.indexOf('{', classSignatureEnd);
  if (classOpeningBrace < 0 ||
      !/^[ \t\r\n]*$/.test(codeOnlySource.slice(classSignatureEnd, classOpeningBrace))) {
    throw new Error('CustomMission class body is malformed');
  }
  const classClosingBrace = findMatchingBrace(codeOnlySource, classOpeningBrace);

  const matches = Array.from(codeOnlySource.matchAll(STARTING_EQUIP_SIGNATURE));
  if (matches.length !== 1) {
    throw new Error('Mission init source must contain exactly one recognized StartingEquipSetup method');
  }
  const signatureStart = matches[0].index;
  if (signatureStart <= classOpeningBrace || signatureStart >= classClosingBrace ||
      braceDepthBefore(codeOnlySource, signatureStart, classOpeningBrace + 1) !== 0 ||
      !/[{};]/.test(previousActiveCharacter(
        codeOnlySource,
        classOpeningBrace + 1,
        signatureStart
      ))) {
    throw new Error('StartingEquipSetup must be a direct CustomMission class declaration');
  }
  const signatureEnd = signatureStart + matches[0][0].length;
  const openingBrace = codeOnlySource.indexOf('{', signatureEnd);
  if (openingBrace < 0 || openingBrace >= classClosingBrace ||
      !/^[ \t\r\n]*$/.test(codeOnlySource.slice(signatureEnd, openingBrace))) {
    throw new Error('StartingEquipSetup body is malformed');
  }
  return { openingBrace, closingBrace: findMatchingBrace(codeOnlySource, openingBrace) };
}

function composeMissionInitSource(source, fragment, options = {}) {
  if (typeof source !== 'string' || typeof fragment !== 'string') {
    throw new TypeError('Mission init source and managed fragment must be strings');
  }
  const approvedSourceHashes = options.approvedSourceHashes;
  if (!(approvedSourceHashes instanceof Set)) {
    throw new TypeError('Approved mission init source hashes are required');
  }
  const fragmentBeginIndexes = markerIndexes(fragment, MANAGED_BEGIN);
  const fragmentBeginPrefixIndexes = markerIndexes(fragment, MANAGED_BEGIN_PREFIX);
  const fragmentEndIndexes = markerIndexes(fragment, MANAGED_END);
  const fragmentFirstLine = fragment.split(/\r?\n/, 1)[0];
  if (fragmentBeginIndexes.length !== 1 || fragmentBeginPrefixIndexes.length !== 1 ||
      fragmentEndIndexes.length !== 1 || fragmentBeginIndexes[0] !== 0 ||
      fragmentBeginPrefixIndexes[0] !== 0 ||
      fragmentEndIndexes[0] <= fragmentBeginIndexes[0] ||
      !/^\/\/ DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN [a-f0-9]{64}$/.test(fragmentFirstLine) ||
      !fragment.endsWith(`${MANAGED_END}\n`)) {
    throw new Error('Managed mission init fragment is invalid');
  }
  const rawBeginIndexes = markerIndexes(source, MANAGED_BEGIN_PREFIX);
  const rawEndIndexes = markerIndexes(source, MANAGED_END);
  const hasManagedMarkerText = rawBeginIndexes.length > 0 || rawEndIndexes.length > 0;
  const { beginLines, endLines } = findExactManagedMarkerLines(source);
  const hasManagedMarkers = beginLines.length > 0 || endLines.length > 0;
  if (hasManagedMarkerText && (rawBeginIndexes.length !== 1 || rawEndIndexes.length !== 1 ||
      beginLines.length !== 1 || endLines.length !== 1 ||
      rawBeginIndexes[0] !== beginLines[0].markerIndex ||
      rawEndIndexes[0] !== endLines[0].markerIndex ||
      beginLines[0].start >= endLines[0].start)) {
    throw new Error('Existing managed mission init markers are malformed or ambiguous');
  }

  const sourceHash = hashContent(source);
  if (!approvedSourceHashes.has(sourceHash)) {
    throw new Error('Mission init source requires a recognized preimage or explicit manual review');
  }

  const { openingBrace, closingBrace } = findStartingEquipBody(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const normalizedFragment = fragment.replace(/\r?\n/g, newline);
  let mode;
  let candidate;
  if (hasManagedMarkers) {
    const managedStart = beginLines[0].start;
    const managedEnd = endLines[0].end;
    if (managedStart <= openingBrace || managedEnd > closingBrace) {
      throw new Error('Existing managed mission init block is outside StartingEquipSetup');
    }
    mode = 'replaced';
    candidate = source.slice(0, managedStart) + normalizedFragment + source.slice(managedEnd);
  } else {
    mode = 'inserted';
    candidate = source.slice(0, openingBrace + 1) + newline + normalizedFragment + source.slice(openingBrace + 1);
  }
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) {
    throw new TypeError('Mission init source limit must be a positive safe integer');
  }
  if (Buffer.byteLength(candidate, 'utf8') > maxSourceBytes) {
    throw new Error('Composed mission init source exceeds the configured source limit');
  }

  return {
    mode,
    sourceHash,
    candidateHash: hashContent(candidate),
    source: candidate,
  };
}

function previewMissionInitDeployment({
  source,
  approvedSourceHash,
  configuration,
  allowedItemClasses,
  maxFragmentBytes,
  maxSourceBytes,
}) {
  if (typeof approvedSourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(approvedSourceHash)) {
    throw new TypeError('A valid approved mission init source hash is required');
  }
  const currentSourceHash = hashContent(source);
  if (currentSourceHash !== approvedSourceHash) {
    throw new Error('Mission init source changed after manual review');
  }
  const generated = generateTeamInitFragment(configuration, {
    allowedItemClasses,
    ...(maxFragmentBytes === undefined ? {} : { maxSourceBytes: maxFragmentBytes }),
  });
  const composed = composeMissionInitSource(source, generated.source, {
    approvedSourceHashes: new Set([approvedSourceHash]),
    ...(maxSourceBytes === undefined ? {} : { maxSourceBytes }),
  });
  return {
    mode: composed.mode,
    sourceHash: composed.sourceHash,
    candidateHash: composed.candidateHash,
    configurationHash: generated.configurationHash,
    source: composed.source,
  };
}

module.exports = {
  composeMissionInitSource,
  hashContent,
  previewMissionInitDeployment,
};
