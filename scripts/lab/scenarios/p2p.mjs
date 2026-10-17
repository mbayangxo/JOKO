/**
 * S-P core: P2P send / double tap / retry-after-unknown / undo / balance reads, all on a small shared set of
 * accounts so operations contend. Every operation's CONTENT is a pure function of (seed, op index), so a replay
 * issues the same operations; only their interleaving depends on timing.
 */
import crypto from 'node:crypto';
import { fundUser, prisma } from '../../../tests/helpers/db.js';
import { customer, signedIn } from '../../../tests/j3/helpers.js';
import { labKey, rngFor } from '../prng.mjs';
import { intentOutcome } from '../../../lib/api-idempotency.js';

export const name = 'p2p';

/**
 * A routed call for this session that behaves like the app: an expired access token (401) triggers ONE refresh
 * (single-flight per session — refresh tokens rotate and must not be reused) and the request is retried once.
 * (J15: the first soak lost its load at minute 30 because the driver never refreshed.)
 */
export function withRefresh(s, api) {
  const send = (method, p, body, extra) =>
    api.client(method, p, { token: s.token, device: s.device, ip: s.ip, headers: { ...(extra.headers ?? {}) }, body: method === 'GET' ? undefined : body, worker: extra.worker });
  const refresh = () => {
    s.refreshing ??= api.client('POST', 'auth/refresh', { device: s.device, ip: s.ip, body: { refreshToken: s.refresh } })
      .then((r) => { if (r.status === 200) { s.token = r.body.accessToken; s.refresh = r.body.refreshToken; s.refreshes = (s.refreshes ?? 0) + 1; } else { s.refreshFailures = (s.refreshFailures ?? 0) + 1; } })
      .finally(() => { s.refreshing = null; });
    return s.refreshing;
  };
  return async (method, p, body, extra = {}) => {
    const r = await send(method, p, body, extra);
    if (r.status !== 401) return r;
    await refresh();
    return send(method, p, body, extra);
  };
}

export async function setup(cluster, { seed, users = 24, fundKori = 20_000 }) {
  const actors = [];
  for (let i = 0; i < users; i += 1) {
    const c = await customer({ koriBalance: 0 });
    await fundUser(c.id, fundKori);
    const s = await signedIn(cluster.apiFor(`login:${seed}:${i}`), c);
    // Route this actor's calls deterministically, independent of the login routing.
    const api = cluster.apiFor(`actor:${seed}:${i}`);
    s.call = withRefresh(s, api);
    actors.push({ i, s, lastSend: null, lastUnknownKey: null });
  }
  return { actors, fundKori };
}

const newKey = labKey;

/** One operation. Returns records (one per HTTP request that could move money). */
export async function step(ctx, opIndex, { seed, apiWorkers }) {
  const rng = rngFor(seed, opIndex);
  const { actors } = ctx;
  const a = actors[Math.floor(rng() * actors.length)];
  let b = actors[Math.floor(rng() * actors.length)];
  if (b === a) b = actors[(a.i + 1) % actors.length];
  const roll = rng();
  const amount = 1 + Math.floor(rng() * 3_000);
  const out = [];
  const send = async (key, worker, tag) => {
    const t0 = Date.now();
    const r = await a.s.call('POST', 'transfers/send', { recipientHandle: b.s.handle, amount }, { headers: { 'idempotency-key': key }, worker });
    const rec = { op: opIndex, kind: 'send', tag, from: a.s.id, to: b.s.id, amount, key, clientKey: `${a.s.id}:${key}`, status: r.status, code: r.body?.code ?? null, reference: r.body?.reference ?? null, worker: r.worker, network: Boolean(r.network), t0, ms: Date.now() - t0 };
    out.push(rec);
    return rec;
  };

  if (roll < 0.1 && a.lastUnknownKey) {
    // The same human retries an instruction whose outcome they never saw, with the SAME key.
    const { key, amount: amt, to } = a.lastUnknownKey;
    a.lastUnknownKey = null;
    const t0 = Date.now();
    const r = await a.s.call('POST', 'transfers/send', { recipientHandle: actors.find((x) => x.s.id === to).s.handle, amount: amt }, { headers: { 'idempotency-key': key } });
    out.push({ op: opIndex, kind: 'send', tag: 'retry_unknown', from: a.s.id, to, amount: amt, key, clientKey: `${a.s.id}:${key}`, status: r.status, code: r.body?.code ?? null, reference: r.body?.reference ?? null, worker: r.worker, network: Boolean(r.network), t0, ms: Date.now() - t0 });
  } else if (roll < 0.2) {
    // Double tap: one key, two requests at once on two different workers.
    const key = newKey(rng);
    const w = Math.floor(rng() * apiWorkers);
    await Promise.all([send(key, w, 'double_tap'), send(key, (w + 1) % apiWorkers, 'double_tap')]);
  } else if (roll < 0.75) {
    const key = newKey(rng);
    const rec = await send(key, undefined, 'send');
    if (rec.status === 201) a.lastSend = rec;
    if (rec.network || rec.status >= 500) a.lastUnknownKey = { key, amount, to: b.s.id };
  } else if (roll < 0.85 && a.lastSend?.reference) {
    const ref = a.lastSend.reference;
    a.lastSend = null;
    const t0 = Date.now();
    const r = await a.s.call('POST', `transfers/${ref}/undo`, {});
    out.push({ op: opIndex, kind: 'undo', from: a.s.id, reference: ref, status: r.status, code: r.body?.code ?? null, worker: r.worker, network: Boolean(r.network), t0, ms: Date.now() - t0 });
  } else {
    await a.s.call('GET', 'money/home');
  }
  return out;
}

export const crons = ['pending-transactions', 'scheduled-payments'];

/** End-of-run audit: what each client was told vs what the ledger booked under that key. */
export async function audit(ctx, records) {
  const findings = [];
  const byKey = new Map();
  for (const r of records.filter((x) => x.kind === 'send')) byKey.set(r.clientKey, [...(byKey.get(r.clientKey) ?? []), r]);
  const keys = [...byKey.keys()];
  const entries = keys.length
    ? await prisma.$queryRawUnsafe(
      `SELECT metadata->>'clientKey' AS key, kind, reference FROM "JournalEntry" WHERE metadata ? 'clientKey' AND metadata->>'clientKey' = ANY($1::text[])`, keys)
    : [];
  const entriesByKey = new Map();
  for (const e of entries) entriesByKey.set(e.key, [...(entriesByKey.get(e.key) ?? []), e]);
  const idem = keys.length ? await prisma.apiIdempotency.findMany({ where: { key: { in: keys.map((k) => { const [u, ...rest] = k.split(':'); return `api:${u}:POST transfers/send:${rest.join(':')}`; }) } } }) : [];
  const idemByClientKey = new Map(idem.map((row) => { const parts = row.key.split(':'); return [`${parts[1]}:${parts.slice(3).join(':')}`, row]; }));
  const DEFINITIVE_REFUSAL = new Set([400, 403, 404, 422, 429]);
  const stats = { keys: keys.length, completed: 0, refused: 0, held: 0, unknownResolvedCompleted: 0, unknownResolvedNothing: 0, stuckInProgress: 0 };
  for (const [key, recs] of byKey) {
    const p2p = (entriesByKey.get(key) ?? []).filter((e) => e.kind === 'p2p_transfer');
    const sawOk = recs.some((r) => r.status === 201);
    const sawHeld = recs.some((r) => r.status === 202);
    const allRefused = recs.every((r) => DEFINITIVE_REFUSAL.has(r.status));
    const unknown = recs.some((r) => r.network || r.status >= 500 || r.status === 409);
    if (p2p.length > 1) findings.push({ check: 'exactly_once', id: 'double_booking', key, n: p2p.length });
    if (sawOk && p2p.length !== 1) findings.push({ check: 'honest_outcome', id: 'told_completed_not_booked', key });
    if (allRefused && p2p.length) findings.push({ check: 'honest_outcome', id: 'told_refused_but_booked', key, statuses: recs.map((r) => r.status) });
    if (sawHeld && p2p.length) findings.push({ check: 'honest_outcome', id: 'held_but_booked', key });
    if (sawOk) stats.completed += 1;
    else if (sawHeld) stats.held += 1;
    else if (allRefused) stats.refused += 1;
    else if (unknown) {
      // What the client is told when it asks (the app asks after any uncertainty — F17).
      const [userId, ...rest] = key.split(':');
      const told = await intentOutcome(userId, rest.join(':'));
      const row = idemByClientKey.get(key);
      if (p2p.length) {
        stats.unknownResolvedCompleted += 1;
        if (told.state !== 'completed' && told.state !== 'in_progress') findings.push({ check: 'honest_outcome', id: 'booked_but_not_reported_completed', key, state: told.state });
      } else if (told.state === 'in_progress') {
        // Nothing moved, yet the client is told to wait and not retry, after the reconciliation window.
        stats.stuckInProgress += 1;
        findings.push({ check: 'honest_outcome', id: 'stuck_in_progress_nothing_moved', key, ageMs: row ? Date.now() - row.createdAt.getTime() : null });
      } else if (told.state === 'completed') {
        findings.push({ check: 'honest_outcome', id: 'reported_completed_nothing_booked', key });
      } else stats.unknownResolvedNothing += 1;
    }
  }
  // No phantom transfers: every lab P2P entry between lab users carries a key the lab issued.
  const ids = ctx.actors.map((x) => x.s.id);
  const phantom = await prisma.$queryRawUnsafe(
    `SELECT j.reference FROM "JournalEntry" j
      WHERE j.kind = 'p2p_transfer' AND j."createdAt" >= $2
        AND (j.metadata->>'clientKey' IS NULL OR NOT (j.metadata->>'clientKey' = ANY($1::text[])))
        AND NOT (j.reference = ANY($4::text[]))
        AND EXISTS (SELECT 1 FROM "Posting" p JOIN "LedgerAccount" a ON a.id = p."accountId" WHERE p."entryId" = j.id AND a."ownerId" = ANY($3::text[]))`,
    keys, ctx.startedAt, ids, ctx.knownReferences ?? []); // knownReferences: entries another lab flow created (e.g. paid money requests)
  if (phantom.length) findings.push({ check: 'exactly_once', id: 'phantom_transfer', n: phantom.length, sample: phantom.slice(0, 3) });
  // Undo: at most one reversal per original.
  const undos = await prisma.$queryRawUnsafe(
    `SELECT "reversesId" AS orig, COUNT(*)::int AS n FROM "JournalEntry" WHERE kind = 'p2p_undo' AND "createdAt" >= $1 GROUP BY 1 HAVING COUNT(*) > 1`, ctx.startedAt);
  if (undos.length) findings.push({ check: 'exactly_once', id: 'double_undo', n: undos.length });
  stats.tokenRefreshes = ctx.actors.reduce((n, a) => n + (a.s.refreshes ?? 0), 0);
  stats.tokenRefreshFailures = ctx.actors.reduce((n, a) => n + (a.s.refreshFailures ?? 0), 0);
  if (stats.tokenRefreshFailures) findings.push({ check: 'driver', id: 'token_refresh_failed', n: stats.tokenRefreshFailures });
  return { findings, stats };
}

export const randomSeed = () => crypto.randomInt(1, 2 ** 31);
