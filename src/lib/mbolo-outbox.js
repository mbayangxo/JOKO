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

/** J12 (P-J12-3): one stable id per message, reused by every retry and outbox flush (server dedupes). */
export function newClientMessageId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `cm-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
}

export async function enqueueMboloMessage(threadId, payload) {
  const userId = await currentUser();
  if (!userId) throw new Error('Session expirée — reconnecte-toi pour envoyer');
  if (!OUTBOX_KINDS.includes(payload?.kind ?? 'text')) throw new Error('Ce type de message ne peut pas attendre hors ligne');
  const items = await readOutbox();
  const withId = payload?.clientMessageId ? payload : { ...payload, clientMessageId: newClientMessageId() };
  if (items.some((e) => e.userId === userId && e.payload?.clientMessageId === withId.clientMessageId)) return null; // already queued
  const entry = {
    id: `ob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    threadId,
    payload: withId,
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
      // A definite refusal (no longer a member, blocked, restricted…) is never retried automatically:
      // the server's permissions win over the device's queue. The user sees it as held.
      const refused = err?.status >= 400 && err?.status < 500 && ![408, 429].includes(err.status);
      keep.push(refused ? { ...entry, held: true, refused: true } : entry);
      if (refused) held += 1;
    }
  }

  await writeOutbox(keep);
  sent.held = held;
  return sent;
}

/** This user's queued messages for a thread, with their sync state (pending | held). */
export async function outboxState(threadId) {
  const userId = await currentUser();
  const mine = (await readOutbox()).filter((e) => e.userId === userId && e.threadId === threadId);
  return { pending: mine.filter((e) => !e.held).length, held: mine.filter((e) => e.held).length };
}

/** The user chose to send their held (stale) messages now: same client ids, so never twice. */
export async function releaseHeld(threadId) {
  const userId = await currentUser();
  const items = await readOutbox();
  const now = new Date().toISOString();
  await writeOutbox(items.map((e) => (e.userId === userId && e.threadId === threadId && e.held ? { ...e, held: false, createdAt: now } : e)));
  return flushMboloOutbox(threadId);
}

/** The user chose to discard their held messages. */
export async function discardHeld(threadId) {
  const userId = await currentUser();
  const items = await readOutbox();
  await writeOutbox(items.filter((e) => !(e.userId === userId && e.threadId === threadId && e.held)));
}

export async function outboxCount(threadId) {
  const userId = await currentUser();
  const items = (await readOutbox()).filter((e) => e.userId === userId);
  return threadId ? items.filter((e) => e.threadId === threadId).length : items.length;
}
