/* global window */
/*
 * Operations alerts panel (AI 7c) — renders the ops-intelligence picture in
 * the dashboard's "Operations alerts" panel:
 *   - active predictive crash/lag precursors with severity badges
 *     (severity color PLUS icon + uppercase text — never color alone) and
 *     "preceded this server's crash on <date>" context when present
 *   - latest deterministic lag-cause findings + top suggestions. ADVISE-ONLY:
 *     review/apply lives on the AI Assistant page, so this panel renders no
 *     apply button (matching the backend contract — suggestions never
 *     auto-apply).
 *   - rollback advisor headline with a confirm-gated link to the existing
 *     mission-file restore flow (authorization unchanged — just a link).
 *
 * Data sources (card 7a/7b endpoints, frontend-only):
 *   GET  /api/ai/ops-intelligence/:psid   — polling-safe, idempotent
 *   GET  /api/ai/ops-rollback/:psid       — polling-safe, idempotent
 *   POST /api/ai/ops-remediation/:psid    — persists a reviewable suggestion
 *                                           group per call, so the page runs
 *                                           it ONCE per load, never in the
 *                                           poll loop
 *
 * Per-server fetch isolation: one server's failed fetch renders its own
 * error row; the rest of the panel stays (card 4/9 polling-loop contract).
 *
 * Browser build exposes window.dzcOps; Node build exports for
 * scripts/dashboard-ops-panel-test.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  } else {
    root.dzcOps = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch];
    });
  }

  // Severity -> theme tier. Warnings use critical/high/medium (7a contract).
  function severityTier(sev) {
    return sev === 'critical' || sev === 'high' ? 'danger' : 'warning';
  }

  // Icon + uppercase text give the non-color cue; the tier colors the border.
  function severityBadge(sev) {
    var tier = severityTier(sev);
    return '<span class="dzc-sev" data-sev="' + escapeHtml(sev || 'warn') + '" data-tier="' + tier + '">' +
      (tier === 'danger' ? '⛔' : '⚠️') + ' ' + escapeHtml(String(sev || 'warn').toUpperCase()) +
      '</span>';
  }

  function formatDate(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return String(iso == null ? '' : iso);
    return d.toLocaleString();
  }

  /**
   * Fetch the two polling-safe ops endpoints for one server.
   * Never rejects on a per-endpoint failure — failures are captured in the
   * returned state so the caller can isolate them per server.
   * @returns {Promise<{serverId, summary, warningsError, rollback, rollbackError}>}
   */
  async function fetchOpsForServer(platformServerId, fetchImpl) {
    var f = typeof fetchImpl === 'function' ? fetchImpl : fetch;
    var id = encodeURIComponent(platformServerId);
    var results = await Promise.allSettled([
      f('/api/ai/ops-intelligence/' + id).then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
      f('/api/ai/ops-rollback/' + id).then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
    ]);
    var state = {
      serverId: platformServerId,
      serverName: null,
      summary: null,
      warningsError: null,
      rollback: null,
      rollbackError: null,
    };
    if (results[0].status === 'fulfilled') {
      state.summary = (results[0].value && results[0].value.summary) || null;
    } else {
      state.warningsError = reasonText(results[0].reason);
    }
    if (results[1].status === 'fulfilled') {
      state.rollback = results[1].value || null;
    } else {
      state.rollbackError = reasonText(results[1].reason);
    }
    return state;
  }

  function reasonText(reason) {
    return (reason && reason.message) ? String(reason.message) : String(reason);
  }

  /**
   * Run the deterministic lag-cause analysis. Persists a reviewable
   * suggestion group server-side — the page calls this once per load
   * (plus on explicit re-run), never from the poll loop.
   * @returns {Promise<{atMs, causes, sampleCount, suggestions}>}
   */
  async function runLagRemediation(platformServerId, fetchImpl) {
    var f = typeof fetchImpl === 'function' ? fetchImpl : fetch;
    var res = await f('/api/ai/ops-remediation/' + encodeURIComponent(platformServerId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data || !data.success) throw new Error((data && data.error) || 'Lag analysis failed');
    var analysis = data.analysis || {};
    return {
      atMs: Date.now(),
      causes: Array.isArray(analysis.causes) ? analysis.causes : [],
      sampleCount: typeof analysis.sampleCount === 'number' ? analysis.sampleCount : null,
      suggestions: Array.isArray(data.suggestions) ? data.suggestions.slice(0, 3) : [],
    };
  }

  function warningRows(warnings) {
    if (!Array.isArray(warnings) || warnings.length === 0) {
      return '<p class="dzc-ops-emptyline">✓ No active warnings</p>';
    }
    return warnings.map(w => {
      var count = (w && w.occurrences != null) ? ' <span class="dzc-ops-warn-detail">' + escapeHtml(String(w.occurrences)) + '×</span>' : '';
      var preceded = (w && w.lastCrashPreceded && w.lastCrashPreceded.at)
        ? '<span class="dzc-ops-warn-detail">preceded this server\'s crash on ' + escapeHtml(formatDate(w.lastCrashPreceded.at)) + '</span>'
        : '';
      return '<div class="dzc-ops-warn">' + severityBadge(w && w.severity) +
        '<span class="dzc-ops-warn-text">' + escapeHtml((w && w.label) || 'warning') + count + '</span>' +
        preceded + '</div>';
    }).join('');
  }

  // Compact context line under the warnings (server-provided numbers only).
  function ceLoopContext(summary) {
    if (!summary) return '';
    var parts = [];
    var ce = summary.ceLoop;
    if (ce && ce.samples) {
      parts.push('CE loop: ' + ce.samples + ' samples, avg ' + ce.avgSeconds + 's (max ' + ce.maxSeconds + 's)');
    }
    if (summary.lastCrashAt) parts.push('last crash ' + formatDate(summary.lastCrashAt));
    if (summary.recentCrashCount) {
      parts.push(summary.recentCrashCount + ' recent crash window' + (summary.recentCrashCount > 1 ? 's' : ''));
    }
    if (!parts.length) return '';
    return '<p class="dzc-ops-warn-detail dzc-ops-context">' + escapeHtml(parts.join(' · ')) + '</p>';
  }

  function lagSection(serverId, rem) {
    if (!rem) return '<p class="dzc-ops-emptyline">Lag analysis running…</p>';
    if (rem.error) {
      return '<div class="dzc-error-row">⛔ Lag analysis unavailable (' + escapeHtml(rem.error) + ')</div>';
    }
    var causes = rem.causes || [];
    var rows = causes.map(c =>
      '<div class="dzc-ops-warn">' + severityBadge(c.severity) +
      '<span class="dzc-ops-warn-text">' + escapeHtml((c && c.label) || (c && c.id) || 'cause') + '</span>' +
      (c && c.evidence ? '<span class="dzc-ops-warn-detail">' + escapeHtml(c.evidence) + '</span>' : '') +
      '</div>'
    ).join('');
    if (causes.length === 0) {
      rows = '<p class="dzc-ops-emptyline">✓ No lag causes in the last 24h' +
        (rem.sampleCount != null ? ' (' + escapeHtml(String(rem.sampleCount)) + ' tick samples)' : '') + '</p>';
    }
    var suggestions = (rem.suggestions || []).map(sg =>
      '<div class="dzc-ops-suggest">✏️ ' + escapeHtml((sg && sg.filename) || '') +
      (sg && sg.diff_summary ? ' — ' + escapeHtml(sg.diff_summary) : '') + '</div>'
    ).join('');
    // ADVISE-ONLY: the apply/review UI is the AI Assistant page, not this panel.
    var link = (rem.suggestions && rem.suggestions.length)
      ? '<a class="dzc-ops-link" href="/dashboard/ai-assistant">Review suggestions in AI Assistant →</a>'
      : '';
    return rows + suggestions + link;
  }

  function rollbackBlock(serverId, headline) {
    var message = escapeHtml(headline.message ||
      'edit at ' + formatDate(headline.editAt) + ' degraded tick time ~' + Math.abs(headline.deltaPct || 0) + '%');
    var confirmText = message +
      ' Restoring overwrites the current working copy with the backup version. Continue to the mission editor?';
    var href = '/mission-editor?server=' + encodeURIComponent(String(serverId));
    return '<div class="dzc-ops-rollback">' +
      '<div class="dzc-ops-warn">' + severityBadge('warning') +
      '<span class="dzc-ops-warn-text">' + message + '</span></div>' +
      '<a class="dzc-ops-link dzc-ops-restore-link" href="' + escapeHtml(href) + '" ' +
      'data-confirm="' + escapeHtml(confirmText) + '">restore this version? →</a>' +
      '</div>';
  }

  function renderServerBlock(s, rem) {
    var html = '<div class="dzc-ops-server">';
    html += '<div class="dzc-ops-server-head"><strong>' + escapeHtml(s.serverName || s.serverId) +
      '</strong><span class="dzc-ops-sub">' + escapeHtml(String(s.serverId)) + '</span></div>';
    if (s.warningsError) {
      html += '<div class="dzc-error-row">⛔ Warnings unavailable (' + escapeHtml(s.warningsError) + ')</div>';
    } else {
      html += '<div class="dzc-ops-section-label">Predictive warnings</div>';
      html += warningRows(s.summary ? s.summary.activeWarnings : null);
      html += ceLoopContext(s.summary);
    }
    html += '<div class="dzc-ops-section-label">Lag findings' +
      (rem && rem.atMs ? ' — analyzed ' + escapeHtml(formatDate(new Date(rem.atMs).toISOString())) : '') +
      '</div>';
    html += lagSection(s.serverId, rem);
    var headline = s.rollback && s.rollback.headline;
    if (s.rollbackError) {
      html += '<div class="dzc-error-row">⛔ Rollback advisor unavailable (' + escapeHtml(s.rollbackError) + ')</div>';
    } else if (headline) {
      html += rollbackBlock(s.serverId, headline);
    }
    html += '</div>';
    return html;
  }

  /**
   * Full panel body. `state` is { [serverId]: per-server state }, `remediation`
   * is { [serverId]: {atMs, causes, sampleCount, suggestions} | {error} }.
   */
  function renderOpsPanel(state, remediation) {
    state = state || {};
    remediation = remediation || {};
    var ids = Object.keys(state);
    if (ids.length === 0) {
      return '<div class="dzc-empty"><div class="dzc-empty-icon">🎖️</div>' +
        '<div class="dzc-empty-title">No active servers</div>' +
        '<div>Connect a Nitrado account to see operations alerts.</div></div>';
    }
    return ids.map(id => renderServerBlock(state[id], remediation[id] || null)).join('');
  }

  // Items for the card 4 attention strip (capped — the strip is shared with
  // sync-job and health items).
  function opsAttentionItems(state) {
    var items = [];
    Object.keys(state || {}).forEach(id => {
      var s = state[id] || {};
      var prefix = s.serverName ? s.serverName + ': ' : '';
      (s.summary && s.summary.activeWarnings || []).forEach(w => {
        if (items.length >= 4) return;
        var tier = severityTier(w && w.severity);
        items.push({
          severity: tier,
          icon: tier === 'danger' ? '⛔' : '⚠️',
          text: prefix + ((w && w.label) || 'warning') +
            (w && w.occurrences != null ? ' (' + w.occurrences + '×)' : ''),
        });
      });
      var h = s.rollback && s.rollback.headline;
      if (h && items.length < 4) {
        items.push({
          severity: 'warning',
          icon: '⚠️',
          text: prefix + 'rollback advisor: ' + ((h.fileName) || 'config edit') +
            ' degraded ~' + Math.abs(h.deltaPct || 0) + '%',
        });
      }
    });
    return items.slice(0, 4);
  }

  /**
   * Confirm-gated navigation for the rollback restore link. The restore
   * endpoint keeps its own authorization; this only adds the human
   * confirmation step before leaving the dashboard.
   */
  function gatedRestore(el, opts) {
    opts = opts || {};
    var confirmFn = typeof opts.confirm === 'function' ? opts.confirm
      : function (msg) { return typeof window !== 'undefined' && window.confirm(msg); };
    var navigateFn = typeof opts.navigate === 'function' ? opts.navigate
      : function (href) { if (typeof window !== 'undefined') window.location.href = href; };
    if (!el || typeof el.getAttribute !== 'function') return false;
    var text = el.getAttribute('data-confirm');
    var href = el.getAttribute('href');
    if (!text || !href) return false;
    if (!confirmFn(text)) return false;
    navigateFn(href);
    return true;
  }

  return {
    escapeHtml: escapeHtml,
    severityTier: severityTier,
    fetchOpsForServer: fetchOpsForServer,
    runLagRemediation: runLagRemediation,
    renderOpsPanel: renderOpsPanel,
    renderServerBlock: renderServerBlock,
    opsAttentionItems: opsAttentionItems,
    gatedRestore: gatedRestore,
  };
}));
