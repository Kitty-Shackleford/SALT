/*
 * DayZ Dashboard — Casino Craps Module
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Standard Pass Line craps — player vs the house.
 *
 * Come-out roll:
 *   7 or 11  → Pass Line wins (natural)
 *   2, 3     → Don't Pass wins; Pass Line loses (craps)
 *   12       → Don't Pass push; Pass Line loses
 *   4–6,8–10 → Point established; roll until point or 7
 *
 * Point phase:
 *   Hit point → Pass Line wins, Don't Pass loses
 *   Roll 7    → Don't Pass wins ("seven out"), Pass Line loses
 *   Other     → roll again
 *
 * Exposes a global `CasinoCraps` object used by player-portal.js.
 */

const CasinoCraps = (function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let identityId     = null;
  let balance        = 0;
  let currencySymbol = '$';
  let rolling        = false;
  let phase          = 'idle';       // 'idle' | 'point'
  let currentPoint   = null;
  let currentSessionId = null;       // signed token from server
  let currentWager   = 0;
  let localHistory   = [];

  // Unicode dice faces ⚀–⚅
  const DICE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

  // ── Helpers ────────────────────────────────────────────────────────────────

  function fmt(amount) {
    return `${currencySymbol}${parseFloat(amount).toFixed(2)}`;
  }

  function updateBalanceDisplay(newBalance) {
    balance = newBalance;
    const el = document.getElementById('craps-balance');
    if (el) el.textContent = fmt(balance);
  }

  function setStatus(text, type = 'info') {
    const el = document.getElementById('craps-status');
    if (!el) return;
    const cls = {
      win:  'text-green-400',
      loss: 'text-red-400',
      push: 'text-blue-400',
      info: 'text-gray-400',
      warn: 'text-yellow-400',
    };
    el.className   = `text-sm font-semibold text-center py-2 ${cls[type] || 'text-gray-400'}`;
    el.textContent = text;
  }

  // ── Dice display ───────────────────────────────────────────────────────────

  /** Update a single die display with animated cycle then settle on value. */
  function animateDie(elId, finalValue) {
    return new Promise(resolve => {
      const el = document.getElementById(elId);
      if (!el) { resolve(); return; }
      let tick = 0;
      const total    = 12;
      const interval = setInterval(() => {
        el.textContent = DICE_FACES[Math.floor(Math.random() * 6) + 1];
        tick++;
        if (tick >= total) {
          clearInterval(interval);
          el.textContent = DICE_FACES[finalValue];
          resolve();
        }
      }, 60);
    });
  }

  async function animateDice(d1, d2) {
    await Promise.all([animateDie('craps-die-1', d1), animateDie('craps-die-2', d2)]);
    const total = document.getElementById('craps-dice-total');
    if (total) total.textContent = d1 + d2;
  }

  function resetDice() {
    document.getElementById('craps-die-1').textContent  = '🎲';
    document.getElementById('craps-die-2').textContent  = '🎲';
    document.getElementById('craps-dice-total').textContent = '';
  }

  // ── Phase display ──────────────────────────────────────────────────────────

  function updatePhaseDisplay() {
    const el = document.getElementById('craps-phase-display');
    if (!el) return;
    if (phase === 'idle') {
      el.textContent = 'Come-out Roll';
      el.className   = 'text-xs font-bold text-gray-400 uppercase tracking-wider';
    } else if (phase === 'point') {
      el.textContent = `Point: ${currentPoint}`;
      el.className   = 'text-xs font-bold text-yellow-400 uppercase tracking-wider';
    }
  }

  // ── Bet type selection ─────────────────────────────────────────────────────

  function getSelectedBetType() {
    return document.querySelector('.craps-bet-btn.ring-2')?.dataset.betType || 'pass';
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  function setRollBtnState(enabled, label) {
    const btn = document.getElementById('craps-roll-btn');
    if (!btn) return;
    btn.disabled    = !enabled;
    btn.textContent = label;
  }

  function setBetSelectorEnabled(enabled) {
    document.querySelectorAll('.craps-bet-btn').forEach(btn => {
      btn.disabled = !enabled;
      btn.classList.toggle('opacity-50', !enabled);
    });
    const wagerInput = document.getElementById('craps-wager');
    if (wagerInput) wagerInput.disabled = !enabled;
  }

  // ── History ────────────────────────────────────────────────────────────────

  function addToHistory(entry) {
    localHistory.unshift(entry);
    if (localHistory.length > 10) localHistory.pop();
    renderHistory();
  }

  function renderHistory() {
    const el = document.getElementById('craps-history');
    if (!el) return;
    if (localHistory.length === 0) {
      el.innerHTML = '<p class="text-gray-500 text-sm">No rolls this session.</p>';
      return;
    }
    el.innerHTML = localHistory.map(h => {
      const cls  = h.result === 'win'  ? 'text-green-400'
                 : h.result === 'loss' ? 'text-red-400'
                 : 'text-blue-400';
      const sign = h.net >= 0 ? '+' : '';
      return `<div class="flex justify-between text-xs py-1 border-b border-gray-700">
        <span class="text-gray-300">${h.label}</span>
        <span class="${cls} font-semibold">${sign}${fmt(h.net)}</span>
      </div>`;
    }).join('');
  }

  // ── Core game actions ──────────────────────────────────────────────────────

  async function doRoll() {
    if (rolling) return;

    let wager    = null;
    let betType  = null;
    let body     = {};
    let action   = '';

    if (phase === 'idle') {
      // Come-out roll
      betType = getSelectedBetType();
      wager   = parseFloat(document.getElementById('craps-wager')?.value);

      if (!wager || wager <= 0) { setStatus('Enter a valid wager.', 'warn'); return; }
      if (wager > balance)      { setStatus('Insufficient balance!', 'loss'); return; }

      action = 'come_out';
      body   = { identityId, serverId: window.currentEconomyServerId, action, wager, betType };
    } else {
      // Point phase roll
      action = 'point_roll';
      body   = { identityId, serverId: window.currentEconomyServerId, action, sessionId: currentSessionId };
    }

    rolling = true;
    setRollBtnState(false, '🎲 Rolling…');
    setBetSelectorEnabled(false);

    const data = await fetchWithCsrf('/api/casino/play/craps', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(e => ({ success: false, error: e.message }));

    if (!data.success) {
      setStatus(data.error || 'Roll failed. Try again.', 'loss');
      rolling = false;
      if (phase === 'idle') {
        setRollBtnState(true, '🎲 Roll');
        setBetSelectorEnabled(true);
      } else {
        setRollBtnState(true, '🎲 Roll Again');
      }
      return;
    }

    // Animate dice then update UI
    await animateDice(data.d1, data.d2);

    const statusType = data.result === 'win'  ? 'win'
                     : data.result === 'loss' ? 'loss'
                     : data.result === 'push' ? 'push'
                     : 'info';
    setStatus(data.message || '', statusType);

    if (data.status === 'point') {
      // Point established — enter point phase
      phase            = 'point';
      currentPoint     = data.point;
      currentSessionId = data.sessionId;
      currentWager     = data.wager;
      updatePhaseDisplay();
      setRollBtnState(true, '🎲 Roll Again');
      // Bet type and wager locked once point is set
    } else if (data.status === 'rolling') {
      // Intermediate point roll — keep going
      currentSessionId = data.sessionId;
      setRollBtnState(true, '🎲 Roll Again');
    } else if (data.status === 'complete') {
      // Hand finished
      if (data.balanceAfter !== undefined) updateBalanceDisplay(data.balanceAfter);

      const betLabel = data.betType || (body.betType === 'dont_pass' ? "Don't Pass" : 'Pass') || 'Pass';
      addToHistory({
        label:  `${betLabel === 'dont_pass' ? "Don't Pass" : 'Pass'} — Rolled ${data.total}`,
        result: data.result,
        net:    data.net ?? (data.result === 'win' ? data.wager : -data.wager),
      });

      // Reset for next hand after a short delay
      rolling = false;
      setTimeout(() => {
        phase            = 'idle';
        currentPoint     = null;
        currentSessionId = null;
        currentWager     = 0;
        resetDice();
        updatePhaseDisplay();
        setRollBtnState(true, '🎲 Roll');
        setBetSelectorEnabled(true);
        setStatus('Place your bet and roll!', 'info');
      }, 4000);
      return;
    }

    rolling = false;
  }

  // ── Initialisation ─────────────────────────────────────────────────────────

  /**
   * Load balance + config and reset the table.
   * Called by player-portal.js when the craps section becomes visible.
   *
   * @param {number|string} playerIdentityId
   */
  async function init(playerIdentityId) {
    identityId       = playerIdentityId;
    rolling          = false;
    phase            = 'idle';
    currentPoint     = null;
    currentSessionId = null;
    localHistory     = [];

    try {
      const res  = await fetch(`/api/casino/status/${identityId}?serverId=${encodeURIComponent(window.currentEconomyServerId)}`);
      const data = await res.json();
      if (!data.success || !data.casinoEnabled) return;
      currencySymbol = data.currency?.symbol || '$';
      updateBalanceDisplay(data.balance);

      document.querySelectorAll('.craps-quick-bet').forEach(btn => {
        btn.textContent = `${currencySymbol}${btn.dataset.amount}`;
      });
    } catch (err) {
      console.error('Failed to load casino status for craps:', err);
    }

    resetDice();
    updatePhaseDisplay();
    renderHistory();
    setRollBtnState(true, '🎲 Roll');
    setBetSelectorEnabled(true);
    setStatus('Place your bet and roll!', 'info');
  }

  // ── Event wiring (runs once on DOMContentLoaded) ───────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('craps-roll-btn')?.addEventListener('click', doRoll);

    document.getElementById('craps-wager')?.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doRoll();
    });

    document.querySelectorAll('.craps-quick-bet').forEach(btn => {
      btn.addEventListener('click', function () {
        const wagerInput = document.getElementById('craps-wager');
        if (wagerInput) wagerInput.value = this.dataset.amount;
      });
    });

    // Bet type selector (Pass / Don't Pass)
    document.querySelectorAll('.craps-bet-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.craps-bet-btn').forEach(b => {
          b.classList.remove('ring-2', 'ring-yellow-400');
        });
        this.classList.add('ring-2', 'ring-yellow-400');
      });
    });

    document.getElementById('craps-back-btn')?.addEventListener('click', function () {
      document.getElementById('craps-game').style.display  = 'none';
      document.getElementById('casino-lobby').style.display = 'block';
    });

    document.getElementById('casino-open-craps')?.addEventListener('click', function () {
      document.getElementById('casino-lobby').style.display = 'none';
      document.getElementById('craps-game').style.display  = 'block';
      if (identityId) init(identityId);
    });
  });

  // Public API
  return { init };
}());
