/**
 * J4 vertical slices — P2P, money requests, merchant charges (QR), refunds,
 * history/receipt links, intent outcome after uncertainty, supportability.
 * Real HTTP (NODE_ENV=production), real OTP logins, J2 invariants after each.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { business, customer, newDevice, operator, signedIn, stepUp } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const avail = async (s) => (await s.call('GET', 'money/home')).body.balance.availableKori;

async function pair(senderKori = 5000) {
  const a = await customer({ koriBalance: 0 });
  if (senderKori) await fundUser(a.id, senderKori);
  const b = await customer();
  await prisma.user.update({ where: { id: b.id }, data: { name: 'Awa Diop' } });
  return { A: await signedIn(api, a), B: await signedIn(api, b) };
}

test('P2P: find recipient (minimal identity) → preview → send → both histories + the same receipt reference', async () => {
  const { A, B } = await pair();
  const look = await A.call('GET', `users/lookup?q=${B.handle}`);
  const found = (Array.isArray(look.body) ? look.body : look.body.users ?? [look.body]).find((u) => u.handle === B.handle);
  assert.ok(found, JSON.stringify(look.body));
  assert.ok(!JSON.stringify(found).includes(B.phone), 'a public handle never reveals the full phone');
  const pv = await A.call('POST', 'money/preview', { flow: 'p2p', amountKori: 1200 });
  assert.deepEqual([pv.body.feeKori, pv.body.payerPaysKori, pv.body.recipientGetsKori, pv.body.allowed], [0, 1200, 1200, true]);

  const r = await A.call('POST', 'transfers/send', { recipientHandle: B.handle, amount: 1200 }, { headers: { 'idempotency-key': key() } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await avail(A), 3800);
  assert.equal(await avail(B), 1200);
  const outItem = (await A.call('GET', 'money/activity')).body.items.find((i) => i.type === 'transfer' && i.direction === 'out');
  const inItem = (await B.call('GET', 'money/activity')).body.items.find((i) => i.type === 'transfer' && i.direction === 'in');
  assert.equal(outItem.title, 'Envoi à Awa Diop');
  assert.equal(outItem.status, 'completed');
  assert.equal(inItem.reference, outItem.reference, 'one transaction, one reference for both parties');
  const rA = await A.call('GET', `money/activity/${outItem.reference}`);
  const rB = await B.call('GET', `money/activity/${outItem.reference}`);
  assert.equal(rA.body.amountKori, 1200);
  assert.equal(rB.body.direction, 'in');
  const stranger = await signedIn(api, await customer());
  assert.equal((await stranger.call('GET', `money/activity/${outItem.reference}`)).status, 404, 'receipts are party-only');
});

test('P2P: duplicate tap / retry with the same intent key never pays twice; the app resolves uncertainty via the intent', async () => {
  const { A, B } = await pair(5000);
  const k = key();
  const taps = await Promise.all([1, 2, 3].map(() => A.call('POST', 'transfers/send', { recipientHandle: B.handle, amount: 1000 }, { headers: { 'idempotency-key': k } })));
  assert.equal(taps.filter((t) => t.status === 201).length >= 1, true);
  assert.equal(await avail(A), 4000, 'debited exactly once');
  // "Timeout": the app does not know the outcome — it asks, never re-sends with a new key.
  const intent = await A.call('GET', `money/intents/${k}`);
  assert.equal(intent.body.state, 'completed');
  assert.equal(intent.body.safeToRetry, false);
  assert.ok(intent.body.references.length >= 1);
  // After an app restart (new session on another phone) the outcome is the same.
  const again = await signedIn(api, { ...A, device: newDevice() });
  assert.equal((await again.call('GET', `money/intents/${k}`)).body.state, 'completed');
  // A never-submitted intent is safe to retry.
  const unknown = await A.call('GET', `money/intents/${key()}`);
  assert.equal(unknown.body.state, 'not_found');
  assert.equal(unknown.body.safeToRetry, true);
  // Same key, different amount → refused (no silent second payment).
  const reuse = await A.call('POST', 'transfers/send', { recipientHandle: B.handle, amount: 999 }, { headers: { 'idempotency-key': k } });
  assert.equal(reuse.status, 422);
  assert.equal(await avail(A), 4000);
});

test('P2P failures: self-transfer, insufficient funds, invalid recipient, blocked relationship, simultaneous devices', async () => {
  const { A, B } = await pair(1000);
  const self = await A.call('POST', 'transfers/send', { recipientHandle: A.handle, amount: 10 });
  assert.equal(self.body.code, 'self_transfer');
  const poor = await A.call('POST', 'transfers/send', { recipientHandle: B.handle, amount: 2000 });
  assert.equal(poor.status, 400);
  assert.equal(poor.body.category, 'insufficient_funds');
  assert.equal((await A.call('POST', 'transfers/send', { recipientHandle: 'nobody_zz_404', amount: 10 })).status, 404);
  await prisma.userBlock.create({ data: { blockerId: B.id, blockedUserId: A.id } });
  const blocked = await A.call('POST', 'transfers/send', { recipientHandle: B.handle, amount: 10 });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'recipient_unavailable');
  assert.ok(!/block/i.test(blocked.body.error), 'the block is not disclosed');
  assert.equal(await avail(A), 1000);
  // Two phones, same account, concurrent sends exceeding the balance: one wins.
  const C = await signedIn(api, await customer());
  const phone2 = await signedIn(api, { ...A, device: newDevice(), deviceAgeHours: 72 });
  await prisma.userDevice.updateMany({ where: { userId: A.id }, data: { firstSeenAt: new Date(Date.now() - 72 * 3600_000), verifiedAt: new Date(Date.now() - 72 * 3600_000) } });
  await prisma.authSession.updateMany({ where: { userId: A.id, revokedAt: null }, data: { trust: 'trusted' } });
  const both = await Promise.all([A, phone2].map((s) => s.call('POST', 'transfers/send', { recipientHandle: C.handle, amount: 700 })));
  assert.equal(both.filter((r) => r.status === 201).length, 1, both.map((r) => r.status).join(','));
  assert.equal(await avail(A), 300);
});

test('money request: request → recipient sees it → pays once → both histories; a request never debits by itself; decline, expiry, strangers, spam, blocks', async () => {
  const { A: requester, B: payer } = await pair(0);
  await fundUser(payer.id, 3000);
  const before = await avail(payer);
  const req = await requester.call('POST', 'transfers/request', { recipientHandle: payer.handle, amount: 700 });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  assert.ok(req.body.expiresAt, 'requests expire');
  assert.equal(await avail(payer), before, 'a request is not a debit');
  const incoming = await payer.call('GET', 'transfers/requests?role=incoming');
  assert.ok(JSON.stringify(incoming.body).includes(req.body.id));
  const stranger = await signedIn(api, await customer({ koriBalance: 0 }));
  assert.ok([403, 404].includes((await stranger.call('POST', `transfers/requests/${req.body.id}/accept`, {})).status));
  assert.ok([400, 403, 404].includes((await requester.call('POST', `transfers/requests/${req.body.id}/accept`, {})).status), 'requester cannot pay own request');
  const paid = await Promise.all([1, 2].map(() => payer.call('POST', `transfers/requests/${req.body.id}/accept`, {})));
  assert.equal(paid.filter((p) => p.status < 300).length, 1, paid.map((p) => p.status).join(','));
  assert.equal(await avail(payer), 2300);
  assert.equal(await avail(requester), 700);

  const declined = await requester.call('POST', 'transfers/request', { recipientHandle: payer.handle, amount: 50 });
  assert.equal((await payer.call('POST', `transfers/requests/${declined.body.id}/deny`, {})).status, 200);
  assert.equal(await avail(payer), 2300, 'declining moves nothing');

  const expiring = await requester.call('POST', 'transfers/request', { recipientHandle: payer.handle, amount: 60 });
  await prisma.moneyRequest.update({ where: { id: expiring.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const late = await payer.call('POST', `transfers/requests/${expiring.body.id}/accept`, {});
  assert.equal(late.status, 410);
  assert.equal(await avail(payer), 2300);

  const spam = await requester.call('POST', 'transfers/request', { recipientHandle: payer.handle, amount: 1 });
  assert.equal(spam.status, 429, '≤ 3 requests to the same person per 24 h');
  await prisma.userBlock.create({ data: { blockerId: stranger.id, blockedUserId: requester.id } });
  const toBlocker = await requester.call('POST', 'transfers/request', { recipientHandle: stranger.handle, amount: 5 });
  assert.equal(toBlocker.status, 403);
});

test('merchant QR charge: server-authoritative merchant + amount; forged / changed / replayed / expired / cancelled / self-pay all refused; one payment', async () => {
  const owner = await signedIn(api, await customer());
  const biz = await business(owner);
  const ch = await owner.call('POST', 'money/charges', { businessId: biz.id, amountKori: 2500, label: 'Table 4' });
  assert.equal(ch.status, 201, JSON.stringify(ch.body));
  assert.match(ch.body.qrUrl, /^k21:\/\/charge\/[A-Za-z0-9_-]{16,}$/);
  assert.ok(!ch.body.qrUrl.includes('2500'), 'the QR carries no amount');

  const payerC = await customer({ koriBalance: 0 });
  await fundUser(payerC.id, 5000);
  const payer = await signedIn(api, payerC);
  const view = await payer.call('GET', `money/charges/${ch.body.code}`);
  assert.equal(view.body.amountKori, 2500);
  assert.equal(view.body.merchant.name, biz.name);

  assert.equal((await payer.call('GET', 'money/charges/forged-code-0000000000')).status, 404);
  const changed = await payer.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 1 });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'amount_mismatch');
  assert.equal(await avail(payer), 5000);
  assert.equal((await owner.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 2500 })).status, 400, 'merchant cannot pay itself');

  const k = key();
  const ok = await payer.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 2500 }, { headers: { 'idempotency-key': k } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const replay = await payer.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 2500 });
  assert.equal(replay.status, 200, 'replayed screenshot by the same payer = same receipt');
  assert.equal(replay.body.replayed, true);
  const otherPayer = await customer({ koriBalance: 0 });
  await fundUser(otherPayer.id, 5000);
  const s2 = await signedIn(api, otherPayer);
  assert.equal((await s2.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 2500 })).status, 409, 'a paid QR cannot be paid again');
  assert.equal(await avail(payer), 2500);
  assert.equal((await prisma.businessWallet.findUnique({ where: { businessId: biz.id } })).balance, 2500);
  const item = (await payer.call('GET', 'money/activity')).body.items.find((i) => i.type === 'merchant_payment');
  assert.equal(item.title, `Paiement à ${biz.name}`);

  const ch2 = await owner.call('POST', 'money/charges', { businessId: biz.id, amountKori: 100 });
  await prisma.merchantCharge.update({ where: { code: ch2.body.code }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await payer.call('POST', `money/charges/${ch2.body.code}/pay`, { expectedAmountKori: 100 })).status, 410);
  const ch3 = await owner.call('POST', 'money/charges', { businessId: biz.id, amountKori: 100 });
  const otherMerchant = await signedIn(api, await customer());
  assert.equal((await otherMerchant.call('POST', `money/charges/${ch3.body.code}/cancel`)).status, 403);
  assert.equal((await owner.call('POST', `money/charges/${ch3.body.code}/cancel`)).status, 200);
  assert.equal((await payer.call('POST', `money/charges/${ch3.body.code}/pay`, { expectedAmountKori: 100 })).status, 409);
  assert.equal(await avail(payer), 2500, 'none of the refused attempts moved money');
  assert.equal((await otherMerchant.call('POST', 'money/charges', { businessId: biz.id, amountKori: 100 })).status, 403, 'another merchant cannot issue charges for this business');
});

test('refund primitive: payee refunds (partial, then rest) as compensating entries linked to the original; never above the original; only the payee; history shows the link', async () => {
  const owner = await signedIn(api, await customer());
  const biz = await business(owner);
  const ch = await owner.call('POST', 'money/charges', { businessId: biz.id, amountKori: 2000 });
  const payerC = await customer({ koriBalance: 0 });
  await fundUser(payerC.id, 2000);
  const payer = await signedIn(api, payerC);
  await payer.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 2000 });
  const original = `charge:${ch.body.code}-J`;

  assert.equal((await payer.call('POST', `money/payments/${encodeURIComponent(original)}/refund`, { amountKori: 100, reason: 'refund myself' })).status, 403, 'the payer cannot refund to themself');
  const stranger = await signedIn(api, await customer());
  assert.equal((await stranger.call('POST', `money/payments/${encodeURIComponent(original)}/refund`, { amountKori: 100, reason: 'steal' })).status, 403);

  const r1 = await owner.call('POST', `money/payments/${encodeURIComponent(original)}/refund`, { amountKori: 500, reason: 'item missing' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.remainingRefundableKori, 1500);
  const races = await Promise.all([1, 2].map(() => owner.call('POST', `money/payments/${encodeURIComponent(original)}/refund`, { amountKori: 1500, reason: 'cancel order' })));
  assert.equal(races.filter((r) => r.status === 201).length, 1, 'concurrent refunds never exceed the original');
  assert.equal((await owner.call('POST', `money/payments/${encodeURIComponent(original)}/refund`, { amountKori: 1, reason: 'more' })).status, 409);
  assert.equal(await avail(payer), 2000);

  const items = (await payer.call('GET', 'money/activity')).body.items;
  const orig = items.find((i) => i.reference === original);
  assert.equal(orig.status, 'refunded');
  assert.equal(orig.links.refundedKori, 2000);
  const refundItems = items.filter((i) => i.type === 'refund');
  assert.equal(refundItems.length, 2);
  assert.ok(refundItems.every((i) => i.links.refundOf === original), 'each refund visibly linked to the original');
  // The original ledger entry is untouched (append-only).
  assert.ok(await prisma.journalEntry.findUnique({ where: { reference: original } }));
});

test('P2P undo shows as a linked reversal; history survives reload', async () => {
  const { A, B } = await pair(1000);
  const r = await A.call('POST', 'transfers/send', { recipientHandle: B.handle, amount: 300 });
  const ref = (await A.call('GET', 'money/activity')).body.items.find((i) => i.type === 'transfer').reference;
  const undo = await A.call('POST', `transfers/${r.body.reference ?? r.body.transaction?.reference ?? ref}/undo`, {});
  assert.ok(undo.status < 300, JSON.stringify(undo.body));
  const items = (await A.call('GET', 'money/activity')).body.items;
  const original = items.find((i) => i.reference === ref);
  assert.equal(original.status, 'reversed');
  const reversal = items.find((i) => i.type === 'reversal');
  assert.equal(reversal.links.reverses, ref);
  assert.equal(await avail(A), 1000);
});

test('supportability: support locates any reference and its stage, read-only; no role cannot; nobody can change a balance from it', async () => {
  const { A, B } = await pair(1000);
  await A.call('POST', 'transfers/send', { recipientHandle: B.handle, amount: 100 });
  const ref = (await A.call('GET', 'money/activity')).body.items[0].reference;
  const support = await operator(api, ['support']);
  const l = await support.call('GET', `admin/money/lookup?reference=${encodeURIComponent(ref)}`);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.stage, 'completed');
  assert.equal(l.body.canSupportChangeBalance, false);
  assert.equal((await (await operator(api, ['sysadmin'])).call('GET', `admin/money/lookup?reference=${ref}`)).status, 403);
  const fin = await operator(api, ['finance_ops']);
  const usage = await fin.call('GET', 'admin/money/limits-usage');
  assert.equal(usage.status, 200);
  assert.equal(usage.body.thresholds.refundSingleMaxKori, 10_000);
});
