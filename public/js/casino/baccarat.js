/*
 * DayZ Dashboard — Casino Baccarat Module
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Punto Banco baccarat — player bets on Player, Banker, or Tie.
 * The entire hand resolves server-side in one request with no player decisions.
 *
 * Payouts:
 *   Player wins → Player 1:1; Banker/Tie lose
 *   Banker wins → Banker 0.95:1 (5% commission); Player/Tie lose
 *   Tie         → Tie 8:1; Player/Banker push (stake returned)
 *
 * Exposes a global `CasinoBaccarat` object used by player-portal.js.
 */

const CasinoBaccarat = (function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let identityId     = null;
  let balance        = 0;
  let currencySymbol = '$';
  let dealing        = false;
  let localHistory   = [];

  const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };

  // ── Helpers ────────────────────────────────────────────────────────────────

  function fmt(amount) {
    return `${currencySymbol}${parseFloat(amount).toFixed(2)}`;
  }

  function updateBalanceDisplay(newBalance) {
    balance = newBalance;
    const el = document.getElementById('baccarat-balance');
    if (el) el.textContent = fmt(balance);
  }

  function setStatus(text, type = 'info') {
    const el = document.getElementById('baccarat-status');
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

  function cardHTML(card) {
    const isRed = card.suit === 'H' || card.suit === 'D';
    const color = isRed ? 'text-red-400' : 'text-white';
    const suit  = SUIT_SYMBOLS[card.suit] || card.suit;
    return `
      <div class="baccarat-card bg-gray-900 border border-gray-600 rounded-lg flex flex-col items-center justify-center select-none" style="width:3rem;height:4rem;">
        <span class="${color} font-bold text-xs leading-none">${card.rank}</span>
        <span class="${color} text-xl leading-none">${suit}</span>
      </div>`;
  }

  function renderHand(containerId, cards, total) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = cards.map(c => cardHTML(c)).join('');
    // Update associated total display
    const totalEl = document.getElementById(containerId + '-total');
    if (totalEl) totalEl.textContent = total;
  }

  function clearTable() {
    ['baccarat-player-cards', 'baccarat-banker-cards'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    ['baccarat-player-cards-total', 'baccarat-banker-cards-total'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
    document.getElementById('baccarat-winner-banner').textContent = '';
    document.getElementById('baccarat-winner-banner').className   = 'text-center text-2xl font-black mb-2 min-h-[2rem]';
  }

  // ── Bet type selector ──────────────────────────────────────────────────────

  function getSelectedBetType() {
    return document.querySelector('.baccarat-bet-btn.ring-2')?.dataset.betType || 'player';
  }

  // ── History ────────────────────────────────────────────────────────────────

  function addToHistory(entry) {
    localHistory.unshift(entry);
    if (localHistory.length > 10) localHistory.pop();
    renderHistory();
  }

  function renderHistory() {
    const el = document.getElementById('baccarat-history');
    if (!el) return;
    if (localHistory.length === 0) {
      el.innerHTML = '<p class="text-gray-500 text-sm">No hands played this session.</p>';
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

  // ── Core deal action ───────────────────────────────────────────────────────

  async function doDeal() {
    if (dealing) return;

    const betType    = getSelectedBetType();
    const wagerInput = document.getElementById('baccarat-wager');
    const wager      = parseFloat(wagerInput?.value);

    if (!wager || wager <= 0) { setStatus('Enter a valid wager.', 'warn'); return; }
    if (wager > balance)      { setStatus('Insufficient balance!', 'loss'); return; }

    dealing = true;
    const dealBtn = document.getElementById('baccarat-deal-btn');
    if (dealBtn) { dealBtn.disabled = true; dealBtn.textContent = '🎴 Dealing…'; }
    document.querySelectorAll('.baccarat-bet-btn').forEach(b => b.disabled = true);
    setStatus('Dealing…', 'info');
    clearTable();

    const data = await fetchWithCsrf('/api/casino/play/baccarat', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ serverId: window.currentEconomyServerId, identityId, wager, betType }),
    }).then(r => r.json()).catch(e => ({ success: false, error: e.message }));

    if (!data.success) {
      setStatus(data.error || 'Deal failed. Try again.', 'loss');
      dealing = false;
      if (dealBtn) { dealBtn.disabled = false; dealBtn.textContent = '🎴 Deal'; }
      document.querySelectorAll('.baccarat-bet-btn').forEach(b => b.disabled = false);
      return;
    }

    // Render cards
    renderHand('baccarat-player-cards', data.playerCards, data.playerTotal);
    renderHand('baccarat-banker-cards', data.bankerCards, data.bankerTotal);

    // Winner banner
    const banner = document.getElementById('baccarat-winner-banner');
    if (banner) {
      banner.textContent = data.winner === 'player' ? '🏆 PLAYER'
                         : data.winner === 'banker' ? '🏦 BANKER'
                         : '🤝 TIE';
      const bannerCls = data.winner === 'player' ? 'text-blue-400'
                      : data.winner === 'banker' ? 'text-red-400'
                      : 'text-yellow-400';
      banner.className = `text-center text-2xl font-black mb-2 min-h-[2rem] ${bannerCls}`;
    }

    // Natural badge
    const naturalBadge = document.getElementById('baccarat-natural-badge');
    if (naturalBadge) {
      naturalBadge.textContent = data.natural ? '✨ Natural' : '';
    }

    // Balance + status
    if (data.balanceAfter !== undefined) updateBalanceDisplay(data.balanceAfter);

    const statusType = data.result === 'win'  ? 'win'
                     : data.result === 'loss' ? 'loss'
                     : 'push';
    setStatus(data.message || '', statusType);

    addToHistory({
      label:  `${betType.charAt(0).toUpperCase() + betType.slice(1)} — ${data.winner.charAt(0).toUpperCase() + data.winner.slice(1)} won`,
      result: data.result,
      net:    data.net,
    });

    dealing = false;
    if (dealBtn) { dealBtn.disabled = false; dealBtn.textContent = '🎴 Deal'; }
    document.querySelectorAll('.baccarat-bet-btn').forEach(b => b.disabled = false);
  }

  // ── Initialisation ─────────────────────────────────────────────────────────

  /**
   * Load balance + config and reset the table.
   * Called by player-portal.js when the baccarat section becomes visible.
   *
   * @param {number|string} playerIdentityId
   */
  async function init(playerIdentityId) {
    identityId   = playerIdentityId;
    dealing      = false;
    localHistory = [];

    try {
      const res  = await fetch(`/api/casino/status/${identityId}?serverId=${encodeURIComponent(window.currentEconomyServerId)}`);
      const data = await res.json();
      if (!data.success || !data.casinoEnabled) return;
      currencySymbol = data.currency?.symbol || '$';
      updateBalanceDisplay(data.balance);

      document.querySelectorAll('.baccarat-quick-bet').forEach(btn => {
        btn.textContent = `${currencySymbol}${btn.dataset.amount}`;
      });
    } catch (err) {
      console.error('Failed to load casino status for baccarat:', err);
    }

    clearTable();
    renderHistory();
    setStatus('Choose your bet and deal!', 'info');
  }

  // ── Event wiring (runs once on DOMContentLoaded) ───────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('baccarat-deal-btn')?.addEventListener('click', doDeal);

    document.getElementById('baccarat-wager')?.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doDeal();
    });

    document.querySelectorAll('.baccarat-quick-bet').forEach(btn => {
      btn.addEventListener('click', function () {
        const wagerInput = document.getElementById('baccarat-wager');
        if (wagerInput) wagerInput.value = this.dataset.amount;
      });
    });

    // Bet type selector
    document.querySelectorAll('.baccarat-bet-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.baccarat-bet-btn').forEach(b => {
          b.classList.remove('ring-2', 'ring-yellow-400');
        });
        this.classList.add('ring-2', 'ring-yellow-400');
      });
    });

    document.getElementById('baccarat-back-btn')?.addEventListener('click', function () {
      document.getElementById('baccarat-game').style.display  = 'none';
      document.getElementById('casino-lobby').style.display  = 'block';
    });

    document.getElementById('casino-open-baccarat')?.addEventListener('click', function () {
      document.getElementById('casino-lobby').style.display  = 'none';
      document.getElementById('baccarat-game').style.display = 'block';
      if (identityId) init(identityId);
    });
  });

  // Public API
  return { init };
}());
