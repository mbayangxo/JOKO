/**
 * P2P undo / reversal — adversarial, over real HTTP (NODE_ENV=production).
 * Reversal must be a NEW compensating ledger event; the original stays.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { createUserWithWallet, createVerifiedDevice, establishedSessionToken, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
let api;

before(async () => {
  api = await startApiServer();
});
after(async () => {
  await api?.stop();
  await prisma.$disconnect();
});

async function actor(koriBalance = 0) {
  const user = await createUserWithWallet({ koriBalance });
  const device = await createVerifiedDevice(user.id);
  const token = await establishedSessionToken(user.id, device, ACCESS_SECRET);
  return { user, device, token, ip: freshIp() };
}
const as = (a, headers = {}) => ({ token: a.token, device: a.device, ip: a.ip, headers: { 'x-vercel-ip-country': 'SN', ...headers } });
const bal = async (a) => (await prisma.wallet.findUnique({ where: { userId: a.user.id } })).koriBalance;

async function send(from, to, amount) {
  const r = await api.client('POST', 'transfers/send', { ...as(from), body: { recipientHandle: to.user.handle, amount } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.reference;
}
const undo = (a, ref, headers) => api.client('POST', `transfers/${ref}/undo`, as(a, headers));

test('normal undo reverses once and preserves the original ledger events', async () => {
  const a = await actor(500);
  const b = await actor();
  const ref = await send(a, b, 100);
  const r = await undo(a, ref);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.undone, true);
  assert.equal(await bal(a), 500);
  assert.equal(await bal(b), 0);
  // Original send is still in history; the reversal is a separate event.
  assert.equal(await prisma.ledgerEntry.count({ where: { reference: ref } }), 1);
  assert.equal(await prisma.koriTransaction.count({ where: { reference: ref } }), 1);
  assert.equal(await prisma.ledgerEntry.count({ where: { reference: r.body.reversedReference } }), 1);
  const row = await prisma.transferUndo.findUnique({ where: { originalReference: ref } });
  assert.equal(row.status, 'reversed');
});

test('double undo: the second attempt is refused and moves nothing', async () => {
  const a = await actor(500);
  const b = await actor();
  const ref = await send(a, b, 100);
  assert.equal((await undo(a, ref)).status, 200);
  const again = await undo(a, ref);
  assert.equal(again.status, 400);
  assert.ok(['already_reversed', 'not_reversible'].includes(again.body.code), again.body.code);
  assert.equal(await bal(a), 500);
  assert.equal(await bal(b), 0);
});

test('concurrent undo: exactly one reversal', async () => {
  const a = await actor(500);
  const b = await actor(200);
  const ref = await send(a, b, 100);
  const rs = await Promise.all(Array.from({ length: 5 }, () => undo(a, ref)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.equal(await bal(a), 500);
  assert.equal(await bal(b), 200);
});

test('wrong user (recipient or stranger) cannot undo; unknown reference is 404', async () => {
  const a = await actor(500);
  const b = await actor();
  const stranger = await actor();
  const ref = await send(a, b, 100);
  assert.equal((await undo(b, ref)).status, 403);
  assert.equal((await undo(stranger, ref)).status, 403);
  assert.equal((await undo(a, 'TXN-DOESNOTEXIST')).status, 404);
  assert.equal(await bal(b), 100);
});

test('expired window: refused, nothing moves', async () => {
  const a = await actor(500);
  const b = await actor();
  const ref = await send(a, b, 100);
  await prisma.transferUndo.update({ where: { originalReference: ref }, data: { reversibleUntil: new Date(Date.now() - 1000) } });
  const r = await undo(a, ref);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'window_expired');
  assert.equal(await bal(b), 100);
});

test('recipient already spent the money: refused cleanly, no negative balance', async () => {
  const a = await actor(500);
  const b = await actor();
  const c = await actor();
  const ref = await send(a, b, 100);
  await send(b, c, 100);
  const r = await undo(a, ref);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'recipient_spent');
  assert.equal(await bal(a), 400);
  assert.equal(await bal(b), 0);
  assert.equal(await bal(c), 100);
});

test('retry with the same Idempotency-Key replays the first result', async () => {
  const a = await actor(500);
  const b = await actor();
  const ref = await send(a, b, 100);
  const key = `undo-${crypto.randomBytes(5).toString('hex')}`;
  const r1 = await undo(a, ref, { 'idempotency-key': key });
  const r2 = await undo(a, ref, { 'idempotency-key': key });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200, 'replayed, not "not_reversible"');
  assert.equal(r2.body.reversedReference, r1.body.reversedReference);
  assert.equal(await bal(a), 500);
});

test('state survives an API restart (reversed stays reversed)', async () => {
  const a = await actor(500);
  const b = await actor();
  const ref = await send(a, b, 100);
  assert.equal((await undo(a, ref)).status, 200);
  await api.stop();
  api = await startApiServer();
  const again = await undo(a, ref);
  assert.equal(again.status, 400);
  assert.equal(await bal(a), 500);
});

test('direct API abuse: undo of a merchant/other operation reference not owned, and unauthenticated', async () => {
  const a = await actor(500);
  const b = await actor();
  const ref = await send(a, b, 100);
  const unauth = await api.client('POST', `transfers/${ref}/undo`, {});
  assert.equal(unauth.status, 401);
  const injected = await api.client('POST', `transfers/${encodeURIComponent(`${ref}' OR '1'='1`)}/undo`, as(a));
  assert.ok([400, 404].includes(injected.status));
  assert.equal(await bal(b), 100);
});
