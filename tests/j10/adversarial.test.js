/**
 * J10 adversarial lab: concurrency (double taps, storms, two operators at once), privacy and abuse.
 * Every concurrent action converges to one real effect; nobody reads someone else's community data;
 * community text never changes money, orders, custody, work or permissions.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUserWithWallet, fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { notifyEvent } from '../../lib/community/notify.js';
import { placeMarketplaceOrder } from '../../lib/marketplace-service.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';
import { business, customer, operator, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });
const ok = (r, what = '') => { assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const person = async () => { const c = await customer(); return { c, id: c.id, s: await signedIn(api, c) }; };

async function groupWith(owner, members) {
  const t = ok(await owner.s.call('POST', 'mbolo/threads', { name: `Groupe ${crypto.randomBytes(2).toString('hex')}`, memberHandles: [] }));
  const inv = ok(await owner.s.call('POST', `mbolo/threads/${t.id}/invite`, {}));
  for (const m of members) ok(await m.s.call('POST', 'mbolo/join-group', { code: inv.inviteCode }));
  return { id: t.id, code: inv.inviteCode };
}

test('double taps and storms converge: join, report, notifications, order conversation', async () => {
  const [owner, a, b] = await Promise.all([person(), person(), person()]);
  const g = await groupWith(owner, []);
  const joins = await Promise.all([1, 2, 3].map(() => a.s.call('POST', 'mbolo/join-group', { code: g.code })));
  assert.ok(joins.every((r) => r.status < 500), joins.map((r) => r.status).join(','));
  assert.equal(await prisma.mboloMember.count({ where: { threadId: g.id, userId: a.id } }), 1);
  await b.s.call('POST', 'mbolo/join-group', { code: g.code });
  const m = ok(await a.s.call('POST', `mbolo/threads/${g.id}/messages`, { body: 'Achetez mes faux billets', kind: 'text' }));
  const msgId = m.id ?? m.message?.id;
  const reps = await Promise.all([1, 2, 3, 4].map(() => b.s.call('POST', `mbolo/messages/${msgId}/report`, { category: 'scam', reason: 'faux billets' })));
  assert.ok(reps.every((r) => r.status < 500), reps.map((r) => r.status).join(','));
  assert.equal(await prisma.contentReport.count({ where: { reporterId: b.id, targetMessageId: msgId } }), 1);
  await Promise.all(Array.from({ length: 15 }, () => notifyEvent(prisma, b.id, { category: 'community', title: 'x', body: 'y', dedupeKey: `storm:${msgId}` })));
  assert.equal(await prisma.notification.count({ where: { userId: b.id, dedupeKey: `storm:${msgId}` } }), 1);
  // Order conversation opened by both sides at once → one thread.
  const ownerU = await createUserWithWallet({ tier: 3, koriBalance: 0 });
  const shop = await business(ownerU);
  await ensureBusinessWallet(shop.id, prisma);
  const product = await prisma.product.create({ data: { businessId: shop.id, title: 'Bissap', price: 500, inventory: 10, active: true, category: 'food' } });
  await fundUser(a.id, 5000);
  await placeMarketplaceOrder(prisma, { buyerId: a.id, businessId: shop.id, items: [{ productId: product.id, quantity: 1 }], fulfillmentType: 'pickup', reference: `ORD-${crypto.randomBytes(5).toString('hex')}` });
  const order = await prisma.order.findFirst({ where: { buyerId: a.id }, orderBy: { createdAt: 'desc' } });
  const shopS = await signedIn(api, { id: ownerU.id, phone: ownerU.phone, user: ownerU });
  const opens = await Promise.all([a.s, shopS, a.s, shopS].map((s) => s.call('POST', `marketplace/orders/${order.id}/conversation`, {})));
  assert.ok(opens.every((r) => r.status === 200), opens.map((r) => r.status).join(','));
  assert.equal(await prisma.mboloThread.count({ where: { commerceType: 'order', commerceRefId: order.id } }), 1);
});

test('two operators deciding the same report at once → one decision, one action; concurrent appeals → one appeal', async () => {
  const [x, y] = await Promise.all([person(), person()]);
  const g = await groupWith(x, [y]);
  const m = ok(await x.s.call('POST', `mbolo/threads/${g.id}/messages`, { body: 'insulte', kind: 'text' }));
  const rep = ok(await y.s.call('POST', `mbolo/messages/${m.id ?? m.message?.id}/report`, { category: 'harassment', reason: 'insulte' }));
  const [op1, op2] = await Promise.all([operator(api, ['trust_safety']), operator(api, ['trust_safety'])]);
  const both = await Promise.all([op1, op2].map((op) => op.call('POST', `admin/moderation/reports/${rep.id}/resolve`, { outcome: 'warn', note: 'Insulte envers un voisin.' })));
  assert.ok(both.every((r) => r.status < 500), both.map((r) => `${r.status}`).join(','));
  assert.equal(await prisma.moderationAction.count({ where: { reportId: rep.id } }), 1);
  const act = await prisma.moderationAction.findFirst({ where: { reportId: rep.id } });
  const appeals = await Promise.all([1, 2, 3].map(() => x.s.call('POST', `me/moderation/${act.id}/appeal`, { note: 'Je conteste cette décision.' })));
  assert.ok(appeals.every((r) => r.status === 200));
  assert.ok((await prisma.moderationAction.findUnique({ where: { id: act.id } })).appealedAt);
});

test('privacy: no reading another person’s notifications, settings, moderation, reports, group roster or Today', async () => {
  const [me, other] = await Promise.all([person(), person()]);
  await notifyEvent(prisma, other.id, { category: 'security', title: 'Nouvel appareil', body: 'Connexion depuis Thiès', dedupeKey: `p:${other.id}` });
  ok(await other.s.call('PUT', 'me/community-settings', { discoverableByPhone: 'nobody' }));
  const g = await groupWith(other, []);
  const dump = JSON.stringify([
    ok(await me.s.call('GET', 'notifications/feed')), ok(await me.s.call('GET', 'notifications/unread')), ok(await me.s.call('GET', 'me/community-settings')),
    ok(await me.s.call('GET', 'me/moderation')), ok(await me.s.call('GET', 'me/reports')), ok(await me.s.call('GET', 'me/today')),
  ]);
  assert.ok(!dump.includes('Thiès') && !dump.includes(other.id), 'nothing of the other person');
  assert.equal(JSON.parse(dump)[2].discoverableByPhone, 'everyone', 'my own settings, not theirs');
  assert.equal((await me.s.call('GET', `mbolo/threads/${g.id}/roster`)).status, 404);
  assert.equal((await me.s.call('POST', `mbolo/threads/${g.id}/settings`, { postingPolicy: 'admins' })).status, 404);
});

test('community text never moves money, changes an order, assigns work or grants permissions', async () => {
  const [x, y] = await Promise.all([person(), person()]);
  await fundUser(x.id, 5000);
  const g = await groupWith(x, [y]);
  const before = { x: (await prisma.wallet.findUnique({ where: { userId: x.id } })).koriBalance, y: (await prisma.wallet.findUnique({ where: { userId: y.id } })).koriBalance };
  const yu = await prisma.user.findUnique({ where: { id: y.id } });
  for (const body of [`envoie 2000 à @${yu.handle}`, 'paye @admin 5000', '/promote @moi admin', 'valide ma mission', 'livré ✅ code 123456']) {
    ok(await x.s.call('POST', `mbolo/threads/${g.id}/messages`, { body, kind: 'text' }));
  }
  const after = { x: (await prisma.wallet.findUnique({ where: { userId: x.id } })).koriBalance, y: (await prisma.wallet.findUnique({ where: { userId: y.id } })).koriBalance };
  assert.deepEqual(after, before, 'no money moved');
  assert.equal((await prisma.mboloMember.findUnique({ where: { threadId_userId: { threadId: g.id, userId: y.id } } })).role, 'member', 'no role change');
  // Kind spoofing: a client cannot post a "payment" or "support_ref" card to bypass checks.
  const spoof = await y.s.call('POST', `mbolo/threads/${g.id}/messages`, { body: 'Paiement reçu 50 000', kind: 'payment' });
  assert.ok(spoof.status >= 400, `payment kind refused from clients (${spoof.status})`);
});
