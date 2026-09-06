/* global fetchWithCsrf, EconomyDashboard */
(async function () {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

      // Load linked accounts via the player portal API
      let identityId = null;
      let guildId = null;
      let serverId = null;
      let economyConfig = null;

      try {
        const res = await fetch('/api/accounts/linked');
        const data = await res.json();
        if (data.success && data.accounts && data.accounts.length > 0) {
          identityId = data.accounts[0].identity_id;
          // Get guild from first account's guild
          guildId = data.accounts[0].guild_id;
          serverId = data.accounts[0].server_id;
        }
      } catch (e) { /* handled below */ }

      if (!identityId) {
        document.getElementById('loading-state').classList.add('hidden');
        document.getElementById('no-guild').classList.remove('hidden');
        return;
      }

      // Load economy data
      document.getElementById('loading-state').classList.add('hidden');
      document.getElementById('main-content').classList.remove('hidden');

      await EconomyDashboard.load(identityId, serverId);

      // Fetch config for modal buttons
      try {
        const res = await fetch(`/api/economy/player/${identityId}?serverId=${encodeURIComponent(serverId)}`);
        const data = await res.json();
        if (data.success) {
          economyConfig = data;
          const sym = data.currency?.symbol || '$';
          const wallet = data.wallet?.cashOnHand ?? 0;
          const bank = data.bank?.balance ?? 0;

          document.getElementById('ed-depositWalletBalance').textContent = `${sym}${wallet.toFixed(2)}`;
          document.getElementById('ed-withdrawBankBalance').textContent = `${sym}${bank.toFixed(2)}`;
          document.getElementById('ed-transferAvailable').textContent = `${sym}${wallet.toFixed(2)}`;

          const bankEnabled = data.guildConfig?.bankEnabled;
          const transferEnabled = data.guildConfig?.transferEnabled;

          const depositBtn = document.getElementById('ed-depositBtn');
          const withdrawBtn = document.getElementById('ed-withdrawBtn');
          const transferBtn = document.getElementById('ed-transferBtn');

          if (depositBtn) { depositBtn.disabled = !bankEnabled; depositBtn.classList.toggle('opacity-50', !bankEnabled); }
          if (withdrawBtn) { withdrawBtn.disabled = !bankEnabled; withdrawBtn.classList.toggle('opacity-50', !bankEnabled); }
          if (transferBtn) { transferBtn.disabled = !transferEnabled; transferBtn.classList.toggle('opacity-50', !transferEnabled); }

          // Fee preview for deposit
          document.getElementById('ed-depositAmount')?.addEventListener('input', function () {
            const amt = parseFloat(this.value) || 0;
            const fee = amt * ((data.guildConfig?.bankDepositFeePercentage || 0) / 100);
            const net = amt - fee;
            const info = document.getElementById('ed-depositFeeInfo');
            if (fee > 0) {
              document.getElementById('ed-depositFeeAmount').textContent = `${sym}${fee.toFixed(2)}`;
              document.getElementById('ed-depositNetAmount').textContent = `${sym}${net.toFixed(2)}`;
              info.classList.remove('hidden');
            } else {
              info.classList.add('hidden');
            }
          });

          // Fee preview for withdraw
          document.getElementById('ed-withdrawAmount')?.addEventListener('input', function () {
            const amt = parseFloat(this.value) || 0;
            const fee = amt * ((data.guildConfig?.bankWithdrawFeePercentage || 0) / 100);
            const net = amt - fee;
            const info = document.getElementById('ed-withdrawFeeInfo');
            if (fee > 0) {
              document.getElementById('ed-withdrawFeeAmount').textContent = `${sym}${fee.toFixed(2)}`;
              document.getElementById('ed-withdrawNetAmount').textContent = `${sym}${net.toFixed(2)}`;
              info.classList.remove('hidden');
            } else {
              info.classList.add('hidden');
            }
          });
        }
      } catch (e) { /* ignore */ }

      function showMsg(elId, msg, isError) {
        const el = document.getElementById(elId);
        if (!el) return;
        el.textContent = msg;
        el.className = `mb-3 p-2 rounded text-sm ${isError ? 'bg-red-900 text-red-300' : 'bg-green-900 text-green-300'}`;
        el.classList.remove('hidden');
      }

      // Modal wiring
      document.getElementById('ed-depositBtn')?.addEventListener('click', () => {
        document.getElementById('depositModal').classList.remove('hidden');
      });
      document.getElementById('ed-cancelDeposit')?.addEventListener('click', () => {
        document.getElementById('depositModal').classList.add('hidden');
      });
      document.getElementById('ed-confirmDeposit')?.addEventListener('click', async () => {
        const amt = parseFloat(document.getElementById('ed-depositAmount').value);
        if (!amt || amt <= 0) { showMsg('ed-depositMsg', 'Enter a valid amount.', true); return; }
        try {
          const res = await fetchWithCsrf('/api/economy/deposit', {
            method: 'POST',
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            body: JSON.stringify({ identityId, serverId, amount: amt })
          });
          const data = await res.json();
          if (data.success) {
            showMsg('ed-depositMsg', 'Deposit successful!', false);
            setTimeout(async () => {
              document.getElementById('depositModal').classList.add('hidden');
              document.getElementById('ed-depositAmount').value = '';
              document.getElementById('ed-depositFeeInfo').classList.add('hidden');
              await EconomyDashboard.load(identityId, serverId);
            }, 1200);
          } else {
            showMsg('ed-depositMsg', data.error || 'Deposit failed.', true);
          }
        } catch (e) { showMsg('ed-depositMsg', 'Network error.', true); }
      });

      document.getElementById('ed-withdrawBtn')?.addEventListener('click', () => {
        document.getElementById('withdrawModal').classList.remove('hidden');
      });
      document.getElementById('ed-cancelWithdraw')?.addEventListener('click', () => {
        document.getElementById('withdrawModal').classList.add('hidden');
      });
      document.getElementById('ed-confirmWithdraw')?.addEventListener('click', async () => {
        const amt = parseFloat(document.getElementById('ed-withdrawAmount').value);
        if (!amt || amt <= 0) { showMsg('ed-withdrawMsg', 'Enter a valid amount.', true); return; }
        try {
          const res = await fetchWithCsrf('/api/economy/withdraw', {
            method: 'POST',
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            body: JSON.stringify({ identityId, serverId, amount: amt })
          });
          const data = await res.json();
          if (data.success) {
            showMsg('ed-withdrawMsg', 'Withdrawal successful!', false);
            setTimeout(async () => {
              document.getElementById('withdrawModal').classList.add('hidden');
              document.getElementById('ed-withdrawAmount').value = '';
              document.getElementById('ed-withdrawFeeInfo').classList.add('hidden');
              await EconomyDashboard.load(identityId, serverId);
            }, 1200);
          } else {
            showMsg('ed-withdrawMsg', data.error || 'Withdrawal failed.', true);
          }
        } catch (e) { showMsg('ed-withdrawMsg', 'Network error.', true); }
      });

      // Transfer modal
      let selectedRecipientId = null;
      let recipientOnline = false;
      document.getElementById('ed-transferBtn')?.addEventListener('click', () => {
        document.getElementById('transferModal').classList.remove('hidden');
      });
      document.getElementById('ed-cancelTransfer')?.addEventListener('click', () => {
        document.getElementById('transferModal').classList.add('hidden');
      });
      document.getElementById('ed-clearRecipient')?.addEventListener('click', () => {
        selectedRecipientId = null;
        document.getElementById('ed-selectedRecipient').classList.add('hidden');
        document.getElementById('ed-recipientSearch').value = '';
        document.getElementById('ed-confirmTransfer').disabled = true;
      });

      let searchTimeout;
      document.getElementById('ed-recipientSearch')?.addEventListener('input', function () {
        clearTimeout(searchTimeout);
        const q = this.value.trim();
        if (q.length < 2) { document.getElementById('ed-recipientResults').classList.add('hidden'); return; }
        searchTimeout = setTimeout(async () => {
          try {
            const res = await fetch(`/api/economy/search-players?query=${encodeURIComponent(q)}&serverId=${encodeURIComponent(serverId)}&limit=10`);
            const data = await res.json();
            const resultsEl = document.getElementById('ed-recipientResults');
            if (data.players && data.players.length > 0) {
              resultsEl.innerHTML = data.players.map(p => `
                <div class="p-2 cursor-pointer hover:bg-gray-600 rounded" data-id="${p.identity_id}" data-gamertag="${p.gamertag}" data-platform="${p.platform || ''}" data-online="${p.is_online}">
                  ${p.is_online ? '🟢' : '⚫'} ${p.gamertag}
                </div>
              `).join('');
              resultsEl.classList.remove('hidden');
              resultsEl.querySelectorAll('[data-id]').forEach(el => {
                el.addEventListener('click', () => {
                  selectedRecipientId = el.dataset.id;
                  recipientOnline = el.dataset.online === 'true';
                  document.getElementById('ed-selectedRecipientName').textContent = el.dataset.gamertag;
                  document.getElementById('ed-selectedRecipientPlatform').textContent = el.dataset.platform;
                  document.getElementById('ed-selectedRecipient').classList.remove('hidden');
                  document.getElementById('ed-recipientResults').classList.add('hidden');
                  document.getElementById('ed-recipientSearch').value = '';
                  document.getElementById('ed-confirmTransfer').disabled = false;
                });
              });
            } else {
              resultsEl.innerHTML = '<div class="p-2 text-gray-400 text-sm">No players found</div>';
              resultsEl.classList.remove('hidden');
            }
          } catch (e) { /* ignore */ }
        }, 300);
      });

      document.getElementById('ed-confirmTransfer')?.addEventListener('click', async () => {
        if (!selectedRecipientId) return;
        const amt = parseFloat(document.getElementById('ed-transferAmount').value);
        const msg = document.getElementById('ed-transferMessage').value;
        if (!amt || amt <= 0) { showMsg('ed-transferMsg', 'Enter a valid amount.', true); return; }
        try {
          const res = await fetchWithCsrf('/api/economy/transfer', {
            method: 'POST',
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            body: JSON.stringify({ fromIdentityId: identityId, toIdentityId: parseInt(selectedRecipientId), serverId, amount: amt, message: msg })
          });
          const data = await res.json();
          if (data.success) {
            showMsg('ed-transferMsg', 'Transfer successful!', false);
            setTimeout(async () => {
              document.getElementById('transferModal').classList.add('hidden');
              document.getElementById('ed-transferAmount').value = '';
              document.getElementById('ed-transferMessage').value = '';
              selectedRecipientId = null;
              document.getElementById('ed-selectedRecipient').classList.add('hidden');
              document.getElementById('ed-confirmTransfer').disabled = true;
              await EconomyDashboard.load(identityId, serverId);
            }, 1200);
          } else {
            showMsg('ed-transferMsg', data.error || 'Transfer failed.', true);
          }
        } catch (e) { showMsg('ed-transferMsg', 'Network error.', true); }
      });

    })();
