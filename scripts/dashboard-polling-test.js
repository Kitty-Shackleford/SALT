#!/usr/bin/env node
'use strict';

/*
 * Dashboard polling test (card 4/9 — dashboard page redesign).
 *
 * 1. Engine unit tests (public/js/dashboard-poll.js, mocked clock/timers):
 *    - exactly ONE master interval drives all widgets
 *    - hidden tab pauses every fetch
 *    - no overlapping fetches for an in-flight widget
 *    - per-widget failure isolation + retry cadence (one failed fetch does
 *      not blank or stall the other widgets)
 *    - freshness callbacks: onTick every tick, onState per settlement
 * 2. Page pins: dashboard.js consolidated onto the shared loop, no native
 *    alert(), attention strip + freshness indicators present in
 *    dashboard.html.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const { createPollingLoop } = require(path.join(root, 'public', 'js', 'dashboard-poll.js'));

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

function makeTimers() {
  const timers = new Map();
  let nextId = 1;
  let count = 0;
  const setIntervalImpl = (fn, ms) => {
    count += 1;
    const id = nextId++;
    timers.set(id, fn);
    return id;
  };
  return {
    get count() { return count; },
    setInterval: setIntervalImpl,
    clearInterval(id) { timers.delete(id); },
    tick() {
      for (const fn of [...timers.values()]) fn();
    },
  };
}

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

// Advance the fake clock 1 tick at a time, flushing microtasks between
// ticks (real browsers settle Promises between interval callbacks).
async function pump(clock, timers, n) {
  for (let i = 0; i < n; i++) {
    clock.advance(1000);
    timers.tick();
    await flushMicrotasks();
  }
}

function makeLoop({ clock, timers, hidden = () => false, widgets, onTick, onState }) {
  const loop = createPollingLoop({
    tickMs: 1000,
    now: clock.now,
    isHidden: hidden,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    widgets,
    onTick,
    onState,
  });
  loop.start();
  return loop;
}

async function testSingleIntervalDrivesAllWidgets() {
  const clock = makeClock();
  const timers = makeTimers();
  const counts = { stats: 0, activity: 0, syncJobs: 0 };
  makeLoop({
    clock,
    timers,
    widgets: {
      stats: { intervalMs: 30000, run: async () => { counts.stats += 1; } },
      activity: { intervalMs: 30000, run: async () => { counts.activity += 1; } },
      syncJobs: { intervalMs: 5000, run: async () => { counts.syncJobs += 1; } },
    },
  });

  assert.strictEqual(timers.count, 1, 'engine must register exactly one master interval, found ' + timers.count);

  await pump(clock, timers, 60);
  assert.strictEqual(counts.syncJobs, 12, `syncJobs should run every 5s (got ${counts.syncJobs})`);
  assert.strictEqual(counts.stats, 2, `stats should run every 30s (got ${counts.stats})`);
  assert.strictEqual(counts.activity, 2, `activity should run every 30s (got ${counts.activity})`);
}

async function testHiddenTabPausesFetches() {
  const clock = makeClock();
  const timers = makeTimers();
  let hidden = false;
  const counts = { syncJobs: 0 };
  makeLoop({
    clock,
    timers,
    hidden: () => hidden,
    widgets: { syncJobs: { intervalMs: 5000, run: async () => { counts.syncJobs += 1; } } },
  });

  // Warm up: one due run while visible.
  await pump(clock, timers, 5);
  assert.strictEqual(counts.syncJobs, 1, 'one run expected while visible');

  // Hide the tab for 25s of wall time — zero fetches.
  hidden = true;
  await pump(clock, timers, 25);
  assert.strictEqual(counts.syncJobs, 1, 'no fetches while document.hidden');

  // Show again: the overdue widget fires exactly once (no burst, no overlap).
  hidden = false;
  await pump(clock, timers, 5);
  assert.strictEqual(counts.syncJobs, 2, 'single catch-up run after tab becomes visible');
}

async function testNoOverlappingFetches() {
  const clock = makeClock();
  const timers = makeTimers();
  let runs = 0;
  let resolveRun = null;
  makeLoop({
    clock,
    timers,
    widgets: {
      syncJobs: {
        intervalMs: 5000,
        run: () => {
          runs += 1;
          return new Promise(resolve => { resolveRun = resolve; });
        },
      },
    },
  });

  clock.advance(5000);
  timers.tick();
  await flushMicrotasks();
  assert.strictEqual(runs, 1, 'first run starts');

  // Ten more seconds pass with the first run still in flight.
  clock.advance(10000);
  timers.tick();
  await flushMicrotasks();
  assert.strictEqual(runs, 1, 'in-flight widget must not be re-fired (no overlapping fetches)');

  // Settle, then let the next interval elapse.
  resolveRun();
  await flushMicrotasks();
  clock.advance(5000);
  timers.tick();
  await flushMicrotasks();
  assert.strictEqual(runs, 2, 'widget resumes on the next due tick after settlement');
}

async function testWidgetFailuresAreIsolated() {
  const clock = makeClock();
  const timers = makeTimers();
  const events = [];
  const widgetA = { intervalMs: 5000, run: () => Promise.reject(new Error('boom')) };
  const widgetB = { intervalMs: 5000, run: async () => {} };
  const loop = makeLoop({
    clock,
    timers,
    widgets: { broken: widgetA, healthy: widgetB },
    onState: (name, state) => { events.push({ name, okCount: state.okCount, errorCount: state.errorCount }); },
  });

  await pump(clock, timers, 15);
  await flushMicrotasks();

  const a = loop.getState().broken;
  const b = loop.getState().healthy;
  assert.strictEqual(a.errorCount, 3, `broken widget retries on its own cadence (errors=${a.errorCount})`);
  assert.strictEqual(a.lastOkAt, null, 'broken widget never marks a false success');
  assert.strictEqual(b.okCount, 3, 'healthy widget unaffected by sibling failure');
  assert.strictEqual(b.lastErrorAt, null, 'healthy widget sees no error state');
  assert.strictEqual(events.length, 6, 'onState fires per widget per settlement');

  // The loop is still alive and ticking after repeated failures.
  clock.advance(5000);
  timers.tick();
  await flushMicrotasks();
  assert.strictEqual(loop.getState().broken.errorCount, 4, 'loop survives repeated failures');
  loop.stop();
}

async function testFreshnessCallbacks() {
  const clock = makeClock();
  const timers = makeTimers();
  let tickCalls = 0;
  let okState = null;
  let errState = null;
  const loop = makeLoop({
    clock,
    timers,
    widgets: {
      stats: { intervalMs: 30000, run: async () => {} },
      syncJobs: { intervalMs: 5000, run: () => Promise.reject(new Error('x')) },
    },
    onTick: () => { tickCalls += 1; },
    onState: (name, state) => {
      if (name === 'stats') okState = state;
      if (name === 'syncJobs') errState = state;
    },
  });

  // One tick before anything is due.
  clock.advance(1000);
  timers.tick();
  assert.strictEqual(tickCalls, 2, 'onTick fires on the start tick and every tick');

  // stats succeeds at t+30s, syncJobs fails at t+5s.
  await pump(clock, timers, 30);
  await flushMicrotasks();

  assert.ok(okState && okState.lastOkAt !== null, 'onState delivers lastOkAt after success');
  assert.ok(errState && errState.lastErrorAt !== null, 'onState delivers lastErrorAt after failure');
  assert.strictEqual(loop.getState().syncJobs.lastOkAt, null, 'failed widget has no lastOkAt (freshness must say stale/unavailable)');
  loop.stop();
}

function testPagePins() {
  const js = read('public/js/dashboard.js');

  assert(js.includes('dzcPolling.createPollingLoop'), 'dashboard must drive ambient refresh through the shared polling loop');
  assert(!js.includes('setInterval(loadDashboardStats'), 'ambient stats poll must not be a raw setInterval');
  assert(!js.includes('setInterval(loadRecentActivity'), 'ambient activity poll must not be a raw setInterval');
  const rawIntervals = (js.match(/setInterval\(/g) || []).length;
  assert.strictEqual(rawIntervals, 1, `only the per-job sync monitor may keep its own interval (found ${rawIntervals})`);
  assert(!js.includes('alert('), 'dashboard page must not use native alert()');
  assert(js.includes('showToast('), 'alert() calls must be replaced with the local toast');

  const html = read('public/dashboard.html');
  for (const marker of [
    'id="attention-items"',
    'id="dzc-freshness-stats"',
    'id="dzc-freshness-activity"',
    'id="dzc-freshness-syncjobs"',
    'id="kpi-daily-spark"',
    'class="dzc-kpi"',
    'class="dzc-panel"',
  ]) {
    assert(html.includes(marker), `dashboard.html missing ${marker}`);
  }
  const pollIdx = html.indexOf('/js/dashboard-poll.js');
  const dashIdx = html.indexOf('/js/dashboard.js');
  assert(pollIdx !== -1, 'dashboard.html must load dashboard-poll.js');
  assert(pollIdx < dashIdx, 'dashboard-poll.js must load before dashboard.js');
}

async function main() {
  let failures = 0;
  const run = (name, fn) => Promise.resolve()
    .then(fn)
    .then(() => console.log(`✅ ${name}`))
    .catch(err => { failures += 1; console.error(`❌ ${name} — ${err.message}`); });

  await run('single interval drives all widgets', testSingleIntervalDrivesAllWidgets);
  await run('hidden tab pauses fetches', testHiddenTabPausesFetches);
  await run('no overlapping fetches', testNoOverlappingFetches);
  await run('widget failures are isolated', testWidgetFailuresAreIsolated);
  await run('freshness callbacks', testFreshnessCallbacks);
  await run('page pins (loop wiring, no alert, states present)', testPagePins);

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll dashboard polling tests passed.');
}

main();
