/* eslint-env browser */
'use strict';

// ── CSRF ────────────────────────────────────────────────────────────────
    let csrfToken = '';
    async function loadCsrf() {
      const r = await fetch('/api/csrf-token');
      const d = await r.json();
      csrfToken = d.token || d.csrfToken || '';
    }

    // ── State ───────────────────────────────────────────────────────────────
    let currentServerId = null;
    let allSnippets     = [];
    let allPresets      = [];
    let editingSnippetId = null;
    let editingPresetId  = null;
    let addSnippetTargetPresetId = null;

    // ── Tab switching ────────────────────────────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => {
          b.className = 'tab-btn bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded';
        });
        btn.className = 'tab-btn bg-blue-600 px-4 py-2 rounded';
        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        document.getElementById('tab-' + tab).classList.remove('hidden');
      });
    });

    // ── Server selector ──────────────────────────────────────────────────────
    async function loadServers() {
      const r = await fetch('/api/owner/servers');
      const d = await r.json();
      const sel = document.getElementById('serverSelect');
      sel.innerHTML = '<option value="">Select server…</option>';
      (d.servers || []).forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name || `Server ${s.id}`;
        sel.appendChild(opt);
      });
    }

    document.getElementById('serverSelect').addEventListener('change', async function () {
      currentServerId = this.value || null;
      if (!currentServerId) return;
      await Promise.all([loadSetupStatus(), loadSnippets(), loadPresets(), loadHistory()]);
    });

    // ── Setup wizard ─────────────────────────────────────────────────────────
    async function loadSetupStatus() {
      const r = await fetch(`/api/rotation/setup/${currentServerId}`);
      const d = await r.json();
      document.getElementById('setupBanner').classList.toggle('hidden', !!d.done);
      document.getElementById('setupDoneBanner').classList.toggle('hidden', !d.done);
    }

    document.getElementById('runSetupBtn').addEventListener('click', async () => {
      document.getElementById('runSetupBtn').textContent = 'Running…';
      const r = await fetch(`/api/rotation/setup/${currentServerId}`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken }
      });
      const d = await r.json();
      if (d.success) {
        await loadSetupStatus();
        alert('Setup complete! cfgeconomycore.xml has been updated.');
      } else {
        await loadHistory();
        alert('Setup failed: ' + (d.error || 'Unknown error'));
        document.getElementById('runSetupBtn').textContent = 'Run Setup';
      }
    });

    // ── Snippet pattern fields toggle ─────────────────────────────────────────
    document.getElementById('sPattern').addEventListener('change', updatePatternFields);

    function updatePatternFields() {
      const pattern = document.getElementById('sPattern').value;
      document.querySelectorAll('.pattern-fields').forEach(el => el.classList.add('hidden'));
      const el = document.getElementById('fields-' + pattern);
      if (el) el.classList.remove('hidden');

      // Show bundle extra fields only for location_bundle
      document.getElementById('bundle-extra-fields').classList.toggle('hidden', pattern !== 'location_bundle');

      // Update content label
      const label = document.getElementById('contentLabel');
      if (pattern === 'cfggameplay_array' || pattern === 'location_bundle') {
        label.textContent = 'Content * (JSON — object spawner or gear preset)';
      } else {
        label.textContent = 'Content * (XML)';
      }
    }

    // ── Snippets ──────────────────────────────────────────────────────────────
    async function loadSnippets() {
      const r = await fetch(`/api/rotation/snippets/${currentServerId}`);
      const d = await r.json();
      allSnippets = d.snippets || [];
      renderSnippets();
    }

    function patternBadgeClass(pattern) {
      return {
        ce_folder:        'bg-blue-800 text-blue-200',
        cfggameplay_array:'bg-purple-800 text-purple-200',
        location_bundle:  'bg-green-800 text-green-200',
        xml_patch:        'bg-yellow-800 text-yellow-200',
        file_swap:        'bg-red-800 text-red-200',
      }[pattern] || 'bg-gray-700 text-gray-300';
    }

    function renderSnippets() {
      const container = document.getElementById('snippetList');
      if (!allSnippets.length) {
        container.innerHTML = '<p class="text-gray-400">No snippets yet. Create one with the button above.</p>';
        return;
      }
      container.innerHTML = allSnippets.map(s => `
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-4 flex items-center justify-between">
          <div>
            <span class="font-semibold">${escHtml(s.name)}</span>
            <span class="ml-2 px-2 py-0.5 rounded text-xs ${patternBadgeClass(s.pattern)}">${s.pattern}</span>
            ${s.ce_type ? `<span class="ml-1 text-gray-400 text-xs">${s.ce_type}</span>` : ''}
            ${s.cfggameplay_array ? `<span class="ml-1 text-gray-400 text-xs">${s.cfggameplay_array}</span>` : ''}
            ${s.description ? `<p class="text-gray-400 text-sm mt-1">${escHtml(s.description)}</p>` : ''}
            ${s.tags ? `<p class="text-gray-500 text-xs mt-1">🏷 ${escHtml(s.tags)}</p>` : ''}
          </div>
          <div class="flex gap-2">
            <button data-action="edit-snippet" data-id="${s.id}" class="bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded text-sm">Edit</button>
            <button data-action="delete-snippet" data-id="${s.id}" class="bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-sm">Delete</button>
          </div>
        </div>
      `).join('');
    }

    function openSnippetModal(snippet = null) {
      editingSnippetId = snippet?.id || null;
      document.getElementById('snippetModalTitle').textContent = snippet ? 'Edit Snippet' : 'New Snippet';
      document.getElementById('sName').value         = snippet?.name || '';
      document.getElementById('sDesc').value         = snippet?.description || '';
      document.getElementById('sTags').value         = snippet?.tags || '';
      document.getElementById('sPattern').value      = snippet?.pattern || 'ce_folder';
      document.getElementById('sCeType').value       = snippet?.ce_type || 'types';
      document.getElementById('sGameplayArray').value= snippet?.cfggameplay_array || 'spawnGearPresetFiles';
      document.getElementById('sDeployPath').value   = snippet?.deploy_path || '';
      document.getElementById('sBundleDeployPath').value = snippet?.deploy_path || '';
      document.getElementById('sTargetFile').value   = snippet?.target_file || '';
      document.getElementById('sTargetPath').value   = snippet?.target_path || '';
      document.getElementById('sContent').value      = snippet?.content || '';
      document.getElementById('sMapgrouppos').value  = snippet?.mapgrouppos_content || '';
      document.getElementById('sTypesContent').value = snippet?.types_content || '';
      document.getElementById('sSpawnableTypes').value = snippet?.spawnabletypes_content || '';
      updatePatternFields();
      document.getElementById('snippetModal').classList.remove('hidden');
    }

    async function editSnippet(id) {
      const r = await fetch(`/api/rotation/snippets/${currentServerId}`);
      const d = await r.json();
      const snippet = (d.snippets || []).find(s => s.id === id);
      if (snippet) openSnippetModal(snippet);
    }

    async function deleteSnippet(id) {
      if (!confirm('Delete this snippet? It will be removed from all presets.')) return;
      await fetch(`/api/rotation/snippets/${currentServerId}/${id}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken }
      });
      await loadSnippets();
    }

    document.getElementById('newSnippetBtn').addEventListener('click', () => openSnippetModal());
    document.getElementById('cancelSnippetBtn').addEventListener('click', () =>
      document.getElementById('snippetModal').classList.add('hidden'));

    document.getElementById('saveSnippetBtn').addEventListener('click', async () => {
      const pattern = document.getElementById('sPattern').value;
      const body = {
        name:                    document.getElementById('sName').value.trim(),
        description:             document.getElementById('sDesc').value.trim(),
        tags:                    document.getElementById('sTags').value.trim(),
        pattern,
        ce_type:                 document.getElementById('sCeType').value,
        cfggameplay_array:       document.getElementById('sGameplayArray').value,
        deploy_path:             pattern === 'location_bundle'
                                   ? document.getElementById('sBundleDeployPath').value.trim()
                                   : document.getElementById('sDeployPath').value.trim(),
        target_file:             document.getElementById('sTargetFile').value.trim(),
        target_path:             document.getElementById('sTargetPath').value.trim(),
        content:                 document.getElementById('sContent').value,
        mapgrouppos_content:     document.getElementById('sMapgrouppos').value,
        types_content:           document.getElementById('sTypesContent').value,
        spawnabletypes_content:  document.getElementById('sSpawnableTypes').value,
      };

      if (!body.name || !body.content) { alert('Name and content are required.'); return; }

      const url    = editingSnippetId
        ? `/api/rotation/snippets/${currentServerId}/${editingSnippetId}`
        : `/api/rotation/snippets/${currentServerId}`;
      const method = editingSnippetId ? 'PUT' : 'POST';

      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (d.success) {
        document.getElementById('snippetModal').classList.add('hidden');
        await loadSnippets();
      } else {
        alert('Save failed: ' + (d.error || 'Unknown error'));
      }
    });

    // ── Presets ───────────────────────────────────────────────────────────────
    async function loadPresets() {
      const r = await fetch(`/api/rotation/presets/${currentServerId}`);
      const d = await r.json();
      allPresets = d.presets || [];
      renderPresets(allPresets);
    }

    function renderPresets(presets) {
      const container = document.getElementById('presetList');
      if (!presets.length) {
        container.innerHTML = '<p class="text-gray-400">No presets yet. Create one with the button above.</p>';
        return;
      }
      container.innerHTML = presets.map(p => {
        const active = p.active;
        const snippetTags = (p.snippets || []).map(s =>
          `<span class="px-2 py-0.5 bg-gray-700 rounded text-xs">${escHtml(s.name)}</span>`
        ).join(' ');
        const scheduleBadge = p.schedule_type !== 'none'
          ? `<span class="ml-2 px-2 py-0.5 bg-indigo-800 text-indigo-200 rounded text-xs">🕒 ${p.schedule_type}</span>`
          : '';
        return `
          <div class="bg-gray-800 border ${active ? 'border-green-600' : 'border-gray-700'} rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <div>
                <span class="font-semibold text-lg">${escHtml(p.name)}</span>
                ${active ? '<span class="ml-2 px-2 py-0.5 bg-green-700 text-green-200 rounded text-xs">● Active</span>' : ''}
                ${scheduleBadge}
                ${p.description ? `<p class="text-gray-400 text-sm mt-1">${escHtml(p.description)}</p>` : ''}
              </div>
              <div class="flex gap-2">
                ${active
                  ? `<button data-action="deactivate-preset" data-id="${p.id}" class="bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-sm">⏹ Deactivate</button>`
                  : `<button data-action="activate-preset" data-id="${p.id}" class="bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-sm">▶ Activate</button>`
                }
                <button data-action="add-snippet" data-id="${p.id}" class="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded text-sm">+ Snippet</button>
                <button data-action="edit-preset" data-id="${p.id}" class="bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded text-sm">Edit</button>
                <button data-action="delete-preset" data-id="${p.id}" class="bg-red-800 hover:bg-red-700 px-3 py-1 rounded text-sm">Delete</button>
              </div>
            </div>
            <div class="flex gap-2 flex-wrap">
              ${p.snippets?.length ? snippetTags : '<span class="text-gray-500 text-sm">No snippets added yet</span>'}
            </div>
          </div>
        `;
      }).join('');
    }

    async function activatePreset(id) {
      if (!confirm('Activate this preset? Files will be uploaded to your server.')) return;
      const r = await fetch(`/api/rotation/presets/${currentServerId}/${id}/activate`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken }
      });
      const d = await r.json();
      if (d.success) { await loadPresets(); await loadHistory(); }
      else {
        await loadHistory();
        alert('Activation failed: ' + (d.error || 'Unknown'));
      }
    }

    async function deactivatePreset(id) {
      if (!confirm('Deactivate this preset? Files will be removed from your server.')) return;
      const r = await fetch(`/api/rotation/presets/${currentServerId}/${id}/deactivate`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken }
      });
      const d = await r.json();
      if (d.success) { await loadPresets(); await loadHistory(); }
      else {
        await loadHistory();
        alert('Deactivation failed: ' + (d.error || 'Unknown'));
      }
    }

    function openPresetModal(preset = null) {
      editingPresetId = preset?.id || null;
      document.getElementById('presetModalTitle').textContent = preset ? 'Edit Preset' : 'New Preset';
      document.getElementById('pName').value         = preset?.name || '';
      document.getElementById('pDesc').value         = preset?.description || '';
      document.getElementById('pScheduleType').value = preset?.schedule_type || 'none';
      const cfg = preset?.schedule_config ? JSON.parse(preset.schedule_config) : null;
      document.getElementById('pStartDate').value = cfg?.start?.slice(0, 16) || '';
      document.getElementById('pEndDate').value   = cfg?.end?.slice(0, 16) || '';
      toggleDateRange();
      document.getElementById('presetModal').classList.remove('hidden');
    }

    function toggleDateRange() {
      const show = document.getElementById('pScheduleType').value === 'date_range';
      document.getElementById('dateRangeFields').classList.toggle('hidden', !show);
    }

    document.getElementById('pScheduleType').addEventListener('change', toggleDateRange);

    function editPreset(id) {
      const preset = allPresets.find(item => Number(item.id) === Number(id));
      if (preset) openPresetModal(preset);
    }

    document.getElementById('snippetList').addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = Number(button.dataset.id);
      if (button.dataset.action === 'edit-snippet') editSnippet(id);
      if (button.dataset.action === 'delete-snippet') deleteSnippet(id);
    });

    document.getElementById('presetList').addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = Number(button.dataset.id);
      const actions = {
        'activate-preset': activatePreset,
        'deactivate-preset': deactivatePreset,
        'add-snippet': openAddSnippetModal,
        'edit-preset': editPreset,
        'delete-preset': deletePreset,
      };
      actions[button.dataset.action]?.(id);
    });

    document.getElementById('newPresetBtn').addEventListener('click', () => openPresetModal());
    document.getElementById('cancelPresetBtn').addEventListener('click', () =>
      document.getElementById('presetModal').classList.add('hidden'));

    document.getElementById('savePresetBtn').addEventListener('click', async () => {
      const scheduleType = document.getElementById('pScheduleType').value;
      let scheduleConfig = null;
      if (scheduleType === 'date_range') {
        scheduleConfig = {
          start: document.getElementById('pStartDate').value,
          end:   document.getElementById('pEndDate').value,
        };
      }

      const body = {
        name:            document.getElementById('pName').value.trim(),
        description:     document.getElementById('pDesc').value.trim(),
        schedule_type:   scheduleType,
        schedule_config: scheduleConfig,
      };
      if (!body.name) { alert('Name is required.'); return; }

      const url    = editingPresetId
        ? `/api/rotation/presets/${currentServerId}/${editingPresetId}`
        : `/api/rotation/presets/${currentServerId}`;
      const method = editingPresetId ? 'PUT' : 'POST';

      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (d.success) {
        document.getElementById('presetModal').classList.add('hidden');
        await loadPresets();
      } else {
        alert('Save failed: ' + (d.error || 'Unknown error'));
      }
    });

    async function deletePreset(id) {
      if (!confirm('Delete this preset?')) return;
      await fetch(`/api/rotation/presets/${currentServerId}/${id}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken }
      });
      await loadPresets();
    }

    // ── Add snippet to preset ─────────────────────────────────────────────────
    function openAddSnippetModal(presetId) {
      addSnippetTargetPresetId = presetId;
      const sel = document.getElementById('snippetPickerSelect');
      sel.innerHTML = '<option value="">Select a snippet…</option>';
      allSnippets.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.name} [${s.pattern}]`;
        sel.appendChild(opt);
      });
      document.getElementById('addSnippetModal').classList.remove('hidden');
    }

    document.getElementById('cancelAddSnippetBtn').addEventListener('click', () =>
      document.getElementById('addSnippetModal').classList.add('hidden'));

    document.getElementById('confirmAddSnippetBtn').addEventListener('click', async () => {
      const snippetId = document.getElementById('snippetPickerSelect').value;
      if (!snippetId) { alert('Select a snippet.'); return; }
      const r = await fetch(`/api/rotation/presets/${currentServerId}/${addSnippetTargetPresetId}/snippets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ snippet_id: parseInt(snippetId, 10) })
      });
      const d = await r.json();
      if (d.success) {
        document.getElementById('addSnippetModal').classList.add('hidden');
        await loadPresets();
      } else {
        alert('Failed: ' + (d.error || 'Unknown'));
      }
    });

    // ── History ───────────────────────────────────────────────────────────────
    async function loadHistory() {
      const serverId = String(currentServerId);
      const r = await fetch(`/api/rotation/history/${serverId}`);
      const d = await r.json();
      if (serverId !== String(currentServerId)) return;
      const container = document.getElementById('historyList');
      const history = d.history || [];
      const recovery = d.recovery || [];
      if (!history.length && !recovery.length) {
        container.innerHTML = '<p class="text-gray-400">No activation history yet.</p>';
        return;
      }
      const recoveryHtml = recovery.map(operation => `
        <div class="bg-red-950 border border-red-600 rounded p-3 text-sm">
          <div class="font-semibold text-red-300">⚠ Provider recovery required</div>
          <div class="text-red-200 text-xs mt-1">
            Operation ${escHtml(operation.id)} (${escHtml(operation.workflow)} / ${escHtml(operation.action)}) is ${escHtml(operation.status)}.
            Do not run another provider mutation until the snapshot is reconciled.
          </div>
          ${operation.error_summary
            ? `<div class="text-red-300 text-xs mt-1">${escHtml(operation.error_summary)}</div>` : ''}
          <button type="button"
                  data-provider-recovery-id="${escHtml(operation.id)}"
                  data-provider-recovery-server="${escHtml(serverId)}"
                  class="mt-2 bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-xs font-semibold">
            Restore exact provider snapshots
          </button>
        </div>
      `).join('');
      const actionColors = { activated: 'text-green-400', deactivated: 'text-yellow-400', failed: 'text-red-400' };
      const historyHtml = history.map(h => `
        <div class="bg-gray-800 border border-gray-700 rounded p-3 flex items-center gap-4 text-sm">
          <span class="${actionColors[h.action] || ''} font-semibold w-24">${h.action}</span>
          <span class="font-medium flex-1">${escHtml(h.preset_name || 'Unknown preset')}</span>
          <span class="text-gray-400 text-xs">${new Date(h.triggered_at).toLocaleString()}</span>
          <span class="text-gray-500 text-xs">${escHtml(h.triggered_by)}</span>
          ${h.result && h.result !== 'OK' ? `<span class="text-red-400 text-xs">${escHtml(h.result)}</span>` : ''}
        </div>
      `).join('');
      container.innerHTML = recoveryHtml + historyHtml;
      container.querySelectorAll('[data-provider-recovery-id]').forEach(button => {
        button.addEventListener('click', async () => {
          const operationId = button.dataset.providerRecoveryId;
          const serverId = button.dataset.providerRecoveryServer;
          if (!operationId || !serverId || serverId !== String(currentServerId)) return;
          if (!window.confirm(
            `Restore the exact original provider snapshots for operation ${operationId}? ` +
            'This overwrites provider files changed by that interrupted operation.'
          )) return;
          button.disabled = true;
          button.textContent = 'Restoring…';
          try {
            const restore = expectedCurrentHashes => fetch(
              `/api/rotation/recovery/${serverId}/${operationId}/restore`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-Token': csrfToken,
                },
                body: JSON.stringify(expectedCurrentHashes ? { expectedCurrentHashes } : {}),
              }
            );
            let response = await restore(null);
            let result = await response.json();
            if (serverId !== String(currentServerId)) return;
            if (response.status === 409 && result.code === 'PROVIDER_RECOVERY_CONFLICT'
                && result.currentHashes) {
              const confirmed = window.confirm(
                'The provider state differs from the original snapshots. This may include later manual edits. ' +
                'Restore only if you reviewed the provider and intend to overwrite the exact state just observed.'
              );
              if (!confirmed) {
                button.disabled = false;
                button.textContent = 'Restore exact provider snapshots';
                return;
              }
              response = await restore(result.currentHashes);
              result = await response.json();
              if (serverId !== String(currentServerId)) return;
            }
            if (!response.ok || !result.success) {
              alert('Provider recovery failed: ' + (result.error || 'Unknown error'));
              button.disabled = false;
              button.textContent = 'Restore exact provider snapshots';
              return;
            }
            await loadHistory();
            if (serverId === String(currentServerId)) {
              alert(`Provider operation ${operationId} was restored and verified.`);
            }
          } catch (error) {
            if (serverId !== String(currentServerId)) return;
            alert('Provider recovery failed: ' + error.message);
            button.disabled = false;
            button.textContent = 'Restore exact provider snapshots';
          }
        });
      });
    }

    // ── Utility ───────────────────────────────────────────────────────────────
    function escHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    (async () => {
      await loadCsrf();
      await loadServers();
    })();
