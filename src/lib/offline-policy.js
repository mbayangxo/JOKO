/**
 * J12 — offline / low-bandwidth rules, kept pure (no React Native imports) so they are unit-tested.
 *
 *  1. Low-data cache: only an ALLOWLIST of non-sensitive, non-personal GETs may be served from cache,
 *     and every entry is partitioned by the signed-in user. Balances, history, intents, groups, offers,
 *     messages… always go to the network. Nothing cached is ever spendable.
 *  2. Offline queue (Mbolo): only plain text / stickers, only for the account that wrote them, and only
 *     while fresh. Expired or clock-ambiguous entries are never auto-sent — the user decides.
 *  3. Money intents: a pending intent key is remembered across restarts for STATUS LOOKUP ONLY.
 *     It is never re-submitted automatically. A manual retry with the same key is allowed only for a
 *     short window AND only if the instruction is byte-for-byte the same; otherwise a fresh intent and
 *     a fresh confirmation are required.
 */

export const LOW_DATA_CACHE_TTL_MS = 45_000;
export const OUTBOX_KINDS = ['text', 'sticker'];
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const INTENT_LOOKUP_TTL_MS = 24 * 60 * 60 * 1000;
export const INTENT_RETRY_WINDOW_MS = 10 * 60 * 1000;

// Public, identical for every user, never money: catalog / directory / config only.
const CACHEABLE = [
  /^\/api\/platform\/config$/,
  /^\/api\/work\/types$/,
  /^\/api\/products$/,
  /^\/api\/marketplace\/products\/[^/]+$/,
  /^\/api\/marketplace\/shops\/nearby$/,
  /^\/api\/merchants\/[^/]+\/public$/,
  /^\/api\/agents\/nearby$/,
  /^\/api\/events$/,
  /^\/api\/channels$/,
  /^\/api\/channels\/[^/]+$/,
];

const pathOf = (url) => {
  const s = String(url);
  const noOrigin = s.replace(/^https?:\/\/[^/]+/, '');
  return noOrigin.split('?')[0].split('#')[0];
};

export function isLowDataCacheable(url) {
  const p = pathOf(url);
  if (p === '/api/channels/mine' || p === '/api/channels/feed') return false;
  return CACHEABLE.some((re) => re.test(p));
}

/** The user a JWT access token was issued to (decoded, NOT verified — used only to partition local data). */
export function subjectOf(token) {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf8');
    const sub = JSON.parse(json)?.sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}

/** Cache key, partitioned by user. A request without a known user is never cached. */
export function lowDataCacheKey(url, userId) {
  if (!userId || !isLowDataCacheable(url)) return null;
  return `${userId}|GET:${url}`;
}

/** What to do with one queued offline message for the user now signed in. */
export function outboxDecision(entry, { userId, now = Date.now() } = {}) {
  if (!entry || !userId || entry.userId !== userId) return 'not_mine';
  if (!OUTBOX_KINDS.includes(entry.payload?.kind ?? 'text')) return 'drop';
  const at = Date.parse(entry.createdAt);
  if (!Number.isFinite(at)) return 'hold';
  if (at - now > CLOCK_SKEW_MS) return 'hold'; // clock moved backwards: ambiguous age → user decides
  if (now - at > OUTBOX_MAX_AGE_MS) return 'hold'; // stale: never auto-sent
  return 'send';
}

/** Canonical fingerprint of a money instruction (flow + every field that changes what is paid, to whom). */
export function instructionFingerprint(flow, instruction) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return `${flow}:${JSON.stringify(canon(instruction ?? {}))}`;
}

/**
 * A remembered pending intent, read back after a restart / account switch.
 *  'ignore'  — another user's, malformed, or too old to look up (shown nowhere, never sent)
 *  'lookup'  — ask the server for its outcome (GET only); NEVER re-submit
 */
export function pendingIntentAction(rec, { userId, now = Date.now() } = {}) {
  if (!rec || !userId || rec.userId !== userId || typeof rec.key !== 'string') return 'ignore';
  const at = Number(rec.createdAt);
  if (!Number.isFinite(at)) return 'ignore';
  if (now - at > INTENT_LOOKUP_TTL_MS) return 'ignore';
  return 'lookup';
}

/**
 * May the user retry with the SAME intent key (server answered "not_found" = nothing executed)?
 * Only inside a short window, for the same user, with an identical instruction, and if the clock is sane.
 * Anything else needs a NEW intent and a fresh confirmation (amount, recipient, fees re-shown).
 */
export function sameKeyRetryAllowed(rec, { userId, fingerprint, now = Date.now() } = {}) {
  if (!rec || rec.userId !== userId) return false;
  if (rec.fingerprint !== fingerprint) return false;
  const age = now - Number(rec.createdAt);
  if (!Number.isFinite(age) || age < -CLOCK_SKEW_MS) return false;
  return age <= INTENT_RETRY_WINDOW_MS;
}
