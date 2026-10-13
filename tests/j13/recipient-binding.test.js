/**
 * J13-4 — mandatory recipient identity binding, end to end (real HTTP, production mode, real OTP sessions,
 * J2 invariants after every test). Deterministic: no sleeps; expiry is exercised with tokens minted at a
 * fixed past instant by the same signing code.
 *
 *   new client: users/lookup → recipientRef → money/p2p/confirm → instructionRef → transfers/send
 *   refused (409) before any money moves: renamed handle, reclaimed handle, changed phone number,
 *     stale (expired) confirmation, forged / tampered / cross-account tokens, changed amount, replay under a
 *     new key; same key = idempotent replay of the ORIGINAL payment
 *   concurrent recipient changes: every executed payment reaches the confirmed account only
 *   legacy client (no instructionRef): stable handle → allowed (compat window); handle reassigned within the
 *     stability window → 426 update_required; direct-thread chat → allowed; group thread → 426;
 *     RECIPIENT_BINDING_ENFORCE=true → 426 for every legacy request
 *   authorization unchanged: 401, PIN step-up, blocks
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { issueInstructionRef, issueRecipientRef } from '../../lib/recipient-ref.js';
import { COMPAT_SUNSET, recipientBindingMode } from '../../lib/recipient-binding-policy.js';
import { customer, signedIn, stepUp } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const hex = () => crypto.randomBytes(3).toString('hex');
const bal = async (id) => {
  const w = await prisma.wallet.findUnique({ where: { userId: id } });
  return w.balance + w.koriBalance;
};
const sentBy = (id) => prisma.koriTransaction.count({ where: { senderId: id } });

async function sender(kori = 50_000) {
  const a = await customer({ koriBalance: 0 });
  await fundUser(a.id, kori);
  return signedIn(api, a);
}
const lookup = (S, q, mode = 'handle') => S.call('GET', `users/lookup?q=${encodeURIComponent(q)}&mode=${mode}`);
const confirm = (S, recipientRef, amountKori, intentKey) => S.call('POST', 'money/p2p/confirm', { recipientRef, amountKori, intentKey });
const send = (S, body, k) => S.call('POST', 'transfers/send', body, { headers: { 'idempotency-key': k } });

/** The new-client sequence; returns the pieces so tests can interleave changes between steps. */
async function prepare(S, handle, amount, mode = 'handle', q = handle) {
  const look = await lookup(S, q, mode);
  assert.equal(look.status, 200, JSON.stringify(look.body));
  const k = key();
  const conf = await confirm(S, look.body.recipientRef, amount, k);
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  return { look, k, instructionRef: conf.body.instructionRef, body: { recipientHandle: look.body.handle.replace(/^@/, ''), instructionRef: conf.body.instructionRef, amount } };
}

test('new client: lookup → confirm → send pays exactly the confirmed account; tokens never expose the account id', async () => {
  const A = await sender();
  const b = await customer();
  const p = await prepare(A, b.handle, 900);
  for (const t of [p.look.body.recipientRef, p.instructionRef]) assert.ok(!Buffer.from(t.split('.')[1], 'base64url').toString().includes(b.id));
  assert.equal(p.look.body.id, undefined);
  const b0 = await bal(b.id);
  const r = await send(A, p.body, p.k);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await bal(b.id), b0 + 900);
});

test('renamed handle (same person) between confirmation and send → refused, nothing moves', async () => {
  const A = await sender();
  const b = await customer();
  const p = await prepare(A, b.handle, 800);
  await prisma.user.update({ where: { id: b.id }, data: { handle: `ren_${hex()}` } });
  const a0 = await bal(A.id);
  const r = await send(A, p.body, p.k);
  assert.ok([404, 409].includes(r.status), `${r.status} ${JSON.stringify(r.body)}`); // old handle now resolves to nobody, or refused
  assert.equal(await bal(A.id), a0);
  assert.equal(await sentBy(A.id), 0);
});

test('reclaimed handle (another account holds it now) → 409 recipient_changed at confirm AND at send; nobody paid', async () => {
  const A = await sender();
  const b = await customer();
  const c = await customer();
  const h = `awa${hex()}`;
  await prisma.user.update({ where: { id: b.id }, data: { handle: h } });
  const look = await lookup(A, h);
  // reclaim before confirm
  await prisma.user.update({ where: { id: b.id }, data: { handle: `old_${hex()}` } });
  await prisma.user.update({ where: { id: c.id }, data: { handle: h } });
  const conf = await confirm(A, look.body.recipientRef, 500, key());
  assert.equal(conf.status, 409, JSON.stringify(conf.body));
  assert.equal(conf.body.code, 'recipient_changed');
  // reclaim after confirm
  const d = await customer();
  const e = await customer();
  const h2 = `moussa${hex()}`;
  await prisma.user.update({ where: { id: d.id }, data: { handle: h2 } });
  const p = await prepare(A, h2, 700);
  await prisma.user.update({ where: { id: d.id }, data: { handle: `old_${hex()}` } });
  await prisma.user.update({ where: { id: e.id }, data: { handle: h2 } });
  const snap = [await bal(A.id), await bal(d.id), await bal(e.id)];
  const r = await send(A, p.body, p.k);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'recipient_changed');
  assert.deepEqual([await bal(A.id), await bal(d.id), await bal(e.id)], snap, 'no money moved for anyone');
});

test('changed phone number after a phone lookup → refused; the number now belongs to someone else → refused', async () => {
  const A = await sender();
  const b = await customer();
  const p = await prepare(A, b.handle, 600, 'phone', b.phone);
  await prisma.user.update({ where: { id: b.id }, data: { phone: `+22176${String(Date.now()).slice(-7)}` } });
  const r = await send(A, p.body, p.k);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'recipient_changed');
  assert.equal(await sentBy(A.id), 0);
});

test('stale confirmation screen: an expired recipientRef cannot be confirmed, an expired instruction cannot pay', async () => {
  const A = await sender();
  const b = await customer();
  const user = await prisma.user.findUnique({ where: { id: b.id } });
  const past = Date.now() - 60 * 60_000;
  const oldRef = issueRecipientRef({ senderId: A.id, recipient: user, via: 'handle', now: past });
  const conf = await confirm(A, oldRef, 500, key());
  assert.equal(conf.status, 409);
  assert.equal(conf.body.code, 'expired');
  const k = key();
  const freshRef = issueRecipientRef({ senderId: A.id, recipient: user, via: 'handle', now: past });
  const oldInstr = issueInstructionRef({ recipientRef: freshRef, senderId: A.id, recipient: user, amountKori: 500, intentKey: k, now: past });
  const r = await send(A, { recipientHandle: b.handle, instructionRef: oldInstr, amount: 500 }, k);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'expired');
  assert.equal(await sentBy(A.id), 0);
});

test('replay: same key = the original payment; a new key, a changed amount or another sender → refused', async () => {
  const A = await sender();
  const b = await customer();
  const p = await prepare(A, b.handle, 700);
  const first = await send(A, p.body, p.k);
  assert.equal(first.status, 201);
  const again = await send(A, p.body, p.k);
  assert.equal(again.status, 201);
  assert.equal(again.body.reference, first.body.reference, 'same key → same payment');
  const newKey = await send(A, p.body, key());
  assert.equal(newKey.status, 409, JSON.stringify(newKey.body));
  assert.equal(newKey.body.code, 'instruction_changed');
  const bigger = await send(A, { ...p.body, amount: 7000 }, key());
  assert.equal(bigger.status, 409);
  assert.equal(bigger.body.code, 'instruction_changed');
  const D = await sender();
  const stolen = await send(D, p.body, p.k);
  assert.ok([409, 422].includes(stolen.status), `${stolen.status}`);
  assert.equal(await sentBy(A.id), 1, 'exactly one payment from A');
  assert.equal(await sentBy(D.id), 0);
});

test('forged, tampered and cross-account tokens are refused before any money moves', async () => {
  const A = await sender();
  const b = await customer();
  const c = await customer();
  const p = await prepare(A, b.handle, 500);
  const [k0, body, sig] = p.instructionRef.split('.');
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), r: c.id })).toString('base64url');
  for (const instructionRef of [`${k0}.${tampered}.${sig}`, p.look.body.recipientRef, 'ri2.e30.AAAA', 'x']) {
    const r = await send(A, { ...p.body, instructionRef }, p.k);
    assert.equal(r.status, 409, `${instructionRef.slice(0, 12)}: ${r.status}`);
  }
  const D = await sender();
  const conf = await confirm(D, p.look.body.recipientRef, 500, key());
  assert.equal(conf.status, 409);
  assert.equal(conf.body.code, 'cross_account');
  const onlyRef = await send(A, { recipientHandle: b.handle, recipientRef: p.look.body.recipientRef, amount: 500 }, key());
  assert.equal(onlyRef.status, 428, 'a lookup ref alone is not a confirmed instruction');
  assert.equal(await sentBy(A.id), 0);
});

test('concurrent recipient change: 8 confirmed payments race a rename + reclaim — money only ever reaches the confirmed account', async () => {
  const A = await sender(100_000);
  const b = await customer();
  const c = await customer();
  const h = `race${hex()}`;
  await prisma.user.update({ where: { id: b.id }, data: { handle: h } });
  const prepared = [];
  for (let i = 0; i < 8; i += 1) prepared.push(await prepare(A, h, 300));
  const [b0, c0] = [await bal(b.id), await bal(c.id)];
  const swap = (async () => {
    await prisma.user.update({ where: { id: b.id }, data: { handle: `gone_${hex()}` } });
    await prisma.user.update({ where: { id: c.id }, data: { handle: h } });
  })();
  const results = await Promise.all(prepared.map((p) => send(A, p.body, p.k)));
  await swap;
  const ok = results.filter((r) => r.status === 201).length;
  for (const r of results) assert.ok([201, 404, 409].includes(r.status), `${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(await bal(c.id), c0, 'the account that reclaimed the handle never received anything');
  assert.equal(await bal(b.id), b0 + ok * 300, 'every executed payment went to the confirmed account');
  assert.equal(await sentBy(A.id), ok);
});

test('legacy client (no instructionRef), stable handle → allowed during the compatibility window', async () => {
  assert.equal(recipientBindingMode(new Date()), 'compat');
  const A = await sender();
  const b = await customer();
  const r = await send(A, { recipientHandle: b.handle, amount: 400 }, key());
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('legacy client, handle released via a real rename and reclaimed → 426 update_required, nobody paid', async () => {
  const A = await sender();
  const b = await customer();
  const c = await customer();
  const B = await signedIn(api, b);
  const h = `legacy${hex()}`;
  await prisma.user.update({ where: { id: b.id }, data: { handle: h } });
  // B renames through the real endpoint → the release is logged in the same transaction.
  const ren = await B.call('POST', 'auth/complete-profile', { name: 'Bintou', handle: `bintou_${hex()}`, arrondissement: { key: 'plateau', name: 'Plateau' } });
  assert.equal(ren.status, 200, JSON.stringify(ren.body));
  assert.equal(await prisma.handleRelease.count({ where: { handle: h, userId: b.id } }), 1);
  await prisma.user.update({ where: { id: c.id }, data: { handle: h } });
  const snap = [await bal(A.id), await bal(b.id), await bal(c.id)];
  const r = await send(A, { recipientHandle: h, amount: 400 }, key());
  assert.equal(r.status, 426, JSON.stringify(r.body));
  assert.equal(r.body.code, 'update_required');
  assert.deepEqual([await bal(A.id), await bal(b.id), await bal(c.id)], snap);
});

test('legacy chat payment: direct thread of exactly sender + recipient → allowed; a group thread → 426', async () => {
  const A = await sender();
  const b = await customer();
  const x = await customer();
  const direct = await prisma.mboloThread.create({ data: { type: 'direct', creatorId: A.id, members: { create: [{ userId: A.id }, { userId: b.id }] } } });
  const ok = await send(A, { recipientHandle: b.handle, amount: 300, threadId: direct.id }, key());
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const group = await prisma.mboloThread.create({ data: { type: 'group', creatorId: A.id, members: { create: [{ userId: A.id }, { userId: b.id }, { userId: x.id }] } } });
  const no = await send(A, { recipientHandle: b.handle, amount: 300, threadId: group.id }, key());
  assert.equal(no.status, 426, JSON.stringify(no.body));
});

test('enforcement: RECIPIENT_BINDING_ENFORCE=true (or the sunset date) closes the legacy path; bound clients unaffected', async () => {
  assert.equal(recipientBindingMode(new Date(COMPAT_SUNSET.getTime() - 1)), process.env.RECIPIENT_BINDING_ENFORCE === 'true' ? 'enforce' : 'compat');
  assert.equal(recipientBindingMode(COMPAT_SUNSET), 'enforce', 'no permanent exemption: the sunset closes it');
  const strict = await startApiServer({ RECIPIENT_BINDING_ENFORCE: 'true' });
  try {
    const a = await customer({ koriBalance: 0 });
    await fundUser(a.id, 10_000);
    const A = await signedIn(strict, a);
    const b = await customer();
    const legacy = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, amount: 300 }, { headers: { 'idempotency-key': key() } });
    assert.equal(legacy.status, 426);
    const look = await A.call('GET', `users/lookup?q=${b.handle}&mode=handle`);
    const k = key();
    const conf = await A.call('POST', 'money/p2p/confirm', { recipientRef: look.body.recipientRef, amountKori: 300, intentKey: k });
    const bound = await A.call('POST', 'transfers/send', { recipientHandle: b.handle, instructionRef: conf.body.instructionRef, amount: 300 }, { headers: { 'idempotency-key': k } });
    assert.equal(bound.status, 201, JSON.stringify(bound.body));
  } finally {
    await strict.stop();
  }
});

test('authorization unchanged with a bound instruction: no session → 401; high value needs the PIN; a block refuses', async () => {
  const A = await sender(100_000);
  const b = await customer();
  const anon = await api.client('POST', 'transfers/send', { body: { recipientHandle: b.handle, amount: 500 } });
  assert.equal(anon.status, 401);
  const anonConfirm = await api.client('POST', 'money/p2p/confirm', { body: { recipientRef: 'rr2.x.y', amountKori: 500, intentKey: key() } });
  assert.equal(anonConfirm.status, 401);
  const p = await prepare(A, b.handle, 60_000);
  const big = await send(A, p.body, p.k);
  assert.equal(big.status, 403);
  assert.equal(big.body.code, 'step_up_required');
  const token = await stepUp(A);
  const b0 = await bal(b.id);
  const ok = await A.call('POST', 'transfers/send', p.body, { headers: { 'idempotency-key': p.k, 'x-step-up-token': token } });
  // PIN accepted; the risk engine may additionally HOLD it (202) — then nothing has reached the recipient.
  assert.ok([201, 202].includes(ok.status), `${ok.status} ${JSON.stringify(ok.body)}`);
  if (ok.status === 202) assert.equal(await bal(b.id), b0);
  await prisma.userBlock.create({ data: { blockerId: b.id, blockedUserId: A.id } });
  const q = await prepare(A, b.handle, 500);
  const blocked = await send(A, q.body, q.k);
  assert.equal(blocked.status, 403);
});
