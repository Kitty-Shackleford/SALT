/*
 * DayZ Dashboard — Casino Texas Hold'em Module
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Casino Hold'em: single player vs the house.
 *   1. Player posts Ante → receives 2 hole cards + 3 community (flop)
 *   2. Player Calls (2× Ante) or Folds
 *   3. Turn + River are revealed; hands compared
 *   4. Dealer must hold at least a pair of 4s to qualify
 *
 * Payouts:
 *   Dealer doesn't qualify  → Ante 1:1, Call push (returned)
 *   Player wins             → Ante 1:1, Call 1:1
 *   Push                    → all bets returned
 *   Dealer wins / Fold      → all bets lost
 *
 * Exposes a global `CasinoHoldem` object consumed by player-portal.js.
 */

const CasinoHoldem = (function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let identityId     = null;
  let balance        = 0;
  let currencySymbol = '$';
  let gameActive     = false;
  let currentSessionId = null; // signed token from server
  let currentAnte      = 0;
  let localHistory     = [];

  // ── Helpers ────────────────────────────────────────────────────────────────

  function fmt(amount) {
    return `${currencySymbol}${parseFloat(amount).toFixed(2)}`;
  }

  function updateBalanceDisplay(newBalance) {
    balance = newBalance;
    const el = document.getElementById('holdem-balance');
    if (el) el.textContent = fmt(balance);
  }

  function setStatus(text, type = 'info') {
    const el = document.getElementById('holdem-status');
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

  // ── Card rendering ─────────────────────────────────────────────────────────

  const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };

  function cardHTML(card, faceDown = false) {
    if (faceDown) {
      return `<div class="holdem-card bg-blue-950 border-2 border-blue-700 rounded-lg flex items-center justify-center text-2xl select-none" style="width:3rem;height:4rem;">🂠</div>`;
    }
    const isRed = card.suit === 'H' || card.suit === 'D';
    const color = isRed ? 'text-red-400' : 'text-white';
    const suit  = SUIT_SYMBOLS[card.suit] || card.suit;
    return `
      <div class="holdem-card bg-gray-900 border border-gray-600 rounded-lg flex flex-col items-center justify-center select-none" style="width:3rem;height:4rem;">
        <span class="${color} font-bold text-xs leading-none">${card.rank}</span>
        <span class="${color} text-xl leading-none">${suit}</span>
      </div>`;
  }

  function emptyCardHTML() {
    return `<div class="holdem-card bg-gray-800 border border-dashed border-gray-600 rounded-lg" style="width:3rem;height:4rem;"></div>`;
  }

  function renderCards(containerId, cards, faceDown = false) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = cards.map(c => (c ? cardHTML(c, faceDown) : emptyCardHTML())).join('');
  }

  function renderDealerCards(hole, faceDown) {
    const el = document.getElementById('holdem-dealer-cards');
    if (!el) return;
    if (faceDown) {
      // Show two face-down cards while game is active
      el.innerHTML = cardHTML(null, true) + cardHTML(null, true);
    } else {
      el.innerHTML = hole.map(c => cardHTML(c)).join('');
    }
  }

  // ── Controls visibility ────────────────────────────────────────────────────

  function showDealControls() {
    document.getElementById('holdem-deal-controls')?.style.setProperty('display', 'block');
    document.getElementById('holdem-action-controls')?.style.setProperty('display', 'none');
    const spinBtn = document.getElementById('holdem-deal-btn');
    if (spinBtn) { spinBtn.disabled = false; spinBtn.textContent = '🃏 Deal'; }
  }

  function showActionControls(ante) {
    document.getElementById('holdem-deal-controls')?.style.setProperty('display', 'none');
    const ctrl = document.getElementById('holdem-action-controls');
    if (ctrl) ctrl.style.display = 'block';
    const callBtn = document.getElementById('holdem-call-btn');
    if (callBtn) callBtn.textContent = `📞 Call (${fmt(ante * 2)})`;
  }

  function lockControls() {
    document.getElementById('holdem-deal-btn')?.setAttribute('disabled', 'true');
    document.getElementById('holdem-call-btn')?.setAttribute('disabled', 'true');
    document.getElementById('holdem-fold-btn')?.setAttribute('disabled', 'true');
  }

  function resetTable() {
    // Reset community and hole cards to blank placeholders
    const community = document.getElementById('holdem-community-cards');
    if (community) community.innerHTML = Array(5).fill(emptyCardHTML()).join('');

    const pCards = document.getElementById('holdem-player-cards');
    if (pCards) pCards.innerHTML = Array(2).fill(emptyCardHTML()).join('');

    const dCards = document.getElementById('holdem-dealer-cards');
    if (dCards) dCards.innerHTML = Array(2).fill(emptyCardHTML()).join('');

    document.getElementById('holdem-player-hand-name').textContent  = '';
    document.getElementById('holdem-dealer-hand-name').textContent  = '';
    document.getElementById('holdem-dealer-qualify').textContent    = '';
  }

  // ── History ────────────────────────────────────────────────────────────────

  function addToHistory(entry) {
    localHistory.unshift(entry);
    if (localHistory.length > 10) localHistory.pop();
    renderHistory();
  }

  function renderHistory() {
    const el = document.getElementById('holdem-history');
    if (!el) return;

    if (localHistory.length === 0) {
      el.innerHTML = '<p class="text-gray-500 text-sm">No hands played this session.</p>';
      return;
    }

    el.innerHTML = localHistory.map(h => {
      const cls = h.result === 'win'  ? 'text-green-400'
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

  async function doDeal() {
    if (gameActive) return;

    const wagerInput = document.getElementById('holdem-wager');
    const ante       = parseFloat(wagerInput?.value);

    if (!ante || ante <= 0) { setStatus('Enter a valid ante.', 'warn'); return; }
    if (ante > balance)     { setStatus('Insufficient balance!', 'loss'); return; }

    gameActive = true;
    lockControls();
    setStatus('Dealing…', 'info');
    resetTable();

    const data = await fetchWithCsrf('/api/casino/play/holdem', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ serverId: window.currentEconomyServerId, identityId, action: 'deal', wager: ante }),
    }).then(r => r.json()).catch(e => ({ success: false, error: e.message }));

    if (!data.success) {
      setStatus(data.error || 'Deal failed. Try again.', 'loss');
      gameActive = false;
      showDealControls();
      return;
    }

    currentSessionId = data.sessionId;
    currentAnte      = data.ante;

    // Render player hole cards and flop
    renderCards('holdem-player-cards', data.playerHole);
    renderCards('holdem-community-cards', [
      ...data.community,
      ...Array(2).fill(null),   // turn and river placeholders
    ]);
    renderDealerCards(null, true); // face-down

    setStatus(`Flop dealt — Call (${fmt(data.ante * 2)}) to see all 5 community cards, or Fold.`, 'info');
    showActionControls(data.ante);
  }

  async function doAction(action) {
    if (!gameActive || !currentSessionId) return;

    lockControls();
    setStatus(action === 'call' ? 'Calling…' : 'Folding…', 'info');

    const data = await fetchWithCsrf('/api/casino/play/holdem', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ serverId: window.currentEconomyServerId, identityId, action, sessionId: currentSessionId }),
    }).then(r => r.json()).catch(e => ({ success: false, error: e.message }));

    if (!data.success) {
      setStatus(data.error || 'Something went wrong.', 'loss');
      gameActive = false;
      showDealControls();
      return;
    }

    // ── Reveal full table ────────────────────────────────────────────────────
    renderCards('holdem-player-cards', data.playerHole);
    renderCards('holdem-community-cards', data.community);
    renderDealerCards(data.dealerHole, false);

    // Hand names
    const pName = document.getElementById('holdem-player-hand-name');
    const dName = document.getElementById('holdem-dealer-hand-name');
    const dQual = document.getElementById('holdem-dealer-qualify');
    if (pName) pName.textContent = action === 'fold' ? '' : (data.playerHand || '');
    if (dName) dName.textContent = action === 'fold' ? '' : (data.dealerHand || '');
    if (dQual) {
      if (action === 'fold') {
        dQual.textContent = '';
      } else {
        dQual.textContent = data.qualifies ? '✓ Qualifies' : '✗ Does not qualify';
        dQual.className   = `text-xs font-semibold ${data.qualifies ? 'text-green-400' : 'text-red-400'}`;
      }
    }

    // Update balance display
    if (data.balanceAfter !== undefined) updateBalanceDisplay(data.balanceAfter);

    // Status message
    let statusMsg = '';
    let statusType = 'info';
    if (action === 'fold') {
      statusMsg  = `Folded — lost ante of ${fmt(currentAnte)}`;
      statusType = 'loss';
    } else if (data.outcome === 'no_qualify') {
      statusMsg  = `🎉 Dealer doesn't qualify! Ante wins, call returned. +${fmt(Math.abs(data.net))}`;
      statusType = 'win';
    } else if (data.outcome === 'player_wins') {
      statusMsg  = `🎉 You win! ${data.playerHand} beats dealer's ${data.dealerHand}. +${fmt(Math.abs(data.net))}`;
      statusType = 'win';
    } else if (data.outcome === 'push') {
      statusMsg  = `🤝 Push — both hands tied. All bets returned.`;
      statusType = 'push';
    } else {
      statusMsg  = `💸 Dealer wins (${data.dealerHand}). Lost ${fmt(Math.abs(data.net))}.`;
      statusType = 'loss';
    }
    setStatus(statusMsg, statusType);

    // Add to session history
    addToHistory({
      label:  action === 'fold' ? 'Fold' : `${data.playerHand || '?'} vs ${data.dealerHand || '?'}`,
      result: data.result,
      net:    data.net,
    });

    // Reset for next hand
    gameActive       = false;
    currentSessionId = null;
    currentAnte      = 0;
    setTimeout(() => {
      resetTable();
      showDealControls();
      setStatus('Place your ante to start a new hand.', 'info');
    }, 5000);
  }

  // ── Initialisation ─────────────────────────────────────────────────────────

  /**
   * Load balance + config then reset the table to a clean idle state.
   * Called by player-portal.js when the hold'em section becomes visible.
   *
   * @param {number|string} playerIdentityId
   */
  async function init(playerIdentityId) {
    identityId       = playerIdentityId;
    gameActive       = false;
    currentSessionId = null;
    localHistory     = [];

    try {
      const res  = await fetch(`/api/casino/status/${identityId}?serverId=${encodeURIComponent(window.currentEconomyServerId)}`);
      const data = await res.json();
      if (!data.success || !data.casinoEnabled) return;
      currencySymbol = data.currency?.symbol || '$';
      updateBalanceDisplay(data.balance);

      // Update quick-bet labels to reflect the real currency symbol
      document.querySelectorAll('.holdem-quick-bet').forEach(btn => {
        btn.textContent = `${currencySymbol}${btn.dataset.amount}`;
      });
    } catch (err) {
      console.error('Failed to load casino status for holdem:', err);
    }

    resetTable();
    renderHistory();
    showDealControls();
    setStatus('Place your ante to start a new hand.', 'info');
  }

  // ── Event wiring (runs once on DOMContentLoaded) ───────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('holdem-deal-btn')?.addEventListener('click', doDeal);
    document.getElementById('holdem-call-btn')?.addEventListener('click', () => doAction('call'));
    document.getElementById('holdem-fold-btn')?.addEventListener('click', () => doAction('fold'));

    document.getElementById('holdem-wager')?.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doDeal();
    });

    document.querySelectorAll('.holdem-quick-bet').forEach(btn => {
      btn.addEventListener('click', function () {
        const wagerInput = document.getElementById('holdem-wager');
        if (wagerInput) wagerInput.value = this.dataset.amount;
      });
    });

    document.getElementById('holdem-back-btn')?.addEventListener('click', function () {
      document.getElementById('holdem-game').style.display   = 'none';
      document.getElementById('casino-lobby').style.display  = 'block';
    });

    document.getElementById('casino-open-holdem')?.addEventListener('click', function () {
      document.getElementById('casino-lobby').style.display  = 'none';
      document.getElementById('holdem-game').style.display   = 'block';
      if (identityId) init(identityId);
    });
  });

  // Public API
  return { init };
}());
