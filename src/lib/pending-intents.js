import { pendingIntentAction } from './offline-policy.js';

/**
 * J12 — remembers money intents whose outcome is UNKNOWN (response lost, app killed, network gone),
 * so that after a restart the screen asks the server what happened instead of letting the user pay
 * again. Records are lookup handles only: no amount, no recipient, nothing spendable, never replayed.
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

export async function rememberPendingIntent({ key, userId, flow, now = Date.now() }, storage = defaultStorage) {
  if (!key || !userId || !flow) return;
  const list = (await readAll(storage)).filter((r) => r.key !== key);
  list.push({ key, userId, flow, createdAt: now });
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
