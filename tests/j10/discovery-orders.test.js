/**
 * J10-S2/S5/S6/S7: privacy-safe discovery (phone lookup respects "find me by number" and is budgeted;
 * consent-only hashed contact matching), neighbourhood (verified active businesses + opted-in people,
 * blocks excluded), order-anchored merchant ↔ customer conversations (buyer or that shop's staff only;
 * blocks close it; messages never change the order) and partner messaging that honours blocks, caps
 * and attribution.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUserWithWallet, fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { business, customer, signedIn } from '../j3/helpers.js';
import { placeMarketplaceOrder } from '../../lib/marketplace-service.js';
import { sendPartnerMessage } from '../../lib/partner-messages-service.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
const ok = (r, what = '') => { assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const person = async () => { const c = await customer(); const u = await prisma.user.findUnique({ where: { id: c.id } }); return { c, u, id: c.id, s: await signedIn(api, c) }; };
const lookup = (p, q) => p.s.call('GET', `users/lookup?q=${encodeURIComponent(q)}`);
const freshBudget = (userId) => prisma.rateLimitBucket.deleteMany({ where: { key: { contains: userId } } });

test('phone lookup honours "find me by number" (nobody / connections / everyone) and is budgeted; handle search unchanged', async () => {
  const [me, target, friend] = await Promise.all([person(), person(), person()]);
  assert.equal((await lookup(me, target.u.phone)).status, 200, 'default: everyone');
  ok(await target.s.call('PUT', 'me/community-settings', { discoverableByPhone: 'nobody' }));
  assert.equal((await lookup(me, target.u.phone)).status, 404, 'hidden looks like not found');
  assert.equal((await lookup(me, target.u.handle)).status, 200, 'handle search is separate');
  ok(await target.s.call('PUT', 'me/community-settings', { discoverableByPhone: 'connections' }));
  await prisma.userFriend.createMany({ data: [{ userId: target.id, friendId: friend.id }, { userId: friend.id, friendId: target.id }] });
  assert.equal((await lookup(me, target.u.phone)).status, 404);
  assert.equal((await lookup(friend, target.u.phone)).status, 200);
  // Budget: misses count too; after 30 phone searches in an hour → targeted 429.
  await freshBudget(me.id);
  let last;
  for (let i = 0; i < 31; i += 1) last = await lookup(me, `+22177${String(1000000 + i)}`);
  assert.equal(last.status, 429);
  assert.equal((await lookup(me, target.u.handle)).status, 200, 'handle search still works');
});

test('contact matching: hashed numbers only, discoverable people only, no number echoed, bounded', async () => {
  const [me, open, hiddenP] = await Promise.all([person(), person(), person()]);
  ok(await hiddenP.s.call('PUT', 'me/community-settings', { discoverableByPhone: 'nobody' }));
  const r = ok(await me.s.call('POST', 'contacts/match', { hashes: [sha(open.u.phone), sha(hiddenP.u.phone), sha('+221700000000')] }));
  assert.deepEqual(r.matches.map((m) => m.userId), [open.id]);
  assert.ok(!JSON.stringify(r).includes(open.u.phone), 'never the number');
  assert.equal((await me.s.call('POST', 'contacts/match', { hashes: Array.from({ length: 201 }, (_, i) => sha(`+2217${i}`)) })).status, 400);
});

test('neighbourhood: verified active businesses in my area and opted-in people only; blocks excluded', async () => {
  const area = `quartier-${crypto.randomBytes(3).toString('hex')}`;
  const [me, optIn, quiet, blockedP] = await Promise.all([person(), person(), person(), person()]);
  await prisma.user.updateMany({ where: { id: { in: [me.id, optIn.id, quiet.id, blockedP.id] } }, data: { arrondissementKey: area } });
  for (const p of [optIn, blockedP]) ok(await p.s.call('PUT', 'me/community-settings', { neighbourhoodVisible: true }));
  await prisma.userBlock.create({ data: { blockerId: blockedP.id, blockedUserId: me.id } });
  const owner = await customer();
  const verified = await business(owner.user);
  const unverified = await business((await customer()).user);
  const suspended = await business((await customer()).user);
  await prisma.business.update({ where: { id: verified.id }, data: { arrondissement: area.toUpperCase(), verificationStatus: 'verified', verified: true } });
  await prisma.business.update({ where: { id: unverified.id }, data: { arrondissement: area } });
  await prisma.business.update({ where: { id: suspended.id }, data: { arrondissement: area, verificationStatus: 'verified', status: 'suspended' } });
  const n = ok(await me.s.call('GET', 'community/neighbourhood'));
  assert.deepEqual(n.businesses.map((b) => b.id), [verified.id]);
  assert.deepEqual(n.people.map((p) => p.userId), [optIn.id]);
});

test('order conversation: buyer or that shop’s staff only, support reference, blocks close it, the order is never changed', async () => {
  const ownerU = await createUserWithWallet({ tier: 3, koriBalance: 0 });
  const shop = await business(ownerU);
  await ensureBusinessWallet(shop.id, prisma);
  const product = await prisma.product.create({ data: { businessId: shop.id, title: 'Thiéboudienne', price: 1500, inventory: 20, active: true, category: 'food' } });
  const buyer = await person();
  await fundUser(buyer.id, 10_000);
  const placed = await placeMarketplaceOrder(prisma, { buyerId: buyer.id, businessId: shop.id, items: [{ productId: product.id, quantity: 1 }], fulfillmentType: 'pickup', reference: `ORD-${crypto.randomBytes(5).toString('hex')}` });
  const order = placed.order ?? (await prisma.order.findFirst({ where: { buyerId: buyer.id }, orderBy: { createdAt: 'desc' } }));
  const before = await prisma.order.findUnique({ where: { id: order.id } });
  const c1 = ok(await buyer.s.call('POST', `marketplace/orders/${order.id}/conversation`, {}));
  assert.equal(c1.role, 'buyer');
  const owner = await signedIn(api, { id: ownerU.id, phone: ownerU.phone, user: ownerU });
  const c2 = ok(await owner.call('POST', `marketplace/orders/${order.id}/conversation`, {}));
  assert.deepEqual([c2.threadId, c2.role], [c1.threadId, 'merchant'], 'one conversation per order');
  const first = await prisma.mboloMessage.findFirst({ where: { threadId: c1.threadId }, orderBy: { createdAt: 'asc' } });
  assert.equal(first.kind, 'support_ref');
  ok(await buyer.s.call('POST', `mbolo/threads/${c1.threadId}/messages`, { body: 'Annule ma commande et rembourse-moi', kind: 'text' }));
  const after = await prisma.order.findUnique({ where: { id: order.id } });
  assert.deepEqual([after.status, after.paymentStatus], [before.status, before.paymentStatus], 'text never changes the order');
  const stranger = await person();
  assert.equal((await stranger.s.call('POST', `marketplace/orders/${order.id}/conversation`, {})).status, 404, 'no cold access');
  assert.equal((await stranger.s.call('GET', `mbolo/threads/${c1.threadId}/messages`)).status >= 400, true);
  await prisma.userBlock.create({ data: { blockerId: buyer.id, blockedBusinessId: shop.id } });
  assert.equal((await owner.call('POST', `marketplace/orders/${order.id}/conversation`, {})).body.code, 'cannot_message');
});

test('partner messaging: always attributed, honours the recipient’s block (no SMS fallback), capped per recipient', async () => {
  const system = await createUserWithWallet({ tier: 3, koriBalance: 0 });
  process.env.PARTNER_MESSAGING_USER_ID = system.id;
  const r = await createUserWithWallet({ tier: 2, koriBalance: 0 });
  const send = (text, metadata = {}) => sendPartnerMessage('kebu', { to_phone: r.phone, text, metadata });
  assert.equal((await send('Votre code : 123456', { kind: 'verification' })).status, 'sent');
  const thread = await prisma.mboloThread.findFirst({ where: { commerceType: 'partner_notify', commerceRefId: `partner:kebu:${r.id}` } });
  const m = await prisma.mboloMessage.findFirst({ where: { threadId: thread.id } });
  assert.ok(m.body.startsWith('[kebu] '), 'verification texts are attributed too');
  for (let i = 0; i < 9; i += 1) await send(`Promo ${i}`);
  const capped = await send('Promo 10');
  assert.deepEqual([capped.status, capped.error, capped.channel_used], ['failed', 'recipient_daily_limit', 'none']);
  await prisma.mboloMessage.updateMany({ where: { threadId: thread.id }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
  await prisma.mboloMember.updateMany({ where: { threadId: thread.id, userId: r.id }, data: { status: 'blocked' } });
  const blocked = await send('Encore une promo');
  assert.deepEqual([blocked.status, blocked.error, blocked.channel_used], ['failed', 'recipient_blocked', 'none'], 'no SMS around a block');
  delete process.env.PARTNER_MESSAGING_USER_ID;
});
