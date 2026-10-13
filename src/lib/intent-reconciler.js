/**
 * J13-F17 — bounded status reconciliation for money attempts whose outcome is UNKNOWN.
 *
 * An attempt is unknown when its reply was lost (timeout, dropped connection, app killed, restart). The
 * server is the only authority; this module ONLY asks it, by the attempt's original intent key:
 *
 *   GET  /api/money/intents/:key        completed | accepted_pending | refused | voided | in_progress | not_found
 *   POST /api/money/intents/:key/void   closes a key that NOTHING ran under (a late original is then refused)
 *
 * Rules (never broken here):
 *   - never re-submits a payment, never creates a key or an instruction for it — lookups and "close" only;
 *   - "not_found" is NOT an answer: the original may still arrive. It stays "unknown" until the key is closed;
 *   - the key is closed only after VOID_AFTER_MS of wall-clock age OR VOID_AFTER_MONO_MS of monotonic time in
 *     this session since the first "not_found" (a clock that jumps either way cannot keep it open forever,
 *     and closing early is always safe: the server refuses to close a key that ran);
 *   - only the signed-in user's records are looked up (account switching never leaks or touches another's);
 *   - checks run on app resume, on history refresh and on a foreground interval while anything is unknown —
 *     background execution on mobile is never assumed.
 */
import { classifyIntent } from './money-ux.js';

export const VOID_AFTER_MS = 90_000;
export const VOID_AFTER_MONO_MS = 60_000;
export const FOREGROUND_INTERVAL_MS = 15_000;

const FINAL = new Set(['done', 'accepted_pending', 'failed_safe']);

/**
 * deps: { getIntent(key), voidIntent(key), listPending(userId), forget(key), currentUser(), now(), mono() }
 * Returns { reconcileOne(rec), reconcileAll(), subscribe(fn), hasPending() }.
 */
export const RECENT_OUTCOME_MS = 10 * 60_000;

export function createIntentReconciler(deps) {
  const firstNotFoundMono = new Map(); // key → monotonic ms of the first "not_found" seen in this session
  const listeners = new Set();
  // A final answer found before the screen of that flow was open (e.g. right after a restart) is kept briefly so
  // that screen can still show it once — per user and flow, monotonic time, consumed on read.
  const recent = new Map(); // `${userId}:${flow}` → { event, mono }
  let running = null;
  let pendingCount = 0;

  const emit = (event) => {
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        /* a listener never breaks reconciliation */
      }
    }
  };

  async function reconcileOne(rec, { source = 'screen' } = {}) {
    let raw;
    try {
      raw = await deps.getIntent(rec.key);
    } catch {
      return { key: rec.key, state: 'checking', unknown: true }; // still unreachable: keep it unknown
    }
    if (raw?.state === 'not_found') {
      const mono = deps.mono();
      if (!firstNotFoundMono.has(rec.key)) firstNotFoundMono.set(rec.key, mono);
      const wallAge = deps.now() - Number(rec.createdAt);
      const monoAge = mono - firstNotFoundMono.get(rec.key);
      if (wallAge >= VOID_AFTER_MS || monoAge >= VOID_AFTER_MONO_MS) {
        try {
          raw = await deps.voidIntent(rec.key); // closes it — or reveals that the original did arrive
        } catch {
          return { key: rec.key, state: 'checking', unknown: true };
        }
      }
    }
    const out = classifyIntent(raw);
    if (FINAL.has(out.state)) {
      firstNotFoundMono.delete(rec.key);
      await deps.forget(rec.key);
      const event = { key: rec.key, flow: rec.flow, source, ...out };
      if (rec.userId && rec.flow) recent.set(`${rec.userId}:${rec.flow}`, { event, mono: deps.mono() });
      emit(event);
      return event;
    }
    return { key: rec.key, ...out };
  }

  async function reconcileAll() {
    if (running) return running; // one pass at a time; callers share it
    running = (async () => {
      const userId = await deps.currentUser();
      if (!userId) {
        pendingCount = 0;
        return [];
      }
      const records = (await deps.listPending(userId)).filter((r) => r.userId === userId);
      const results = [];
      for (const rec of records) results.push(await reconcileOne(rec, { source: 'background' }));
      pendingCount = results.filter((r) => !FINAL.has(r.state)).length;
      return results;
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  /** The final answer of this user's most recent unknown attempt in `flow`, if found in the last 10 min (once). */
  function takeRecent(userId, flow) {
    const k = `${userId}:${flow}`;
    const r = recent.get(k);
    if (!r) return null;
    recent.delete(k);
    return deps.mono() - r.mono <= RECENT_OUTCOME_MS ? r.event : null;
  }

  return {
    reconcileOne,
    reconcileAll,
    takeRecent,
    hasPending: () => pendingCount > 0,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
