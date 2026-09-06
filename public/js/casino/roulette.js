/*
 * DayZ Dashboard — Casino Roulette Module
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * American roulette with double zeros (0 and 00) — 38 total slots.
 * Exposes a global `CasinoRoulette` object used by player-portal.js.
 *
 * Wheel is rendered on a <canvas> element with a requestAnimationFrame
 * spin animation that decelerates smoothly onto the winning slot.
 * The betting table is rendered as an HTML table with green felt styling.
 *
 * Usage:
 *   CasinoRoulette.init(identityId)  — call when the roulette section becomes visible
 */

const CasinoRoulette = (function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

  // Standard American double-zero wheel order (clockwise from top)
  const WHEEL_ORDER = [
    '0','28','9','26','30','11','7','20','32','17','5','22',
    '34','15','3','24','36','13','1','00','27','10','25','29',
    '12','8','19','31','18','6','21','33','16','4','23','35','14','2',
  ];

  // Number grid rows displayed top-to-bottom on the betting board
  const BOARD_ROWS = [
    [3,  6,  9,  12, 15, 18, 21, 24, 27, 30, 33, 36], // → column bet 3
    [2,  5,  8,  11, 14, 17, 20, 23, 26, 29, 32, 35], // → column bet 2
    [1,  4,  7,  10, 13, 16, 19, 22, 25, 28, 31, 34], // → column bet 1
  ];

  const BET_LABELS = {
    straight: v  => `Straight — ${v}`,
    dozen:    v  => (['', '1st Dozen (1–12)', '2nd Dozen (13–24)', '3rd Dozen (25–36)'])[v] || '',
    column:   v  => (['', 'Column 1 (1,4,7…34)', 'Column 2 (2,5,8…35)', 'Column 3 (3,6,9…36)'])[v] || '',
    even:     () => 'Even',
    odd:      () => 'Odd',
    red:      () => 'Red',
    black:    () => 'Black',
    low:      () => 'Low (1–18)',
    high:     () => 'High (19–36)',
  };

  const PAYOUT_LABELS = {
    straight: 'pays 35:1',
    dozen:    'pays 2:1',
    column:   'pays 2:1',
    even:     'pays 1:1',
    odd:      'pays 1:1',
    red:      'pays 1:1',
    black:    'pays 1:1',
    low:      'pays 1:1',
    high:     'pays 1:1',
  };

  // ── Wheel geometry (canvas is 260 × 260) ──────────────────────────────────

  const CW           = 260;                  // canvas width / height
  const CX           = CW / 2;              // center x
  const CY           = CW / 2;              // center y
  const RIM_R        = CW / 2 - 2;          // outer wooden rim radius
  const SEG_OUTER_R  = RIM_R * 0.83;        // outer edge of number segments
  const SEG_INNER_R  = RIM_R * 0.24;        // inner edge of segments (center cap edge)
  const TEXT_R       = SEG_INNER_R + (SEG_OUTER_R - SEG_INNER_R) * 0.54; // text position
  const BALL_TRACK_R = RIM_R * 0.92;        // ball orbit radius in fast phase
  const BALL_POCKET_R = SEG_OUTER_R * 0.82; // ball settle radius inside segments
  const SEG_ANGLE    = (2 * Math.PI) / 38;

  // ── Animation constants ────────────────────────────────────────────────────

  const FAST_WHEEL_SPEED = 6.5;   // rad/s during fast phase
  const FAST_BALL_SPEED  = -10.0; // rad/s for ball (counter-clockwise)
  const DECEL_MS         = 3600;  // deceleration duration in ms

  // ── State ──────────────────────────────────────────────────────────────────

  let identityId     = null;
  let balance        = 0;
  let currencySymbol = '$';
  let spinning       = false;
  let selectedBet    = null;
  let animFrame      = null; // current requestAnimationFrame handle

  // ── Helpers ────────────────────────────────────────────────────────────────

  function fmt(amount) {
    return `${currencySymbol}${parseFloat(amount).toFixed(2)}`;
  }

  function slotColor(slot) {
    if (slot === '0' || slot === '00') return 'green';
    return RED_NUMBERS.has(parseInt(slot, 10)) ? 'red' : 'black';
  }

  function updateBalanceDisplay(newBalance) {
    balance = newBalance;
    const el = document.getElementById('roulette-balance');
    if (el) el.textContent = fmt(balance);
  }

  function setStatus(text, type = 'info') {
    const el = document.getElementById('roulette-status');
    if (!el) return;
    const cls = { win: 'text-green-400', loss: 'text-red-400', info: 'text-gray-400', warn: 'text-yellow-400' };
    el.className = `text-sm font-semibold ${cls[type] || 'text-gray-400'}`;
    el.textContent = text;
  }

  // ── Canvas wheel rendering ─────────────────────────────────────────────────

  /**
   * Draws the full roulette wheel onto the canvas at the given rotation angle.
   * rotation=0 places WHEEL_ORDER[0] at the 12-o'clock position.
   */
  function drawWheel(canvas, rotation) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, CW, CW);

    // Outer wooden rim — radial gradient for a 3-D wood effect
    const rimGrad = ctx.createRadialGradient(CX - 18, CY - 18, RIM_R * 0.4, CX, CY, RIM_R);
    rimGrad.addColorStop(0,   '#8B4513');
    rimGrad.addColorStop(0.6, '#5C2E00');
    rimGrad.addColorStop(1,   '#2A1200');
    ctx.beginPath();
    ctx.arc(CX, CY, RIM_R, 0, 2 * Math.PI);
    ctx.fillStyle = rimGrad;
    ctx.fill();

    // Gold outer border
    ctx.beginPath();
    ctx.arc(CX, CY, RIM_R - 1, 0, 2 * Math.PI);
    ctx.strokeStyle = '#D4AF37';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Gold inner border of rim (marks edge of ball track)
    ctx.beginPath();
    ctx.arc(CX, CY, SEG_OUTER_R + 5, 0, 2 * Math.PI);
    ctx.strokeStyle = '#B8952A';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Colored number segments — drawn as arcs between SEG_INNER_R and SEG_OUTER_R
    for (let i = 0; i < 38; i++) {
      const slot    = WHEEL_ORDER[i];
      const startA  = rotation + i * SEG_ANGLE - Math.PI / 2;
      const endA    = startA + SEG_ANGLE;
      const midA    = startA + SEG_ANGLE / 2;

      const color = slotColor(slot);
      const fill  = color === 'green' ? '#15803d'
                  : color === 'red'   ? '#9f1239'
                                      : '#111111';

      // Segment fill
      ctx.beginPath();
      ctx.arc(CX, CY, SEG_OUTER_R, startA, endA);
      ctx.arc(CX, CY, SEG_INNER_R, endA, startA, true);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();

      // Gold pocket divider line along the leading edge
      ctx.beginPath();
      ctx.moveTo(CX + SEG_INNER_R * Math.cos(startA), CY + SEG_INNER_R * Math.sin(startA));
      ctx.lineTo(CX + SEG_OUTER_R * Math.cos(startA), CY + SEG_OUTER_R * Math.sin(startA));
      ctx.strokeStyle = '#C9A227';
      ctx.lineWidth   = 1;
      ctx.stroke();

      // Number text — rotated to read outward from center
      const tx = CX + TEXT_R * Math.cos(midA);
      const ty = CY + TEXT_R * Math.sin(midA);
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(midA + Math.PI / 2);
      ctx.fillStyle    = '#ffffff';
      ctx.font         = `bold 8.5px Arial, sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor  = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur   = 2;
      ctx.fillText(slot, 0, 0);
      ctx.restore();
    }

    // Outer segment ring border
    ctx.beginPath();
    ctx.arc(CX, CY, SEG_OUTER_R, 0, 2 * Math.PI);
    ctx.strokeStyle = '#D4AF37';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Center cap — radial gradient for dome effect
    const capGrad = ctx.createRadialGradient(CX - 6, CY - 6, 2, CX, CY, SEG_INNER_R);
    capGrad.addColorStop(0, '#4b5563');
    capGrad.addColorStop(1, '#111827');
    ctx.beginPath();
    ctx.arc(CX, CY, SEG_INNER_R, 0, 2 * Math.PI);
    ctx.fillStyle = capGrad;
    ctx.fill();
    ctx.strokeStyle = '#D4AF37';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Gold center pin
    ctx.beginPath();
    ctx.arc(CX, CY, 5, 0, 2 * Math.PI);
    ctx.fillStyle = '#D4AF37';
    ctx.fill();
  }

  /** Move the ball DOM element to (angle, radius) on the wheel. */
  function moveBall(ballEl, angle, radius) {
    if (!ballEl) return;
    ballEl.style.left    = (CX + radius * Math.cos(angle) - 6.5) + 'px';
    ballEl.style.top     = (CY + radius * Math.sin(angle) - 6.5) + 'px';
    ballEl.style.display = 'block';
  }

  // ── Spin animation ─────────────────────────────────────────────────────────

  /**
   * Animates the wheel spinning while the API call resolves.
   *
   * Phase 1 — "fast":   constant speed until apiPromise resolves.
   * Phase 2 — "decel":  smooth quadratic ease-out onto the winning slot.
   *
   * Returns a promise that resolves with the API response object once
   * both the animation and the API call are complete.
   *
   * @param {Promise} apiPromise  The in-flight casino API call.
   */
  function animateWheel(apiPromise) {
    // Cancel any leftover animation from a previous spin
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }

    return new Promise(resolve => {
      const canvas = document.getElementById('roulette-wheel-canvas');
      const ballEl = document.getElementById('roulette-ball');
      if (!canvas) { apiPromise.then(resolve); return; }

      let startTs         = null;
      let prevTs          = null;
      let rotation        = 0;          // wheel rotation in radians
      let ballAngle       = Math.random() * 2 * Math.PI;

      let phase           = 'fast';
      let apiData         = null;
      let targetRot       = null;
      let decelBallTarget = null; // ball angle to converge to during decel
      let decelTs         = null;
      let decelRotStart   = null;
      let decelBallStart  = null;

      // When the API resolves, record the result and switch to decel phase
      apiPromise.then(data => {
        apiData        = data;
        phase          = 'decel';
        decelTs        = performance.now();
        decelRotStart  = rotation;
        decelBallStart = ballAngle;

        if (data && data.success && data.winningSlot) {
          const idx = WHEEL_ORDER.indexOf(String(data.winningSlot));
          if (idx >= 0) {
            // Wheel target: winning slot's center sits at 12-o'clock (-PI/2)
            const slotBase  = -(idx + 0.5) * SEG_ANGLE;
            const idealStop = rotation + (FAST_WHEEL_SPEED * DECEL_MS / 1000) / 2;
            const kw        = Math.round((idealStop - slotBase) / (2 * Math.PI));
            targetRot       = slotBase + kw * 2 * Math.PI;
            if (targetRot <= rotation + Math.PI) targetRot += 2 * Math.PI;

            // Ball target: the pocket is also at 12-o'clock (-PI/2 in canvas coords).
            // Find the nearest equivalent angle reachable by the ball's counter-
            // clockwise travel, so it converges smoothly without any jump.
            const naturalBallEnd = decelBallStart + FAST_BALL_SPEED * (DECEL_MS / 1000) * 0.5;
            const kb  = Math.round((naturalBallEnd - (-Math.PI / 2)) / (2 * Math.PI));
            decelBallTarget = -Math.PI / 2 + kb * 2 * Math.PI;
            // Guarantee the ball moves counter-clockwise (angle decreases)
            if (decelBallTarget >= decelBallStart) decelBallTarget -= 2 * Math.PI;
          }
        }

        if (targetRot === null) {
          // Fallback when no valid slot: just coast to a natural stop
          targetRot       = rotation + 2 * Math.PI * 2;
          decelBallTarget = decelBallStart + FAST_BALL_SPEED * (DECEL_MS / 1000) * 0.5;
        }
      });

      function tick(ts) {
        if (!startTs) { startTs = ts; prevTs = ts; }
        const dt = (ts - prevTs) / 1000; // seconds since last frame
        prevTs = ts;

        if (phase === 'fast') {
          rotation  += FAST_WHEEL_SPEED * dt;
          ballAngle += FAST_BALL_SPEED  * dt;
          drawWheel(canvas, rotation);
          moveBall(ballEl, ballAngle, BALL_TRACK_R);
          animFrame = requestAnimationFrame(tick);

        } else if (phase === 'decel') {
          const elapsed = ts - decelTs;
          const t       = Math.min(elapsed / DECEL_MS, 1);
          // Quadratic ease-out: starts at full speed, smoothly reaches zero velocity
          const eased   = 1 - Math.pow(1 - t, 2);

          // Wheel and ball both converge to their targets with the same easing —
          // no snap, no jump; the ball arrives at the pocket exactly when the wheel stops.
          rotation  = decelRotStart  + (targetRot       - decelRotStart)  * eased;
          ballAngle = decelBallStart + (decelBallTarget  - decelBallStart) * eased;

          // Ball spirals inward from the track to the pocket depth
          const ballRadius = BALL_TRACK_R + (BALL_POCKET_R - BALL_TRACK_R) * eased;

          drawWheel(canvas, rotation);
          moveBall(ballEl, ballAngle, ballRadius);

          if (t < 1) {
            animFrame = requestAnimationFrame(tick);
          } else {
            animFrame = null;
            resolve(apiData);
          }
        }
      }

      animFrame = requestAnimationFrame(tick);
    });
  }

  // ── Betting board ──────────────────────────────────────────────────────────

  /**
   * Store the selected bet and update UI highlighting.
   */
  function selectBet(type, value) {
    selectedBet = { type, value: value ?? null };

    const labelFn = BET_LABELS[type];
    const v       = value != null ? (parseInt(value, 10) || value) : null;
    const label   = labelFn ? labelFn(v) : type;
    const payout  = PAYOUT_LABELS[type] || '';

    const display = document.getElementById('roulette-bet-display');
    if (display) {
      display.textContent = `Selected: ${label} — ${payout}`;
      display.className   = 'text-center text-yellow-300 text-sm font-semibold py-2';
    }

    // Toggle gold outline on the matching cell; clear all others
    document.querySelectorAll('.roulette-bet-btn').forEach(btn => {
      const match = btn.dataset.betType === type &&
                    (btn.dataset.betValue ?? null) === (value ?? null);
      btn.classList.toggle('roulette-selected', match);
    });

    setStatus('Bet selected — enter a wager and spin!', 'info');
  }

  /**
   * Build the green-felt betting table into #roulette-board.
   * The table has 13 columns: 12 for numbers + 1 for column-bet (2:1) buttons.
   *
   * Layout (top → bottom):
   *   Row 0: [0 ×6] [00 ×6] [empty]
   *   Row 1: [3][6]…[36]    [2:1 col3]
   *   Row 2: [2][5]…[35]    [2:1 col2]
   *   Row 3: [1][4]…[34]    [2:1 col1]
   *   Row 4: [1st 12 ×4] [2nd 12 ×4] [3rd 12 ×4] [empty]
   *   Row 5: [1-18×2] [Even×2] [Red×2] [Black×2] [Odd×2] [19-36×2] [empty]
   */
  function renderBoard() {
    const board = document.getElementById('roulette-board');
    if (!board) return;

    function numCell(slot, extra = '') {
      const color = slotColor(slot);
      const cls   = color === 'green' ? 'rn-green' : color === 'red' ? 'rn-red' : 'rn-black';
      return `<td class="roulette-num roulette-bet-btn ${cls}" ${extra}
                  data-bet-type="straight" data-bet-value="${slot}">${slot}</td>`;
    }

    function outsideCell(html, type, value, extra = '', cls = '') {
      const vAttr = value != null ? `data-bet-value="${value}"` : '';
      return `<td class="roulette-outside roulette-bet-btn ${cls}" ${extra}
                  data-bet-type="${type}" ${vAttr}>${html}</td>`;
    }

    board.innerHTML = `
      <div class="roulette-felt">
        <table class="roulette-table">
          <tbody>

            <!-- ── Zero row ──────────────────────────────────────────────── -->
            <tr>
              ${numCell('0',  'colspan="6"')}
              ${numCell('00', 'colspan="6"')}
              <td></td>
            </tr>

            <!-- ── Number rows + column bets ─────────────────────────────── -->
            ${BOARD_ROWS.map((row, ri) => `
              <tr>
                ${row.map(n => numCell(String(n))).join('')}
                ${outsideCell('2:1', 'column', 3 - ri, '', 'ro-col')}
              </tr>
            `).join('')}

            <!-- ── Dozen bets ─────────────────────────────────────────────── -->
            <tr>
              ${outsideCell('1st 12<br><span style="font-size:9px;opacity:.7">1–12</span>',   'dozen', 1, 'colspan="4"')}
              ${outsideCell('2nd 12<br><span style="font-size:9px;opacity:.7">13–24</span>', 'dozen', 2, 'colspan="4"')}
              ${outsideCell('3rd 12<br><span style="font-size:9px;opacity:.7">25–36</span>', 'dozen', 3, 'colspan="4"')}
              <td></td>
            </tr>

            <!-- ── Even-money bets ────────────────────────────────────────── -->
            <tr>
              ${outsideCell('1–18',    'low',   null, 'colspan="2"')}
              ${outsideCell('Even',    'even',  null, 'colspan="2"')}
              ${outsideCell('● Red',   'red',   null, 'colspan="2"', 'ro-red')}
              ${outsideCell('● Black', 'black', null, 'colspan="2"', 'ro-black')}
              ${outsideCell('Odd',     'odd',   null, 'colspan="2"')}
              ${outsideCell('19–36',   'high',  null, 'colspan="2"')}
              <td></td>
            </tr>

          </tbody>
        </table>
      </div>
    `;

    // Wire click handlers onto every bet cell
    board.querySelectorAll('.roulette-bet-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        selectBet(this.dataset.betType, this.dataset.betValue ?? null);
      });
    });
  }

  // ── Core spin ──────────────────────────────────────────────────────────────

  async function doSpin() {
    if (spinning) return;

    if (!selectedBet) {
      setStatus('Select a bet from the board first.', 'warn');
      return;
    }

    const wagerInput = document.getElementById('roulette-wager');
    const wager      = parseFloat(wagerInput?.value);
    if (!wager || wager <= 0) { setStatus('Please enter a valid wager.', 'warn'); return; }
    if (wager > balance)      { setStatus('Insufficient balance!', 'loss');        return; }

    spinning = true;
    const spinBtn = document.getElementById('roulette-spin-btn');
    if (spinBtn) { spinBtn.disabled = true; spinBtn.textContent = '⏳ Spinning…'; }
    setStatus('Spinning…', 'info');

    // Start the API call immediately; the animation receives the promise and
    // decelerates to the correct slot once the result arrives.
    const apiPromise = fetchWithCsrf('/api/casino/play/roulette', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ serverId: window.currentEconomyServerId,
        identityId,
        wager,
        betType:  selectedBet.type,
        betValue: selectedBet.value,
      }),
    }).then(r => r.json()).catch(err => ({ success: false, error: err.message }));

    const data = await animateWheel(apiPromise);

    if (data && data.success) {
      updateBalanceDisplay(data.balanceAfter);
      if (data.result === 'win') {
        setStatus(`🎉 ${data.winningSlot} — you won ${fmt(data.net)}!`, 'win');
      } else {
        setStatus(`💸 ${data.winningSlot} — lost ${fmt(data.wager)}`, 'loss');
      }
    } else {
      setStatus((data && data.error) || 'Something went wrong. Please try again.', 'loss');
    }

    if (spinBtn) { spinBtn.disabled = false; spinBtn.textContent = '🎡 SPIN'; }
    spinning = false;
  }

  // ── Initialisation ─────────────────────────────────────────────────────────

  /**
   * Load casino status then render the wheel and betting board.
   * Called by player-portal.js whenever the roulette section becomes visible.
   *
   * @param {number|string} playerIdentityId
   */
  async function init(playerIdentityId) {
    identityId  = playerIdentityId;
    selectedBet = null;

    // Cancel any in-progress animation from a previous session
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    spinning = false;

    try {
      const res  = await fetch(`/api/casino/status/${identityId}?serverId=${encodeURIComponent(window.currentEconomyServerId)}`);
      const data = await res.json();

      if (!data.success || !data.casinoEnabled) return;

      currencySymbol = data.currency?.symbol || '$';
      updateBalanceDisplay(data.balance);

      document.querySelectorAll('.roulette-quick-bet').forEach(btn => {
        btn.textContent = `${currencySymbol}${btn.dataset.amount}`;
      });
    } catch (err) {
      console.error('Failed to load casino status for roulette:', err);
    }

    renderBoard();

    // Draw the initial wheel and hide the ball
    const canvas = document.getElementById('roulette-wheel-canvas');
    const ballEl = document.getElementById('roulette-ball');
    if (canvas) drawWheel(canvas, 0);
    if (ballEl) ballEl.style.display = 'none';

    const display = document.getElementById('roulette-bet-display');
    if (display) {
      display.textContent = 'No bet selected — click a number or outside bet below';
      display.className   = 'text-center text-gray-500 text-sm py-2 mb-3';
    }
    setStatus('Select a bet from the board then enter a wager.', 'info');
  }

  // ── Event wiring (runs once on DOMContentLoaded) ───────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('roulette-spin-btn')?.addEventListener('click', doSpin);

    document.querySelectorAll('.roulette-quick-bet').forEach(btn => {
      btn.addEventListener('click', function () {
        const wagerInput = document.getElementById('roulette-wager');
        if (wagerInput) wagerInput.value = this.dataset.amount;
      });
    });

    document.getElementById('roulette-wager')?.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSpin();
    });

    document.getElementById('roulette-back-btn')?.addEventListener('click', function () {
      document.getElementById('roulette-game').style.display  = 'none';
      document.getElementById('casino-lobby').style.display   = 'block';
    });

    document.getElementById('casino-open-roulette')?.addEventListener('click', function () {
      document.getElementById('casino-lobby').style.display   = 'none';
      document.getElementById('roulette-game').style.display  = 'block';
      if (identityId) init(identityId);
    });
  });

  // Public API
  return { init };
}());
