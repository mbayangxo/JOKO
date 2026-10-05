/**
 * J4 — "did I pay twice?" server side: the idempotency row is the source of
 * truth for a client intent. A 5xx or crash AFTER money committed must never
 * release the key (a retry would pay again); a failure before any money moved
 * must release it (a retry is safe). In-process, real Postgres.
 */
import '../helpers/setup.js';
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createUserWithWallet, fundUser, prisma } from '../helpers/db.js';
import { entriesForClientKey, intentOutcome, withIdempotency } from '../../lib/api-idempotency.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';

after(async () => { await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}
const req = (k, body = { amount: 10 }) => ({ headers: { 'idempotency-key': k }, body });

test('5xx after the ledger committed: key is kept, retry replays "completed" and never moves money again', async () => {
  const u = await createUserWithWallet({ koriBalance: 0 });
  const k = key();
  let runs = 0;
  const run = (res) => async () => {
    runs += 1;
    await fundUser(u.id, 10); // commits a kernel entry carrying this request's clientKey
    res.status(500).json({ error: 'response lost after commit' });
  };
  const r1 = fakeRes();
  await withIdempotency(req(k), r1, { userId: u.id, routeKey: 'test.pay' }, run(r1));
  assert.equal(r1.statusCode, 500);
  const moved = await entriesForClientKey(`${u.id}:${k}`);
  assert.equal(moved.length, 1, 'the entry is tagged with the client key');

  const r2 = fakeRes();
  await withIdempotency(req(k), r2, { userId: u.id, routeKey: 'test.pay' }, run(r2));
  assert.equal(runs, 1, 'a retry with the same key never executes again');
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.status, 'completed');
  assert.equal(r2.body.code, 'completed_response_lost');
  assert.deepEqual(r2.body.references, [moved[0].reference]);
  assert.equal(r2.headers['Idempotent-Replay'], 'true');

  const outcome = await intentOutcome(u.id, k);
  assert.equal(outcome.state, 'completed');
  assert.equal((await prisma.wallet.findUnique({ where: { userId: u.id } })).koriBalance, 10, 'credited once');
});

test('crash after commit (thrown error) is treated the same as a 5xx', async () => {
  const u = await createUserWithWallet({ koriBalance: 0 });
  const k = key();
  const r1 = fakeRes();
  await assert.rejects(
    withIdempotency(req(k), r1, { userId: u.id, routeKey: 'test.pay' }, async () => {
      await fundUser(u.id, 7);
      throw new Error('process died mid-response');
    }),
  );
  assert.equal((await intentOutcome(u.id, k)).state, 'completed');
  const r2 = fakeRes();
  let ran = false;
  await withIdempotency(req(k), r2, { userId: u.id, routeKey: 'test.pay' }, async () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(r2.body.code, 'completed_response_lost');
});

test('5xx before any money moved: key released, intent "not_found", same-key retry executes once', async () => {
  const u = await createUserWithWallet({ koriBalance: 0 });
  const k = key();
  const r1 = fakeRes();
  await withIdempotency(req(k), r1, { userId: u.id, routeKey: 'test.pay' }, async () => { r1.status(503).json({ error: 'provider down' }); });
  assert.equal((await intentOutcome(u.id, k)).state, 'not_found');
  const r2 = fakeRes();
  await withIdempotency(req(k), r2, { userId: u.id, routeKey: 'test.pay' }, async () => {
    await fundUser(u.id, 5);
    r2.status(201).json({ status: 'completed', reference: 'x' });
  });
  assert.equal(r2.statusCode, 201);
  assert.equal((await intentOutcome(u.id, k)).state, 'completed');
});

test('intent states: refused (4xx), accepted_pending (202), in_progress, invalid; other users cannot read my intent', async () => {
  const u = await createUserWithWallet({ koriBalance: 0 });
  const other = await createUserWithWallet({ koriBalance: 0 });
  const refused = key();
  const r = fakeRes();
  await withIdempotency(req(refused), r, { userId: u.id, routeKey: 'test.pay' }, async () => { r.status(400).json({ code: 'insufficient_funds' }); });
  assert.equal((await intentOutcome(u.id, refused)).state, 'refused');

  const pending = key();
  const p = fakeRes();
  await withIdempotency(req(pending), p, { userId: u.id, routeKey: 'test.pay' }, async () => { p.status(202).json({ rail: { status: 'pending' } }); });
  assert.equal((await intentOutcome(u.id, pending)).state, 'accepted_pending');

  const inflight = key();
  await prisma.apiIdempotency.create({ data: { key: `api:${u.id}:test.pay:${inflight}`, provider: 'api', userId: u.id, operation: 'test.pay', reference: 'fp', status: 'in_progress' } });
  assert.equal((await intentOutcome(u.id, inflight)).state, 'in_progress');
  const dup = fakeRes();
  let ran = false;
  await withIdempotency(req(inflight), dup, { userId: u.id, routeKey: 'test.pay' }, async () => { ran = true; });
  // Different fingerprint → 422; same fingerprint while running → 409. Neither executes.
  assert.equal(ran, false);
  assert.ok([409, 422].includes(dup.statusCode));

  assert.equal((await intentOutcome(u.id, 'bad key!')).state, 'invalid');
  assert.equal((await intentOutcome(other.id, refused)).state, 'not_found', 'intents are per user');
});
