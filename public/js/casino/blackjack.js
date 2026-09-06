/*
 * DayZ Dashboard — Casino Blackjack Module
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Single-player Blackjack (player vs dealer) game UI module.
 * Exposes a global `CasinoBlackjack` object used by player-portal.js.
 *
 * Game rules:
 *   - Dealer hits on soft 17, stands on hard 17+
 *   - Blackjack pays 3:2
 *   - Double down on first two cards only
 *   - Split allowed on pairs (no re-split, no double after split)
 *   - Insurance offered when dealer shows Ace
 *
 * Usage:
 *   CasinoBlackjack.init(identityId)
 */

const CasinoBlackjack = (function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let identityId     = null;
  let balance        = 0;
  let currencySymbol = '$';
  let sessionId        = null;   // signed server-side hand state object
  let gameActive       = false;
  let currentWager     = 0;
  let insurancePending = false;  // true when dealer showed Ace and player hasn't decided yet

  // ── Helpers ────────────────────────────────────────────────────────────────

  function fmt(amount) {
    return `${currencySymbol}${parseFloat(amount).toFixed(2)}`;
  }

  function updateBalanceDisplay(newBalance) {
    balance = newBalance;
    const el = document.getElementById('bj-balance');
    if (el) el.textContent = fmt(balance);
  }

  function setStatus(text, type) {
    const el = document.getElementById('bj-status');
    if (!el) return;
    const colours = {
      win:       'text-green-400',
      blackjack: 'text-yellow-300',
      loss:      'text-red-400',
      push:      'text-yellow-400',
      info:      'text-gray-300',
      bust:      'text-red-400'
    };
    el.className = `text-center text-lg font-bold min-h-7 mb-3 ${colours[type] || 'text-gray-300'}`;
    el.textContent = text;
  }

  // ── Card rendering ─────────────────────────────────────────────────────────

  /** Return true when the suit is red (hearts / diamonds). */
  function isRed(suit) {
    return suit === '♥' || suit === '♦';
  }

  /**
   * Build an HTML string for a single playing card.
   * @param {{ suit: string, rank: string }} card
   * @param {boolean} faceDown  - render as a blank card back
   */
  function cardHTML(card, faceDown = false) {
    if (faceDown) {
      return `<div class="bj-card bj-card-back" title="Hidden card">
                <span class="bj-card-inner">🂠</span>
              </div>`;
    }
    const red = isRed(card.suit) ? 'bj-card-red' : 'bj-card-black';
    return `<div class="bj-card ${red}" title="${card.rank}${card.suit}">
              <div class="bj-card-rank-top">${card.rank}</div>
              <div class="bj-card-suit">${card.suit}</div>
              <div class="bj-card-rank-bot">${card.rank}</div>
            </div>`;
  }

  /** Render a hand (array of card objects) into a container element. */
  function renderHand(containerId, cards, hideSecond = false) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = cards.map((c, i) =>
      (hideSecond && i === 1) ? cardHTML(null, true) : cardHTML(c)
    ).join('');
  }

  /**
   * Render both split hands into #bj-split-cards-{i} / #bj-split-total-{i}.
   * Highlights the active hand with a green border.
   * Shows interim labels (Bust / Stood) on settled hands.
   * @param {Array}  splitHands        - array of { cards, total, result, wager }
   * @param {number} currentHandIndex  - index of the hand currently being played
   */
  function renderSplitHands(splitHands, currentHandIndex) {
    splitHands.forEach((hand, i) => {
      const cardsEl = document.getElementById(`bj-split-cards-${i}`);
      if (cardsEl) cardsEl.innerHTML = hand.cards.map(c => cardHTML(c)).join('');

      const totalEl = document.getElementById(`bj-split-total-${i}`);
      if (totalEl) totalEl.textContent = `Total: ${hand.total}`;

      // Highlight the active hand; grey out the others
      const handEl = document.getElementById(`bj-split-hand-${i}`);
      if (handEl) {
        if (i === currentHandIndex) {
          handEl.classList.add('border-green-500');
          handEl.classList.remove('border-gray-700');
        } else {
          handEl.classList.remove('border-green-500');
          handEl.classList.add('border-gray-700');
        }
      }

      // Show interim result label for settled hands
      const resultEl = document.getElementById(`bj-split-result-${i}`);
      if (resultEl) {
        if (hand.result === 'loss') {
          resultEl.textContent = 'Bust!';
          resultEl.className   = 'text-center text-xs font-bold mt-1 text-red-400';
        } else if (hand.result === 'stood') {
          resultEl.textContent = 'Stood';
          resultEl.className   = 'text-center text-xs font-bold mt-1 text-gray-400';
        } else {
          resultEl.textContent = '';
          resultEl.className   = 'text-center text-xs font-bold mt-1';
        }
      }
    });
  }

  /**
   * Render the final state of split hands after settlement.
   * Shows dealer cards/total and per-hand results with colour coding.
   * @param {Array}  splitResults - array of { result, net, balanceAfter, cards, playerTotal }
   * @param {Array}  dealerCards  - final dealer cards (all revealed)
   * @param {number} dealerTotal  - dealer's final total
   */
  function renderSplitComplete(splitResults, dealerCards, dealerTotal) {
    // Reveal dealer hand
    renderHand('bj-dealer-cards', dealerCards);
    const dlrLabel = document.getElementById('bj-dealer-total');
    if (dlrLabel) dlrLabel.textContent = `Total: ${dealerTotal}`;

    const resultColours = { win: 'text-green-400', loss: 'text-red-400', push: 'text-yellow-400' };
    const resultLabels  = { win: 'Win!', loss: 'Loss', push: 'Push' };

    splitResults.forEach((r, i) => {
      const cardsEl = document.getElementById(`bj-split-cards-${i}`);
      if (cardsEl) cardsEl.innerHTML = r.cards.map(c => cardHTML(c)).join('');

      const totalEl = document.getElementById(`bj-split-total-${i}`);
      if (totalEl) totalEl.textContent = `Total: ${r.playerTotal}`;

      const resultEl = document.getElementById(`bj-split-result-${i}`);
      if (resultEl) {
        resultEl.textContent = resultLabels[r.result] || r.result;
        resultEl.className   = `text-center text-xs font-bold mt-1 ${resultColours[r.result] || 'text-gray-400'}`;
      }

      // Remove active highlight on both hands
      const handEl = document.getElementById(`bj-split-hand-${i}`);
      if (handEl) {
        handEl.classList.remove('border-green-500');
        handEl.classList.add('border-gray-700');
      }
    });
  }

  // ── Action buttons ─────────────────────────────────────────────────────────

  function setActions(phase) {
    // phase: 'idle' | 'active' | 'active-nodbl' | 'complete'
    const dealBtn   = document.getElementById('bj-deal-btn');
    const hitBtn    = document.getElementById('bj-hit-btn');
    const standBtn  = document.getElementById('bj-stand-btn');
    const dblBtn    = document.getElementById('bj-double-btn');
    const wagerWrap = document.getElementById('bj-wager-wrap');

    const show = (...ids) => ids.forEach(id => { const e = document.getElementById(id); if (e) e.style.display = ''; });
    const hide = (...ids) => ids.forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; });
    const enable  = el => { if (el) el.disabled = false; };
    const disable = el => { if (el) el.disabled = true; };

    if (phase === 'idle' || phase === 'complete') {
      show('bj-wager-wrap', 'bj-deal-btn');
      hide('bj-hit-btn', 'bj-stand-btn', 'bj-double-btn', 'bj-split-btn');
      enable(dealBtn);
    } else if (phase === 'active') {
      hide('bj-wager-wrap', 'bj-deal-btn');
      show('bj-hit-btn', 'bj-stand-btn', 'bj-double-btn');
      hide('bj-split-btn'); // shown separately in handleResponse when canSplit is true
      enable(hitBtn); enable(standBtn); enable(dblBtn);
    } else if (phase === 'active-nodbl') {
      hide('bj-wager-wrap', 'bj-deal-btn', 'bj-double-btn', 'bj-split-btn');
      show('bj-hit-btn', 'bj-stand-btn');
      enable(hitBtn); enable(standBtn);
    } else if (phase === 'insurance') {
      // Insurance prompt is shown separately; hide all normal game buttons, enable insurance buttons
      hide('bj-wager-wrap', 'bj-deal-btn', 'bj-hit-btn', 'bj-stand-btn', 'bj-double-btn', 'bj-split-btn');
      enable(document.getElementById('bj-insurance-yes-btn'));
      enable(document.getElementById('bj-insurance-no-btn'));
    }
  }

  function disableAllActions() {
    ['bj-deal-btn','bj-hit-btn','bj-stand-btn','bj-double-btn','bj-split-btn',
     'bj-insurance-yes-btn','bj-insurance-no-btn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
  }

  // ── Core game actions ──────────────────────────────────────────────────────

  async function sendAction(action, extraBody = {}) {
    disableAllActions();
    try {
      const body = { identityId, serverId: window.currentEconomyServerId, action, ...extraBody };
      const res  = await fetchWithCsrf('/api/casino/play/blackjack', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body:   JSON.stringify(body)
      });
      return await res.json();
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function handleResponse(data) {
    // Always hide insurance prompt unless we're about to show it below
    const insurancePromptEl = document.getElementById('bj-insurance-prompt');
    if (insurancePromptEl) insurancePromptEl.style.display = 'none';

    if (!data.success) {
      setStatus(data.error || 'Something went wrong.', 'info');
      // If insurance was offered but not yet resolved, restore the insurance prompt
      // so the player can still make a decision instead of being stuck.
      if (gameActive && insurancePending && insurancePromptEl) {
        insurancePromptEl.style.display = '';
        setActions('insurance');
      } else {
        setActions(gameActive ? 'active' : 'idle');
      }
      return;
    }

    if (data.currency?.symbol) currencySymbol = data.currency.symbol;

    if (data.status === 'active') {
      gameActive = true;
      sessionId  = data.sessionId;

      if (data.insuranceAvailable) {
        // ── Insurance offer ────────────────────────────────────────────────
        // Show player cards and dealer's face-up card, then prompt for insurance
        renderHand('bj-player-cards', data.playerCards);
        const playerLabelEl = document.getElementById('bj-player-total');
        if (playerLabelEl) playerLabelEl.textContent = `Total: ${data.playerTotal}`;

        renderHand('bj-dealer-cards', data.dealerCards);
        const dlrLabel = document.getElementById('bj-dealer-total');
        if (dlrLabel) dlrLabel.textContent = `Showing: ${data.dealerVisible}`;

        // Fill in the insurance cost and reveal the prompt
        const amountEl = document.getElementById('bj-insurance-amount');
        if (amountEl) amountEl.textContent = fmt(currentWager / 2);
        if (insurancePromptEl) insurancePromptEl.style.display = '';

        insurancePending = true;
        setStatus('Dealer shows Ace — Insurance?', 'info');
        setActions('insurance');
        return; // insurance buttons take it from here
      }

      if (data.splitHands) {
        // ── Split hand in progress ─────────────────────────────────────────
        insurancePending = false;
        // Hide the normal single-hand area; show the split display
        const playerHandEl = document.getElementById('bj-player-cards')?.closest('div.mb-6');
        if (playerHandEl) playerHandEl.style.display = 'none';
        document.getElementById('bj-split-display').style.display = '';

        renderSplitHands(data.splitHands, data.currentHandIndex);

        // Dealer face-up card
        renderHand('bj-dealer-cards', data.dealerCards);
        const dlrLabel = document.getElementById('bj-dealer-total');
        if (dlrLabel) dlrLabel.textContent = `Showing: ${data.dealerVisible}`;

        const handNum = data.currentHandIndex + 1;
        if (data.bustMessage) {
          setStatus(data.bustMessage, 'bust');
        } else {
          setStatus(`Hand ${handNum} — Total: ${data.playerTotal}`, 'info');
        }

        // No double or split allowed during split play
        setActions('active-nodbl');
      } else {
        // ── Normal active hand ─────────────────────────────────────────────
        insurancePending = false;
        renderHand('bj-player-cards', data.playerCards);
        const playerLabelEl = document.getElementById('bj-player-total');
        if (playerLabelEl) playerLabelEl.textContent = `Total: ${data.playerTotal}`;

        renderHand('bj-dealer-cards', data.dealerCards);
        const dlrLabel = document.getElementById('bj-dealer-total');
        if (dlrLabel) dlrLabel.textContent = `Showing: ${data.dealerVisible}`;

        // Show brief insurance-lost message if insurance was just settled against us
        if (data.insuranceLost) {
          setStatus(`Insurance lost (−${fmt(currentWager / 2)}). Play your hand.`, 'info');
        } else {
          setStatus(`Your total: ${data.playerTotal}`, 'info');
        }

        setActions(data.canDouble ? 'active' : 'active-nodbl');

        // Show split button when the pair is eligible
        if (data.canSplit) {
          const splitBtn = document.getElementById('bj-split-btn');
          if (splitBtn) splitBtn.style.display = '';
        }
      }
    } else {
      // ── Hand complete ──────────────────────────────────────────────────────
      gameActive       = false;
      sessionId        = null;
      insurancePending = false;

      if (data.split) {
        // Split hand settlement
        renderSplitComplete(data.splitResults, data.dealerCards, data.dealerTotal);
        document.getElementById('bj-split-display').style.display = '';

        updateBalanceDisplay(data.balanceAfter);
        setStatus(data.message || 'Split complete.', 'info');

        // Build a synthetic playerTotal string for the history entry
        const splitSummary = data.splitResults.map((r, i) => `H${i + 1}:${r.playerTotal}`).join(' ');
        addToHistory('split', data.totalNet, currentWager, splitSummary, data.dealerTotal);
        setActions('complete');
      } else {
        // Normal single-hand settlement
        renderHand('bj-player-cards', data.playerCards);
        const playerLabelEl = document.getElementById('bj-player-total');
        if (playerLabelEl) playerLabelEl.textContent = `Total: ${data.playerTotal}`;

        renderHand('bj-dealer-cards', data.dealerCards);
        const dlrLabel = document.getElementById('bj-dealer-total');
        if (dlrLabel) dlrLabel.textContent = `Total: ${data.dealerTotal}`;

        updateBalanceDisplay(data.balanceAfter);

        const resultType = data.result === 'blackjack' ? 'blackjack' : data.result;
        setStatus(data.message || '', resultType);
        addToHistory(data.result, data.net, currentWager, data.playerTotal, data.dealerTotal);
        setActions('complete');
      }
    }
  }

  async function deal() {
    if (gameActive) return;
    const wagerInput = document.getElementById('bj-wager');
    const wager = parseFloat(wagerInput?.value);
    if (!wager || wager <= 0) { setStatus('Enter a valid wager.', 'info'); return; }
    if (wager > balance) { setStatus('Insufficient balance!', 'loss'); return; }

    currentWager     = wager;
    insurancePending = false;
    setStatus('Dealing…', 'info');

    // Reset split display and restore the normal player-hand area
    document.getElementById('bj-split-display').style.display = 'none';
    document.getElementById('bj-insurance-prompt').style.display = 'none';
    [0, 1].forEach(i => {
      const el = document.getElementById(`bj-split-cards-${i}`);
      if (el) el.innerHTML = '';
      const totalEl = document.getElementById(`bj-split-total-${i}`);
      if (totalEl) totalEl.textContent = '';
      const resultEl = document.getElementById(`bj-split-result-${i}`);
      if (resultEl) resultEl.textContent = '';
    });
    const playerHandEl = document.getElementById('bj-player-cards')?.closest('div.mb-6');
    if (playerHandEl) playerHandEl.style.display = '';

    // Clear previous cards
    ['bj-player-cards','bj-dealer-cards'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    ['bj-player-total','bj-dealer-total'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    });

    const data = await sendAction('deal', { wager });
    handleResponse(data);
  }

  async function hit() {
    if (!gameActive || !sessionId) return;
    setStatus('Hit…', 'info');
    const data = await sendAction('hit', { sessionId });
    handleResponse(data);
  }

  async function stand() {
    if (!gameActive || !sessionId) return;
    setStatus('Standing — dealer plays…', 'info');
    const data = await sendAction('stand', { sessionId });
    handleResponse(data);
  }

  async function doubleDown() {
    if (!gameActive || !sessionId) return;
    setStatus('Doubling down…', 'info');
    const data = await sendAction('double', { sessionId });
    handleResponse(data);
  }

  async function split() {
    if (!gameActive || !sessionId) return;
    setStatus('Splitting…', 'info');
    const data = await sendAction('split', { sessionId });
    handleResponse(data);
  }

  async function insuranceYes() {
    if (!gameActive || !sessionId) return;
    setStatus('Taking insurance…', 'info');
    const data = await sendAction('insurance', { sessionId });
    handleResponse(data);
  }

  async function insuranceNo() {
    if (!gameActive || !sessionId) return;
    setStatus('Declining insurance…', 'info');
    const data = await sendAction('no-insurance', { sessionId });
    handleResponse(data);
  }

  // ── History ────────────────────────────────────────────────────────────────

  const localHistory = [];

  function addToHistory(result, net, wager, playerTotal, dealerTotal) {
    const netStr   = net >= 0 ? `+${fmt(net)}` : fmt(net);
    const colours  = { win: 'text-green-400', blackjack: 'text-yellow-300', loss: 'text-red-400', push: 'text-yellow-400', split: 'text-blue-400' };
    const labels   = { win: 'Win', blackjack: '🃏 BJ', loss: 'Loss', push: 'Push', split: 'Split' };
    localHistory.unshift({ result, netStr, colour: colours[result] || 'text-gray-400',
                           label: labels[result] || result, playerTotal, dealerTotal });
    if (localHistory.length > 10) localHistory.pop();
    renderHistory();
  }

  function renderHistory() {
    const el = document.getElementById('bj-history');
    if (!el) return;
    if (!localHistory.length) {
      el.innerHTML = '<p class="text-gray-500 text-sm">No hands played this session.</p>';
      return;
    }
    el.innerHTML = localHistory.map(h =>
      `<div class="flex justify-between items-center bg-gray-900 rounded px-3 py-1 text-sm">
         <span class="text-gray-400">${h.label} &nbsp; P:${h.playerTotal} D:${h.dealerTotal}</span>
         <span class="${h.colour} font-semibold">${h.netStr}</span>
       </div>`
    ).join('');
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init(playerIdentityId) {
    identityId = playerIdentityId;
    sessionId  = null;
    gameActive = false;
    localHistory.length = 0;

    try {
      const res  = await fetch(`/api/casino/status/${identityId}?serverId=${encodeURIComponent(window.currentEconomyServerId)}`);
      const data = await res.json();
      if (data.currency?.symbol) currencySymbol = data.currency.symbol;
      updateBalanceDisplay(data.balance || 0);
    } catch (err) {
      console.error('Blackjack: failed to load casino status', err);
    }

    setActions('idle');
    setStatus('Place your bet and deal to start.', 'info');
    ['bj-player-cards','bj-dealer-cards'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    ['bj-player-total','bj-dealer-total'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    });
    renderHistory();
  }

  // ── DOM wiring ─────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('bj-deal-btn')?.addEventListener('click',   deal);
    document.getElementById('bj-hit-btn')?.addEventListener('click',    hit);
    document.getElementById('bj-stand-btn')?.addEventListener('click',  stand);
    document.getElementById('bj-double-btn')?.addEventListener('click', doubleDown);
    document.getElementById('bj-split-btn')?.addEventListener('click',  split);
    document.getElementById('bj-insurance-yes-btn')?.addEventListener('click', insuranceYes);
    document.getElementById('bj-insurance-no-btn')?.addEventListener('click',  insuranceNo);

    document.getElementById('bj-wager')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') deal();
    });

    document.querySelectorAll('.bj-quick-bet').forEach(btn => {
      btn.addEventListener('click', function () {
        const el = document.getElementById('bj-wager');
        if (el) el.value = this.dataset.amount;
      });
    });

    document.getElementById('bj-back-btn')?.addEventListener('click', function () {
      document.getElementById('bj-game').style.display   = 'none';
      document.getElementById('casino-lobby').style.display = 'block';
    });

    document.getElementById('casino-open-blackjack')?.addEventListener('click', function () {
      document.getElementById('casino-lobby').style.display = 'none';
      document.getElementById('bj-game').style.display     = 'block';
      if (identityId) init(identityId);
    });
  });

  return { init };
}());
