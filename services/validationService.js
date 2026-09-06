const xml2js = require('xml2js');
const { XMLValidator } = require('fast-xml-parser'); // npm install fast-xml-parser

class ValidationService {
  constructor() {
    this.rules = this.loadValidationRules();
  }

  /**
   * Load validation rules for each file type
   */
  loadValidationRules() {
    return {
      'types.xml': {
        rootElement: 'types',
        requiredChildElements: ['type'],
        typeAttributes: {
          required: ['name'],
          optional: ['nominal', 'lifetime', 'restock', 'min', 'quantmin', 'quantmax', 'cost', 'count_in_cargo', 'count_in_hoarder', 'count_in_map', 'count_in_player', 'crafted', 'deloot']
        },
        childElements: {
          optional: ['flags', 'category', 'usage', 'value', 'tag']
        }
      },
      'events.xml': {
        rootElement: 'eventposdef',
        requiredChildElements: ['event'],
        eventAttributes: {
          required: ['name']
        },
        childElements: {
          required: ['pos'],
          optional: ['active']
        }
      },
      'cfgweather.xml': {
        rootElement: 'weather',
        requiredChildElements: ['object'],
        objectAttributes: {
          required: ['class', 'name']
        }
      },
      'cfgenvironment.xml': {
        rootElement: 'variables',
        requiredChildElements: ['var']
      },
      'cfgplayerspawnpoints.xml': {
        rootElement: 'spawnpoints',
        requiredChildElements: ['fresh', 'hop']
      },
      'cfgrandompresets.xml': {
        rootElement: 'randompresets',
        requiredChildElements: ['cargo']
      },
      'globals.xml': {
        rootElement: 'variables',
        requiredChildElements: ['var'],
        varAttributes: {
          required: ['name', 'type', 'value']
        }
      },
      'spawnabletypes.xml': {
        rootElement: 'spawnabletypes',
        requiredChildElements: ['type']
      },
      'mapgroupproto.xml': {
        rootElement: 'group',
        requiredChildElements: ['child']
      },
      'mapgrouppos.xml': {
        rootElement: 'map',
        requiredChildElements: ['group']
      },
      'messages.xml': {
        rootElement: 'messages',
        requiredChildElements: ['message']
      }
    };
  }

  /**
   * Validate XML file
   */
  async validateXML(fileName, content) {
    const errors = [];
    const warnings = [];
    const info = [];

    // Step 1: Check if content is empty
    if (!content || content.trim().length === 0) {
      errors.push({
        line: 0,
        column: 0,
        message: 'File is empty',
        severity: 'error',
        code: 'EMPTY_FILE'
      });
      return { valid: false, errors, warnings, info };
    }

    // Step 2: Basic XML syntax validation
    const syntaxValidation = XMLValidator.validate(content, {
      allowBooleanAttributes: true
    });

    if (syntaxValidation !== true) {
      errors.push({
        line: syntaxValidation.err.line,
        column: syntaxValidation.err.col,
        message: syntaxValidation.err.msg,
        severity: 'error',
        code: 'XML_SYNTAX_ERROR'
      });
      return { valid: false, errors, warnings, info };
    }

    info.push({
      message: '✓ XML syntax is valid',
      code: 'SYNTAX_OK'
    });

    // Step 3: Parse XML
    let parsedXML;
    try {
      const parser = new xml2js.Parser();
      parsedXML = await parser.parseStringPromise(content);
    } catch (error) {
      errors.push({
        line: 0,
        column: 0,
        message: 'Failed to parse XML: ' + error.message,
        severity: 'error',
        code: 'PARSE_ERROR'
      });
      return { valid: false, errors, warnings, info };
    }

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
    const rules = this.rules[fileName];

    if (rules) {
      const structureValidation = this.validateStructure(parsedXML, rules);
      errors.push(...structureValidation.errors);
      warnings.push(...structureValidation.warnings);
      info.push(...structureValidation.info);
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

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      info,
      structure: parsedXML
    };
  }

  /**
   * Validate XML structure against rules
   */
  validateStructure(parsedXML, rules) {
    const errors = [];
    const warnings = [];
    const info = [];

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

    // Check required child elements
    if (rules.requiredChildElements) {
      const rootData = parsedXML[rootElement];

      rules.requiredChildElements.forEach(childName => {
        if (!rootData[childName]) {
          errors.push({
            message: `Missing required child element: <${childName}>`,
            severity: 'error',
            code: 'MISSING_CHILD'
          });
        } else {
          const childArray = Array.isArray(rootData[childName]) ? rootData[childName] : [rootData[childName]];
          info.push({
            message: `✓ Found ${childArray.length} <${childName}> element(s)`,
            code: 'CHILD_COUNT'
          });

          // Validate children
          this.validateChildren(childName, childArray, rules, errors, warnings);
        }
      });
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
      if (!child.$) {
        warnings.push({
          message: `<${childName}> at index ${index} has no attributes`,
          severity: 'warning',
          code: 'NO_ATTRIBUTES'
        });
        return;
      }

      const attrs = child.$;

      // Check required attributes
      if (attributeRules.required) {
        attributeRules.required.forEach(attrName => {
          if (!attrs[attrName]) {
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

      // Check for invalid attributes
      const validAttrs = [
        ...(attributeRules.required || []),
        ...(attributeRules.optional || [])
      ];

      Object.keys(attrs).forEach(attrName => {
        if (!validAttrs.includes(attrName)) {
          warnings.push({
            message: `<${childName}> at index ${index} has unknown attribute: ${attrName}`,
            severity: 'warning',
            code: 'UNKNOWN_ATTRIBUTE',
            element: childName,
            attribute: attrName
          });
        }
      });

      // Special validations
      if (childName === 'type' && attrs.name) {
        // Validate type name format
        if (!/^[a-zA-Z0-9_]+$/.test(attrs.name)) {
          warnings.push({
            message: `<type> name "${attrs.name}" contains invalid characters (use only letters, numbers, underscores)`,
            severity: 'warning',
            code: 'INVALID_NAME_FORMAT'
          });
        }

        // Validate numeric attributes
        ['nominal', 'lifetime', 'restock', 'min', 'quantmin', 'quantmax', 'cost'].forEach(numAttr => {
          if (attrs[numAttr]) {
            const value = parseFloat(attrs[numAttr]);
            if (isNaN(value)) {
              errors.push({
                message: `<type> "${attrs.name}" has invalid ${numAttr}: "${attrs[numAttr]}" (must be numeric)`,
                severity: 'error',
                code: 'INVALID_NUMBER'
              });
            } else if (value < 0) {
              warnings.push({
                message: `<type> "${attrs.name}" has negative ${numAttr}: ${value}`,
                severity: 'warning',
                code: 'NEGATIVE_VALUE'
              });
            }
          }
        });

        // Validate min/nominal relationship
        if (attrs.min && attrs.nominal) {
          const min = parseInt(attrs.min);
          const nominal = parseInt(attrs.nominal);
          if (min > nominal) {
            warnings.push({
              message: `<type> "${attrs.name}": min (${min}) is greater than nominal (${nominal})`,
              severity: 'warning',
              code: 'MIN_GREATER_THAN_NOMINAL'
            });
          }
        }

        // Validate quantmin/quantmax relationship
        if (attrs.quantmin && attrs.quantmax) {
          const quantmin = parseInt(attrs.quantmin);
          const quantmax = parseInt(attrs.quantmax);
          if (quantmin > quantmax) {
            warnings.push({
              message: `<type> "${attrs.name}": quantmin (${quantmin}) is greater than quantmax (${quantmax})`,
              severity: 'warning',
              code: 'QUANTMIN_GREATER_THAN_QUANTMAX'
            });
          }
        }
      }

      // Validate event positions
      if (childName === 'event' && child.pos) {
        const positions = Array.isArray(child.pos) ? child.pos : [child.pos];
        positions.forEach((pos, posIndex) => {
          if (!pos.$ || !pos.$.x || !pos.$.z) {
            errors.push({
              message: `<event> "${attrs.name}" position ${posIndex} missing x or z coordinate`,
              severity: 'error',
              code: 'MISSING_COORDINATES'
            });
          } else {
            const x = parseFloat(pos.$.x);
            const z = parseFloat(pos.$.z);

            if (isNaN(x) || isNaN(z)) {
              errors.push({
                message: `<event> "${attrs.name}" position ${posIndex} has invalid coordinates`,
                severity: 'error',
                code: 'INVALID_COORDINATES'
              });
            }

            // Check if coordinates are within typical map bounds
            const maxCoord = 15360; // Largest DayZ map
            if (x < 0 || x > maxCoord || z < 0 || z > maxCoord) {
              warnings.push({
                message: `<event> "${attrs.name}" position ${posIndex} coordinates may be out of bounds (${x}, ${z})`,
                severity: 'warning',
                code: 'COORDINATES_OUT_OF_BOUNDS'
              });
            }
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
    const errors = [];
    const warnings = [];
    const info = [];

    // Check if empty
    if (!content || content.trim().length === 0) {
      errors.push({
        line: 0,
        column: 0,
        message: 'File is empty',
        severity: 'error',
        code: 'EMPTY_FILE'
      });
      return { valid: false, errors, warnings, info };
    }

    // Try to parse JSON
    let parsed;
    try {
      parsed = JSON.parse(content);
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
      return { valid: false, errors, warnings, info };
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
      const commonIndent = Math.min(...spaceIndents.map(i => i.length).filter(l => l > 0));
      info.push({
        message: `✓ Using ${commonIndent}-space indentation`,
        code: 'INDENTATION_STYLE'
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      info,
      parsed
    };
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