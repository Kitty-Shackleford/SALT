(function checkoutStateModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CheckoutState = api;
})(typeof window !== 'undefined' ? window : globalThis, function buildCheckoutStateModule() {
  'use strict';

  const CHECKOUT_STATES = Object.freeze({
    IDLE: 'idle',
    CHECKING: 'checking',
    PROCESSING: 'processing',
    SUCCESS: 'success',
    FAILED: 'failed',
    RECOVERY: 'recovery',
    UNKNOWN: 'unknown',
  });

  const transitions = Object.freeze({
    [CHECKOUT_STATES.IDLE]: new Set([CHECKOUT_STATES.CHECKING]),
    [CHECKOUT_STATES.CHECKING]: new Set([
      CHECKOUT_STATES.PROCESSING,
      CHECKOUT_STATES.SUCCESS,
      CHECKOUT_STATES.FAILED,
      CHECKOUT_STATES.RECOVERY,
      CHECKOUT_STATES.UNKNOWN,
    ]),
    [CHECKOUT_STATES.PROCESSING]: new Set([
      CHECKOUT_STATES.SUCCESS,
      CHECKOUT_STATES.FAILED,
      CHECKOUT_STATES.RECOVERY,
      CHECKOUT_STATES.UNKNOWN,
    ]),
    [CHECKOUT_STATES.FAILED]: new Set([CHECKOUT_STATES.CHECKING]),
    [CHECKOUT_STATES.SUCCESS]: new Set(),
    [CHECKOUT_STATES.RECOVERY]: new Set(),
    [CHECKOUT_STATES.UNKNOWN]: new Set([CHECKOUT_STATES.CHECKING]),
  });

  function checkoutView(state, detail = {}) {
    const views = {
      [CHECKOUT_STATES.IDLE]: {
        buttonLabel: 'Checkout', message: '', disabled: false, busy: false,
      },
      [CHECKOUT_STATES.CHECKING]: {
        buttonLabel: 'Checking order…',
        message: 'Checking your cart and balance…',
        disabled: true,
        busy: true,
      },
      [CHECKOUT_STATES.PROCESSING]: {
        buttonLabel: 'Processing order…',
        message: detail.slow
          ? 'Still working — this may take a few moments.'
          : 'Processing your order… Please wait while we confirm your purchase.',
        disabled: true,
        busy: true,
      },
      [CHECKOUT_STATES.SUCCESS]: {
        buttonLabel: 'Order complete',
        message: detail.message || 'Purchase successful.',
        disabled: true,
        busy: false,
      },
      [CHECKOUT_STATES.FAILED]: {
        buttonLabel: 'Try Again',
        message: detail.message || 'Checkout failed. Please review the error and try again.',
        disabled: false,
        busy: false,
      },
      [CHECKOUT_STATES.RECOVERY]: {
        buttonLabel: 'Reconciliation required',
        message: detail.message || 'Checkout requires provider reconciliation before another attempt.',
        disabled: true,
        busy: false,
      },
      [CHECKOUT_STATES.UNKNOWN]: {
        buttonLabel: 'Retry safely',
        message: detail.message || 'The order status is uncertain. Retry to check the same request safely.',
        disabled: false,
        busy: false,
      },
    };
    if (!views[state]) throw new Error('Unknown checkout state: ' + String(state));
    return views[state];
  }

  function createCheckoutAttemptRegistry() {
    const activeByContext = new Map();

    function begin(contextKey) {
      if (!contextKey || activeByContext.has(contextKey)) return null;
      const attempt = Object.freeze({ contextKey, id: Symbol(contextKey) });
      activeByContext.set(contextKey, attempt);
      return attempt;
    }

    function finish(attempt) {
      if (!attempt || activeByContext.get(attempt.contextKey) !== attempt) return false;
      activeByContext.delete(attempt.contextKey);
      return true;
    }

    return {
      begin,
      finish,
      has(contextKey) { return activeByContext.has(contextKey); },
    };
  }

  function resolveCheckoutOutcome({
    responseOk = false,
    responseStatus = 0,
    checkoutState,
    networkError = false,
    invalidResponse = false,
  } = {}) {
    if (networkError || invalidResponse || [502, 503, 504].includes(responseStatus)
        || checkoutState === CHECKOUT_STATES.UNKNOWN
        || checkoutState === CHECKOUT_STATES.PROCESSING) {
      return CHECKOUT_STATES.UNKNOWN;
    }
    if (checkoutState === CHECKOUT_STATES.RECOVERY) return CHECKOUT_STATES.RECOVERY;
    if (responseOk && checkoutState === CHECKOUT_STATES.SUCCESS) return CHECKOUT_STATES.SUCCESS;
    return CHECKOUT_STATES.FAILED;
  }

  function createCheckoutStateMachine(render = () => {}) {
    let state = CHECKOUT_STATES.IDLE;
    let detail = {};

    function publish() {
      render(state, detail, checkoutView(state, detail));
    }

    function transition(nextState, nextDetail = {}) {
      if (!transitions[state]?.has(nextState)) {
        throw new Error(`Invalid checkout transition: ${state} -> ${nextState}`);
      }
      state = nextState;
      detail = nextDetail;
      publish();
    }

    function update(nextDetail = {}) {
      detail = nextDetail;
      publish();
    }

    function reset() {
      state = CHECKOUT_STATES.IDLE;
      detail = {};
      publish();
    }

    publish();
    return {
      get state() { return state; },
      get detail() { return detail; },
      reset,
      transition,
      update,
    };
  }

  return {
    CHECKOUT_STATES,
    checkoutView,
    createCheckoutAttemptRegistry,
    createCheckoutStateMachine,
    resolveCheckoutOutcome,
  };
});
