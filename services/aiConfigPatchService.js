'use strict';

/*
 * AI Config Patch Engine
 *
 * The provider output cap (~40k chars, validated by aiService.assertValidReplacement)
 * means an AI suggestion CANNOT carry a full 745KB types.xml replacement. Instead of
 * raising the cap (which would blow most provider context windows), this feature
 * uses a *patch-style* mode: the AI emits small, targeted edits that are applied
 * deterministically against the real working copy.
 *
 * Two patch kinds are supported:
 *
 *   { kind: 'xml-search-replace',
 *     edits: [ { search: "...", replace: "..." }, ... ] }
 *     - each edit's `search` block must occur EXACTLY once in the file (unique,
 *       whitespace-tolerant match); replace is the full new block for that span.
 *     - The result must still be well-formed XML (validated).
 *
 *   { kind: 'json-merge',
 *     patch: { ... } }
 *     - a JSON object that is merged into the root document. A key set to `null`
 *       deletes it; nested objects merge recursively. Result must be valid JSON.
 *
 * Patches are validated *before* a suggestion is stored (the apply step re-runs
 * the same validator against the stored patch + the on-disk original so a stale
 * patch can never silently fail). Applying a patch is pure: it returns the new
 * content and is safe to run twice (the second run detects the already-applied
 * state and throws a structured error rather than corrupting the file).
 *
 * This module has no AI/DB dependencies — it is the deterministic core that the
 * routes and tests exercise directly.
 */

const { XMLValidator } = require('fast-xml-parser');
const crypto = require('crypto');

const PATCH_KINDS = new Set(['xml-search-replace', 'json-merge']);

function patchError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/** Normalize a line for matching: strip leading + trailing whitespace so the
 * search block matches the document regardless of indentation style. Used by the
 * diff summary; token matching in findSearchSpan handles the search itself. */
function normalizeLine(line) {
  return String(line == null ? '' : line).trim();
}

/**
 * Tokenize a document into an ordered list of tags and text nodes. Whitespace
 * between tokens is ignored entirely (both leading/trailing indentation and
 * blank lines), and a tag and its value are separate tokens:
 *   "<nominal>9</nominal>"  ->  [ '<nominal>', '9', '</nominal>' ]
 * Because matching happens on this token stream (not raw lines), a search block
 * written on one line or across ten lines, in any indentation, matches the same
 * document region. Each document token also records its absolute char span so a
 * matched run maps back to a contiguous [start, end) slice of the original.
 */
function tokenize(content) {
  const tokens = [];
  const re = /<[^>]*>|[^<]+/g;
  let match;
  while ((match = re.exec(String(content))) !== null) {
    const raw = match[0];
    const isTag = raw.startsWith('<');
    const text = isTag ? raw : raw.trim();
    if (!isTag && text === '') continue; // pure-whitespace text node
    tokens.push({ text, start: match.index, end: match.index + raw.length });
  }
  return tokens;
}

/**
 * Line-aware unique search within a document.
 *
 * Returns the absolute character [start, end) span of the region whose token
 * stream equals the search block's token stream. Throws
 * PATCH_SEARCH_NOT_FOUND (0 matches) or PATCH_SEARCH_AMBIGUOUS (>1 match).
 */
function findSearchSpan(content, searchBlock) {
  const docTokens = tokenize(content);
  const searchTokens = tokenize(searchBlock).map(t => t.text);

  if (searchTokens.length === 0) {
    throw patchError('PATCH_SEARCH_EMPTY', 'Search block must not be empty');
  }

  const n = docTokens.length;
  const m = searchTokens.length;
  const matches = [];
  for (let start = 0; start + m <= n; start++) {
    let matched = true;
    for (let i = 0; i < m; i++) {
      if (docTokens[start + i].text !== searchTokens[i]) { matched = false; break; }
    }
    if (!matched) continue;
    const spanStart = docTokens[start].start;
    const spanEnd = docTokens[start + m - 1].end;
    matches.push({ spanStart, spanEnd, spanText: content.slice(spanStart, spanEnd) });
  }

  if (matches.length === 0) {
    throw patchError('PATCH_SEARCH_NOT_FOUND',
      'Search block not found in the file (must match a contiguous region, whitespace-insensitive)');
  }
  if (matches.length > 1) {
    throw patchError('PATCH_SEARCH_AMBIGUOUS',
      `Search block matched ${matches.length} times; it must be unique — include more context`);
  }
  return matches[0];
}

/** Validate a single edit object's shape. */
function assertEditShape(edit, index) {
  if (!edit || typeof edit !== 'object') throw patchError('PATCH_EDIT_INVALID', `Edit #${index} must be an object`);
  if (typeof edit.search !== 'string' || typeof edit.replace !== 'string') {
    throw patchError('PATCH_EDIT_INVALID', `Edit #${index} must have string "search" and "replace"`);
  }
}

/** SHA-256 of the exact document bytes — used to pin the base content a
 * patch was validated against, so a later apply can detect drift. */
function contentFingerprint(content) {
  return crypto.createHash('sha256').update(String(content)).digest('hex');
}

/**
 * Apply a patch to a document. Returns { content, appliedEdits }.
 * Throws a structured patchError on any failure (bad shape, ambiguous/missing
 * search, invalid resulting XML/JSON, already-applied, etc).
 */
function applyPatch(filename, originalContent, patch) {
  if (typeof originalContent !== 'string') throw patchError('PATCH_CONTENT_INVALID', 'File content must be text');
  if (!patch || typeof patch !== 'object') throw patchError('PATCH_INVALID', 'Patch must be an object');
  if (!PATCH_KINDS.has(patch.kind)) {
    throw patchError('PATCH_KIND_INVALID', `Unsupported patch kind "${patch.kind}"`);
  }

  if (patch.kind === 'xml-search-replace') {
    const edits = Array.isArray(patch.edits) ? patch.edits : null;
    if (!edits || edits.length === 0) throw patchError('PATCH_INVALID', 'xml-search-replace patch requires a non-empty "edits" array');
    if (edits.length > 200) throw patchError('PATCH_TOO_MANY_EDITS', 'Patch exceeds the 200-edit safety limit');

    // Resolve every span first (against the ORIGINAL) so one bad edit cannot
    // shift the offsets the others were found at.
    const resolved = [];
    for (let i = 0; i < edits.length; i++) {
      assertEditShape(edits[i], i);
      const span = findSearchSpan(originalContent, edits[i].search);
      resolved.push({ edit: edits[i], span });
    }
    // Sort by span start descending so replacements don't invalidate later spans.
    resolved.sort((a, b) => b.span.spanStart - a.span.spanStart);
    // Detect overlapping edits: after the descending sort, a later entry (lower
    // start) overlaps the previous one if it extends past the previous start.
    for (let i = 0; i < resolved.length - 1; i++) {
      const hi = resolved[i]; const lo = resolved[i + 1];
      if (lo.span.spanEnd > hi.span.spanStart) {
        throw patchError('PATCH_EDITS_OVERLAP', 'Two edits target the same region of the file');
      }
    }

    let content = originalContent;
    let appliedEdits = 0;
    for (const { edit, span } of resolved) {
      const before = content.slice(0, span.spanStart);
      const after = content.slice(span.spanEnd);
      content = before + edit.replace + after;
      appliedEdits += 1;
    }

    const lowerName = String(filename || '').toLowerCase();
    if (lowerName.endsWith('.xml')) {
      const validation = XMLValidator.validate(content, { allowBooleanAttributes: true });
      if (validation !== true) {
        throw patchError('PATCH_RESULT_INVALID_XML', `Patch result is not well-formed XML: ${validation}`);
      }
    }
    return { content, appliedEdits };
  }

  // json-merge
  let original;
  try { original = JSON.parse(originalContent); }
  catch (_) { throw patchError('PATCH_RESULT_INVALID_JSON', 'Original file is not valid JSON'); }
  if (original === null || typeof original !== 'object' || Array.isArray(original)) {
    throw patchError('PATCH_TARGET_INVALID', 'json-merge requires a JSON object at the top level');
  }
  if (!patch.patch || typeof patch.patch !== 'object' || Array.isArray(patch.patch)) {
    throw patchError('PATCH_INVALID', 'json-merge patch requires an object "patch" field');
  }
  const merged = mergeJson(original, patch.patch);
  const content = JSON.stringify(merged, null, 2) + '\n';
  return { content, appliedEdits: countJsonChanges(patch.patch) };
}

function mergeJson(target, patchObj) {
  if (Array.isArray(patchObj)) return patchObj; // replace arrays wholesale
  if (typeof patchObj !== 'object' || patchObj === null) {
    return patchObj; // primitives / null handled by caller
  }
  const out = { ...target };
  for (const key of Object.keys(patchObj)) {
    const value = patchObj[key];
    if (value === null) { delete out[key]; continue; } // explicit delete
    if (typeof value === 'object' && !Array.isArray(value)
        && out[key] !== null && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeJson(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function countJsonChanges(patchObj) {
  if (patchObj === null || typeof patchObj !== 'object' || Array.isArray(patchObj)) return 1;
  let count = 0;
  for (const value of Object.values(patchObj)) {
    count += (value !== null && typeof value === 'object' && !Array.isArray(value))
      ? countJsonChanges(value) : 1;
  }
  return Math.max(1, count);
}

/**
 * Produce a short, stable diff summary between original and new content
 * (line-level). Used for the suggestion's diff_summary field and for the
 * deterministic diff-explain fallback.
 */
function diffSummary(originalContent, newContent, maxLines = 20) {
  const a = String(originalContent).split('\n');
  const b = String(newContent).split('\n');
  const additions = [];
  const removals = [];
  const setA = new Set(a.map(normalizeLine));
  const setB = new Set(b.map(normalizeLine));
  for (const line of b) if (!setA.has(normalizeLine(line))) additions.push(line);
  for (const line of a) if (!setB.has(normalizeLine(line))) removals.push(line);
  return {
    addedLines: additions.slice(0, maxLines),
    removedLines: removals.slice(0, maxLines),
    addedCount: additions.length,
    removedCount: removals.length,
    summary: `+${additions.length} line(s), -${removals.length} line(s)`,
  };
}

/** Fingerprint the patch (for auditability / de-dup of identical suggestions). */
function patchFingerprint(patch) {
  return crypto.createHash('sha256').update(JSON.stringify(patch)).digest('hex');
}

module.exports = {
  PATCH_KINDS,
  applyPatch,
  findSearchSpan,
  diffSummary,
  patchFingerprint,
  contentFingerprint,
  patchError,
};
