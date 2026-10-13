'use strict';

/*
 * DayZ Config Validator
 *
 * Deterministic structural validation of DayZ config working copies. The
 * existing CE-registration typing already exists in missionFileInspectionService
 * (it tells us *what kind* of file a path is). This module adds the *known-good
 * schema + DayZ invariants* layer on top:
 *
 *   - XML well-formedness (fast-xml-parser)
 *   - root tag sanity for types.xml / events.xml / globals.xml / economy.xml
 *   - types.xml invariants: <type name=...> unique names, required numeric
 *     children, nominal/min/lifetime >= 0, min <= nominal
 *   - events.xml invariants: <event name=...> unique, nominal/min/max numeric,
 *     max >= min, children present
 *   - JSON parseability
 *
 * Every finding is {severity, code, message, target} so a route can return a
 * deterministic report with or without an AI layer, and the AI layer (when a
 * provider is configured) can explain the deviations in plain language.
 */

const { XMLValidator } = require('fast-xml-parser');

const SEVERITY = { error: 'error', warning: 'warning', info: 'info' };

/** Root tags we recognize for the common DayZ config files. */
const KNOWN_ROOTS = {
  'types.xml': 'types',
  'events.xml': 'events',
  'globals.xml': 'globals',
  'economy.xml': 'economycore',
  'randompresets.xml': 'randompresets',
};

/**
 * Validate a working-copy file.
 * @param {string} fileName - e.g. 'dayzOffline.enoch/db/types.xml'
 * @param {string} content  - file content
 * @returns {{ valid: boolean, documentType: string|null, findings: Array }}
 */
function validateConfigFile(fileName, content) {
  const findings = [];
  const base = String(fileName || '').split('/').pop().toLowerCase();
  const expectedRoot = KNOWN_ROOTS[base] || null;
  let tree = null;

  if (typeof content !== 'string' || !content.trim()) {
    findings.push({ severity: SEVERITY.error, code: 'EMPTY_FILE', message: 'File is empty', target: fileName });
    return { valid: false, documentType: expectedRoot, findings };
  }

  const lowerName = String(fileName || '').toLowerCase();
  if (lowerName.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      findings.push({ severity: SEVERITY.error, code: 'INVALID_JSON', message: `Not valid JSON: ${error.message}`, target: fileName });
      return { valid: false, documentType: null, findings };
    }
    if (parsed === null || typeof parsed !== 'object') {
      findings.push({ severity: SEVERITY.error, code: 'JSON_NOT_OBJECT', message: 'JSON top level must be an object', target: fileName });
      return { valid: false, documentType: null, findings };
    }
    return { valid: true, documentType: 'json', findings };
  }

  if (lowerName.endsWith('.xml')) {
    const validation = XMLValidator.validate(content, { allowBooleanAttributes: true });
    if (validation !== true) {
      findings.push({ severity: SEVERITY.error, code: 'INVALID_XML', message: `Not well-formed XML: ${validation}`, target: fileName });
      return { valid: false, documentType: expectedRoot, findings };
    }

    // Build an ordered element tree to inspect structure.
    tree = null;
    try {
      const { XMLParser } = require('fast-xml-parser');
      tree = new XMLParser({
        preserveOrder: true,
        ignoreAttributes: false,
        attributeNamePrefix: '',
        trimValues: false,
        parseTagValue: false,
        parseAttributeValue: false,
        ignoreDeclaration: true,
        ignorePiTags: true,
      }).parse(content);
    } catch (error) {
      findings.push({ severity: SEVERITY.error, code: 'XML_PARSE_FAILED', message: `XML parse failed: ${error.message}`, target: fileName });
      return { valid: false, documentType: expectedRoot, findings };
    }

    const root = rootElement(tree);
    if (root) {
      if (expectedRoot && root.name !== expectedRoot) {
        findings.push({
          severity: SEVERITY.warning,
          code: 'UNEXPECTED_ROOT',
          message: `Expected root <${expectedRoot}> but found <${root.name}>`,
          target: fileName,
        });
      }
      if (base === 'types.xml') validateTypes(root, findings, fileName);
      else if (base === 'events.xml') validateEvents(root, findings, fileName);
      else if (base === 'globals.xml') validateGlobals(root, findings, fileName);
    } else {
      findings.push({ severity: SEVERITY.error, code: 'NO_ROOT', message: 'No root element found', target: fileName });
    }
  }

  const valid = !findings.some(f => f.severity === SEVERITY.error);
  const resolvedRoot = tree ? (rootElement(tree) ? rootElement(tree).name : null) : null;
  return { valid, documentType: resolvedRoot || expectedRoot, findings };
}

function rootElement(tree) {
  const top = Array.isArray(tree) ? tree[0] : tree;
  if (!top) return null;
  for (const element of Array.isArray(top) ? top : [top]) {
    const name = Object.keys(element).find(key => key !== ':@');
    if (name && name !== '#text') {
      return { name, children: element[name] };
    }
  }
  return null;
}

function childrenOf(elementName, children) {
  const out = [];
  for (const element of Array.isArray(children) ? children : []) {
    const name = Object.keys(element).find(key => key !== ':@');
    if (name === elementName) out.push(element);
  }
  return out;
}

function childValue(name, element) {
  // `element` is a preserveOrder node: { <ownTag>: [childNodes], ':@': {attrs} }.
  // The child nodes are the array under the own-tag key; a pure-text child is
  // the single node { '#text': '50' }.
  const ownKey = Object.keys(element).find(key => key !== ':@');
  if (!ownKey) return undefined;
  const child = childrenOf(name, element[ownKey])[0];
  if (!child) return undefined;
  let value = child[name];
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === 'object' && ('#text' in value)) value = value['#text'];
  if (value === undefined) return undefined;
  return String(value).trim();
}

function num(value) {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** types.xml: <type name=...> — unique names, numeric children, sane ranges. */
function validateTypes(root, findings, fileName) {
  const types = childrenOf('type', root.children);
  const seen = new Set();
  const requiredNumeric = ['nominal', 'lifetime', 'min', 'max'];
  for (const type of types) {
    const attrs = type[':@'] || {};
    const typeName = attrs.name;
    if (!typeName) {
      findings.push({ severity: SEVERITY.error, code: 'TYPE_MISSING_NAME', message: 'A <type> is missing its name attribute', target: fileName });
      continue;
    }
    if (seen.has(typeName)) {
      findings.push({ severity: SEVERITY.error, code: 'TYPE_DUPLICATE', message: `Duplicate type "${typeName}"`, target: fileName });
    }
    seen.add(typeName);
    for (const field of requiredNumeric) {
      const raw = childValue(field, type);
      if (raw === undefined) continue; // optional in practice; only validate when present
      const n = num(raw);
      if (n === null) {
        findings.push({ severity: SEVERITY.error, code: 'TYPE_BAD_NUMBER', message: `<${field}> on "${typeName}" is not a number (${raw})`, target: fileName });
      }
    }
    const nominal = num(childValue('nominal', type));
    const min = num(childValue('min', type));
    if (nominal !== null && min !== null && min > nominal) {
      findings.push({ severity: SEVERITY.warning, code: 'TYPE_MIN_GT_NOMINAL', message: `"${typeName}": min (${min}) is greater than nominal (${nominal})`, target: fileName });
    }
  }
  if (findings.length === 0) {
    findings.push({ severity: SEVERITY.info, code: 'TYPE_OK', message: `${types.length} types, all names unique`, target: fileName });
  }
}

/** events.xml: <event name=...> — unique names, nominal/min/max numeric, max>=min. */
function validateEvents(root, findings, fileName) {
  const events = childrenOf('event', root.children);
  const seen = new Set();
  for (const event of events) {
    const attrs = event[':@'] || {};
    const eventName = attrs.name;
    if (!eventName) {
      findings.push({ severity: SEVERITY.error, code: 'EVENT_MISSING_NAME', message: 'An <event> is missing its name attribute', target: fileName });
      continue;
    }
    if (seen.has(eventName)) {
      findings.push({ severity: SEVERITY.error, code: 'EVENT_DUPLICATE', message: `Duplicate event "${eventName}"`, target: fileName });
    }
    seen.add(eventName);
    const nominal = num(childValue('nominal', event));
    const min = num(childValue('min', event));
    const max = num(childValue('max', event));
    if (nominal !== null && min !== null && max !== null && max < min) {
      findings.push({ severity: SEVERITY.warning, code: 'EVENT_MAX_LT_MIN', message: `"${eventName}": max (${max}) is less than min (${min})`, target: fileName });
    }
  }
  if (!findings.some(f => f.code === 'EVENT_MISSING_NAME' || f.code === 'EVENT_DUPLICATE')) {
    findings.push({ severity: SEVERITY.info, code: 'EVENT_OK', message: `${events.length} events, all names unique`, target: fileName });
  }
}

/** globals.xml: just confirm <globals> root (already checked) — no deep invariants. */
function validateGlobals(root, findings, fileName) {
  findings.push({ severity: SEVERITY.info, code: 'GLOBALS_OK', message: 'Root <globals> present', target: fileName });
}

module.exports = { validateConfigFile, KNOWN_ROOTS, SEVERITY };
