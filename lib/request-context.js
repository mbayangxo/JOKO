import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context (J4). Carries the client's Idempotency-Key ("intent
 * key") so every ledger entry a request posts records it. That lets the API
 * answer "did this payment happen?" exactly — for timeouts, app kills and
 * 5xx after commit — instead of letting the user pay twice.
 */
const store = new AsyncLocalStorage();

export function runWithRequestContext(ctx, fn) {
  return store.run(ctx, fn);
}

export function requestContext() {
  return store.getStore() ?? null;
}
