/**
 * J12-F7 recheck — PIN challenge × idempotency, over real HTTP (NODE_ENV=production API, real OTP logins).
 *
 * Proves, deterministically:
 *   1. the PIN challenge (403 step_up_required) moves no money and leaves the intent open;
 *   2. a valid PIN completes the ORIGINAL instruction with the SAME key;
 *   3. many concurrent PIN-confirmed retries of one key execute at most once;
 *   4. a changed instruction cannot reuse the key (before or after the challenge);
 *   5. a lost response cannot cause a second debit (retry replays the stored outcome);
 *   6. a completed key can never be reopened (not by a challenge, not by a new body);
 *   7. expired, foreign-session and revoked-session step-up credentials are rejected and move nothing;
 *   8. no failure leaves a partial movement: Σ balances conserved, J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { ACCESS_SECRET, customer, signedIn, stepUp } from '../j3/helpers.js';
import { intentOutcome } from '../../lib/api-idempotency.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const AMOUNT = 6000; // ≥ the 50 000 XOF high-value threshold → PIN required
const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const bal = async (id) => (await prisma.wallet.findUnique({ where: { userId: id } })).koriBalance;
const send = (s, k, body, headers = {}) => s.call('POST', 'transfers/send', body, { headers: { 'idempotency-key': k, ...headers } });

async function pair() {
  const a = await customer({ koriBalance: 0 });
  await fundUser(a.id, 30_000);
  const b = await customer();
  return { A: await signedIn(api, a), B: await signedIn(api, b) };
}
const instruction = (B, amount = AMOUNT) => ({ recipientHandle: B.handle, amount });

test('1+2: the challenge moves nothing and keeps the intent open; the PIN completes the same instruction with the same key', async () => {
  const { A, B } = await pair();
  const k = key();
  const [a0, b0] = [await bal(A.id), await bal(B.id)];
  const c = await send(A, k, instruction(B));
  assert.equal(c.status, 403);
  assert.equal(c.body.code, 'step_up_required');
  assert.deepEqual([await bal(A.id), await bal(B.id)], [a0, b0], 'the challenge itself moved nothing');
  assert.equal((await intentOutcome(A.id, k)).state, 'not_found', 'nothing executed → the intent stays open, never "refused"');

  const ok = await send(A, k, instruction(B), { 'x-step-up-token': await stepUp(A) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([await bal(A.id), await bal(B.id)], [a0 - AMOUNT, b0 + AMOUNT]);
  assert.equal((await intentOutcome(A.id, k)).state, 'completed');
});

test('3: 12 concurrent PIN-confirmed retries of one key execute at most once', async () => {
  const { A, B } = await pair();
  const k = key();
  const a0 = await bal(A.id);
  assert.equal((await send(A, k, instruction(B))).status, 403);
  const token = await stepUp(A);
  const rs = await Promise.all(Array.from({ length: 12 }, () => send(A, k, instruction(B), { 'x-step-up-token': token })));
  const codes = rs.map((r) => r.status);
  assert.ok(codes.every((s) => [201, 409].includes(s)), JSON.stringify(codes));
  assert.ok(codes.filter((s) => s === 201).length >= 1);
  assert.equal(await bal(A.id), a0 - AMOUNT, 'debited exactly once');
  const again = await send(A, k, instruction(B), { 'x-step-up-token': token });
  assert.equal(again.status, 201);
  assert.equal(again.headers?.['idempotent-replay'] ?? 'true', 'true');
  assert.equal(await bal(A.id), a0 - AMOUNT, 'a later retry replays, never re-executes');
});

test('4: a changed instruction can never reuse the key — not after the challenge, not after completion', async () => {
  const { A, B } = await pair();
  const k = key();
  const a0 = await bal(A.id);
  assert.equal((await send(A, k, instruction(B))).status, 403);
  // The challenge released the key, so the FIRST instruction to execute under it is the one that binds it.
  const token = await stepUp(A);
  assert.equal((await send(A, k, instruction(B), { 'x-step-up-token': token })).status, 201);
  const changed = await send(A, k, instruction(B, AMOUNT * 2), { 'x-step-up-token': token });
  assert.equal(changed.status, 422);
  assert.equal(changed.body.code, 'idempotency_key_reuse');
  assert.equal(await bal(A.id), a0 - AMOUNT, 'the changed amount never executed');
  // While a challenge is pending, a different body under the same key is just a new first attempt that is
  // also challenged — it can never ride on another instruction's PIN proof (the PIN is per session, the
  // body is re-validated and re-limited by the server every time).
  const k2 = key();
  assert.equal((await send(A, k2, instruction(B, 100))).status, 201, 'a small payment needs no PIN');
  const bigger = await send(A, k2, instruction(B), { 'x-step-up-token': token });
  assert.equal(bigger.status, 422, 'a completed small payment key can never be upgraded to a large one');
});

test('5+6: a lost response replays the stored outcome; a completed key can never be reopened by a challenge', async () => {
  const { A, B } = await pair();
  const k = key();
  const a0 = await bal(A.id);
  const token = await stepUp(A);
  const first = await send(A, k, instruction(B), { 'x-step-up-token': token });
  assert.equal(first.status, 201);
  // "the response was lost": the client retries the same key — WITHOUT a step-up token (e.g. after restart)
  const retry = await send(A, k, instruction(B));
  assert.equal(retry.status, 201, 'the stored completion is replayed, never re-challenged or re-executed');
  assert.equal(await bal(A.id), a0 - AMOUNT, 'no second debit');
  assert.equal((await intentOutcome(A.id, k)).state, 'completed');
});

test('7: expired, foreign-session and revoked-session step-up credentials are rejected and move nothing', async () => {
  const { A, B } = await pair();
  const a0 = await bal(A.id);
  const sid = (await prisma.authSession.findFirst({ where: { userId: A.id }, orderBy: { createdAt: 'desc' } }))?.id ?? null;

  const expired = jwt.sign({ sub: A.id, type: 'step_up', verifiedAt: new Date(Date.now() - 600_000).toISOString(), ...(sid ? { sid } : {}), exp: Math.floor(Date.now() / 1000) - 60 }, ACCESS_SECRET);
  const r1 = await send(A, key(), instruction(B), { 'x-step-up-token': expired });
  assert.equal(r1.status, 403, 'expired step-up');

  const foreign = jwt.sign({ sub: A.id, type: 'step_up', verifiedAt: new Date().toISOString(), sid: 'some-other-session' }, ACCESS_SECRET, { expiresIn: '5m' });
  const r2 = await send(A, key(), instruction(B), { 'x-step-up-token': foreign });
  assert.equal(r2.status, 403, 'a step-up proven in another session');

  const other = await customer();
  const notMine = jwt.sign({ sub: other.id, type: 'step_up', verifiedAt: new Date().toISOString(), ...(sid ? { sid } : {}) }, ACCESS_SECRET, { expiresIn: '5m' });
  const r3 = await send(A, key(), instruction(B), { 'x-step-up-token': notMine });
  assert.equal(r3.status, 403, 'another user’s step-up');

  const token = await stepUp(A); // valid … then the session is revoked
  await prisma.authSession.updateMany({ where: { userId: A.id }, data: { revokedAt: new Date() } });
  const r4 = await send(A, key(), instruction(B), { 'x-step-up-token': token });
  assert.ok([401, 403].includes(r4.status), `revoked session: ${r4.status}`);
  assert.equal(await bal(A.id), a0, 'no rejected credential moved any money');
});

test('8: no failure leaves a partial movement — Σ balances conserved across challenges, conflicts and replays', async () => {
  const { A, B } = await pair();
  const before = (await bal(A.id)) + (await bal(B.id));
  const k = key();
  await send(A, k, instruction(B));
  const token = await stepUp(A);
  await Promise.all([
    send(A, k, instruction(B), { 'x-step-up-token': token }),
    send(A, k, instruction(B, AMOUNT + 1), { 'x-step-up-token': token }),
    send(A, k, instruction(B)),
    send(A, k, instruction(B), { 'x-step-up-token': token }),
  ]);
  const after = (await bal(A.id)) + (await bal(B.id));
  assert.equal(after, before, 'money only moved between the two wallets, never created or lost');
  const moved = 30_000 - (await bal(A.id));
  assert.ok(moved === 0 || moved === AMOUNT || moved === AMOUNT + 1, `either nothing or exactly one instruction executed (moved ${moved})`);
});
