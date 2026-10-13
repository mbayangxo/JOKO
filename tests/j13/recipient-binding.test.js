/**
 * J13-F12 (financial identity safety) — the payment recipient is the IMMUTABLE account the sender confirmed.
 *
 *  - lookup returns an opaque server-signed `recipientRef` (never the raw account id)
 *  - handle lookups are exact-handle only; phone lookups are phone only; no silent switch between them
 *  - a handle renamed and reclaimed by someone else between lookup and send → refused (409), no money moves
 *  - a forged / foreign ref → refused, no money moves
 *  - the same idempotency key with a changed recipient → 422, never executed
 *  - step-up, block and authorization rules are unchanged when a ref is supplied
 * Real HTTP (production mode), real OTP sessions, J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, signedIn, stepUp } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const bal = async (id) => {
  const w = await prisma.wallet.findUnique({ where: { userId: id } });
  return w.balance + w.koriBalance;
};
const uniq = (p) => `${p}${crypto.randomBytes(3).toString('hex')}`;

async function sender(kori = 20_000) {
  const a = await customer({ koriBalance: 0 });
  await fundUser(a.id, kori);
  return signedIn(api, a);
}

test('lookup gives an opaque recipientRef — not the account id — and send with it pays exactly that account', async () => {
  const A = await sender();
  const b = await customer();
  const look = await A.call('GET', `users/lookup?q=${b.handle}&mode=handle`);
  assert.equal(look.status, 200);
  assert.match(look.body.recipientRef, /^r1\.[A-Za-z0-9_-]{32}$/);
  assert.ok(!JSON.stringify(look.body).includes(b.id), 'the raw account id is never exposed');
  assert.equal(look.body.id, undefined);
  const before = await bal(b.id);
  const r = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, recipientRef: look.body.recipientRef, amount: 900 }, { headers: { 'idempotency-key': key() } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await bal(b.id), before + 900);
});

test('handle renamed and RECLAIMED by another person between lookup and send → refused, nobody paid', async () => {
  const A = await sender();
  const b = await customer();
  const c = await customer();
  const handle = uniq('awa');
  await prisma.user.update({ where: { id: b.id }, data: { handle } });
  const look = await A.call('GET', `users/lookup?q=${handle}&mode=handle`);
  assert.equal(look.status, 200);
  // B renames; C takes B's old handle.
  await prisma.user.update({ where: { id: b.id }, data: { handle: uniq('awa_new') } });
  await prisma.user.update({ where: { id: c.id }, data: { handle } });
  const [a0, b0, c0] = [await bal(A.id), await bal(b.id), await bal(c.id)];
  const r = await A.call('POST', 'transfers/send', { recipientHandle: handle, recipientRef: look.body.recipientRef, amount: 1500 }, { headers: { 'idempotency-key': key() } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'recipient_changed');
  assert.deepEqual([await bal(A.id), await bal(b.id), await bal(c.id)], [a0, b0, c0], 'no money moved for anyone');
  assert.equal(await prisma.transaction.count({ where: { senderId: A.id } }), 0);
});

test('forged, malformed and foreign refs are refused before any money moves', async () => {
  const A = await sender();
  const b = await customer();
  const other = await customer();
  const foreign = (await A.call('GET', `users/lookup?q=${other.handle}&mode=handle`)).body.recipientRef;
  const a0 = await bal(A.id);
  for (const recipientRef of [foreign, 'r1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'r1.', 'x', b.id]) {
    const r = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, recipientRef, amount: 500 }, { headers: { 'idempotency-key': key() } });
    assert.equal(r.status, 409, `${recipientRef}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'recipient_changed');
  }
  assert.equal(await bal(A.id), a0);
});

test('same idempotency key with a changed recipient or ref → 422, never executed; replay of the original is the original', async () => {
  const A = await sender();
  const b = await customer();
  const c = await customer();
  const refB = (await A.call('GET', `users/lookup?q=${b.handle}&mode=handle`)).body.recipientRef;
  const refC = (await A.call('GET', `users/lookup?q=${c.handle}&mode=handle`)).body.recipientRef;
  const k = key();
  const first = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, recipientRef: refB, amount: 700 }, { headers: { 'idempotency-key': k } });
  assert.equal(first.status, 201);
  const c0 = await bal(c.id);
  const toC = await A.call('POST', 'transfers/send', { recipientHandle: c.handle, recipientRef: refC, amount: 700 }, { headers: { 'idempotency-key': k } });
  assert.equal(toC.status, 422, JSON.stringify(toC.body));
  const refSwap = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, recipientRef: refC, amount: 700 }, { headers: { 'idempotency-key': k } });
  assert.equal(refSwap.status, 422);
  assert.equal(await bal(c.id), c0, 'C never paid');
  const replay = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, recipientRef: refB, amount: 700 }, { headers: { 'idempotency-key': k } });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.reference, first.body.reference, 'a replay is the original payment, not a new one');
  assert.equal(await prisma.transaction.count({ where: { senderId: A.id } }), 1);
});

test('authorization unchanged with a ref: no session → 401; high value still needs PIN; a block still refuses', async () => {
  const A = await sender(100_000);
  const b = await customer();
  const ref = (await A.call('GET', `users/lookup?q=${b.handle}&mode=handle`)).body.recipientRef;
  const anon = await api.client('POST', 'transfers/send', { body: { recipientHandle: b.handle, recipientRef: ref, amount: 500 } });
  assert.equal(anon.status, 401);
  const big = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, recipientRef: ref, amount: 60_000 }, { headers: { 'idempotency-key': key() } });
  assert.equal(big.status, 403);
  assert.equal(big.body.code, 'step_up_required');
  const token = await stepUp(A);
  const ok = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, recipientRef: ref, amount: 60_000 }, { headers: { 'idempotency-key': key(), 'x-step-up-token': token } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  await prisma.userBlock.create({ data: { blockerId: b.id, blockedUserId: A.id } });
  const blocked = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, recipientRef: ref, amount: 500 }, { headers: { 'idempotency-key': key() } });
  assert.equal(blocked.status, 403);
});

test('no silent switch: handle mode never finds a phone owner; phone mode never finds a handle owner', async () => {
  const A = await sender();
  const phoneOwner = await customer();
  const local = phoneOwner.phone.replace(/^\+221/, '');
  // handle mode with the digits of someone's phone: exact handle match only → nobody holds that handle.
  const asHandle = await A.call('GET', `users/lookup?q=${local}&mode=handle`);
  assert.equal(asHandle.status, 404, JSON.stringify(asHandle.body));
  // phone mode with a handle: a phone search only → never resolves the handle owner.
  const h = await customer();
  const asPhone = await A.call('GET', `users/lookup?q=${h.handle}&mode=phone`);
  assert.ok([400, 404, 429].includes(asPhone.status), `${asPhone.status}`);
  assert.notEqual(asPhone.body?.handle?.replace(/^@/, ''), h.handle);
  // explicit "@" is a handle even when it is all digits.
  const digitsHandle = await customer();
  const dh = `${Date.now()}`.slice(-9);
  await prisma.user.update({ where: { id: digitsHandle.id }, data: { handle: dh } });
  const at = await A.call('GET', `users/lookup?q=${encodeURIComponent(`@${dh}`)}`);
  assert.equal(at.status, 200);
  assert.equal(at.body.handle?.replace(/^@/, ''), dh);
});
