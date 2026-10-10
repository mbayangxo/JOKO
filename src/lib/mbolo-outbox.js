import { getAccessToken } from './secure-storage.js';
import { OUTBOX_KINDS, outboxDecision, subjectOf } from './offline-policy.js';

const OUTBOX_KEY = 'mbolo_outbox_v1';

// J12: the outbox carries plain text / stickers only (never money), belongs to the account that wrote
// each message, and never auto-sends a stale or clock-ambiguous entry (see offline-policy.js).

async function readRaw() {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(OUTBOX_KEY);
  }
  const SecureStore = await import('expo-secure-store');
  return SecureStore.getItemAsync(OUTBOX_KEY);
}

async function writeRaw(value) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(OUTBOX_KEY, value);
    return;
  }
  const SecureStore = await import('expo-secure-store');
  await SecureStore.setItemAsync(OUTBOX_KEY, value);
}

async function readOutbox() {
  try {
    const raw = await readRaw();
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeOutbox(items) {
  await writeRaw(JSON.stringify(items));
}

const currentUser = async () => subjectOf(await getAccessToken());

export async function enqueueMboloMessage(threadId, payload) {
  const userId = await currentUser();
  if (!userId) throw new Error('Session expirée — reconnecte-toi pour envoyer');
  if (!OUTBOX_KINDS.includes(payload?.kind ?? 'text')) throw new Error('Ce type de message ne peut pas attendre hors ligne');
  const items = await readOutbox();
  const entry = {
    id: `ob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    threadId,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  items.push(entry);
  await writeOutbox(items);
  return entry;
}

/**
 * Sends this user's fresh queued messages for `threadId`. Another account's entries are left untouched
 * (they stay theirs); stale or clock-ambiguous ones are kept as `held` for the user to resend or discard.
 */
export async function flushMboloOutbox(threadId) {
  const userId = await currentUser();
  const items = await readOutbox();
  const keep = [];
  const sent = [];
  let held = 0;

  const { sendMboloMessage } = await import('./api-client');

  for (const entry of items) {
    if (entry.threadId !== threadId) {
      keep.push(entry);
      continue;
    }
    const decision = outboxDecision(entry, { userId });
    if (decision === 'not_mine') {
      keep.push(entry);
      continue;
    }
    if (decision === 'drop') continue;
    if (decision === 'hold') {
      held += 1;
      keep.push({ ...entry, held: true });
      continue;
    }
    try {
      const msg = await sendMboloMessage(entry.threadId, entry.payload);
      sent.push(msg);
    } catch (err) {
      entry.attempts += 1;
      entry.lastError = err?.message ?? 'send failed';
      keep.push(entry);
    }
  }

  await writeOutbox(keep);
  sent.held = held;
  return sent;
}

export async function outboxCount(threadId) {
  const userId = await currentUser();
  const items = (await readOutbox()).filter((e) => e.userId === userId);
  return threadId ? items.filter((e) => e.threadId === threadId).length : items.length;
}
