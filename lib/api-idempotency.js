import crypto from 'crypto';
import { prisma } from './prisma.js';
import { runWithRequestContext } from './request-context.js';

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

export async function withIdempotency(req, res, { userId, routeKey }, run) {
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
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    const existing = await prisma.apiIdempotency.findUnique({ where: { key } });
    if (existing && existing.reference !== fp) {
      res.status(422).json({ error: 'Idempotency-Key réutilisée avec une autre requête', code: 'idempotency_key_reuse' });
      return;
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
  return db.journalEntry.findMany({
    where: { metadata: { path: ['clientKey'], equals: clientKey } },
    select: { id: true, reference: true, kind: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
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
  const original = await db.apiIdempotency.findFirst({ where: { userId, provider: 'api', key: { endsWith: `:${k}` }, NOT: { operation: VOID_OPERATION } } });
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
  const rows = await db.apiIdempotency.findMany({ where: { userId, key: { endsWith: `:${k}` }, provider: 'api' } });
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
