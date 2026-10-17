/**
 * J7.19 — conversation text is never financial authority. A seller shares a
 * server charge as a card (code only); the buyer pays the SERVER amount with
 * expectedAmountKori. Users cannot post commerce/payment kinds themselves.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { business, customer, signedIn } from '../j3/helpers.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';
import { idemH, member } from './fixture.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

test('seller charge card: code-only payload, amount from server, forged text pays nothing extra; strangers and non-staff cannot share; users cannot post commerce kinds', async () => {
  const ownerC = await customer();
  const owner = await signedIn(api, ownerC);
  const shop = await business(ownerC.user);
  await ensureBusinessWallet(shop.id, prisma);
  const cashier = await member(api, shop, 'cashier');
  const buyerC = await customer();
  await fundUser(buyerC.id, 5000);
  const buyer = await signedIn(api, buyerC);
  const thread = await prisma.mboloThread.create({ data: { creatorId: cashier.id, name: 'shop', type: 'group', members: { create: [{ userId: cashier.id }, { userId: buyerC.id }, { userId: ownerC.id }] } } });

  const ch = await cashier.call('POST', 'money/charges', { businessId: shop.id, amountKori: 1200, label: 'Commande WhatsApp' });
  assert.equal(ch.status, 201, JSON.stringify(ch.body));
  const card = await cashier.call('POST', `mbolo/threads/${thread.id}/charge-card`, { code: ch.body.code });
  assert.equal(card.status, 201, JSON.stringify(card.body));
  const msg = await prisma.mboloMessage.findUnique({ where: { id: card.body.messageId } });
  assert.equal(msg.kind, 'commerce');
  assert.deepEqual(JSON.parse(msg.mediaUrl), { type: 'charge_card', code: ch.body.code, version: '2026-10-j7' }, 'no amount in the card');

  // Buyer posts a text claiming a lower price, and cannot post a commerce card.
  await buyer.call('POST', `mbolo/threads/${thread.id}/messages`, { body: 'On a dit 200 ₭ pour la commande, ok ?' });
  const fake = await buyer.call('POST', `mbolo/threads/${thread.id}/messages`, { body: 'pay', kind: 'commerce', mediaUrl: JSON.stringify({ type: 'charge_card', code: ch.body.code, amountKori: 200 }) });
  assert.ok(fake.status >= 400 || (await prisma.mboloMessage.findFirst({ where: { threadId: thread.id, senderId: buyerC.id, kind: 'commerce' } })) === null, 'buyer cannot create commerce cards');
  const view = await buyer.call('GET', `money/charges/${ch.body.code}`);
  assert.equal(view.body.amountKori, 1200);
  const low = await buyer.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 200 }, idemH());
  assert.ok(low.status >= 400, 'chat-negotiated amount is not authority');
  const ok = await buyer.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 1200 }, idemH());
  assert.ok(ok.status < 300, JSON.stringify(ok.body));
  assert.equal((await prisma.wallet.findUnique({ where: { userId: buyerC.id } })).koriBalance, 3800);

  // Paid charge can no longer be shared; buyer (not staff) cannot share someone else's charge; non-member cannot post.
  assert.equal((await cashier.call('POST', `mbolo/threads/${thread.id}/charge-card`, { code: ch.body.code })).body.code, 'charge_not_open');
  const ch2 = await owner.call('POST', 'money/charges', { businessId: shop.id, amountKori: 500, label: 'x' });
  assert.equal((await buyer.call('POST', `mbolo/threads/${thread.id}/charge-card`, { code: ch2.body.code })).status, 404);
  const outsiderC = await customer();
  const outsider = await signedIn(api, outsiderC);
  await prisma.businessMember.create({ data: { businessId: shop.id, userId: outsiderC.id, role: 'cashier', status: 'active', acceptedAt: new Date() } });
  assert.equal((await outsider.call('POST', `mbolo/threads/${thread.id}/charge-card`, { code: ch2.body.code })).status, 403, 'staff who is not in the thread cannot post into it');
  // Suspended business: no new card.
  await prisma.business.update({ where: { id: shop.id }, data: { status: 'suspended' } });
  assert.equal((await owner.call('POST', `mbolo/threads/${thread.id}/charge-card`, { code: ch2.body.code })).body.code, 'business_inactive');
});
