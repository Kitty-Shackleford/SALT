/*
 * DayZ Dashboard — Horse Racing Casino Module
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Exposes a single global: CasinoHorseRacing = { init(identityId) }
 *
 * Game flow:
 *   1. init() → loads balance + calls loadRace()
 *   2. loadRace() → POST new-race → renderRaceCard()
 *   3. Player clicks a horse card → selectHorse()
 *   4. Player enters wager + clicks "Place Bet" → placeBet()
 *   5. placeBet() → POST place-bet → showRaceAnimation() → showResult()
 *   6. "New Race" button calls loadRace() again
 */

const CasinoHorseRacing = (function () {

  // ── Private state ───────────────────────────────────────────────────────────

  let identityId     = null;
  let balance        = 0;
  let currencySymbol = '$';
  let currentSessionId = null; // signed race state echoed back on place-bet
  let currentHorses    = [];   // [{ name, odds }] for current race
  let selectedHorse    = null; // index into currentHorses
  let isBetting        = false;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function fmt(amount) {
    return `${currencySymbol}${parseFloat(amount).toFixed(2)}`;
  }

  function updateBalanceDisplay(newBalance) {
    balance = newBalance;
    const el = document.getElementById('hr-balance');
    if (el) el.textContent = fmt(newBalance);
  }

  function setStatus(msg, type = 'info') {
    const el = document.getElementById('hr-status');
    if (!el) return;
    const colours = {
      info:    'text-gray-400',
      success: 'text-green-400',
      error:   'text-red-400',
      warning: 'text-yellow-400',
    };
    el.className = `text-center min-h-[1.5rem] font-semibold ${colours[type] || colours.info}`;
    el.textContent = msg;
  }

  // ── Race loading ─────────────────────────────────────────────────────────────

  async function loadRace() {
    setStatus('Loading race…', 'info');
    selectedHorse = null;
    currentSessionId = null;
    currentHorses = [];

    // Hide post-race UI, show bet controls
    document.getElementById('hr-track').style.display = 'none';
    document.getElementById('hr-new-race-btn').style.display = 'none';
    document.getElementById('hr-bet-btn').style.display = '';
    document.getElementById('hr-wager-wrap').style.display = '';
    document.getElementById('hr-horses').innerHTML = '<p class="text-gray-500 text-sm col-span-3">Loading horses…</p>';

    try {
      const res  = await fetchWithCsrf('/api/casino/play/horse-racing', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body:   JSON.stringify({ serverId: window.currentEconomyServerId, identityId, action: 'new-race' }),
      });
      const data = await res.json();

      if (!data.success) {
        setStatus(data.error || 'Failed to load race.', 'error');
        return;
      }

      if (data.currency?.symbol) currencySymbol = data.currency.symbol;

      currentHorses    = data.horses;
      currentSessionId = data.sessionId;

      renderRaceCard(data.horses);
      setStatus('Pick a horse, set your wager, and place your bet!', 'info');

    } catch (err) {
      setStatus('Network error — please try again.', 'error');
    }
  }

  // ── Race card rendering ─────────────────────────────────────────────────────

  function renderRaceCard(horses) {
    const container = document.getElementById('hr-horses');
    if (!container) return;

    container.innerHTML = horses.map((h, i) => `
      <div class="hr-horse-card cursor-pointer rounded-xl border-2 border-gray-700 bg-gray-800 p-4
                  transition-all hover:border-purple-500 select-none"
           data-index="${i}">
        <div class="text-3xl text-center mb-2">🐎</div>
        <p class="text-sm font-bold text-white text-center leading-tight mb-1">${h.name}</p>
        <p class="text-xs text-purple-400 text-center font-semibold">${h.odds}:1</p>
      </div>
    `).join('');

    // Wire click via delegation on the container to avoid relying on globals
    container.onclick = function (e) {
      const card = e.target.closest('.hr-horse-card');
      if (card) selectHorse(parseInt(card.dataset.index, 10));
    };
  }

  function selectHorse(index) {
    selectedHorse = index;

    // Highlight selected card, de-highlight others
    document.querySelectorAll('.hr-horse-card').forEach((card, i) => {
      if (i === index) {
        card.classList.remove('border-gray-700');
        card.classList.add('border-purple-500', 'bg-purple-900/30');
      } else {
        card.classList.remove('border-purple-500', 'bg-purple-900/30');
        card.classList.add('border-gray-700');
      }
    });

    const horse = currentHorses[index];
    setStatus(`Selected: ${horse.name} — odds ${horse.odds}:1`, 'info');
  }

  // ── Betting ──────────────────────────────────────────────────────────────────

  async function placeBet() {
    if (isBetting) return;

    if (selectedHorse === null) {
      setStatus('Please select a horse first.', 'warning');
      return;
    }

    const wagerInput = document.getElementById('hr-wager');
    const wager = parseFloat(wagerInput?.value);
    if (!wager || wager <= 0) {
      setStatus('Please enter a valid wager.', 'warning');
      return;
    }

    if (!currentSessionId) {
      setStatus('Race data missing — please load a new race.', 'error');
      return;
    }

    isBetting = true;
    document.getElementById('hr-bet-btn').disabled = true;

    setStatus('Placing bet…', 'info');

    try {
      const res  = await fetchWithCsrf('/api/casino/play/horse-racing', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body:   JSON.stringify({ serverId: window.currentEconomyServerId,
          identityId,
          action:     'place-bet',
          wager,
          horseIndex: selectedHorse,
          sessionId:  currentSessionId,
        }),
      });
      const data = await res.json();

      if (!data.success) {
        setStatus(data.error || 'Something went wrong.', 'error');
        document.getElementById('hr-bet-btn').disabled = false;
        isBetting = false;
        return;
      }

      if (data.currency?.symbol) currencySymbol = data.currency.symbol;

      // Animate the race before showing the result
      await showRaceAnimation(data.horses, data.winnerIndex);
      showResult(data);

    } catch (err) {
      setStatus('Network error — please try again.', 'error');
      document.getElementById('hr-bet-btn').disabled = false;
    } finally {
      isBetting = false;
    }
  }

  // ── Race animation ──────────────────────────────────────────────────────────

  /**
   * Animates horses moving across a track and reveals the winner.
   * Each horse is a progress bar that fills over ~3 seconds.
   * The winning horse always reaches 100%; others stop at a random position < 100%.
   * Returns a Promise that resolves when the animation is complete.
   */
  function showRaceAnimation(horses, winnerIndex) {
    return new Promise(resolve => {
      const trackEl = document.getElementById('hr-track');
      const lanesEl = document.getElementById('hr-lanes');
      if (!trackEl || !lanesEl) { resolve(); return; }

      // Build lanes HTML
      lanesEl.innerHTML = horses.map((h, i) => `
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-400 w-36 truncate shrink-0">${h.name}</span>
          <div class="flex-1 bg-gray-700 rounded-full h-5 overflow-hidden relative">
            <div id="hr-lane-${i}"
                 class="h-full bg-purple-600 rounded-full transition-none flex items-center justify-end pr-1 text-xs"
                 style="width:0%">🐎</div>
          </div>
          <span id="hr-odds-${i}" class="text-xs text-gray-500 w-8 text-right">${h.odds}:1</span>
        </div>
      `).join('');

      trackEl.style.display = '';
      document.getElementById('hr-wager-wrap').style.display = 'none';
      document.getElementById('hr-bet-btn').style.display = 'none';

      setStatus('🏁 They\'re off!', 'info');

      // Each horse has a random target < 100%; winner gets exactly 100%
      const targets = horses.map((_, i) => i === winnerIndex ? 100 : Math.floor(40 + Math.random() * 45));

      // Animate with a simple interval — update widths every 50ms over ~2.5s
      const DURATION  = 2500; // ms
      const INTERVAL  = 50;   // ms
      const steps     = DURATION / INTERVAL;
      let   step      = 0;

      const timer = setInterval(() => {
        step++;
        const progress = step / steps; // 0 → 1

        horses.forEach((_, i) => {
          const lane = document.getElementById(`hr-lane-${i}`);
          if (!lane) return;
          // Ease-out: progress^0.6 to slow down at end
          const eased = Math.pow(progress, 0.6);
          const pct   = Math.min(targets[i] * eased, targets[i]);
          lane.style.width = `${pct.toFixed(1)}%`;
        });

        if (step >= steps) {
          clearInterval(timer);

          // Highlight the winning lane
          const winLane = document.getElementById(`hr-lane-${winnerIndex}`);
          if (winLane) {
            winLane.classList.replace('bg-purple-600', 'bg-yellow-500');
            winLane.textContent = '🏆';
          }

          // Short pause so the player can see the winner before result text
          setTimeout(resolve, 600);
        }
      }, INTERVAL);
    });
  }

  // ── Result display ──────────────────────────────────────────────────────────

  function showResult(data) {
    const won = data.result === 'win';

    if (won) {
      setStatus(
        `🏆 ${data.playerHorse.name} wins! You won ${fmt(data.net)} at ${data.playerHorse.odds}:1!`,
        'success'
      );
    } else {
      setStatus(
        `💸 ${data.winnerName} wins — better luck next time.`,
        'error'
      );
    }

    updateBalanceDisplay(data.balanceAfter);
    addToHistory(data.result, data.net, data.playerHorse.name, data.playerHorse.odds);

    // Swap buttons: hide Bet, show New Race
    document.getElementById('hr-bet-btn').style.display = 'none';
    const newRaceBtn = document.getElementById('hr-new-race-btn');
    if (newRaceBtn) {
      newRaceBtn.style.display = '';
      newRaceBtn.disabled = false;
    }
  }

  // ── History ──────────────────────────────────────────────────────────────────

  function addToHistory(result, net, horseName, odds) {
    const container = document.getElementById('hr-history');
    if (!container) return;

    // Remove placeholder text on first real entry
    const placeholder = container.querySelector('p.text-gray-500');
    if (placeholder) placeholder.remove();

    const colours = { win: 'text-green-400', loss: 'text-red-400' };
    const labels  = { win: 'Win', loss: 'Loss' };
    const netStr  = net >= 0 ? `+${fmt(net)}` : fmt(net);

    const row = document.createElement('div');
    row.className = 'flex items-center justify-between text-sm py-1 border-b border-gray-700 last:border-0';
    row.innerHTML = `
      <span class="text-gray-300 truncate max-w-[9rem]">${horseName}</span>
      <span class="text-gray-500 text-xs">${odds}:1</span>
      <span class="${colours[result] || 'text-gray-400'} font-semibold">${labels[result] || result}</span>
      <span class="${colours[result] || 'text-gray-400'}">${netStr}</span>
    `;

    // Newest entries at top; cap at 10
    container.insertBefore(row, container.firstChild);
    while (container.children.length > 10) {
      container.removeChild(container.lastChild);
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async function init(id) {
    identityId = id;
    isBetting  = false;

    // Fetch balance via casino status endpoint (same as other games)
    try {
      const res  = await fetch(`/api/casino/status/${identityId}?serverId=${encodeURIComponent(window.currentEconomyServerId)}`);
      const data = await res.json();
      if (data.success) {
        updateBalanceDisplay(data.balance ?? 0);
        if (data.currency?.symbol) currencySymbol = data.currency.symbol;
      }
    } catch (_) { /* non-fatal */ }

    // Load the first race
    loadRace();
  }

  // ── DOM wiring ───────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    // Wire quick-bet buttons
    document.querySelectorAll('.hr-quick').forEach(btn => {
      btn.addEventListener('click', () => {
        const wagerInput = document.getElementById('hr-wager');
        if (wagerInput) wagerInput.value = btn.dataset.amount;
      });
    });

    // Wire Place Bet button
    document.getElementById('hr-bet-btn')?.addEventListener('click', placeBet);

    // Wire New Race button
    document.getElementById('hr-new-race-btn')?.addEventListener('click', loadRace);

    // Wire Back button — return to lobby
    document.getElementById('hr-back-btn')?.addEventListener('click', () => {
      document.getElementById('hr-game').style.display    = 'none';
      document.getElementById('casino-lobby').style.display = 'block';
    });

    // Wire lobby card click — open the game
    document.getElementById('casino-open-horseracing')?.addEventListener('click', function () {
      document.getElementById('casino-lobby').style.display = 'none';
      document.getElementById('hr-game').style.display     = 'block';
      if (identityId) init(identityId);
    });
  });

  // ── Public API ───────────────────────────────────────────────────────────────

  return {
    init,
  };

}());
