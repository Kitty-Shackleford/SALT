'use strict';

/*
 * AI Config Intelligence
 *
 * Multi-file / cross-file AI editing + balance passes + validation
 * explanation + diff-explain for DayZ config working copies.
 *
 * DESIGN — why patches instead of full-file replacements:
 *   aiService.assertValidReplacement caps AI output at ~40k chars, so a
 *   745KB types.xml can never round-trip as a full replacement. This module
 *   asks the provider for *patch-style* edits (aiConfigPatchService's
 *   xml-search-replace / json-merge) instead: small, targeted edits that the
 *   deterministic engine applies against the real working copy. Each patch is
 *   validated independently BEFORE anything is stored (unique search span,
 *   well-formed result), then materialized into the existing
 *   original_content -> suggested_content shape so the existing apply /
 *   claim-lease / diff / PR machinery is untouched. The raw patch and a
 *   base_content_hash (sha256 of the working copy the patch was validated
 *   against) are stored alongside for drift detection and audit.
 *
 *   Multi-file requests: one request names an ordered list of files; the
 *   provider returns a single JSON document carrying one patch per file; all
 *   are validated all-or-nothing and stored as one linked suggestion group
 *   (ai_suggestion_groups anchor row + per-file rows with group_id).
 *
 *   Balance pass: a plain-language goal ("make early game harder") across
 *   types.xml / events.xml / randompresets.xml returns 2-4 coordinated patch
 *   suggestions, each with its own rationale.
 *
 *   Diff-explain: generated at suggestion creation time (AI when a provider
 *   is available, deterministic line-delta fallback otherwise) and stored on
 *   the suggestion row (diff_explanation) so the UI can show a plain-language
 *   delta of every applied suggestion. The apply/finalization path stays
 *   purely deterministic — no provider call on the critical path.
 *
 * All provider calls go through aiService.callProvider (per-user key >
 * Copilot > shared router > operator key); routes consume the shared-router
 * quota via the existing prepareAiProvider path.
 */

const aiService = require('./aiService');
const patchEngine = require('./aiConfigPatchService');
const configValidatorService = require('./configValidatorService');

const MAX_FILES_PER_REQUEST = 5;
const MAX_SUGGESTIONS = 6;
const MAX_DIFF_EXPLAIN_LINES = 60;
const MAX_BALANCE_FILES = 4;

// ─── Errors ─────────────────────────────────────────────────────────────────

function intelligenceError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// ─── Request normalization ──────────────────────────────────────────────────

/**
 * Validate + normalize a request file list.
 * @param {Array<{filename:string, fileContent:string}>} files
 * @returns {Array<{filename, content}>}
 */
function normalizeFileList(files, { maxFiles = MAX_FILES_PER_REQUEST } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw intelligenceError('CONFIG_FILES_REQUIRED', 'At least one working-copy file is required');
  }
  if (files.length > maxFiles) {
    throw intelligenceError('CONFIG_FILES_TOO_MANY', `At most ${maxFiles} files per request`);
  }
  const seen = new Set();
  const out = [];
  for (const file of files) {
    if (!file || typeof file.filename !== 'string' || !file.filename.trim()) {
      throw intelligenceError('CONFIG_FILE_INVALID', 'Each file needs a filename');
    }
    if (typeof file.fileContent !== 'string' || !file.fileContent.trim()) {
      throw intelligenceError('CONFIG_FILE_INVALID', `${file.filename}: complete file content is required`);
    }
    const key = file.filename;
    if (seen.has(key)) throw intelligenceError('CONFIG_FILE_DUPLICATE', `Duplicate file: ${key}`);
    seen.add(key);
    out.push({ filename: key, content: file.fileContent });
  }
  return out;
}

// ─── Prompt construction ────────────────────────────────────────────────────

const PATCH_SYSTEM = [
  'You are an expert DayZ server administrator assistant.',
  'You edit DayZ config files (types.xml, events.xml, globals.xml, economy.xml,',
  'randompresets.xml, cfg*.xml, *.json) using a strict patch protocol.',
  '',
  'PATCH PROTOCOL (follow exactly):',
  'Return ONE fenced ```json block containing ONLY a JSON document of this shape:',
  '{',
  '  "suggestions": [',
  '    {',
  '      "file": "<exact filename from the request>",',
  '      "rationale": "<one or two sentences: what and why>",',
  '      "patch": {',
  '        "kind": "xml-search-replace",',
  '        "edits": [ { "search": "<verbatim block copied from the file, whitespace-insensitive>", "replace": "<the new block>" } ]',
  '      }',
  '    }',
  '  ]',
  '}',
  '',
  'Rules:',
  '- Every "search" block MUST be copied verbatim from the provided file content (matching is whitespace-insensitive but the tags/values must be exact) and must occur EXACTLY ONCE in that file. Include enough surrounding context to make it unique.',
  '- "replace" is the full new text for that same span. The result must remain well-formed XML / valid JSON.',
  '- For JSON files use {"kind":"json-merge","patch":{...}} instead: keys set to null are deleted, nested objects merge recursively, arrays are replaced wholesale.',
  '- Make MINIMAL, targeted edits. Do not reformat or reorder anything you are not asked to change.',
  '- Never reference a file that was not included in the request.',
  '- Put no prose inside the fenced JSON block. Any explanation goes in "rationale".',
].join('\n');

function buildFileSection(filename, content) {
  return `--- File: ${filename} ---\n\`\`\`\n${content}\n\`\`\``;
}

function planPrompt({ instruction, goal, files }) {
  const filesText = files.map(f => buildFileSection(f.filename, f.content)).join('\n\n');
  const task = goal
    ? `BALANCE PASS — Goal: ${goal}\n\nMake coordinated, minimal changes across the included files to achieve the goal. Suggest 2-${MAX_BALANCE_FILES} patches across DIFFERENT files where possible (e.g. types.xml spawn rates, events.xml event frequency, randompresets.xml presets). Each patch must stand on its own; together they implement the goal.`
    : `Apply the following instruction to the included file(s):\n\nINSTRUCTION: ${instruction}`;
  return [
    task,
    '',
    `Include these files (use their exact names in "file"):`,
    files.map(f => `- ${f.filename}`).join('\n'),
    '',
    filesText,
    '',
    'Respond now with exactly one fenced ```json block per the protocol.',
  ].join('\n');
}

// ─── Response parsing + materialization ─────────────────────────────────────

/** Extract the first fenced block from a provider response. */
function extractFencedBlock(response) {
  const match = String(response || '').match(/```(?:json|xml)?\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

/**
 * Parse the provider's JSON plan and materialize every patch against the real
 * file content. ALL-OR-NOTHING: if any file's patch fails, no suggestion is
 * returned — the caller gets per-file structured errors.
 *
 * @returns {{ suggestions: Array<{filename, explanation, patch, originalContent, suggestedContent, baseContentHash, diffSummary}> }}
 * @throws {Error} intelligenceError with code 'CONFIG_PATCH_<...>' and
 *                 error.fileErrors = [{file, code, message}]
 */
function parseAndMaterialize(response, files) {
  const block = extractFencedBlock(response);
  if (!block) throw intelligenceError('CONFIG_PATCH_NO_BLOCK', 'AI response contained no fenced JSON block');

  let plan;
  try { plan = JSON.parse(block); }
  catch (error) {
    throw intelligenceError('CONFIG_PATCH_INVALID_JSON', `AI plan is not valid JSON: ${error.message}`);
  }
  const rawSuggestions = plan?.suggestions;
  if (!Array.isArray(rawSuggestions) || rawSuggestions.length === 0) {
    throw intelligenceError('CONFIG_PATCH_EMPTY', 'AI plan contained no suggestions');
  }

  const byFile = new Map(files.map(f => [f.filename, f]));
  const suggestions = [];
  const fileErrors = [];

  for (const raw of rawSuggestions.slice(0, MAX_SUGGESTIONS)) {
    const filename = typeof raw?.file === 'string' ? raw.file : null;
    const file = filename ? byFile.get(filename) : null;
    if (!file) {
      fileErrors.push({ file: filename || '(unknown)', code: 'FILE_NOT_IN_REQUEST', message: 'AI referenced a file that was not in the request' });
      continue;
    }
    try {
      const applied = patchEngine.applyPatch(filename, file.content, raw.patch);
      suggestions.push({
        filename,
        explanation: typeof raw.rationale === 'string' && raw.rationale.trim()
          ? raw.rationale.trim()
          : `AI patch for ${filename}`,
        patch: raw.patch,
        originalContent: file.content,
        suggestedContent: applied.content,
        appliedEdits: applied.appliedEdits,
        baseContentHash: patchEngine.contentFingerprint(file.content),
        diffSummary: patchEngine.diffSummary(file.content, applied.content, MAX_DIFF_EXPLAIN_LINES),
      });
    } catch (error) {
      fileErrors.push({
        file: filename,
        code: error.code || 'PATCH_FAILED',
        message: error.message || 'Patch failed validation',
      });
    }
  }

  if (fileErrors.length > 0) {
    const error = intelligenceError(
      'CONFIG_PATCH_INVALID',
      `Patch validation failed for ${fileErrors.length} of ${rawSuggestions.length} file(s)`
    );
    error.fileErrors = fileErrors;
    throw error;
  }
  if (suggestions.length === 0) throw intelligenceError('CONFIG_PATCH_EMPTY', 'No usable suggestions in the AI plan');
  return { suggestions };
}

// ─── Public: multi-file edit + balance pass ─────────────────────────────────

/**
 * One provider call that returns validated, materialized patch suggestions.
 *
 * @param {object} db
 * @param {number} serverId
 * @param {object} params
 * @param {string} [params.instruction] - plain-English edit instruction (multi-file edit)
 * @param {string} [params.goal]        - plain-English balance goal (balance pass)
 * @param {Array}  params.files         - normalized file list (see normalizeFileList)
 * @param {object} provider             - resolved provider descriptor
 */
async function planPatchSuggestions(db, serverId, { instruction, goal, files, provider }) {
  const context = await aiService.buildServerContext(db, serverId);
  const system = [PATCH_SYSTEM, '', context ? `--- Server Data ---\n${context}` : ''].join('\n').trim();
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: planPrompt({ instruction, goal, files }) },
  ];
  const response = await aiService.callProvider(messages, 0.2, provider);
  const { suggestions } = parseAndMaterialize(response, files);
  return suggestions;
}

// ─── Public: config validation + AI explanation ─────────────────────────────

/**
 * Deterministic validation of one working-copy file (configValidatorService)
 * plus an optional plain-language AI explanation of the findings.
 * @returns {{ valid, documentType, findings, aiExplanation: string|null }}
 */
async function validateAndExplain({ filename, content, provider, question }) {
  const result = configValidatorService.validateConfigFile(filename, content);
  let aiExplanation = null;
  if (provider) {
    const findingLines = result.findings
      .filter(f => f.severity !== 'info')
      .slice(0, 20)
      .map(f => `[${f.severity}] ${f.code}: ${f.message}`)
      .join('\n') || '(no non-info findings — the file passed deterministic validation)';
    const messages = [
      {
        role: 'system',
        content: 'You explain DayZ server config validation results in plain language for a server owner. Be concrete and short (2-4 sentences). Never invent findings that are not listed.',
      },
      {
        role: 'user',
        content: [
          `File: ${filename}`,
          `Valid: ${result.valid}`,
          '',
          'Deterministic findings:',
          findingLines,
          '',
          question
            ? `Context question: ${question}`
            : 'Explain the findings above in plain language, including what would break in-game if a "error" finding is left unfixed.',
        ].join('\n'),
      },
    ];
    try {
      aiExplanation = await aiService.callProvider(messages, 0.2, provider);
    } catch (_error) {
      aiExplanation = null; // deterministic report still stands
    }
  }
  return { ...result, aiExplanation };
}

// ─── Public: diff-explain ────────────────────────────────────────────────────

/**
 * Deterministic plain-language delta for a stored suggestion. Used as the
 * guaranteed fallback so every suggestion row can carry a diff_explanation
 * even when no provider is connected.
 */
function deterministicDiffExplanation(suggestion) {
  const summary = suggestion.diffSummary ||
    patchEngine.diffSummary(suggestion.originalContent || '', suggestion.suggestedContent || '');
  const added = summary.addedCount ?? 0;
  const removed = summary.removedCount ?? 0;
  const parts = [];
  if (added) parts.push(`adds ${added} line(s)`);
  if (removed) parts.push(`removes ${removed} line(s)`);
  const verb = parts.length ? parts.join(' and ') : 'makes no line changes';
  return `This edit to ${suggestion.filename} ${verb}.`;
}

/**
 * Plain-language explanation of the delta between a suggestion's original and
 * suggested content. AI prose when a provider is available; deterministic
 * line-delta fallback otherwise.
 * @returns {Promise<string>}
 */
async function explainDiff(suggestion, provider) {
  if (!provider) return deterministicDiffExplanation(suggestion);
  const summary = suggestion.diffSummary ||
    patchEngine.diffSummary(suggestion.originalContent || '', suggestion.suggestedContent || '');
  const added = (summary.addedLines || []).slice(0, MAX_DIFF_EXPLAIN_LINES);
  const removed = (summary.removedLines || []).slice(0, MAX_DIFF_EXPLAIN_LINES);
  const messages = [
    {
      role: 'system',
      content: 'You are a DayZ server administrator assistant. Explain file changes in plain language, in 1-3 short sentences, for a server owner. Reference concrete values (item names, numbers) when present.',
    },
    {
      role: 'user',
      content: [
        `File: ${suggestion.filename}`,
        suggestion.explanation ? `Suggested change: ${suggestion.explanation}` : '',
        '',
        removed.length ? `Removed lines:\n${removed.map(l => `- ${l}`).join('\n')}` : 'Removed lines: (none)',
        added.length ? `Added lines:\n${added.map(l => `+ ${l}`).join('\n')}` : 'Added lines: (none)',
        summary.addedCount > added.length || summary.removedCount > removed.length
          ? `(…and more; total +${summary.addedCount} / -${summary.removedCount} lines)`
          : '',
        '',
        'Explain in plain language what this change does to the server config.',
      ].filter(Boolean).join('\n'),
    },
  ];
  try {
    const reply = await aiService.callProvider(messages, 0.2, provider);
    const text = String(reply || '').trim();
    return text || deterministicDiffExplanation(suggestion);
  } catch (_error) {
    return deterministicDiffExplanation(suggestion);
  }
}

module.exports = {
  MAX_FILES_PER_REQUEST,
  MAX_SUGGESTIONS,
  MAX_BALANCE_FILES,
  PATCH_SYSTEM,
  intelligenceError,
  normalizeFileList,
  planPrompt,
  parseAndMaterialize,
  planPatchSuggestions,
  validateAndExplain,
  deterministicDiffExplanation,
  explainDiff,
};
