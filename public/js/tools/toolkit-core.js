/* global window */
/*
 * DayZ Toolkit — core validation engine.
 *
 * Pure, dependency-free logic shared by the client-side /tools/* pages.
 * Everything here runs in the user's browser; no network, no eval.
 *
 * UMD: in Node it exports via module.exports (used by
 * scripts/toolkit-client-test.js); in the browser it sets
 * globalThis.DayZToolkitCore.
 *
 * A "parser" is a function: parser(content) ->
 *   { ok: true,  model: Node }  |  { ok: false, error: { message, line?, column? } }
 * where Node = { tag, attrs: {name: value}, children: [Node], text: string }.
 * The browser supplies a DOMParser-backed parser (toolkit-dom.js);
 * tests supply an xml2js-backed one. Structure checks never see a DOM.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    (root || (root = window)).DayZToolkitCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Limits — mirror the server-side mission doctor (validationService)  *
   * ------------------------------------------------------------------ */
  var MAX_FILE_BYTES = 5 * 1024 * 1024;    // per file (5 MiB)
  var MAX_SCAN_BYTES = 25 * 1024 * 1024;   // total budget for a mission scan
  var MAX_DIAGNOSTICS = 200;               // per severity kind
  var MAX_LONG_LINE = 200;

  /* ------------------------------------------------------------------ *
   * DayZ world bounds — mirrors public/js/dayz-map-coordinates.js       *
   * ------------------------------------------------------------------ */
  var MAP_BOUNDS = {
    chernarusplus: 15360,
    enoch: 12800,
    sakhal: 15360,
    namalsk: 12800,
    takistanplus: 12800
  };

  /** Extract a map id from a mission folder/file name, e.g.
   *  'dayzOffline.chernarusplus' -> 'chernarusplus'. Null when unknown. */
  function mapIdFromMissionName(name) {
    if (typeof name !== 'string') return null;
    var dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    return MAP_BOUNDS[name.slice(dot + 1).toLowerCase()] !== undefined
      ? name.slice(dot + 1).toLowerCase()
      : null;
  }

  /* ------------------------------------------------------------------ *
   * Diagnostics                                                         *
   * ------------------------------------------------------------------ */
  function newDiagnostics() {
    return {
      errors: [],
      warnings: [],
      info: [],
      add: function (kind, finding) {
        if (!this[kind]) return;
        if (this[kind].length >= MAX_DIAGNOSTICS) return;
        finding.severity = kind === 'info' ? 'info' : kind;
        this[kind].push(finding);
      }
    };
  }

  function summarize(report) {
    var errorCount = report.errors.length;
    var warningCount = report.warnings.length;
    return {
      valid: errorCount === 0,
      errorCount: errorCount,
      warningCount: warningCount,
      infoCount: report.info.length,
      status: errorCount === 0 ? (warningCount === 0 ? 'excellent' : 'good') : 'invalid'
    };
  }

  /* ------------------------------------------------------------------ *
   * Number helpers (port of validationService.parseFiniteNumber)        *
   * ------------------------------------------------------------------ */
  var FINITE_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  function parseFiniteNumber(raw) {
    if (typeof raw !== 'string') return null;
    var text = raw.trim();
    if (!FINITE_NUMBER_RE.test(text)) return null;
    var value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  var CLASS_NAME_RE = /^[A-Za-z0-9_]+$/;

  /* ------------------------------------------------------------------ *
   * Known DayZ file rules                                               *
   *                                                                     *
   * Ported from services/validationService.js (server-side mission      *
   * doctor) with two deliberate extensions:                             *
   *   - uniqueName: duplicate name= attributes are an engine error for  *
   *     registry-style files (types/events/groups/cargo/attachments).   *
   *   - classNames: name values must be DayZ class identifiers.         *
   * mapgrouppos.xml is the exception: the same group name occurs once   *
   * per placement by design, so it is never uniqueness-checked.         *
   * ------------------------------------------------------------------ */
  var DAYZ_RULES = {
    'types.xml': {
      root: 'types',
      children: {
        type: {
          requiredAttrs: ['name'],
          uniqueName: true,
          classNames: true,
          numericFields: ['nominal', 'lifetime', 'restock', 'min', 'quantmin', 'quantmax', 'cost']
        }
      }
    },
    'events.xml': {
      root: 'events',
      children: { event: { requiredAttrs: ['name'], uniqueName: true, classNames: true } }
    },
    'cfgeventspawns.xml': {
      root: 'eventposdef',
      children: {
        event: { requiredAttrs: ['name'], uniqueName: true, classNames: true, coordChild: 'pos' }
      }
    },
    'cfgeventgroups.xml': {
      root: 'eventgroupdef',
      children: {
        group: { requiredAttrs: ['name'], uniqueName: true, classNames: true, lootChild: 'child' }
      }
    },
    'cfgweather.xml': { root: 'weather' },
    'cfgenvironment.xml': { root: 'env' },
    'cfgplayerspawnpoints.xml': { root: 'playerspawnpoints' },
    'cfgrandompresets.xml': {
      root: 'randompresets',
      children: {
        cargo: { requiredAttrs: ['name'], uniqueName: true },
        attachments: { requiredAttrs: ['name'], uniqueName: true },
        item: { requiredAttrs: ['name'] }
      }
    },
    'globals.xml': {
      root: 'variables',
      children: {
        var: {
          requiredAttrs: ['name', 'type', 'value'],
          dayzVarTypes: ['0', '1', '2', '3', '4']
        }
      }
    },
    'cfgspawnabletypes.xml': {
      root: 'spawnabletypes',
      children: { type: { requiredAttrs: ['name'], uniqueName: true, classNames: true } }
    },
    'mapgroupproto.xml': {
      root: 'prototype',
      children: {
        group: { requiredAttrs: ['name'], uniqueName: true, classNames: true },
        container: { requiredAttrs: ['name'], uniqueName: true, classNames: true }
      }
    },
    'mapgrouppos.xml': {
      root: 'map',
      children: { group: { requiredAttrs: ['name'], classNames: true } }
    },
    'messages.xml': { root: 'messages', children: { message: {} } }
  };

  /** Resolve the rules key for a file basename (case-insensitive). */
  function classify(fileName) {
    var basename = typeof fileName === 'string'
      ? fileName.split(/[\\/]/).pop().toLowerCase()
      : '';
    for (var key in DAYZ_RULES) {
      if (Object.prototype.hasOwnProperty.call(DAYZ_RULES, key) && key === basename) return key;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * XML structural validation (operates on the normalized model)        *
   * ------------------------------------------------------------------ */
  function checkXmlStructure(fileName, model, diags, documentType) {
    var rules = (documentType && classify(documentType)) ? DAYZ_RULES[classify(documentType)]
      : (classify(fileName) ? DAYZ_RULES[classify(fileName)] : null);
    if (!model || !model.tag) {
      diags.add('errors', { code: 'NO_ROOT', message: 'No root element found' });
      return { supportLevel: 'basic' };
    }

    if (!rules) {
      diags.add('info', {
        code: 'NO_RULES',
        message: 'No DayZ rules for "' + model.tag + '" — syntax-only check performed'
      });
      return { supportLevel: 'syntax-only' };
    }

    if (rules.root && model.tag !== rules.root) {
      diags.add('errors', {
        code: 'WRONG_ROOT',
        message: 'Expected root element <' + rules.root + '>, found <' + model.tag + '>'
      });
      return { supportLevel: 'basic' };
    }
    diags.add('info', { code: 'ROOT_OK', message: 'Root element <' + model.tag + '> is correct' });

    var names = {}; // per child tag: name -> count (for uniqueName)
    var rootChildren = model.children || [];

    for (var ci = 0; ci < rootChildren.length; ci++) {
      var child = rootChildren[ci];
      var childRule = rules.children && rules.children[child.tag];
      if (!childRule) continue;
      checkChildNode(child, childRule, childRule === rules.children.type && rules.root === 'types',
        names, diags, ci);
    }
    return { supportLevel: 'basic' };
  }

  function checkChildNode(child, rule, isCeType, names, diags, index) {
    var childTag = child.tag;
    var attrs = child.attrs || {};

    (rule.requiredAttrs || []).forEach(function (attrName) {
      if (typeof attrs[attrName] !== 'string' || !attrs[attrName].trim()) {
        diags.add('errors', {
          code: 'MISSING_ATTRIBUTE',
          element: childTag,
          attribute: attrName,
          message: '<' + childTag + '> #' + (index + 1) + ' missing required attribute: ' + attrName
        });
      }
    });

    var name = attrs.name;
    if (typeof name === 'string' && name.trim()) {
      if (rule.classNames && !CLASS_NAME_RE.test(name)) {
        diags.add('errors', {
          code: 'BAD_CLASS_NAME',
          element: childTag,
          message: '<' + childTag + '> "' + name + '" is not a valid DayZ class name (letters, digits, underscore)'
        });
      }
      if (rule.uniqueName) {
        var key = childTag + '::' + name;
        if (Object.prototype.hasOwnProperty.call(names, key)) {
          names[key]++;
          diags.add('errors', {
            code: 'DUPLICATE_NAME',
            element: childTag,
            message: 'Duplicate <' + childTag + ' name="' + name + '"> (occurrence ' + names[key] + ')'
          });
        } else {
          names[key] = 1;
        }
      }
    }

    // CE types.xml numeric settings are text CHILD elements, not attributes.
    if (isCeType) {
      var values = {};
      (rule.numericFields || []).forEach(function (field) {
        (child.children || []).forEach(function (sub) {
          if (sub.tag !== field) return;
          var value = parseFiniteNumber(sub.text);
          if (value === null) {
            diags.add('errors', {
              code: 'INVALID_NUMBER',
              element: childTag,
              field: field,
              message: '<' + childTag + '> "' + name + '" has invalid <' + field + '> (must be a complete finite number)'
            });
            return;
          }
          values[field] = value;
          if (value < 0 && !(field === 'quantmin' || field === 'quantmax') && value !== -1) {
            diags.add('warnings', {
              code: 'NEGATIVE_VALUE',
              element: childTag,
              message: '<' + childTag + '> "' + name + '" has negative <' + field + '>: ' + value
            });
          }
        });
      });
      if (values.nominal > 0 && values.min > values.nominal) {
        diags.add('warnings', {
          code: 'MIN_GREATER_THAN_NOMINAL',
          element: childTag,
          message: '<type> "' + name + '": min (' + values.min + ') is greater than nominal (' + values.nominal + ')'
        });
      }
      if (values.quantmin !== undefined && values.quantmax !== undefined &&
          values.quantmin !== -1 && values.quantmax !== -1 && values.quantmin > values.quantmax) {
        diags.add('warnings', {
          code: 'QUANTMIN_GREATER_THAN_QUANTMAX',
          element: childTag,
          message: '<type> "' + name + '": quantmin (' + values.quantmin + ') is greater than quantmax (' + values.quantmax + ')'
        });
      }
    }

    // Event spawn positions (cfgeventspawns.xml): <pos x z a>
    if (rule.coordChild) {
      var positions = (child.children || []).filter(function (sub) { return sub.tag === rule.coordChild; });
      if (positions.length === 0) {
        diags.add('warnings', {
          code: 'NO_POSITIONS',
          element: childTag,
          message: '<' + childTag + '> "' + name + '" has no <' + rule.coordChild + '> entries'
        });
      }
      positions.forEach(function (pos, posIndex) {
        var px = parseFiniteNumber(pos.attrs.x);
        var pz = parseFiniteNumber(pos.attrs.z);
        if (px === null || pz === null) {
          diags.add('errors', {
            code: 'INVALID_COORDINATES',
            element: childTag,
            message: '<' + childTag + '> "' + name + '" position ' + (posIndex + 1) + ' has invalid x/z coordinates'
          });
          return;
        }
        var a = pos.attrs.a;
        if (a !== undefined && parseFiniteNumber(a) === null) {
          diags.add('errors', {
            code: 'INVALID_COORDINATES',
            element: childTag,
            message: '<' + childTag + '> "' + name + '" position ' + (posIndex + 1) + ' has invalid angle a="' + a + '"'
          });
        }
      });
    }

    // Event group children (cfgeventgroups.xml): <child type ... lootmin lootmax x z a y>
    if (rule.lootChild) {
      (child.children || []).filter(function (sub) { return sub.tag === rule.lootChild; }).forEach(function (sub, si) {
        var lootmin = parseFiniteNumber(sub.attrs.lootmin);
        var lootmax = parseFiniteNumber(sub.attrs.lootmax);
        if (lootmin !== null && lootmax !== null && lootmin > lootmax) {
          diags.add('warnings', {
            code: 'LOOTMIN_GREATER_THAN_LOOTMAX',
            element: 'child',
            message: 'Group "' + name + '" child ' + (si + 1) + ' (' + sub.attrs.type + '): lootmin (' + lootmin + ') > lootmax (' + lootmax + ')'
          });
        }
        ['x', 'z', 'a', 'y'].forEach(function (axis) {
          var raw = sub.attrs[axis];
          if (raw === undefined) return;
          if (parseFiniteNumber(raw) === null) {
            diags.add('errors', {
              code: 'INVALID_COORDINATES',
              element: 'child',
              message: 'Group "' + name + '" child ' + (si + 1) + ' has invalid ' + axis + '="' + raw + '"'
            });
          }
        });
      });
    }

    // globals.xml variables
    if (rule.dayzVarTypes) {
      if (attrs.type && rule.dayzVarTypes.indexOf(attrs.type) === -1) {
        diags.add('warnings', {
          code: 'UNUSUAL_TYPE',
          element: 'var',
          message: '<var> "' + name + '" has unusual type: ' + attrs.type
        });
      }
      if (attrs.value && Number(attrs.value) !== 0 && !isFiniteNumber(attrs.value)) {
        diags.add('warnings', {
          code: 'NON_NUMERIC_VALUE',
          element: 'var',
          message: '<var> "' + name + '" has non-numeric value: "' + attrs.value + '"'
        });
      }
    }
  }

  function isFiniteNumber(raw) {
    return parseFiniteNumber(raw) !== null;
  }

  /* ------------------------------------------------------------------ *
   * Common XML issues (pure string checks, port of the server rules)    *
   * ------------------------------------------------------------------ */
  function checkCommonXmlIssues(content, diags) {
    if (!content.includes('encoding="UTF-8"') && !content.includes("encoding='UTF-8'")) {
      diags.add('warnings', { code: 'NO_UTF8', message: 'UTF-8 encoding not explicitly declared' });
    }
    var hasTabs = content.includes('\t');
    var hasSpaces = /^ {2,}/m.test(content);
    if (hasTabs && hasSpaces) {
      diags.add('warnings', { code: 'MIXED_INDENTATION', message: 'Mixed tabs and spaces detected for indentation' });
    }
    var lines = content.split('\n');
    var trailing = 0;
    var longLines = 0;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].length !== lines[i].trimEnd().length) trailing++;
      if (lines[i].length > MAX_LONG_LINE) longLines++;
    }
    if (trailing > 0) diags.add('info', { code: 'TRAILING_WHITESPACE', message: trailing + ' line(s) with trailing whitespace' });
    if (longLines > 0) diags.add('info', { code: 'LONG_LINES', message: longLines + ' line(s) exceeding ' + MAX_LONG_LINE + ' characters' });
    if (content.includes('<!--')) diags.add('info', { code: 'HAS_COMMENTS', message: 'File contains XML comments' });
  }

  /* ------------------------------------------------------------------ *
   * Full XML validation entry point                                     *
   * ------------------------------------------------------------------ */
  function validateXml(fileName, content, parser, documentType) {
    var diags = newDiagnostics();
    var report = {
      fileName: fileName || '(untitled)',
      kind: 'xml',
      inputBytes: typeof content === 'string' ? utf8ByteLength(content) : null
    };
    if (typeof content !== 'string') {
      diags.add('errors', { code: 'INVALID_CONTENT', message: 'Content must be a UTF-8 string' });
      report.errors = diags.errors; report.warnings = diags.warnings; report.info = diags.info;
      report.summary = summarize(report);
      return report;
    }
    if (report.inputBytes > MAX_FILE_BYTES) {
      diags.add('errors', { code: 'INPUT_TOO_LARGE', message: 'File exceeds the ' + (MAX_FILE_BYTES / 1048576) + ' MiB inspection limit' });
      report.errors = diags.errors; report.warnings = diags.warnings; report.info = diags.info;
      report.summary = summarize(report);
      return report;
    }
    if (!content.trim()) {
      diags.add('errors', { code: 'EMPTY_FILE', message: 'File is empty' });
      report.errors = diags.errors; report.warnings = diags.warnings; report.info = diags.info;
      report.summary = summarize(report);
      return report;
    }
    if (typeof parser !== 'function') {
      diags.add('errors', { code: 'NO_PARSER', message: 'No XML parser available in this environment' });
      report.errors = diags.errors; report.warnings = diags.warnings; report.info = diags.info;
      report.summary = summarize(report);
      return report;
    }
    var parsed;
    try {
      parsed = parser(content);
    } catch (err) {
      parsed = { ok: false, error: { message: err && err.message ? err.message : 'Parser failure' } };
    }
    if (!parsed || parsed.ok !== true) {
      var message = parsed && parsed.error && parsed.error.message ? parsed.error.message : 'XML parse error';
      var line = parsed && parsed.error && parsed.error.line;
      var column = parsed && parsed.error && parsed.error.column;
      diags.add('errors', {
        code: 'XML_SYNTAX_ERROR',
        line: typeof line === 'number' ? line : 0,
        column: typeof column === 'number' ? column : 0,
        message: 'Malformed XML: ' + message
      });
      report.errors = diags.errors; report.warnings = diags.warnings; report.info = diags.info;
      report.summary = summarize(report);
      return report;
    }
    diags.add('info', { code: 'SYNTAX_OK', message: 'XML is well-formed' });
    if (!content.replace(/^\uFEFF/, '').trim().startsWith('<?xml')) {
      diags.add('warnings', { code: 'MISSING_XML_DECLARATION', message: 'Missing XML declaration. Recommended: <?xml version="1.0" encoding="UTF-8" standalone="yes"?>' });
    }
    checkXmlStructure(fileName, parsed.model, diags, documentType);
    checkCommonXmlIssues(content, diags);
    report.errors = diags.errors; report.warnings = diags.warnings; report.info = diags.info;
    report.summary = summarize(report);
    return report;
  }

  /* ------------------------------------------------------------------ *
   * JSON validation + utilities (pure, identical in Node/browser)       *
   * ------------------------------------------------------------------ */
  function validateJson(fileName, content) {
    var diags = newDiagnostics();
    var report = { fileName: fileName || '(untitled)', kind: 'json', inputBytes: null };
    if (typeof content !== 'string') {
      diags.add('errors', { code: 'INVALID_CONTENT', message: 'Content must be a UTF-8 string' });
      finishJson(report, diags);
      return report;
    }
    report.inputBytes = utf8ByteLength(content);
    if (report.inputBytes > MAX_FILE_BYTES) {
      diags.add('errors', { code: 'INPUT_TOO_LARGE', message: 'File exceeds the ' + (MAX_FILE_BYTES / 1048576) + ' MiB inspection limit' });
      finishJson(report, diags);
      return report;
    }
    if (!content.trim()) {
      diags.add('errors', { code: 'EMPTY_FILE', message: 'File is empty' });
      finishJson(report, diags);
      return report;
    }
    var value;
    try {
      value = JSON.parse(content);
      diags.add('info', { code: 'JSON_VALID', message: 'Valid JSON syntax' });
    } catch (error) {
      var line = 0;
      var column = 0;
      var position = null;
      var posMatch = /position (\d+)/.exec(error.message || '');
      var lineMatch = /line (\d+) column (\d+)/.exec(error.message || '');
      if (posMatch) {
        position = parseInt(posMatch[1], 10);
      } else if (lineMatch) {
        line = parseInt(lineMatch[1], 10);
        column = parseInt(lineMatch[2], 10);
      } else {
        // Newer V8 (Node) omits the position: locate the offending token
        // from the "Unexpected token 'X'" fragment when present.
        var tokenMatch = /Unexpected token '([^']*)'/.exec(error.message || '');
        if (tokenMatch && tokenMatch[1]) {
          var tokenIndex = content.indexOf(tokenMatch[1]);
          if (tokenIndex >= 0) position = tokenIndex;
        }
      }
      if (position !== null && position >= 0) {
        var upto = content.substring(0, position);
        var uptoLines = upto.split('\n');
        line = uptoLines.length;
        column = uptoLines[uptoLines.length - 1].length + 1;
      }
      diags.add('errors', {
        code: 'JSON_SYNTAX_ERROR',
        line: line,
        column: column,
        message: 'Malformed JSON: ' + (error.message || 'parse error')
      });
      finishJson(report, diags);
      return report;
    }
    if (/,(\s*[}\]])/.test(content)) {
      diags.add('warnings', { code: 'TRAILING_COMMA_SUSPECT', message: 'Potential trailing comma detected (JSON is strict)' });
    }
    var lines = content.split('\n');
    var usesSpaces = false;
    var usesTabs = false;
    var minSpaceIndent = Infinity;
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var indent = lines[i].match(/^\s*/)[0];
      if (indent.includes(' ')) { usesSpaces = true; if (!indent.includes('\t')) minSpaceIndent = Math.min(minSpaceIndent, indent.length); }
      if (indent.includes('\t')) usesTabs = true;
    }
    if (usesSpaces && usesTabs) {
      diags.add('warnings', { code: 'MIXED_INDENTATION', message: 'Mixed tabs and spaces for indentation' });
    } else if (usesSpaces && minSpaceIndent < Infinity) {
      diags.add('info', { code: 'INDENTATION_STYLE', message: 'Using ' + minSpaceIndent + '-space indentation' });
    } else if (usesTabs) {
      diags.add('info', { code: 'INDENTATION_STYLE', message: 'Using tab indentation' });
    }
    // DayZ-flavored structural hints for known JSON files.
    var basename = (fileName || '').split(/[\\/]/).pop().toLowerCase();
    if (basename === 'cfggameplay.json' || basename === 'cfgundergroundtriggers.json' || basename === 'cfgeffectarea.json') {
      diags.add('info', { code: 'DAYZ_JSON', message: 'Recognized DayZ JSON file — generic JSON checks only (no engine schema in browser)' });
    }
    report.value = value; // browser pages reuse for split/download; not serialized anywhere
    finishJson(report, diags);
    return report;
  }

  function finishJson(report, diags) {
    report.errors = diags.errors;
    report.warnings = diags.warnings;
    report.info = diags.info;
    report.summary = summarize(report);
  }

  /** Pretty-print JSON with 2-space indentation. Null when unparseable. */
  function prettyJson(content) {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch (err) {
      return null;
    }
  }

  /** Split a top-level JSON array into chunks.
   *  mode 'count': exactly `parts` chunks (last takes the remainder).
   *  mode 'size':  chunks of at most `maxBytes` serialized bytes.
   *  Returns { ok, chunks: [{ name, content }], error? }. */
  function splitJsonArray(content, mode, arg) {
    var value;
    try {
      value = JSON.parse(content);
    } catch (err) {
      return { ok: false, error: 'Not parseable JSON: ' + (err.message || 'parse error') };
    }
    if (!Array.isArray(value)) {
      return { ok: false, error: 'Top-level value is ' + (value === null ? 'null' : typeof value) + ', not an array. Split a file whose root is a JSON array.' };
    }
    if (value.length === 0) return { ok: true, chunks: [] };
    var chunks = [];
    if (mode === 'count') {
      var parts = Math.max(1, Math.floor(Number(arg) || 1));
      if (parts > 1000) return { ok: false, error: 'Too many parts (max 1000)' };
      var base = Math.floor(value.length / parts);
      var rem = value.length % parts;
      var start = 0;
      for (var i = 0; i < parts; i++) {
        var take = base + (i < rem ? 1 : 0);
        if (take === 0) continue;
        var slice = value.slice(start, start + take);
        start += take;
        chunks.push({ name: 'part-' + (i + 1), content: JSON.stringify(slice, null, 2) });
      }
    } else if (mode === 'size') {
      var maxBytes = Math.max(1024, Math.floor(Number(arg) || 512 * 1024));
      var current = [];
      var size = 2; // '[' + ']'
      var n = 0;
      for (var j = 0; j < value.length; j++) {
        var itemSize = JSON.stringify(value[j], null, 2).length + 2;
        if (current.length > 0 && size + itemSize > maxBytes) {
          n++;
          chunks.push({ name: 'part-' + n, content: JSON.stringify(current, null, 2) });
          current = [];
          size = 2;
        }
        current.push(value[j]);
        size += itemSize;
      }
      if (current.length > 0) {
        n++;
        chunks.push({ name: 'part-' + n, content: JSON.stringify(current, null, 2) });
      }
    } else {
      return { ok: false, error: 'Unknown split mode' };
    }
    return { ok: true, chunks: chunks };
  }

  /* ------------------------------------------------------------------ *
   * Classname collection (duplicate checker)                            *
   * ------------------------------------------------------------------ */
  /** Walk a model collecting { tag, name, index } for every element that
   *  carries a name= attribute on a registry-style element. */
  function collectNamed(model) {
    var out = [];
    var registryTags = { type: 1, class: 1, group: 1, event: 1, cargo: 1, attachments: 1, var: 1, prototype: 1, container: 1, default: 1 };
    (function walk(node, depth) {
      if (!node || depth > 12) return;
      if (node.attrs && typeof node.attrs.name === 'string' && node.attrs.name.trim() && registryTags[node.tag]) {
        out.push({ tag: node.tag, name: node.attrs.name.trim(), index: out.length });
      }
      (node.children || []).forEach(function (c) { walk(c, depth + 1); });
    })(model, 0);
    return out;
  }

  /** Report duplicate names grouped by (file basename, element tag).
   *  Cross-file duplicates are only flagged for identical basenames
   *  (same file kind merged across sources) — a type named X in
   *  types.xml vs cfgspawnabletypes.xml is not a conflict. */
  function findDuplicates(files) {
    // files: [{ fileName, entries: [{tag, name}] }]
    var groups = {};
    files.forEach(function (file) {
      var base = (file.fileName || '').split(/[\\/]/).pop().toLowerCase();
      file.entries.forEach(function (entry) {
        var key = base + '::' + entry.tag + '::' + entry.name;
        (groups[key] = groups[key] || { base: base, tag: entry.tag, name: entry.name, files: [] }).files.push(file.fileName);
      });
    });
    var duplicates = [];
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      var count = g.files.length;
      var distinctFiles = {};
      g.files.forEach(function (f) { distinctFiles[f] = 1; });
      var distinctCount = Object.keys(distinctFiles).length;
      if (count > 1) {
        duplicates.push({
          name: g.name,
          tag: g.tag,
          count: count,
          crossFile: distinctCount > 1,
          files: g.files
        });
      }
    });
    duplicates.sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
    return duplicates;
  }

  /* ------------------------------------------------------------------ *
   * Map bounds                                                          *
   * ------------------------------------------------------------------ */
  function checkMapBounds(x, z, mapId) {
    var size = MAP_BOUNDS[mapId];
    if (size === undefined) return { ok: true, unchecked: true };
    var outOfMap = !(x >= 0 && x <= size && z >= 0 && z <= size);
    return { ok: !outOfMap, unchecked: false, mapSize: size, mapId: mapId };
  }

  /* ------------------------------------------------------------------ *
   * Event conflict analysis (cfgeventspawns / cfgeventgroups / events)  *
   * ------------------------------------------------------------------ */
  function analyzeEvents(fileName, model, mapId) {
    var diags = newDiagnostics();
    var report = { fileName: fileName, kind: 'events', mapId: mapId || null };
    if (!model || !model.tag) {
      diags.add('errors', { code: 'NO_ROOT', message: 'No root element found' });
      finishEvents(report, diags);
      return report;
    }
    var isSpawns = model.tag === 'eventposdef';
    var isGroups = model.tag === 'eventgroupdef';
    if (!isSpawns && !isGroups) {
      diags.add('info', { code: 'NOT_AN_EVENT_FILE', message: 'Root <' + model.tag + '> is not an event spawn/group definition; nothing to cross-check' });
      finishEvents(report, diags);
      return report;
    }
    var seen = {};
    model.children.forEach(function (node, idx) {
      var tag = isSpawns ? 'event' : 'group';
      if (node.tag !== tag) return;
      var name = node.attrs.name;
      if (typeof name !== 'string' || !name.trim()) {
        diags.add('errors', { code: 'MISSING_NAME', element: tag, message: '<' + tag + '> #' + (idx + 1) + ' has no name attribute' });
        return;
      }
      if (seen[name]) {
        diags.add('errors', { code: 'DUPLICATE_EVENT_NAME', element: tag, message: 'Duplicate ' + (isSpawns ? 'event' : 'group') + ' name "' + name + '" — the engine keys ' + tag + 's by name; the second definition shadows the first' });
      } else {
        seen[name] = true;
      }
      if (!CLASS_NAME_RE.test(name)) {
        diags.add('errors', { code: 'BAD_CLASS_NAME', element: tag, message: '"' + name + '" is not a valid DayZ class name' });
      }
      // World-position bounds: spawns carry absolute <pos x z a>;
      // group positions live in the adjacent <!--pos x z a y group--> comment.
      if (isSpawns) {
        node.children.filter(function (p) { return p.tag === 'pos'; }).forEach(function (pos, pi) {
          var x = parseFiniteNumber(pos.attrs.x);
          var z = parseFiniteNumber(pos.attrs.z);
          if (x === null || z === null) {
            diags.add('errors', { code: 'INVALID_COORDINATES', element: 'pos', message: 'Event "' + name + '" pos #' + (pi + 1) + ': x/z must be finite numbers (got x="' + pos.attrs.x + '", z="' + pos.attrs.z + '")' });
            return;
          }
          var bounds = checkMapBounds(x, z, mapId);
          if (!bounds.ok) {
            diags.add('warnings', { code: 'OUT_OF_MAP_BOUNDS', element: 'pos', message: 'Event "' + name + '" pos #' + (pi + 1) + ' (' + x + ', ' + z + ') is outside ' + mapId + ' (' + bounds.mapSize + 'x' + bounds.mapSize + ' m)' });
          }
        });
      }
    });
    // Group world positions from comment lines:
    //   <!--pos x="11254.23" z="3290.31" a="0" y="6.5" group="Train_Abandoned_Kamy"/-->
    if (isGroups) {
      var sourceText = model.sourceText || '';
      var re = /<!--\s*pos\s+x="([^"]*)"\s+z="([^"]*)"(?:\s+a="([^"]*)")?(?:\s+y="([^"]*)")?\s+group="([^"]*)"\s*\/-->/g;
      var m;
      var commentSeen = {};
      while ((m = re.exec(sourceText)) !== null) {
        var gname = m[5];
        var gx = parseFiniteNumber(m[1]);
        var gz = parseFiniteNumber(m[2]);
        if (gx === null || gz === null) {
          diags.add('errors', { code: 'INVALID_COORDINATES', element: 'group', message: 'Group "' + gname + '": position comment has invalid x/z' });
          continue;
        }
        if (commentSeen[gname]) {
          diags.add('warnings', { code: 'DUPLICATE_EVENT_NAME', element: 'group', message: 'Group "' + gname + '" has multiple position comments' });
        } else {
          commentSeen[gname] = true;
        }
        var bounds = checkMapBounds(gx, gz, mapId);
        if (!bounds.ok) {
          diags.add('warnings', { code: 'OUT_OF_MAP_BOUNDS', element: 'group', message: 'Group "' + gname + '" sits at (' + gx + ', ' + gz + '), outside ' + mapId + ' (' + bounds.mapSize + ' m)' });
        }
      }
      // Groups declared but with no position comment cannot be placed by the engine.
      model.children.filter(function (g) { return g.tag === 'group' && g.attrs.name; }).forEach(function (g) {
        if (!commentSeen[g.attrs.name]) {
          diags.add('info', { code: 'GROUP_WITHOUT_POS_COMMENT', element: 'group', message: 'Group "' + g.attrs.name + '" has no position comment (relative/cluster placement only)' });
        }
      });
    }
    finishEvents(report, diags);
    return report;
  }

  function finishEvents(report, diags) {
    report.errors = diags.errors;
    report.warnings = diags.warnings;
    report.info = diags.info;
    report.summary = summarize(report);
  }

  /* ------------------------------------------------------------------ *
   * init.c light checks                                                 *
   * ------------------------------------------------------------------ */
  function validateInitC(fileName, content) {
    var diags = newDiagnostics();
    var report = { fileName: fileName || 'init.c', kind: 'initc', inputBytes: null };
    if (typeof content !== 'string') {
      diags.add('errors', { code: 'INVALID_CONTENT', message: 'Content must be a UTF-8 string' });
      finishInitC(report, diags);
      return report;
    }
    report.inputBytes = utf8ByteLength(content);
    if (report.inputBytes > MAX_FILE_BYTES) {
      diags.add('errors', { code: 'INPUT_TOO_LARGE', message: 'File exceeds the ' + (MAX_FILE_BYTES / 1048576) + ' MiB inspection limit' });
      finishInitC(report, diags);
      return report;
    }
    if (!content.trim()) {
      diags.add('errors', { code: 'EMPTY_FILE', message: 'File is empty' });
      finishInitC(report, diags);
      return report;
    }
    diags.add('info', { code: 'SCRIPT_FILE', message: 'init.c is a SQF config script — structural checks only (no engine compile in browser)' });
    // Strip line comments and strings, then count braces.
    var stripped = content
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
    var open = (stripped.match(/\{/g) || []).length;
    var close = (stripped.match(/\}/g) || []).length;
    if (open !== close) {
      diags.add('warnings', { code: 'UNBALANCED_BRACES', message: 'Brace balance off: ' + open + ' "{" vs ' + close + ' "}" (comments/strings stripped; may be a false positive in macro code)' });
    } else {
      diags.add('info', { code: 'BRACES_BALANCED', message: 'Braces balanced (' + open + ' pairs)' });
    }
    var parenOpen = (stripped.match(/\(/g) || []).length;
    var parenClose = (stripped.match(/\)/g) || []).length;
    if (parenOpen !== parenClose) {
      diags.add('warnings', { code: 'UNBALANCED_PARENS', message: 'Paren balance off: ' + parenOpen + ' "(" vs ' + parenClose + ' ")"' });
    }
    finishInitC(report, diags);
    return report;
  }

  function finishInitC(report, diags) {
    report.errors = diags.errors;
    report.warnings = diags.warnings;
    report.info = diags.info;
    report.summary = summarize(report);
  }

  /* ------------------------------------------------------------------ *
   * Safe cleanup (port of the server lintAndFix string steps)           *
   * ------------------------------------------------------------------ */
  /** Apply safe, layout-preserving fixes to XML text: add missing XML
   *  declaration, trim trailing whitespace, normalize CRLF to LF.
   *  Returns { fixed, fixes, hasChanges }. Never re-serializes the tree. */
  function safeCleanupXml(content) {
    var fixes = [];
    var fixed = content;
    if (!fixed.replace(/^\uFEFF/, '').trim().startsWith('<?xml')) {
      fixed = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + fixed;
      fixes.push({ code: 'ADD_XML_DECLARATION', message: 'Added XML declaration' });
    }
    var lines = fixed.split('\n');
    var trimmed = lines.map(function (l) { return l.replace(/\s+$/, ''); });
    if (trimmed.join('\n') !== fixed) {
      fixed = trimmed.join('\n');
      fixes.push({ code: 'REMOVE_TRAILING_WHITESPACE', message: 'Removed trailing whitespace' });
    }
    if (fixed.includes('\r\n')) {
      fixed = fixed.replace(/\r\n/g, '\n');
      fixes.push({ code: 'NORMALIZE_LINE_ENDINGS', message: 'Normalized line endings to LF' });
    }
    return { fixed: fixed, fixes: fixes, hasChanges: fixed !== content };
  }

  /** Safe cleanup for JSON: 2-space re-stringify + trailing newline.
   *  Returns { fixed, fixes, hasChanges, error? }. */
  function safeCleanupJson(content) {
    try {
      var formatted = JSON.stringify(JSON.parse(content), null, 2) + '\n';
      var fixes = [];
      if (formatted !== content + '\n' && formatted !== content) {
        fixes.push({ code: 'REFORMAT_JSON', message: 'Reformatted JSON with 2-space indentation' });
      }
      return { fixed: formatted, fixes: fixes, hasChanges: formatted !== content };
    } catch (err) {
      return { fixed: content, fixes: [], hasChanges: false, error: err.message };
    }
  }

  /* ------------------------------------------------------------------ *
   * UTF-8 byte length (browser has no Buffer)                           *
   * ------------------------------------------------------------------ */
  function utf8ByteLength(text) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text).length;
    }
    var len = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) len += 1;
      else if (code < 0x800) len += 2;
      else if (code >= 0xD800 && code < 0xDC00) { len += 4; i++; }
      else len += 3;
    }
    return len;
  }

  /* ------------------------------------------------------------------ *
   * Mission structure checklist                                         *
   * ------------------------------------------------------------------ */
  var MISSION_REQUIRED = ['mission.sqm'];
  var MISSION_COMMON = ['init.c', 'areaflags.map', 'cfgeconomycore.xml', 'db/messages.xml', 'env', 'pra'];

  /** names = lower-cased relative paths in the mission (e.g. 'db/messages.xml').
   *  A leading mission-folder prefix (from zipping the whole mission folder)
   *  is tolerated: 'mymission/mission.sqm' satisfies 'mission.sqm'. */
  function missionStructureReport(names) {
    var diags = newDiagnostics();
    function present(target) {
      if (names[target]) return true;
      var suffix = '/' + target;
      for (var name in names) {
        if (name.length > target.length && name.slice(name.length - suffix.length) === suffix) return true;
      }
      return false;
    }
    MISSION_REQUIRED.forEach(function (req) {
      if (!present(req)) {
        diags.add('errors', { code: 'MISSING_REQUIRED_FILE', message: 'Required file missing: ' + req });
      }
    });
    MISSION_COMMON.forEach(function (common) {
      if (!present(common)) {
        diags.add('warnings', { code: 'MISSING_COMMON_FILE', message: 'Unusual for a mission: ' + common + ' not found' });
      }
    });
    var report = { kind: 'mission' };
    report.errors = diags.errors;
    report.warnings = diags.warnings;
    report.info = diags.info;
    report.summary = summarize(report);
    return report;
  }

  /* ------------------------------------------------------------------ *
   * Exports                                                             *
   * ------------------------------------------------------------------ */
  return {
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_SCAN_BYTES: MAX_SCAN_BYTES,
    RULE_NAMES: Object.keys(DAYZ_RULES).sort(),
    MAP_BOUNDS: MAP_BOUNDS,
    mapIdFromMissionName: mapIdFromMissionName,
    classify: classify,
    validateXml: validateXml,
    validateJson: validateJson,
    validateInitC: validateInitC,
    prettyJson: prettyJson,
    splitJsonArray: splitJsonArray,
    collectNamed: collectNamed,
    findDuplicates: findDuplicates,
    checkMapBounds: checkMapBounds,
    analyzeEvents: analyzeEvents,
    checkXmlStructure: checkXmlStructure,
    checkCommonXmlIssues: checkCommonXmlIssues,
    safeCleanupXml: safeCleanupXml,
    safeCleanupJson: safeCleanupJson,
    missionStructureReport: missionStructureReport,
    parseFiniteNumber: parseFiniteNumber,
    summarize: summarize
  };
});
