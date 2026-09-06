/*
 * DayZ Dashboard — Casino Slots Module
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Self-contained slots game UI module.
 * Exposes a global `CasinoSlots` object used by player-portal.js.
 *
 * Usage:
 *   CasinoSlots.init(identityId)  — call when the slots section becomes visible
 */

const CasinoSlots = (function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let identityId   = null;
  let balance      = 0;
  let currencySymbol = '$';
  let spinning     = false;

  // Recent spin history shown in the local history panel (not from API)
  const localHistory = [];

  // ── Symbol animation frames (shown during spin) ────────────────────────────
  const SPIN_FRAMES = ['🍒', '🍋', '🔔', '💎', '⭐'];

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Format a monetary amount with the configured currency symbol. */
  function fmt(amount) {
    return `${currencySymbol}${parseFloat(amount).toFixed(2)}`;
  }

  /** Update the balance display element. */
  function updateBalanceDisplay(newBalance) {
    balance = newBalance;
    const el = document.getElementById('slots-balance');
    if (el) el.textContent = fmt(balance);
  }

  /** Show a result message with a colour-coded class. */
  function showResult(text, type) {
    const el = document.getElementById('slots-result');
    if (!el) return;
    const colours = { win: 'text-green-400', loss: 'text-red-400', push: 'text-yellow-400', info: 'text-gray-400' };
    el.className = `text-center mb-4 min-h-8 text-lg font-bold ${colours[type] || 'text-gray-300'}`;
    el.textContent = text;
  }

  /** Set the three reel display elements to given emojis. */
  function setReels(r0, r1, r2) {
    const setReel = (id, emoji) => {
      const el = document.getElementById(id);
      if (el) el.textContent = emoji;
    };
    setReel('slots-reel-0', r0);
    setReel('slots-reel-1', r1);
    setReel('slots-reel-2', r2);
  }

  /**
   * Animate the reels spinning for ~1.5 s then resolve.
   * Each reel cycles through SPIN_FRAMES rapidly.
   */
  function animateReels() {
    return new Promise(resolve => {
      let tick = 0;
      const total = 20; // number of frame changes
      const interval = setInterval(() => {
        const pick = () => SPIN_FRAMES[Math.floor(Math.random() * SPIN_FRAMES.length)];
        setReels(pick(), pick(), pick());
        tick++;
        if (tick >= total) {
          clearInterval(interval);
          resolve();
        }
      }, 75);
    });
  }

  /**
   * Add a spin to the local history panel.
   * Only the most recent 10 spins are shown.
   */
  function addToHistory(reels, net, result) {
    const reelStr = reels.join(' ');
    const netStr  = net >= 0 ? `+${fmt(net)}` : fmt(net);
    const colour  = result === 'win' ? 'text-green-400' : result === 'loss' ? 'text-red-400' : 'text-yellow-400';

    localHistory.unshift({ reelStr, netStr, colour });
    if (localHistory.length > 10) localHistory.pop();

    renderHistory();
  }

  function renderHistory() {
    const el = document.getElementById('slots-history');
    if (!el) return;
    if (localHistory.length === 0) {
      el.innerHTML = '<p class="text-gray-500 text-sm">No spins yet this session.</p>';
      return;
    }
    el.innerHTML = localHistory.map(h =>
      `<div class="flex justify-between items-center bg-gray-900 rounded px-3 py-1 text-sm">
         <span class="tracking-widest">${h.reelStr}</span>
         <span class="${h.colour} font-semibold">${h.netStr}</span>
       </div>`
    ).join('');
  }

  // ── Core spin logic ────────────────────────────────────────────────────────

  async function doSpin() {
    if (spinning) return;

    const wagerInput = document.getElementById('slots-wager');
    const wager = parseFloat(wagerInput?.value);
    if (!wager || wager <= 0) {
      showResult('Please enter a valid wager.', 'info');
      return;
    }

    if (wager > balance) {
      showResult('Insufficient balance!', 'loss');
      return;
    }

    spinning = true;
    const spinBtn = document.getElementById('slots-spin-btn');
    if (spinBtn) { spinBtn.disabled = true; spinBtn.textContent = '⏳ Spinning…'; }
    showResult('', 'info');

    // Animate reels while waiting for the API response
    const [, data] = await Promise.all([
      animateReels(),
      fetchWithCsrf('/api/casino/play/slots', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ serverId: window.currentEconomyServerId, identityId, wager })
      }).then(r => r.json()).catch(err => ({ success: false, error: err.message }))
    ]);

    // Show actual reel result
    if (data.success) {
      setReels(data.reels[0], data.reels[1], data.reels[2]);
      updateBalanceDisplay(data.balanceAfter);

      if (data.result === 'win') {
        showResult(`🎉 ${data.description}  +${fmt(data.net)}`, 'win');
      } else if (data.result === 'push') {
        showResult(`↩️ Push — wager returned`, 'push');
      } else {
        showResult(`💸 ${data.description}  −${fmt(data.wager)}`, 'loss');
      }

      addToHistory(data.reels, data.net, data.result);
    } else {
      setReels('❌', '❌', '❌');
      showResult(data.error || 'Something went wrong. Please try again.', 'loss');
    }

    if (spinBtn) { spinBtn.disabled = false; spinBtn.textContent = '🎰 SPIN'; }
    spinning = false;
  }

  // ── Initialisation ─────────────────────────────────────────────────────────

  /**
   * Fetch the player's current balance and casino config, then display the
   * slots section. Called by player-portal.js when the casino tab opens.
   *
   * @param {number|string} playerIdentityId - The linked identity to play as
   */
  async function init(playerIdentityId) {
    identityId = playerIdentityId;

    // Fetch casino status (balance + config)
    try {
      const res  = await fetch(`/api/casino/status/${identityId}?serverId=${encodeURIComponent(window.currentEconomyServerId)}`);
      const data = await res.json();

      if (!data.success || !data.casinoEnabled) {
        // Casino is disabled — already handled by the "Closed" banner in the lobby
        return;
      }

      currencySymbol = data.currency?.symbol || '$';
      updateBalanceDisplay(data.balance);

      // Update quick-bet labels to use the right currency symbol
      document.querySelectorAll('.slots-quick-bet').forEach(btn => {
        const amt = btn.dataset.amount;
        btn.textContent = `${currencySymbol}${amt}`;
      });

    } catch (err) {
      console.error('Failed to load casino status:', err);
    }

    renderHistory();
  }

  // ── Event wiring (runs once on DOMContentLoaded) ───────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    // Spin button
    document.getElementById('slots-spin-btn')?.addEventListener('click', doSpin);

    // Quick-bet buttons
    document.querySelectorAll('.slots-quick-bet').forEach(btn => {
      btn.addEventListener('click', function () {
        const wagerInput = document.getElementById('slots-wager');
        if (wagerInput) wagerInput.value = this.dataset.amount;
      });
    });

    // Allow pressing Enter in the wager field to spin
    document.getElementById('slots-wager')?.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSpin();
    });

    // Back to lobby button
    document.getElementById('slots-back-btn')?.addEventListener('click', function () {
      document.getElementById('slots-game').style.display = 'none';
      document.getElementById('casino-lobby').style.display = 'block';
    });

    // Slots card in the lobby opens the game
    document.getElementById('casino-open-slots')?.addEventListener('click', function () {
      document.getElementById('casino-lobby').style.display = 'none';
      document.getElementById('slots-game').style.display = 'block';
      // Re-init to refresh balance whenever the game is opened
      if (identityId) init(identityId);
    });
  });

  // Public API
  return { init };
}());
