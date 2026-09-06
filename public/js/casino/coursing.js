/*
 * DayZ Dashboard — Coursing Casino Module
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Exposes a single global: CasinoCoursing = { init(identityId) }
 *
 * Game flow:
 *   1. init() → loads balance + calls loadRace()
 *   2. loadRace() → POST new-race → renderDogCards()
 *   3. Player clicks a dog card → selectDog()
 *   4. Player enters wager + clicks "Place Bet" → placeBet()
 *   5. placeBet() → POST place-bet → showRaceAnimation() → showResult()
 *   6. "New Race" button calls loadRace() again
 *
 * Dogs are persistent per guild — they gain XP, level up, and retire.
 */

const CasinoCoursing = (function () {

  // ── Private state ───────────────────────────────────────────────────────────

  let identityId       = null;
  let balance          = 0;
  let currencySymbol   = '$';
  let currentSessionId = null;
  let currentDogs      = [];   // [{ id, name, breed, emoji, level, xp, xpToNext, wins, losses, races, odds }]
  let selectedDogId    = null;
  let isBetting        = false;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function fmt(amount) {
    return `${currencySymbol}${parseFloat(amount).toFixed(2)}`;
  }

  function updateBalanceDisplay(newBalance) {
    balance = newBalance;
    const el = document.getElementById('coursing-balance');
    if (el) el.textContent = fmt(newBalance);
  }

  function setStatus(msg, type = 'info') {
    const el = document.getElementById('coursing-status');
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

  function levelStars(level) {
    return '⭐'.repeat(Math.min(level, 5)) + (level > 5 ? `×${level}` : '');
  }

  // ── Race loading ─────────────────────────────────────────────────────────────

  async function loadRace() {
    setStatus('Loading race…', 'info');
    selectedDogId    = null;
    currentSessionId = null;
    currentDogs      = [];

    // Hide post-race UI
    document.getElementById('coursing-track').style.display = 'none';
    document.getElementById('coursing-new-race-btn').style.display = 'none';
    document.getElementById('coursing-bet-btn').style.display = '';
    document.getElementById('coursing-bet-btn').disabled = false;
    document.getElementById('coursing-wager-wrap').style.display = '';
    document.getElementById('coursing-retirement-banner').style.display = 'none';
    document.getElementById('coursing-dogs').innerHTML =
      '<p class="text-gray-500 text-sm col-span-3">Loading dogs…</p>';

    try {
      const res  = await fetchWithCsrf('/api/casino/play/coursing', {
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

      currentDogs      = data.dogs;
      currentSessionId = data.sessionId;

      renderDogCards(data.dogs);
      setStatus('Pick a dog, set your wager, and place your bet!', 'info');

    } catch (err) {
      setStatus('Network error — please try again.', 'error');
    }
  }

  // ── Dog card rendering ───────────────────────────────────────────────────────

  function renderDogCards(dogs) {
    const container = document.getElementById('coursing-dogs');
    if (!container) return;

    container.innerHTML = dogs.map(dog => {
      const xpPct      = dog.level < 10 ? Math.round(((100 - dog.xpToNext) / 100) * 100) : 100;
      const xpLabel    = dog.level < 10 ? `${100 - dog.xpToNext}/100 XP` : 'MAX';
      const record     = `${dog.wins}W / ${dog.losses}L`;
      const genLabel   = dog.generation > 1 ? ` <span class="text-gray-500 text-xs">(Gen ${dog.generation})</span>` : '';

      return `
        <div class="coursing-dog-card cursor-pointer rounded-xl border-2 border-gray-700 bg-gray-800 p-3
                    transition-all hover:border-purple-500 select-none"
             data-dog-id="${dog.id}">
          <div class="text-3xl text-center mb-1">${dog.emoji}</div>
          <p class="text-sm font-bold text-white text-center leading-tight">${dog.name}${genLabel}</p>
          <p class="text-xs text-gray-400 text-center mb-1">${dog.breed}</p>
          <p class="text-xs text-yellow-400 text-center mb-2">${levelStars(dog.level)} Lv.${dog.level}</p>
          <!-- XP bar -->
          <div class="w-full bg-gray-700 rounded-full h-2 mb-1">
            <div class="bg-purple-500 h-2 rounded-full" style="width:${xpPct}%"></div>
          </div>
          <p class="text-xs text-gray-500 text-center mb-2">${xpLabel}</p>
          <p class="text-xs text-gray-500 text-center mb-1">${record}</p>
          <p class="text-xs text-purple-400 text-center font-semibold">${dog.odds}:1</p>
        </div>
      `;
    }).join('');

    // Wire selection via event delegation
    container.onclick = function (e) {
      const card = e.target.closest('.coursing-dog-card');
      if (card) selectDog(parseInt(card.dataset.dogId, 10));
    };
  }

  function selectDog(dogId) {
    selectedDogId = dogId;

    document.querySelectorAll('.coursing-dog-card').forEach(card => {
      if (parseInt(card.dataset.dogId, 10) === dogId) {
        card.classList.remove('border-gray-700');
        card.classList.add('border-purple-500', 'bg-purple-900/30');
      } else {
        card.classList.remove('border-purple-500', 'bg-purple-900/30');
        card.classList.add('border-gray-700');
      }
    });

    const dog = currentDogs.find(d => d.id === dogId);
    if (dog) setStatus(`Selected: ${dog.name} (${dog.breed}) — ${dog.odds}:1`, 'info');
  }

  // ── Betting ──────────────────────────────────────────────────────────────────

  async function placeBet() {
    if (isBetting) return;

    if (selectedDogId === null) {
      setStatus('Please select a dog first.', 'warning');
      return;
    }

    const wagerInput = document.getElementById('coursing-wager');
    const wager      = parseFloat(wagerInput?.value);
    if (!wager || wager <= 0) {
      setStatus('Please enter a valid wager.', 'warning');
      return;
    }

    if (!currentSessionId) {
      setStatus('Race data missing — please load a new race.', 'error');
      return;
    }

    isBetting = true;
    document.getElementById('coursing-bet-btn').disabled = true;
    setStatus('Placing bet…', 'info');

    try {
      const res  = await fetchWithCsrf('/api/casino/play/coursing', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body:   JSON.stringify({ serverId: window.currentEconomyServerId,
          identityId,
          action:    'place-bet',
          wager,
          dogId:     selectedDogId,
          sessionId: currentSessionId,
        }),
      });
      const data = await res.json();

      if (!data.success) {
        setStatus(data.error || 'Something went wrong.', 'error');
        document.getElementById('coursing-bet-btn').disabled = false;
        isBetting = false;
        return;
      }

      if (data.currency?.symbol) currencySymbol = data.currency.symbol;

      await showRaceAnimation(data.results);
      showResult(data);

    } catch (err) {
      setStatus('Network error — please try again.', 'error');
      document.getElementById('coursing-bet-btn').disabled = false;
    } finally {
      isBetting = false;
    }
  }

  // ── Race animation ──────────────────────────────────────────────────────────

  function showRaceAnimation(results) {
    return new Promise(resolve => {
      const trackEl = document.getElementById('coursing-track');
      const lanesEl = document.getElementById('coursing-lanes');
      if (!trackEl || !lanesEl) { resolve(); return; }

      // Sort display order by dog ID to keep consistent with card grid
      const displayOrder = [...results].sort((a, b) => a.id - b.id);

      // Winner finishes at 100%; others stop at random position < 100%
      const targets = displayOrder.map(dog =>
        dog.finishPosition === 1 ? 100 : Math.floor(35 + Math.random() * 50)
      );

      lanesEl.innerHTML = displayOrder.map((dog, i) => `
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-400 w-24 truncate shrink-0">${dog.name}</span>
          <div class="flex-1 bg-gray-700 rounded-full h-5 overflow-hidden">
            <div id="coursing-lane-${dog.id}"
                 class="h-full bg-purple-600 rounded-full flex items-center justify-end pr-1 text-xs"
                 style="width:0%">${dog.emoji}</div>
          </div>
          <span class="text-xs text-gray-500 w-6 text-right">#${dog.finishPosition}</span>
        </div>
      `).join('');

      trackEl.style.display = '';
      document.getElementById('coursing-wager-wrap').style.display = 'none';
      document.getElementById('coursing-bet-btn').style.display = 'none';
      setStatus('🏁 They\'re off!', 'info');

      const DURATION = 2500;
      const INTERVAL = 50;
      const steps    = DURATION / INTERVAL;
      let   step     = 0;

      const timer = setInterval(() => {
        step++;
        const progress = step / steps;
        const eased    = Math.pow(progress, 0.6);

        displayOrder.forEach((dog, i) => {
          const lane = document.getElementById(`coursing-lane-${dog.id}`);
          if (!lane) return;
          lane.style.width = `${Math.min(targets[i] * eased, targets[i]).toFixed(1)}%`;
        });

        if (step >= steps) {
          clearInterval(timer);

          // Highlight winner
          const winner = results.find(d => d.finishPosition === 1);
          if (winner) {
            const winLane = document.getElementById(`coursing-lane-${winner.id}`);
            if (winLane) {
              winLane.classList.replace('bg-purple-600', 'bg-yellow-500');
              winLane.textContent = '🏆';
            }
          }

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
        `🏆 ${data.selectedDog.name} wins! You won ${fmt(data.net)} at ${data.selectedDog.odds}:1!`,
        'success'
      );
    } else {
      const winner = data.results.find(d => d.finishPosition === 1);
      setStatus(
        `💸 ${winner ? winner.name : 'Another dog'} wins — better luck next time.`,
        'error'
      );
    }

    updateBalanceDisplay(data.balanceAfter);
    addToHistory(data.result, data.net, data.selectedDog.name, data.selectedDog.odds);

    // Show retirement announcements
    if (data.retiredDogs && data.retiredDogs.length > 0) {
      const banner = document.getElementById('coursing-retirement-banner');
      if (banner) {
        banner.textContent = data.retiredDogs.map(d =>
          `🏆 ${d.name} the ${d.breed} has retired after ${d.races} races! A new pup joins the kennel.`
        ).join(' | ');
        banner.style.display = '';
      }
    }

    // Swap buttons
    document.getElementById('coursing-bet-btn').style.display = 'none';
    const newRaceBtn = document.getElementById('coursing-new-race-btn');
    if (newRaceBtn) {
      newRaceBtn.style.display = '';
      newRaceBtn.disabled = false;
    }
  }

  // ── History ──────────────────────────────────────────────────────────────────

  function addToHistory(result, net, dogName, odds) {
    const container = document.getElementById('coursing-history');
    if (!container) return;

    const placeholder = container.querySelector('p.text-gray-500');
    if (placeholder) placeholder.remove();

    const colours = { win: 'text-green-400', loss: 'text-red-400' };
    const labels  = { win: 'Win', loss: 'Loss' };
    const netStr  = net >= 0 ? `+${fmt(net)}` : fmt(net);

    const row = document.createElement('div');
    row.className = 'flex items-center justify-between text-sm py-1 border-b border-gray-700 last:border-0';
    row.innerHTML = `
      <span class="text-gray-300 truncate max-w-[9rem]">${dogName}</span>
      <span class="text-gray-500 text-xs">${odds}:1</span>
      <span class="${colours[result] || 'text-gray-400'} font-semibold">${labels[result] || result}</span>
      <span class="${colours[result] || 'text-gray-400'}">${netStr}</span>
    `;

    container.insertBefore(row, container.firstChild);
    while (container.children.length > 10) container.removeChild(container.lastChild);
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async function init(id) {
    identityId = id;
    isBetting  = false;

    try {
      const res  = await fetch(`/api/casino/status/${identityId}?serverId=${encodeURIComponent(window.currentEconomyServerId)}`);
      const data = await res.json();
      if (data.success) {
        updateBalanceDisplay(data.balance ?? 0);
        if (data.currency?.symbol) currencySymbol = data.currency.symbol;
      }
    } catch (_) { /* non-fatal */ }

    loadRace();
  }

  // ── DOM wiring ───────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    // Quick-bet buttons
    document.querySelectorAll('.coursing-quick').forEach(btn => {
      btn.addEventListener('click', () => {
        const el = document.getElementById('coursing-wager');
        if (el) el.value = btn.dataset.amount;
      });
    });

    document.getElementById('coursing-bet-btn')?.addEventListener('click', placeBet);
    document.getElementById('coursing-new-race-btn')?.addEventListener('click', loadRace);

    // Back to lobby
    document.getElementById('coursing-back-btn')?.addEventListener('click', () => {
      document.getElementById('coursing-game').style.display    = 'none';
      document.getElementById('casino-lobby').style.display = 'block';
    });

    // Open from lobby card
    document.getElementById('casino-open-coursing')?.addEventListener('click', function () {
      document.getElementById('casino-lobby').style.display  = 'none';
      document.getElementById('coursing-game').style.display = 'block';
      if (identityId) init(identityId);
    });
  });

  // ── Public API ───────────────────────────────────────────────────────────────

  return { init };

}());
