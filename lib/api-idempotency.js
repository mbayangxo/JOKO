import crypto from 'crypto';
import { prisma } from './prisma.js';
import { runWithRequestContext } from './request-context.js';
import { labEnabled } from './lab/faults.js';

/**
 * Generic Idempotency-Key support for money-moving API routes.
 *
 * A client sends the same `Idempotency-Key` for every retry of ONE user action
 * (double tap, timeout + retry, flaky network). The first request executes;
 * concurrent duplicates get 409 while it runs; later duplicates replay the
 * stored response without executing again. Reusing a key with a different
 * body is refused (422). 5xx outcomes are not stored, so a genuine retry can run.
 */
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function fingerprint(req) {
  return crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
}

/**
 * J15-L5 (found by the torture lab): a request killed mid-flight (instance crash, platform timeout, OOM) never
 * reaches the `finally` below, so its key stayed `in_progress` FOREVER — the client was told "in progress, do not
 * retry", a retry got 409 and a void could not close it, even when nothing had moved. After a lease that the
 * original request cannot outlive (30 s function limit, 15 s money-transaction timeout; a dead process's
 * transaction is rolled back with its connection), the key converges exactly like a 5xx does today:
 * a ledger entry carries the key → "completed" (response lost); nothing moved → the key is released.
 */
const DEFAULT_STALE_LEASE_MS = 5 * 60_000;
export function staleLeaseMs() {
  const v = Number(process.env.IDEMPOTENCY_STALE_LEASE_MS);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_STALE_LEASE_MS;
  // Only the local lab may go below 2 minutes (to observe convergence inside a run).
  return labEnabled() ? v : Math.max(v, 2 * 60_000);
}

const rawKeyOf = (row) => row.key.slice(`api:${row.userId}:${row.operation}:`.length);
const KEY_REUSE_BODY = { error: 'Idempotency-Key réutilisée avec une autre requête', code: 'idempotency_key_reuse' };

async function keyUsedElsewhere(userId, rawKey, ownKey, db = prisma) {
  const rows = await db.apiIdempotency.findMany({
    where: { userId, provider: 'api', key: { endsWith: `:${rawKey}` }, NOT: [{ key: ownKey }, { operation: VOID_OPERATION }] },
    select: { key: true, userId: true, operation: true },
  });
  return rows.some((r) => rawKeyOf(r) === rawKey);
}

/** Converge one abandoned `in_progress` key. Returns 'completed' | 'released' | null (not stale / lost a race). */
export async function releaseStaleIntent(row, db = prisma) {
  if (row?.status !== 'in_progress' || row.operation === VOID_OPERATION) return null;
  if (Date.now() - new Date(row.createdAt).getTime() < staleLeaseMs()) return null;
  const moved = await entriesForClientKey(`${row.userId}:${rawKeyOf(row)}`, db);
  if (moved.length) {
    const body = { status: 'completed', code: 'completed_response_lost', message: 'Opération effectuée — consulte ton historique.', references: moved.map((e) => e.reference) };
    const r = await db.apiIdempotency.updateMany({ where: { key: row.key, status: 'in_progress' }, data: { status: 'done', responseJson: JSON.stringify({ status: 200, body }) } });
    return r.count ? 'completed' : null;
  }
  const r = await db.apiIdempotency.deleteMany({ where: { key: row.key, status: 'in_progress', createdAt: row.createdAt } });
  return r.count ? 'released' : null;
}

/** Cron hygiene (cron/pending-transactions): converge abandoned keys even if the client never comes back. */
export async function sweepStaleIntents(db = prisma, { limit = 200 } = {}) {
  const rows = await db.apiIdempotency.findMany({
    where: { provider: 'api', status: 'in_progress', createdAt: { lt: new Date(Date.now() - staleLeaseMs()) } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  const out = { scanned: rows.length, completed: 0, released: 0 };
  for (const row of rows) {
    const r = await releaseStaleIntent(row, db);
    if (r) out[r] += 1;
  }
  return out;
}

export async function withIdempotency(req, res, { userId, routeKey }, run, attempt = 0) {
  const raw = req.headers?.['idempotency-key'];
  if (typeof raw !== 'string' || !KEY_RE.test(raw.trim())) return run();

  const key = `api:${userId}:${routeKey}:${raw.trim()}`;
  const fp = fingerprint(req);

  try {
    await prisma.apiIdempotency.create({
      data: { key, provider: 'api', userId, operation: routeKey, reference: fp, status: 'in_progress' },
    });
    // J13-F17: an intent the client CLOSED (voidIntent) can never execute later. Insert-then-check on both
    // sides: whichever commits second sees the other, so a late original and a void never both proceed.
    if (await prisma.apiIdempotency.findUnique({ where: { key: voidKeyFor(userId, raw.trim()) } })) {
      await prisma.apiIdempotency.delete({ where: { key } }).catch(() => {});
      res.status(409).json(VOIDED_BODY);
      return;
    }
    // J15-L6 (found by the soak): ONE key is ONE intent per user, across every route. Intent lookup, void and
    // crash recovery resolve a key per (user, key) — the ledger carries `user:key`, not the route — so a key
    // reused on a second operation let a crash of the second be reported "completed" from the FIRST one's
    // entry. Same insert-then-check as the void above: two concurrent uses on different routes both refuse.
    if (await keyUsedElsewhere(userId, raw.trim(), key)) {
      await prisma.apiIdempotency.delete({ where: { key } }).catch(() => {});
      res.status(422).json(KEY_REUSE_BODY);
      return;
    }
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    const existing = await prisma.apiIdempotency.findUnique({ where: { key } });
    if (existing && existing.reference !== fp) {
      res.status(422).json(KEY_REUSE_BODY);
      return;
    }
    if (attempt === 0 && existing?.status === 'in_progress' && (await releaseStaleIntent(existing))) {
      return withIdempotency(req, res, { userId, routeKey }, run, 1);
    }
    if (existing?.responseJson) {
      const stored = JSON.parse(existing.responseJson);
      res.setHeader?.('Idempotent-Replay', 'true');
      res.status(stored.status).json(stored.body);
      return;
    }
    res.status(409).json({ error: 'Cette opération est déjà en cours', code: 'idempotency_in_progress' });
    return;
  }

  // J12: the reply is HELD until the idempotency row is final (stored, or released). Sending first left a
  // window in which an instant retry (the PIN-confirmed retry after a challenge, or a reconnect after a
  // success) met the still-"in_progress" row and got a spurious 409 instead of executing / replaying.
  let captured = null;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    captured = { status: res.statusCode ?? 200, body };
    return res;
  };

  const clientKey = `${userId}:${raw.trim()}`;
  try {
    await runWithRequestContext({ clientKey }, run);
  } finally {
    res.json = originalJson;
    // J12-F7: a PIN challenge is not an answer to the instruction — the same intent must run once the
    // PIN is proven. Storing it would replay the 403 forever. It falls through to the "nothing moved →
    // release the key" check below, so a challenge after a commit can never re-open a paid intent.
    const challenge = captured?.status === 403 && captured.body?.code === 'step_up_required';
    if (captured && captured.status < 500 && !challenge) {
      await prisma.apiIdempotency
        .update({ where: { key }, data: { status: 'done', responseJson: JSON.stringify(captured) } })
        .catch((e) => console.error('[idempotency] store failed', e?.message));
    } else {
      // J4: a 5xx (or a crash) AFTER money committed must never let a retry
      // with the same key pay again. If any ledger entry carries this key, the
      // outcome is "completed" and a retry replays that — otherwise nothing
      // moved and the key is released for a genuine retry.
      const moved = await entriesForClientKey(clientKey);
      if (moved.length) {
        const body = {
          status: 'completed',
          code: 'completed_response_lost',
          message: 'Opération effectuée — consulte ton historique.',
          references: moved.map((e) => e.reference),
        };
        await prisma.apiIdempotency
          .update({ where: { key }, data: { status: 'done', responseJson: JSON.stringify({ status: 200, body }) } })
          .catch((e) => console.error('[idempotency] store failed', e?.message));
      } else {
        await prisma.apiIdempotency.delete({ where: { key } }).catch(() => {});
      }
    }
    if (captured) {
      res.status(captured.status);
      originalJson(captured.body);
    }
  }
}

/** Ledger entries a request carrying this client key committed. */
export async function entriesForClientKey(clientKey, db = prisma) {
  // J15 (found by the L6 soak): the partial expression index "JournalEntry_clientKey_idx" serves this lookup only
  // when the query repeats its predicate; the JSON-path filter it replaces scanned the whole journal every time.
  return db.$queryRaw`
    SELECT id, reference, kind, "createdAt" FROM "JournalEntry"
     WHERE metadata ? 'clientKey' AND metadata->>'clientKey' = ${clientKey}
     ORDER BY "createdAt" ASC`;
}

// J13-F17: closing an abandoned intent. A key with no row and no ledger entry ("not_found") only says that
// nothing has arrived YET; closing it makes that final — any later request carrying the key is refused.
export const VOID_OPERATION = 'intent_void';
const voidKeyFor = (userId, k) => `api:${userId}:VOID:${k}`;
export const VOIDED_BODY = {
  error: 'Ce paiement a été annulé avant d’être reçu par K21. Aucun argent n’a été débité.',
  code: 'intent_voided',
};

/**
 * Close the caller's intent `rawKey` if — and only if — nothing ran under it. Never executes, never creates
 * a payment, never touches another account's namespace. Returns the resulting intent outcome:
 * 'voided' (closed now or earlier), or the real state when the original did arrive (in_progress / completed
 * / accepted_pending / refused), in which case nothing is closed.
 */
export async function voidIntent(userId, rawKey, db = prisma) {
  const k = String(rawKey ?? '').trim();
  if (!KEY_RE.test(k)) return { state: 'invalid' };
  const vkey = voidKeyFor(userId, k);
  let created = false;
  try {
    await db.apiIdempotency.create({
      data: { key: vkey, provider: 'api', userId, operation: VOID_OPERATION, reference: 'void', status: 'done', responseJson: JSON.stringify({ status: 409, body: VOIDED_BODY }) },
    });
    created = true;
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
  }
  let original = await db.apiIdempotency.findFirst({ where: { userId, provider: 'api', key: { endsWith: `:${k}` }, NOT: { operation: VOID_OPERATION } } });
  if (original && (await releaseStaleIntent(original, db))) {
    original = await db.apiIdempotency.findFirst({ where: { userId, provider: 'api', key: { endsWith: `:${k}` }, NOT: { operation: VOID_OPERATION } } });
  }
  const entries = await entriesForClientKey(`${userId}:${k}`, db);
  if (original || entries.length) {
    // The original reached the server first: it decides. Remove our closure (only if we created it now).
    if (created) await db.apiIdempotency.delete({ where: { key: vkey } }).catch(() => {});
    return intentOutcome(userId, k, db);
  }
  return { state: 'voided', references: [] };
}

/**
 * Outcome of a client intent (Idempotency-Key), for "did my payment go
 * through?" after a timeout, app kill or network loss. Never guesses.
 */
export async function intentOutcome(userId, rawKey, db = prisma) {
  const k = String(rawKey ?? '').trim();
  if (!KEY_RE.test(k)) return { state: 'invalid' };
  let rows = await db.apiIdempotency.findMany({ where: { userId, key: { endsWith: `:${k}` }, provider: 'api' } });
  let converged = false;
  for (const r of rows) if (await releaseStaleIntent(r, db)) converged = true;
  if (converged) rows = await db.apiIdempotency.findMany({ where: { userId, key: { endsWith: `:${k}` }, provider: 'api' } });
  const row = rows.find((r) => r.operation !== VOID_OPERATION) ?? null;
  const voided = rows.some((r) => r.operation === VOID_OPERATION);
  const entries = await entriesForClientKey(`${userId}:${k}`, db);
  if (row?.status === 'done' && row.responseJson) {
    const stored = JSON.parse(row.responseJson);
    const ok = stored.status < 300;
    return {
      // 202 = accepted but not final (provider pending, or held for review).
      state: ok ? (stored.status === 202 ? 'accepted_pending' : 'completed') : 'refused',
      httpStatus: stored.status,
      code: stored.body?.code ?? null,
      references: entries.map((e) => e.reference),
      operation: row.operation,
    };
  }
  if (row) return { state: 'in_progress', references: entries.map((e) => e.reference), operation: row.operation };
  if (entries.length) return { state: 'completed', references: entries.map((e) => e.reference) };
  if (voided) return { state: 'voided', references: [] };
  return { state: 'not_found', references: [] };
}
