/* global window */
/*
 * Dashboard polling engine (card 4/9 — dashboard page redesign).
 *
 * One visibility-aware master loop drives every ambient widget on the
 * dashboard page:
 *   - single setInterval (default 1s tick) — no per-widget intervals
 *   - paused while document.hidden (no fetches on a background tab)
 *   - no overlapping fetches: a widget already in flight is never re-fired
 *   - per-widget failure isolation: a rejected run only marks that widget
 *     (state.lastErrorAt) and schedules a retry on the next due tick
 *   - freshness: onTick(states) fires every tick so the page can render
 *     "updated Xs ago" per panel; onState(name, state) fires on each
 *     success/failure so the page can render error/stale per panel
 *
 * The engine does NOT fetch or render anything itself — widgets supply
 * run() -> Promise. Browser build exposes window.dzcPolling; Node build
 * exports for scripts/dashboard-polling-test.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  } else {
    root.dzcPolling = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * @param {object} options
   *   widgets:    { name: { intervalMs: number, run: () => Promise } }
   *   tickMs:     master tick period (default 1000)
   *   now:        clock (default Date.now) — injected in tests
   *   isHidden:   visibility predicate (default document.hidden)
   *   setInterval / clearInterval: injectable for tests
   *   onTick:     (states) => void, every tick
   *   onState:    (name, state) => void, after each widget success/failure
   * @returns {{ start, stop, getState, state }}
   */
  function createPollingLoop(options) {
    var opts = options || {};
    var widgets = opts.widgets || {};
    var tickMs = opts.tickMs > 0 ? opts.tickMs : 1000;
    var nowFn = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var isHiddenFn = typeof opts.isHidden === 'function'
      ? opts.isHidden
      : function () { return typeof document !== 'undefined' && document.hidden; };
    var setInt = opts.setInterval || (typeof setInterval === 'function' ? setInterval : null);
    var clearInt = opts.clearInterval || (typeof clearInterval === 'function' ? clearInterval : null);

    var state = {};
    Object.keys(widgets).forEach(function (name) {
      state[name] = { inflight: false, lastRunAt: null, lastOkAt: null, lastErrorAt: null, okCount: 0, errorCount: 0 };
    });
    var timer = null;
    var started = false;

    function notify(name) {
      if (typeof opts.onState === 'function') opts.onState(name, state[name]);
    }

    function runWidget(name) {
      var w = state[name];
      w.inflight = true;
      w.lastRunAt = nowFn();
      var result;
      try {
        result = widgets[name].run();
      } catch (err) {
        // Synchronous throw — treat as a failed run, never blank the page.
        w.inflight = false;
        w.lastErrorAt = nowFn();
        w.errorCount += 1;
        notify(name);
        return;
      }
      if (result && typeof result.then === 'function') {
        result.then(
          function () {
            w.inflight = false;
            w.lastOkAt = nowFn();
            w.okCount += 1;
            notify(name);
          },
          function () {
            w.inflight = false;
            w.lastErrorAt = nowFn();
            w.errorCount += 1;
            notify(name);
          }
        );
      } else {
        // Non-thenable run: settled synchronously.
        w.inflight = false;
        w.lastOkAt = nowFn();
        w.okCount += 1;
        notify(name);
      }
    }

    function tick() {
      if (isHiddenFn()) return;
      var t = nowFn();
      Object.keys(widgets).forEach(function (name) {
        var w = state[name];
        if (w.inflight || w.lastRunAt === null) return;
        if (t - w.lastRunAt >= widgets[name].intervalMs) runWidget(name);
      });
      if (typeof opts.onTick === 'function') opts.onTick(state);
    }

    return {
      start: function () {
        if (started || !setInt) return this;
        // Baseline lastRunAt so the first ambient run happens one full
        // interval after start (the page performs the initial load itself).
        var t = nowFn();
        Object.keys(widgets).forEach(function (name) {
          if (state[name].lastRunAt === null) state[name].lastRunAt = t;
        });
        started = true;
        timer = setInt(tick, tickMs);
        tick();
        return this;
      },
      stop: function () {
        if (timer !== null && clearInt) clearInt(timer);
        timer = null;
        started = false;
        return this;
      },
      getState: function () { return state; },
      state: state,
    };
  }

  return { createPollingLoop: createPollingLoop };
}));
