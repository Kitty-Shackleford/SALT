'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const requestSignals = new AsyncLocalStorage();

function runWithRequestSignal(signal, callback) {
  return requestSignals.run(signal, callback);
}

function runWithoutRequestSignal(callback) {
  return requestSignals.run(null, callback);
}

function currentRequestSignal() {
  return requestSignals.getStore() || null;
}

function requestAbortMiddleware(req, res, next) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });
  runWithRequestSignal(controller.signal, next);
}

module.exports = {
  currentRequestSignal,
  requestAbortMiddleware,
  runWithoutRequestSignal,
  runWithRequestSignal,
};
