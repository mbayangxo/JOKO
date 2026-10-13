import { pendingIntentAction } from './offline-policy.js';

/**
 * J12 — remembers money intents whose outcome is UNKNOWN (response lost, app killed, network gone),
 * so that after a restart the screen asks the server what happened instead of letting the user pay
 * again. Records are lookup handles only: no amount, no recipient (only a one-way hash of the
 * instruction), nothing spendable, never replayed.
 */
const KEY = 'k21_pending_intents_v1';

const defaultStorage = {
  async get() {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(KEY);
    const SecureStore = await import('expo-secure-store');
    return SecureStore.getItemAsync(KEY);
  },
  async set(v) {
    if (typeof localStorage !== 'undefined') return localStorage.setItem(KEY, v);
    const SecureStore = await import('expo-secure-store');
    return SecureStore.setItemAsync(KEY, v);
  },
};

async function readAll(storage) {
  try {
    const raw = await storage.get();
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function rememberPendingIntent({ key, userId, flow, fp = null, now = Date.now() }, storage = defaultStorage) {
  if (!key || !userId || !flow) return;
  const list = (await readAll(storage)).filter((r) => r.key !== key);
  // fp = a HASH of the instruction (never the amount/recipient): lets the same payment, re-entered after a
  // restart, reuse this key — so even a late-arriving original request can never execute twice.
  list.push({ key, userId, flow, ...(fp ? { fp } : {}), createdAt: now });
  await storage.set(JSON.stringify(list.slice(-20)));
}

export async function forgetPendingIntent(key, storage = defaultStorage) {
  const list = await readAll(storage);
  const next = list.filter((r) => r.key !== key);
  if (next.length !== list.length) await storage.set(JSON.stringify(next));
}

/** The intents this user should look up now for `flow` (newest first). Expired ones are pruned. */
export async function pendingIntentsToLookUp({ userId, flow, now = Date.now() }, storage = defaultStorage) {
  const list = await readAll(storage);
  const live = list.filter((r) => pendingIntentAction(r, { userId: r.userId, now }) === 'lookup');
  if (live.length !== list.length) await storage.set(JSON.stringify(live));
  return live.filter((r) => pendingIntentAction(r, { userId, now }) === 'lookup' && r.flow === flow).sort((a, b) => b.createdAt - a.createdAt);
}

/** J13-F17: hard upper bound — a record is never kept beyond this, even if never resolved. */
export const PENDING_INTENT_MAX_AGE_MS = 7 * 24 * 3600_000;

/**
 * J13-F17: EVERY remembered unknown attempt of this user (all flows), for reconciliation to a final answer.
 * Unlike pendingIntentsToLookUp, the 24 h lookup TTL does not silently drop an unresolved record; only the
 * 7-day bound (or a clock far in the past/future) does. Other users' records are never returned.
 */
export async function listPendingIntents({ userId, now = Date.now() }, storage = defaultStorage) {
  if (!userId) return [];
  const list = await readAll(storage);
  const keep = list.filter((r) => r && typeof r.key === 'string' && Number.isFinite(Number(r.createdAt)) && Math.abs(now - Number(r.createdAt)) <= PENDING_INTENT_MAX_AGE_MS);
  if (keep.length !== list.length) await storage.set(JSON.stringify(keep));
  return keep.filter((r) => r.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
}
