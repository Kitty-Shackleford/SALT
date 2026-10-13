const { createHash } = require('node:crypto');
const xml2js = require('xml2js');
const { XMLValidator } = require('fast-xml-parser');

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_DIAGNOSTICS = 100;
const MAX_DIAGNOSTIC_CHARS = 512;

class ValidationService {
  constructor() {
    this.rules = this.loadValidationRules();
  }

  /**
   * Load validation rules for each file type
   */
  loadValidationRules() {
    // Deliberately partial, file-specific checks, not an engine schema/class registry.
    // Empty CE registries are valid; validate entries when present.
    return {
      'types.xml': {
        rootElement: 'types', checkedChildElements: ['type'],
        typeAttributes: { required: ['name'] }
      },
      'events.xml': {
        rootElement: 'events', checkedChildElements: ['event'],
        eventAttributes: { required: ['name'] }
      },
      'cfgeventspawns.xml': {
        rootElement: 'eventposdef', checkedChildElements: ['event'],
        eventAttributes: { required: ['name'] }
      },
      'cfgweather.xml': { rootElement: 'weather' },
      'cfgenvironment.xml': { rootElement: 'env' },
      'cfgplayerspawnpoints.xml': { rootElement: 'playerspawnpoints' },
      'cfgrandompresets.xml': {
        rootElement: 'randompresets', checkedChildElements: ['cargo', 'attachments'],
        cargoAttributes: { required: ['name'] },
        attachmentsAttributes: { required: ['name'] },
        itemAttributes: { required: ['name'] },
        nestedChildren: { cargo: ['item'], attachments: ['item'] }
      },
      'globals.xml': {
        rootElement: 'variables', checkedChildElements: ['var'],
        varAttributes: { required: ['name', 'type', 'value'] }
      },
      'cfgspawnabletypes.xml': {
        rootElement: 'spawnabletypes', checkedChildElements: ['type'],
        typeAttributes: { required: ['name'] }
      },
      'mapgroupproto.xml': {
        rootElement: 'prototype', checkedChildElements: ['group'],
        groupAttributes: { required: ['name'] },
        containerAttributes: { required: ['name'] },
        nestedChildren: { group: ['container'] }
      },
      'mapgrouppos.xml': {
        rootElement: 'map', checkedChildElements: ['group'],
        groupAttributes: { required: ['name'] }
      },
      'messages.xml': { rootElement: 'messages', checkedChildElements: ['message'] }
    };
  }

  /**
   * Inspect a submitted XML string without rewriting it or verifying engine readiness.
   * documentType is an optional trusted canonical filename, e.g. 'types.xml'. A
   * recognized explicit type takes precedence; otherwise use the exact basename.
   * 'basic' coverage means the root and the targeted checks in loadValidationRules,
   * NOT a full schema, class allowlist, cross-file reference audit or runtime test.
   * Unknown names/types are 'syntax-only'. JSON uses that same support level.
   *
   * Reports retain valid/errors/warnings/info and add documentType (or null),
   * supportLevel, sha256 (exact UTF-8 input; null for non-string input), inputBytes,
   * limits and truncation[kind] = { total, omitted, truncated }. Summary counts
   * remain counts of returned diagnostics; use truncation totals for full counts.
   * Parsed XML/JSON trees are intentionally not returned to API consumers.
   */
  async validateXML(fileName, content, documentType) {
    // Names are case-sensitive identifiers. Do not infer a schema from XML content.
    const basename = typeof fileName === 'string' ? fileName.split(/[\\/]/).pop() : '';
    const recognized = name => typeof name === 'string' && Object.hasOwn(this.rules, name);
    const resolvedType = recognized(documentType) ? documentType : (recognized(basename) ? basename : null);
    const metadata = this.inputMetadata(content, resolvedType);
    const { errors, warnings, info } = this.createDiagnostics();

    const inputError = this.checkInput(content, metadata);
    if (inputError) {
      errors.push(inputError);
      return this.finishReport({ valid: false, errors, warnings, info, ...metadata });
    }

    // Step 1: Check if content is empty
    if (!content || content.trim().length === 0) {
      errors.push({
        line: 0,
        column: 0,
        message: 'File is empty',
        severity: 'error',
        code: 'EMPTY_FILE'
      });
      return this.finishReport({ valid: false, errors, warnings, info, ...metadata });
    }

    // Step 2: Basic XML syntax validation
    const syntaxValidation = XMLValidator.validate(content, {
      allowBooleanAttributes: false
    });

    if (syntaxValidation !== true) {
      errors.push({
        line: syntaxValidation.err.line,
        column: syntaxValidation.err.col,
        message: syntaxValidation.err.msg,
        severity: 'error',
        code: 'XML_SYNTAX_ERROR'
      });
      return this.finishReport({ valid: false, errors, warnings, info, ...metadata });
    }

    // Step 3: Parse the entire XML document, not just its first root.
    let parsedXML;
    try {
      const parser = new xml2js.Parser({ strict: true, explicitArray: true });
      // parseStringPromise resolves at the first root and can ignore trailing errors.
      // Use its existing SAX stream through close(), retaining xml2js's tree builder.
      const stream = parser.saxParser;
      const open = stream.onopentag;
      const close = stream.onclosetag;
      let depth = 0;
      let roots = 0;
      stream.onopentag = node => {
        if (depth === 0 && ++roots > 1) throw new Error('XML must have exactly one root element');
        depth++;
        open(node);
      };
      stream.onclosetag = name => {
        close(name);
        depth--;
      };
      parser.on('error', error => { throw error; });
      stream.write(content).close();
      parsedXML = parser.resultObject;
    } catch (error) {
      errors.push({
        line: 0,
        column: 0,
        message: 'Failed to parse XML: ' + error.message,
        severity: 'error',
        code: 'PARSE_ERROR'
      });
      return this.finishReport({ valid: false, errors, warnings, info, ...metadata });
    }

    info.push({ message: '✓ XML syntax is valid', code: 'SYNTAX_OK' });

    // Step 4: Check XML declaration
    if (!content.trim().startsWith('<?xml')) {
      warnings.push({
        line: 1,
        column: 1,
        message: 'Missing XML declaration. Recommended: <?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        severity: 'warning',
        code: 'MISSING_XML_DECLARATION'
      });
    }

    // Step 5: File-specific validation
    const rules = resolvedType ? this.rules[resolvedType] : null;
    
    if (rules) {
      this.validateStructure(parsedXML, rules, { errors, warnings, info });
    } else {
      info.push({
        message: 'No specific validation rules for this file type',
        code: 'NO_RULES'
      });
    }

    // Step 6: Common XML issues
    const commonIssues = this.checkCommonXMLIssues(content);
    warnings.push(...commonIssues.warnings);
    info.push(...commonIssues.info);

    return this.finishReport({ valid: errors.length === 0, errors, warnings, info, ...metadata });
  }

  /**
   * Validate XML structure against rules
   */
  validateStructure(parsedXML, rules, diagnostics = this.createDiagnostics()) {
    const { errors, warnings, info } = diagnostics;

    // Check root element
    const rootKeys = Object.keys(parsedXML);
    if (rootKeys.length === 0) {
      errors.push({
        message: 'No root element found',
        severity: 'error',
        code: 'NO_ROOT'
      });
      return { errors, warnings, info };
    }

    const rootElement = rootKeys[0];
    if (rules.rootElement && rootElement !== rules.rootElement) {
      errors.push({
        message: `Expected root element <${rules.rootElement}>, found <${rootElement}>`,
        severity: 'error',
        code: 'WRONG_ROOT'
      });
      return { errors, warnings, info };
    }

    info.push({
      message: `✓ Root element <${rootElement}> is correct`,
      code: 'ROOT_OK'
    });

    const rootData = parsedXML[rootElement];
    for (const childName of rules.checkedChildElements || []) {
      if (!Object.hasOwn(rootData, childName)) continue;
      const children = rootData[childName];
      info.push({ message: `✓ Found ${children.length} <${childName}> element(s)`, code: 'CHILD_COUNT' });
      this.validateChildren(childName, children, rules, errors, warnings);
    }

    return { errors, warnings, info };
  }

  /**
   * Validate child elements
   */
  validateChildren(childName, children, rules, errors, warnings) {
    // Get attribute rules for this child type
    const attributeRulesKey = childName + 'Attributes';
    const attributeRules = rules[attributeRulesKey];

    if (!attributeRules) return;

    children.forEach((child, index) => {
      const attrs = child.$ || {};

      // Check required attributes
      if (attributeRules.required) {
        attributeRules.required.forEach(attrName => {
          if (typeof attrs[attrName] !== 'string' || !attrs[attrName].trim()) {
            errors.push({
              message: `<${childName}> at index ${index} missing required attribute: ${attrName}`,
              severity: 'error',
              code: 'MISSING_ATTRIBUTE',
              element: childName,
              attribute: attrName
            });
          }
        });
      }

      // Only declared paths are checked; unknown attributes/classes are not inferred.
      for (const nestedName of rules.nestedChildren?.[childName] || []) {
        if (Object.hasOwn(child, nestedName)) {
          this.validateChildren(nestedName, child[nestedName], rules, errors, warnings);
        }
      }

      // CE types.xml numeric settings are text CHILD elements, not attributes.
      // Do not infer class existence or apply these fields to spawnable types.
      if (rules.rootElement === 'types' && childName === 'type') {
        const values = {};
        for (const field of ['nominal', 'lifetime', 'restock', 'min', 'quantmin', 'quantmax', 'cost']) {
          if (!Object.hasOwn(child, field)) continue;
          for (const raw of child[field]) {
            const value = this.parseFiniteNumber(raw);
            if (value === null) {
              errors.push({
                message: `<type> at index ${index} has invalid <${field}> (must be a complete finite number)`,
                severity: 'error', code: 'INVALID_NUMBER', element: 'type', field
              });
              continue;
            }
            values[field] = value;
            const quantitySentinel = (field === 'quantmin' || field === 'quantmax') && value === -1;
            if (value < 0 && !quantitySentinel) {
              warnings.push({
                message: `<type> at index ${index} has negative <${field}>: ${value}`,
                severity: 'warning', code: 'NEGATIVE_VALUE'
              });
            }
          }
        }
        // Vanilla dormant/non-CE entries can retain min > 0 with nominal = 0.
        if (values.nominal > 0 && values.min > values.nominal) {
          warnings.push({
            message: `<type> at index ${index}: min (${values.min}) is greater than nominal (${values.nominal})`,
            severity: 'warning', code: 'MIN_GREATER_THAN_NOMINAL'
          });
        }
        if (values.quantmin !== -1 && values.quantmax !== -1 && values.quantmin > values.quantmax) {
          warnings.push({
            message: `<type> at index ${index}: quantmin (${values.quantmin}) is greater than quantmax (${values.quantmax})`,
            severity: 'warning', code: 'QUANTMIN_GREATER_THAN_QUANTMAX'
          });
        }
      }

      // Validate event positions
      if (rules.rootElement === 'eventposdef' && childName === 'event' && child.pos) {
        const positions = Array.isArray(child.pos) ? child.pos : [child.pos];
        positions.forEach((pos, posIndex) => {
          if (!pos.$ || !pos.$.x || !pos.$.z) {
            errors.push({
              message: `<event> "${attrs.name}" position ${posIndex} missing x or z coordinate`,
              severity: 'error',
              code: 'MISSING_COORDINATES'
            });
          } else {
            const x = this.parseFiniteNumber(pos.$.x);
            const z = this.parseFiniteNumber(pos.$.z);
            
            if (x === null || z === null) {
              errors.push({
                message: `<event> "${attrs.name}" position ${posIndex} has invalid coordinates`,
                severity: 'error',
                code: 'INVALID_COORDINATES'
              });
            }

            // No map is provided: do not invent universal coordinate bounds.
          }
        });
      }

      // Validate globals
      if (childName === 'var' && attrs.name) {
        if (attrs.type) {
          const validTypes = ['0', '1', '2', '3', '4']; // DayZ variable types
          if (!validTypes.includes(attrs.type)) {
            warnings.push({
              message: `<var> "${attrs.name}" has unusual type: ${attrs.type}`,
              severity: 'warning',
              code: 'UNUSUAL_TYPE'
            });
          }
        }

        if (attrs.value) {
          const value = parseFloat(attrs.value);
          if (isNaN(value)) {
            warnings.push({
              message: `<var> "${attrs.name}" has non-numeric value: "${attrs.value}"`,
              severity: 'warning',
              code: 'NON_NUMERIC_VALUE'
            });
          }
        }
      }
    });
  }

  createDiagnostics() {
    const diagnostics = {};
    for (const kind of ['errors', 'warnings', 'info']) {
      const items = [];
      let total = 0;
      Object.defineProperties(items, {
        total: { get: () => total },
        push: { value: (...entries) => {
          total += entries.length;
          for (const entry of entries) {
            if (items.length >= MAX_DIAGNOSTICS) break;
            const bounded = {};
            for (const [key, value] of Object.entries(entry)) {
              bounded[key] = typeof value === 'string' && value.length > MAX_DIAGNOSTIC_CHARS
                ? value.slice(0, MAX_DIAGNOSTIC_CHARS - 1) + '…' : value;
            }
            Array.prototype.push.call(items, bounded);
          }
          return items.length;
        } }
      });
      diagnostics[kind] = items;
    }
    return diagnostics;
  }

  finishReport(result) {
    const truncation = {};
    for (const kind of ['errors', 'warnings', 'info']) {
      const items = result[kind];
      const total = items.total ?? items.length;
      const omitted = total - items.length;
      truncation[kind] = { total, omitted, truncated: omitted > 0 };
      result[kind] = Array.from(items);
    }
    return { ...result, truncation };
  }

  inputMetadata(content, documentType) {
    const isText = typeof content === 'string';
    return {
      documentType,
      supportLevel: documentType ? 'basic' : 'syntax-only',
      // Exact UTF-8 input, before BOM/whitespace/newline parsing or normalization.
      sha256: isText ? createHash('sha256').update(content, 'utf8').digest('hex') : null,
      inputBytes: isText ? Buffer.byteLength(content, 'utf8') : null,
      limits: { maxInputBytes: MAX_INPUT_BYTES, maxDiagnostics: MAX_DIAGNOSTICS, maxDiagnosticChars: MAX_DIAGNOSTIC_CHARS }
    };
  }

  checkInput(content, metadata) {
    if (typeof content !== 'string') {
      return { line: 0, column: 0, severity: 'error', code: 'INVALID_CONTENT', message: 'Content must be a UTF-8 string' };
    }
    if (metadata.inputBytes > MAX_INPUT_BYTES) {
      return { line: 0, column: 0, severity: 'error', code: 'INPUT_TOO_LARGE', message: 'Content exceeds the 5 MiB input limit' };
    }
    return null;
  }

  parseFiniteNumber(raw) {
    // No partial parse, booleans, hex, empty values, nested elements or Infinity.
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Check for common XML issues
   */
  checkCommonXMLIssues(content) {
    const warnings = [];
    const info = [];

    // Check encoding
    if (content.includes('encoding="UTF-8"') || content.includes("encoding='UTF-8'")) {
      info.push({
        message: '✓ UTF-8 encoding declared',
        code: 'ENCODING_OK'
      });
    } else {
      warnings.push({
        message: 'UTF-8 encoding not explicitly declared',
        severity: 'warning',
        code: 'NO_UTF8'
      });
    }

    // Check for tabs vs spaces (consistency warning)
    const hasTabs = content.includes('\t');
    const hasSpaces = /^ {2,}/m.test(content);
    
    if (hasTabs && hasSpaces) {
      warnings.push({
        message: 'Mixed tabs and spaces detected for indentation',
        severity: 'warning',
        code: 'MIXED_INDENTATION'
      });
    }

    // Check for trailing whitespace
    const lines = content.split('\n');
    const trailingWhitespaceLines = lines
      .map((line, index) => ({ line: line, number: index + 1 }))
      .filter(item => item.line.length !== item.line.trimEnd().length);

    if (trailingWhitespaceLines.length > 0) {
      warnings.push({
        message: `Found ${trailingWhitespaceLines.length} line(s) with trailing whitespace`,
        severity: 'info',
        code: 'TRAILING_WHITESPACE'
      });
    }

    // Check for very long lines
    const longLines = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(item => item.line.length > 200);

    if (longLines.length > 0) {
      warnings.push({
        message: `Found ${longLines.length} line(s) exceeding 200 characters`,
        severity: 'info',
        code: 'LONG_LINES'
      });
    }

    // Check for comments
    const hasComments = /<!--/.test(content);
    if (hasComments) {
      info.push({
        message: '✓ File contains comments',
        code: 'HAS_COMMENTS'
      });
    }

    return { warnings, info };
  }

  /**
   * Validate JSON file
   */
  validateJSON(fileName, content) {
    const metadata = this.inputMetadata(content, null);
    const { errors, warnings, info } = this.createDiagnostics();

    const inputError = this.checkInput(content, metadata);
    if (inputError) {
      errors.push(inputError);
      return this.finishReport({ valid: false, errors, warnings, info, ...metadata });
    }

    // Check if empty
    if (!content || content.trim().length === 0) {
      errors.push({
        line: 0,
        column: 0,
        message: 'File is empty',
        severity: 'error',
        code: 'EMPTY_FILE'
      });
      return this.finishReport({ valid: false, errors, warnings, info, ...metadata });
    }

    // Try to parse JSON
    try {
      JSON.parse(content);
      info.push({
        message: '✓ Valid JSON syntax',
        code: 'JSON_VALID'
      });
    } catch (error) {
      // Extract line/column from error message
      const match = error.message.match(/position (\d+)/);
      const position = match ? parseInt(match[1]) : 0;
      
      const lines = content.substring(0, position).split('\n');
      const line = lines.length;
      const column = lines[lines.length - 1].length;

      errors.push({
        line,
        column,
        message: error.message,
        severity: 'error',
        code: 'JSON_SYNTAX_ERROR'
      });
      return this.finishReport({ valid: false, errors, warnings, info, ...metadata });
    }

    // Check for common JSON issues
    
    // Check for trailing commas (will be caught by parse, but good to mention)
    if (/,\s*[}\]]/.test(content)) {
      warnings.push({
        message: 'Potential trailing comma detected',
        severity: 'warning',
        code: 'TRAILING_COMMA'
      });
    }

    // Check indentation consistency
    const lines = content.split('\n');
    const indentations = lines
      .filter(line => line.trim().length > 0)
      .map(line => line.match(/^\s*/)[0]);

    const usesSpaces = indentations.some(indent => indent.includes(' '));
    const usesTabs = indentations.some(indent => indent.includes('\t'));

    if (usesSpaces && usesTabs) {
      warnings.push({
        message: 'Mixed tabs and spaces for indentation',
        severity: 'warning',
        code: 'MIXED_INDENTATION'
      });
    }

    // Detect indentation style
    const spaceIndents = indentations.filter(i => i.includes(' ') && !i.includes('\t'));
    if (spaceIndents.length > 0) {
      const commonIndent = spaceIndents.reduce((min, indent) => Math.min(min, indent.length), Infinity);
      info.push({
        message: `✓ Using ${commonIndent}-space indentation`,
        code: 'INDENTATION_STYLE'
      });
    }

    return this.finishReport({ valid: errors.length === 0, errors, warnings, info, ...metadata });
  }

  /**
   * Auto-fix common issues
   */
  async lintAndFix(fileName, content, fileType = 'xml') {
    const fixes = [];

    if (fileType === 'xml') {
      let fixed = content;

      // Add XML declaration if missing
      if (!fixed.trim().startsWith('<?xml')) {
        fixed = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + fixed;
        fixes.push({
          message: 'Added XML declaration',
          code: 'ADD_XML_DECLARATION'
        });
      }

      // Remove trailing whitespace
      const originalLines = fixed.split('\n');
      const trimmedLines = originalLines.map(line => line.trimEnd());
      if (originalLines.join('\n') !== trimmedLines.join('\n')) {
        fixed = trimmedLines.join('\n');
        fixes.push({
          message: 'Removed trailing whitespace',
          code: 'REMOVE_TRAILING_WHITESPACE'
        });
      }

      // Normalize line endings to \n
      if (fixed.includes('\r\n')) {
        fixed = fixed.replace(/\r\n/g, '\n');
        fixes.push({
          message: 'Normalized line endings to LF',
          code: 'NORMALIZE_LINE_ENDINGS'
        });
      }

      // Try to pretty-print XML
      try {
        const parser = new xml2js.Parser();
        const builder = new xml2js.Builder({
          xmldec: { version: '1.0', encoding: 'UTF-8', standalone: 'yes' },
          renderOpts: { pretty: true, indent: '  ' }
        });

        const parsed = await parser.parseStringPromise(fixed);
        const formatted = builder.buildObject(parsed);

        if (formatted !== fixed) {
          fixed = formatted;
          fixes.push({
            message: 'Reformatted XML for consistency',
            code: 'REFORMAT_XML'
          });
        }
      } catch (error) {
        // If parsing fails, don't apply formatting
        console.log('Cannot reformat XML:', error.message);
      }

      return {
        fixed,
        fixes,
        hasChanges: fixed !== content
      };

    } else if (fileType === 'json') {
      let fixed = content;

      try {
        // Parse and re-stringify with consistent formatting
        const parsed = JSON.parse(fixed);
        const formatted = JSON.stringify(parsed, null, 2);

        if (formatted !== fixed) {
          fixed = formatted + '\n'; // Add trailing newline
          fixes.push({
            message: 'Reformatted JSON with 2-space indentation',
            code: 'REFORMAT_JSON'
          });
        }
      } catch (error) {
        // If parsing fails, return original
        return {
          fixed: content,
          fixes: [],
          hasChanges: false,
          error: error.message
        };
      }

      return {
        fixed,
        fixes,
        hasChanges: fixed !== content
      };
    }

    return {
      fixed: content,
      fixes: [],
      hasChanges: false
    };
  }

  /**
   * Get validation summary
   */
  getValidationSummary(result) {
    return {
      valid: result.valid,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
      infoCount: result.info.length,
      status: result.errors.length === 0 
        ? (result.warnings.length === 0 ? 'excellent' : 'good') 
        : 'invalid'
    };
  }
}

module.exports = new ValidationService();