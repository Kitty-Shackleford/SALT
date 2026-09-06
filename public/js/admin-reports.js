/* eslint-env browser */
/* global fetchWithCsrf */
'use strict';

// Inline script — uses fetchWithCsrf from csrf-helper.js

    let currentStatus = 'all';
    let pendingResolveId = null;

    // ── Guild selector ────────────────────────────────────────────────────────
    async function loadGuilds() {
      try {
        const res   = await fetch('/api/user/guilds');
        const data  = await res.json();
        const guilds = data.guilds || [];
        const sel   = document.getElementById('guildSelect');
        guilds.forEach(g => {
          const opt = document.createElement('option');
          opt.value = esc(g.id);
          opt.textContent = g.name;
          sel.appendChild(opt);
        });
      } catch (_) {
        // Guild selection remains optional when the lookup is unavailable.
      }
    }

    // ── Reports loading ───────────────────────────────────────────────────────
    async function loadReports() {
      const guildId = document.getElementById('guildSelect').value;
      const tbody   = document.getElementById('reports-body');
      tbody.innerHTML = `<tr><td colspan="8" class="text-center py-8 text-gray-400">
        <div class="spinner border-4 border-orange-600 border-t-transparent rounded-full w-8 h-8 mx-auto mb-2"></div>
        Loading…</td></tr>`;

      try {
        const params = new URLSearchParams({ status: currentStatus });
        if (guildId) params.set('guildId', guildId);
        const res  = await fetch('/api/admin/reports?' + params);
        const data = await res.json();

        if (!data.ok || !data.reports.length) {
          tbody.innerHTML = `<tr><td colspan="8" class="text-center py-8 text-gray-400">No reports found</td></tr>`;
          return;
        }

        tbody.innerHTML = data.reports.map(r => {
          const ts        = r.created_at ? new Date(r.created_at).toLocaleString() : '—';
          const badgeCls  = `badge-${r.status}`;
          const canAct    = r.status === 'open';
          return `<tr class="border-t border-gray-700 hover:bg-gray-750">
            <td class="px-4 py-3 text-gray-400">${r.id}</td>
            <td class="px-4 py-3">${esc(r.reporter_name || '—')}</td>
            <td class="px-4 py-3 font-medium">${esc(r.reported_gamertag)}</td>
            <td class="px-4 py-3 max-w-xs truncate" title="${esc(r.reason || '')}">${esc(r.reason || '—')}</td>
            <td class="px-4 py-3 max-w-xs truncate" title="${esc(r.evidence || '')}">
              ${safeEvidenceUrl(r.evidence) ? `<a href="${esc(safeEvidenceUrl(r.evidence))}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:underline">View</a>` : '—'}
            </td>
            <td class="px-4 py-3">
              <span class="px-2 py-1 rounded text-xs font-semibold ${badgeCls}">${r.status}</span>
            </td>
            <td class="px-4 py-3 text-gray-400 text-xs">${ts}</td>
            <td class="px-4 py-3">
              ${canAct ? `
                <button class="bg-green-700 hover:bg-green-600 px-3 py-1 rounded text-xs mr-1" data-action="resolve" data-id="${r.id}">✅ Resolve</button>
                <button class="bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded text-xs" data-action="dismiss" data-id="${r.id}">❌ Dismiss</button>
              ` : '<span class="text-gray-500 text-xs">—</span>'}
            </td>
          </tr>`;
        }).join('');
      } catch (err) {
        console.error('Reports load error:', err);
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-red-400">❌ Failed to load reports</td></tr>`;
      }
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    function openResolveModal(reportId) {
      pendingResolveId = reportId;
      document.getElementById('resolveNote').value = '';
      document.getElementById('resolveModal').classList.remove('hidden');
    }

    async function confirmResolve() {
      if (!pendingResolveId) return;
      const note = document.getElementById('resolveNote').value.trim();
      try {
        const res  = await fetchWithCsrf(`/api/admin/reports/${pendingResolveId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        });
        const data = await res.json();
        if (data.ok) {
          closeResolveModal();
          loadReports();
        } else {
          alert('Failed: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Request failed: ' + err.message);
      }
    }

    async function dismissReport(reportId) {
      if (!confirm('Dismiss this report?')) return;
      try {
        const res  = await fetchWithCsrf(`/api/admin/reports/${reportId}/dismiss`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json();
        if (data.ok) loadReports();
        else alert('Failed: ' + (data.error || 'Unknown error'));
      } catch (err) {
        alert('Request failed: ' + err.message);
      }
    }

    function closeResolveModal() {
      pendingResolveId = null;
      document.getElementById('resolveModal').classList.add('hidden');
    }

    // ── Utility ───────────────────────────────────────────────────────────────
    function esc(str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function safeEvidenceUrl(value) {
      if (!value) return null;
      try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
      } catch (_) {
        return null;
      }
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', async () => {
      await loadGuilds();
      loadReports();

      document.getElementById('guildSelect').addEventListener('change', loadReports);

      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          this.classList.add('active');
          currentStatus = this.dataset.status;
          loadReports();
        });
      });

      document.getElementById('resolveConfirmBtn').addEventListener('click', confirmResolve);
      document.getElementById('resolveCloseBtn').addEventListener('click', closeResolveModal);
      document.getElementById('reports-body').addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const reportId = Number(button.dataset.id);
        if (button.dataset.action === 'resolve') openResolveModal(reportId);
        if (button.dataset.action === 'dismiss') dismissReport(reportId);
      });
    });
