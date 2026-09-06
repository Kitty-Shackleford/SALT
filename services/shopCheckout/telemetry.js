'use strict';

const { performance } = require('perf_hooks');
const telemetry = require('../../utils/telemetry');

const CHECKOUT_STAGES = new Set([
  'validation',
  'database',
  'provider_preflight',
  'spawn_generation',
  'provider_mutation',
  'order_finalization',
]);
const CHECKOUT_OUTCOMES = new Set(['success', 'failed', 'recovery', 'unknown']);

function createCheckoutTimer({
  now = () => performance.now(),
  record = telemetry.recordTiming,
  enabled = process.env.SHOP_CHECKOUT_TIMING_ENABLED !== 'false',
  log = process.env.SHOP_CHECKOUT_TIMING_LOG === 'true',
} = {}) {
  const startedAt = now();
  let lastCheckpointAt = startedAt;
  const timings = {};

  function assertStage(stage) {
    if (!CHECKOUT_STAGES.has(stage)) throw new TypeError('Unknown checkout timing stage');
  }

  async function measure(stage, operation) {
    assertStage(stage);
    if (!enabled) return operation();
    const stageStartedAt = now();
    try {
      return await operation();
    } finally {
      const duration = now() - stageStartedAt;
      timings[stage] = (timings[stage] || 0) + duration;
      record(`shop_checkout.${stage}`, duration);
    }
  }

  function measureSync(stage, operation) {
    assertStage(stage);
    if (!enabled) return operation();
    const stageStartedAt = now();
    try {
      return operation();
    } finally {
      const duration = now() - stageStartedAt;
      timings[stage] = (timings[stage] || 0) + duration;
      record(`shop_checkout.${stage}`, duration);
    }
  }

  function checkpoint(stage) {
    assertStage(stage);
    if (!enabled) return;
    const checkpointAt = now();
    const duration = checkpointAt - lastCheckpointAt;
    lastCheckpointAt = checkpointAt;
    timings[stage] = (timings[stage] || 0) + duration;
    record(`shop_checkout.${stage}`, duration);
  }

  function finish(outcome) {
    if (!enabled) return {};
    if (!CHECKOUT_OUTCOMES.has(outcome)) throw new TypeError('Unknown checkout timing outcome');
    const total = now() - startedAt;
    timings.total = total;
    record(`shop_checkout.total.${outcome}`, total);
    if (log) console.log('⏱ [shop-checkout]', JSON.stringify({ outcome, ...timings }));
    return { ...timings };
  }

  return { checkpoint, finish, measure, measureSync };
}

module.exports = { CHECKOUT_STAGES, createCheckoutTimer };
