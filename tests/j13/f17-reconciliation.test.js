/**
 * J13-F17 — server side of uncertain-payment reconciliation (real HTTP, production mode, real OTP sessions,
 * J2 invariants after every test). Exactly-once money movement and no cross-account leakage throughout.
 *
 *   - "not_found" is provisional: a delayed original can still settle, and the lookup then says so
 *   - closing (void) makes "not received" FINAL: a delayed original is refused afterwards, nothing moves
 *   - a key that ran is never closed (lost reply, risk-review hold, confirmed refusal keep their answer)
 *   - the close and a racing original never both proceed (20 concurrent races)
 *   - closing is per account: another user's identical key is never affected
 *   - history and balance always come from the server ledger
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const lookup = (S, k) => S.call('GET', `money/intents/${k}`);
const close = (S, k) => S.call('POST', `money/intents/${k}/void`, {});
const send = (S, to, amount, k) => S.call('POST', 'transfers/send', { recipientHandle: to, amount }, { headers: { 'idempotency-key': k } });
const avail = async (S) => (await S.call('GET', 'money/home')).body.balance.availableKori;
const sentCount = (id) => prisma.koriTransaction.count({ where: { senderId: id } });

async function pair(kori = 20_000) {
  const a = await customer({ koriBalance: 0 });
  await fundUser(a.id, kori);
  const b = await customer();
  return { A: await signedIn(api, a), B: await signedIn(api, b), b };
}

test('not_found is PROVISIONAL: wording never claims an outcome, and a delayed original still settles and shows', async () => {
  const { A, B, b } = await pair();
  const k = key();
  const early = await lookup(A, k);
  assert.equal(early.body.state, 'not_found');
  assert.equal(early.body.safeToRetry, false, 'never "safe to retry" while the original may still arrive');
  assert.ok(!/aucun argent|réessa/i.test(early.body.message), early.body.message);
  const late = await send(A, b.handle, 1200, k); // the delayed original arrives
  assert.equal(late.status, 201, JSON.stringify(late.body));
  const now = await lookup(A, k);
  assert.equal(now.body.state, 'completed');
  const item = (await A.call('GET', 'money/activity')).body.items.find((i) => i.reference === late.body.reference || now.body.references.includes(i.reference));
  assert.ok(item, 'history shows the settled payment');
  assert.equal(item.status, 'completed');
  assert.equal(await avail(B), 1200);
  assert.equal(await avail(A), 20_000 - 1200, 'debited exactly once');
});

test('closing an attempt that never arrived makes "not received" FINAL: the delayed original is refused, nothing moves', async () => {
  const { A, B, b } = await pair();
  const k = key();
  const v = await close(A, k);
  assert.equal(v.status, 200);
  assert.equal(v.body.state, 'voided');
  const late = await send(A, b.handle, 1500, k);
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.equal(late.body.code, 'intent_voided');
  assert.equal((await lookup(A, k)).body.state, 'voided');
  assert.match((await lookup(A, k)).body.message, /pas été reçu.*aucun argent/);
  assert.equal(await avail(A), 20_000);
  assert.equal(await avail(B), 0);
  assert.equal(await sentCount(A.id), 0);
  assert.equal((await close(A, k)).body.state, 'voided', 'closing twice is harmless');
});

test('lost reply: the original RAN → the close never cancels it; lookup, history and balance agree; replay = original', async () => {
  const { A, B, b } = await pair();
  const k = key();
  const ran = await send(A, b.handle, 900, k); // its reply "lost" (we ignore it)
  assert.equal(ran.status, 201);
  const v = await close(A, k);
  assert.equal(v.body.state, 'completed', 'a key that ran is never closed');
  assert.equal((await lookup(A, k)).body.state, 'completed');
  const replay = await send(A, b.handle, 900, k);
  assert.equal(replay.body.reference, ran.body.reference);
  assert.equal(await sentCount(A.id), 1);
  assert.equal(await avail(B), 900);
});

test('confirmed failure: a refused attempt keeps "refused" (no money), and the close does not rewrite it', async () => {
  const { A, b } = await pair(100);
  const k = key();
  const r = await send(A, b.handle, 1000, k); // insufficient funds, below the PIN threshold (so it is a real refusal)
  assert.ok(r.status >= 400 && r.status < 500 && r.body?.code !== 'step_up_required', `${r.status} ${JSON.stringify(r.body)}`);
  assert.equal((await close(A, k)).body.state, 'refused');
  assert.equal((await lookup(A, k)).body.state, 'refused');
  assert.equal(await avail(A), 100);
});

test('risk-review hold (202 stored) → "accepted_pending" (under review); the close never cancels a held operation', async () => {
  const { A } = await pair();
  const k = key();
  await prisma.apiIdempotency.create({
    data: { key: `api:${A.id}:POST transfers/send:${k}`, provider: 'api', userId: A.id, operation: 'POST transfers/send', reference: 'fp', status: 'done', responseJson: JSON.stringify({ status: 202, body: { status: 'pending_review', held: true } }) },
  });
  assert.equal((await close(A, k)).body.state, 'accepted_pending');
  assert.equal((await lookup(A, k)).body.state, 'accepted_pending');
  assert.equal(await prisma.apiIdempotency.count({ where: { key: `api:${A.id}:VOID:${k}` } }), 0, 'no closure recorded');
});

test('race: 20 × (original ‖ close) — never both; money moves exactly once per executed original', async () => {
  const { A, B, b } = await pair(100_000);
  let executed = 0;
  for (let i = 0; i < 20; i += 1) {
    const k = key();
    const [s, v] = await Promise.all([send(A, b.handle, 100, k), close(A, k)]);
    const final = (await lookup(A, k)).body.state;
    if (s.status === 201) {
      executed += 1;
      assert.notEqual(v.body.state, 'voided', `iteration ${i}: executed AND voided`);
      assert.equal(final, 'completed');
    } else {
      assert.equal(s.status, 409, `iteration ${i}: ${s.status} ${JSON.stringify(s.body)}`);
      assert.ok(['voided', 'not_found'].includes(final), `iteration ${i}: final ${final}`);
    }
  }
  assert.equal(await sentCount(A.id), executed);
  assert.equal(await avail(B), executed * 100);
  assert.equal(await avail(A), 100_000 - executed * 100);
});

test('per account: closing my key never affects another user\'s identical key (no cross-account effect or leak)', async () => {
  const { A, b } = await pair();
  const { A: M } = await pair(); // an unrelated account
  const k = key();
  const v = await close(M, k); // M "closes" the same raw key — only in M's own namespace
  assert.equal(v.body.state, 'voided');
  const mine = await send(A, b.handle, 700, k);
  assert.equal(mine.status, 201, 'A\'s payment is unaffected by M\'s closure');
  assert.equal((await lookup(A, k)).body.state, 'completed');
  assert.equal((await lookup(M, k)).body.state, 'voided', 'M sees only its own namespace');
  assert.deepEqual((await lookup(M, k)).body.references, [], 'nothing of A leaks to M');
  const kA = key();
  await send(A, b.handle, 300, kA);
  const probe = await close(M, kA);
  assert.equal(probe.body.state, 'voided', 'same answer whether or not the key exists elsewhere (no existence oracle)');
  assert.equal((await lookup(A, kA)).body.state, 'completed');
});

test('invalid keys are refused; an unauthenticated close is refused', async () => {
  const { A } = await pair();
  assert.equal((await close(A, 'x')).status, 400);
  const anon = await api.client('POST', `money/intents/${key()}/void`, { body: {} });
  assert.equal(anon.status, 401);
});
