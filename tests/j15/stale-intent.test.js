/**
 * J15-L5 — found by the torture lab (scripts/lab, crash mix seed 2002: 22 keys stuck). A request killed
 * mid-flight left its idempotency key `in_progress` forever: the client was told "in progress, do not retry",
 * a retry got 409 and a void could not close it, although nothing had moved. After the lease (default 5 min,
 * far beyond the 30 s function limit) the key converges like a 5xx: money moved → completed (response lost);
 * nothing moved → released. A key younger than the lease is NEVER touched (the original may still commit).
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { staleLeaseMs, sweepStaleIntents } from '../../lib/api-idempotency.js';
import { customer, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

const key = () => `lab-${crypto.randomBytes(6).toString('hex')}`;
const avail = async (s) => (await s.call('GET', 'money/home')).body.balance.availableKori;
const rowKey = (s, k) => `api:${s.id}:POST transfers/send:${k}`;
const fp = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

async function pair() {
  const a = await customer({ koriBalance: 0 });
  await fundUser(a.id, 5000);
  return { A: await signedIn(api, a), B: await signedIn(api, await customer()) };
}

/** The row a killed request leaves behind: created, never finalized. */
async function orphan(s, k, body, ageMs) {
  await prisma.apiIdempotency.create({
    data: { key: rowKey(s, k), provider: 'api', userId: s.id, operation: 'POST transfers/send', reference: fp(body), status: 'in_progress', createdAt: new Date(Date.now() - ageMs) },
  });
}

test('abandoned key, nothing moved, past the lease: the client is told "not found" and the retry executes once', async () => {
  const { A, B } = await pair();
  const k = key();
  const body = { recipientHandle: B.handle, amount: 700 };
  await orphan(A, k, body, 6 * 60_000);
  const told = await A.call('GET', `money/intents/${k}`);
  assert.equal(told.body.state, 'not_found', JSON.stringify(told.body));
  const r = await A.call('POST', 'transfers/send', body, { headers: { 'idempotency-key': k } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const again = await A.call('POST', 'transfers/send', body, { headers: { 'idempotency-key': k } });
  assert.equal(again.headers['idempotent-replay'], 'true');
  const earned = (await prisma.koriTransaction.aggregate({ where: { recipientId: A.id, transactionType: 'earn' }, _sum: { amountKori: true } }))._sum.amountKori ?? 0;
  assert.equal((await avail(A)) - earned, 4300, 'debited exactly once (net of any funded send reward)');
  await assertInvariants(prisma);
});

test('abandoned key whose money DID move (response lost): converges to completed, a retry never pays again', async () => {
  const { A, B } = await pair();
  const k = key();
  const body = { recipientHandle: B.handle, amount: 900 };
  const first = await A.call('POST', 'transfers/send', body, { headers: { 'idempotency-key': k } });
  assert.equal(first.status, 201);
  // Simulate the crash after COMMIT: the row never got its stored response.
  await prisma.apiIdempotency.update({ where: { key: rowKey(A, k) }, data: { status: 'in_progress', responseJson: null, createdAt: new Date(Date.now() - 6 * 60_000) } });
  const before = await avail(A);
  const retry = await A.call('POST', 'transfers/send', body, { headers: { 'idempotency-key': k } });
  assert.ok(retry.status < 300, JSON.stringify(retry.body));
  assert.equal(retry.body.code, 'completed_response_lost');
  assert.equal(await avail(A), before, 'the retry moved nothing');
  assert.equal((await A.call('GET', `money/intents/${k}`)).body.state, 'completed');
  assert.equal(await prisma.journalEntry.count({ where: { kind: 'p2p_transfer', metadata: { path: ['clientKey'], equals: `${A.id}:${k}` } } }), 1);
  await assertInvariants(prisma);
});

test('a key younger than the lease is never released: still "in progress", the retry gets 409 (the original may still commit)', async () => {
  const { A, B } = await pair();
  const k = key();
  const body = { recipientHandle: B.handle, amount: 500 };
  await orphan(A, k, body, 60_000);
  assert.equal((await A.call('GET', `money/intents/${k}`)).body.state, 'in_progress');
  const r = await A.call('POST', 'transfers/send', body, { headers: { 'idempotency-key': k } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'idempotency_in_progress');
  assert.equal(await avail(A), 5000);
  assert.ok(await prisma.apiIdempotency.findUnique({ where: { key: rowKey(A, k) } }), 'row untouched');
});

test('void on an abandoned key closes it for good; the cron sweep converges keys nobody asks about', async () => {
  const { A, B } = await pair();
  const k1 = key();
  await orphan(A, k1, { recipientHandle: B.handle, amount: 100 }, 6 * 60_000);
  const v = await A.call('POST', `money/intents/${k1}/void`, {});
  assert.equal(v.body.state, 'voided', JSON.stringify(v.body));
  const late = await A.call('POST', 'transfers/send', { recipientHandle: B.handle, amount: 100 }, { headers: { 'idempotency-key': k1 } });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'intent_voided');

  const k2 = key();
  await orphan(A, k2, { recipientHandle: B.handle, amount: 200 }, 6 * 60_000);
  const swept = await sweepStaleIntents(prisma);
  assert.ok(swept.released >= 1, JSON.stringify(swept));
  assert.equal(await prisma.apiIdempotency.findUnique({ where: { key: rowKey(A, k2) } }), null);
  assert.equal(await avail(A), 5000, 'nothing moved anywhere');
});

test('outside the lab the lease can never be configured below 2 minutes', () => {
  const prev = process.env.IDEMPOTENCY_STALE_LEASE_MS;
  try {
    process.env.IDEMPOTENCY_STALE_LEASE_MS = '1000';
    assert.equal(staleLeaseMs(), 120_000);
    delete process.env.IDEMPOTENCY_STALE_LEASE_MS;
    assert.equal(staleLeaseMs(), 300_000);
  } finally {
    if (prev === undefined) delete process.env.IDEMPOTENCY_STALE_LEASE_MS;
    else process.env.IDEMPOTENCY_STALE_LEASE_MS = prev;
  }
});
