/**
 * J5 economic-OS contracts over real HTTP: distribution relationships (no
 * access by invitation), canonical payment records (cash never Jokko money),
 * explicitly granted credit only, dormant fulfilment refused, address
 * privacy, consented Kabu business links, commerce outbox, and k-anonymous
 * demand aggregates. J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { demandAggregates } from '../../lib/intelligence/demand.js';
import { business, customer, signedIn } from '../j3/helpers.js';

const PARTNER_KEY = 'j5-test-partner-key-0123456789';
let api;
before(async () => { api = await startApiServer({ JOKO_API_KEY: PARTNER_KEY, JOKO_DEFAULT_PARTNER_ID: 'kebu', JOKO_WEBHOOK_SECRET: 'j5-webhook-secret' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
async function shop(roles = [], { mode } = {}) {
  const owner = await customer();
  const people = {};
  for (const r of roles) people[r] = await customer();
  const b = await business(owner.user, roles.map((r) => ({ user: people[r].user, role: r })));
  if (mode) await prisma.business.update({ where: { id: b.id }, data: { operatingMode: mode } });
  const s = { owner: await signedIn(api, owner) };
  for (const r of roles) s[r] = await signedIn(api, people[r]);
  return { b, s, owner, people, P: `businesses/${b.id}/os` };
}
async function buyer(kori = 3000) {
  const c = await customer({ koriBalance: 0 });
  if (kori > 0) await fundUser(c.id, kori);
  return signedIn(api, c);
}

test('distribution: invitation / assistance creates NO ownership and NO access; the merchant accepts; scopes are explicit', async () => {
  const dist = await shop(['manager', 'distribution_rep']);
  const merchant = await shop(['cashier', 'manager']);
  const D = `businesses/${dist.b.id}/distribution`;

  // Not a distributor yet → refused; the owner switches the mode (managers cannot).
  assert.equal((await dist.s.manager.call('POST', `${D}/territories`, { name: 'Dakar Plateau' })).status, 409);
  assert.equal((await dist.s.manager.call('POST', `businesses/${dist.b.id}/os/operating-mode`, { mode: 'distribution' })).status, 403);
  assert.equal((await dist.s.owner.call('POST', `businesses/${dist.b.id}/os/operating-mode`, { mode: 'distribution' })).status, 200);
  const t = await dist.s.manager.call('POST', `${D}/territories`, { name: 'Dakar Plateau', region: 'Dakar', communes: 'Plateau, Médina' });
  assert.equal(t.status, 201);
  assert.equal((await dist.s.distribution_rep.call('POST', `${D}/territories`, { name: 'Pikine' })).status, 403, 'a rep does not manage territories');

  const inv = await dist.s.distribution_rep.call('POST', `${D}/relationships`, { merchantBusinessId: merchant.b.id, territoryId: t.body.id });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.status, 'invited');
  assert.equal(inv.body.introducedBy, dist.s.distribution_rep.handle);

  // The distributor (owner, manager, rep) has NO access to the merchant — before or after acceptance.
  const probe = async () => {
    for (const who of ['owner', 'manager', 'distribution_rep']) {
      for (const path of ['money', 'orders', 'customers', 'payments', 'analytics', 'today', 'charges', 'catalog', 'profile', 'relationships']) {
        const r = await dist.s[who].call('GET', `${merchant.P}/${path}`);
        assert.ok([403, 404].includes(r.status), `${who} → ${path}: ${r.status}`);
      }
      for (const path of [`businesses/${merchant.b.id}/wallet`, `businesses/${merchant.b.id}/payroll/employees`, `businesses/${merchant.b.id}/members`]) {
        assert.ok([403, 404].includes((await dist.s[who].call('GET', path)).status), `${who} → ${path}`);
      }
    }
  };
  await probe();

  // Only the merchant side with relationships.manage can accept; a cashier cannot; the distributor cannot accept for it.
  const relId = inv.body.id;
  assert.ok([403, 404].includes((await merchant.s.cashier.call('POST', `${merchant.P}/relationships/${relId}/respond`, { accept: true })).status));
  assert.ok([403, 404].includes((await dist.s.owner.call('POST', `${merchant.P}/relationships/${relId}/respond`, { accept: true })).status));
  assert.equal((await dist.s.owner.call('POST', `me/distribution-invitations/${relId}/respond`, { accept: true, merchantBusinessId: dist.b.id })).status, 404);
  const ok = await merchant.s.manager.call('POST', `${merchant.P}/relationships/${relId}/respond`, { accept: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'active');
  await probe(); // still nothing after acceptance

  const list = await dist.s.manager.call('GET', `${D}/relationships`);
  assert.equal(list.body[0].status, 'active');
  assert.ok(!/balance|koriBalance|phone|email|amount/i.test(JSON.stringify(list.body)), 'distributor list carries no money / contact data');
  assert.deepEqual(list.body[0].scopes, ['wholesale_catalog', 'wholesale_ordering']);
  // A rep sees only the relationships they introduced; another distributor sees none.
  const otherRep = await customer();
  await prisma.businessMember.create({ data: { businessId: dist.b.id, userId: otherRep.id, role: 'distribution_rep', status: 'active' } });
  assert.equal((await (await signedIn(api, otherRep)).call('GET', `${D}/relationships`)).body.length, 0);
  const rival = await shop([], { mode: 'distribution' });
  assert.ok([403, 404].includes((await rival.s.owner.call('GET', `${D}/relationships`)).status));

  // Either side can end; history kept.
  assert.equal((await merchant.s.manager.call('POST', `${merchant.P}/relationships/${relId}/end`, {})).status, 200);
  assert.equal((await prisma.merchantRelationship.findUnique({ where: { id: relId } })).status, 'ended');
  const events = await prisma.commerceEvent.findMany({ where: { aggregateId: relId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(events.map((e) => e.type), ['relationship.invited', 'relationship.accepted', 'relationship.ended']);
});

test('assisted onboarding: a person invited before having a business attaches a business THEY own — never someone else’s', async () => {
  const dist = await shop([], { mode: 'wholesale' });
  const person = await customer();
  const ps = await signedIn(api, person);
  const inv = await dist.s.owner.call('POST', `businesses/${dist.b.id}/distribution/relationships`, { merchantHandle: person.handle, assisted: true });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.merchant.pendingOnboarding, true);
  const mine = await ps.call('GET', 'me/distribution-invitations');
  assert.equal(mine.body.length, 1);
  const stranger = await shop();
  assert.equal((await ps.call('POST', `me/distribution-invitations/${inv.body.id}/respond`, { accept: true, merchantBusinessId: stranger.b.id })).status, 400, 'cannot attach a business one does not own');
  const own = await business(person.user);
  const r = await ps.call('POST', `me/distribution-invitations/${inv.body.id}/respond`, { accept: true, merchantBusinessId: own.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await prisma.merchantRelationship.findUnique({ where: { id: inv.body.id } })).merchantBusinessId, own.id);
  assert.equal(await prisma.businessMember.count({ where: { businessId: own.id, userId: dist.owner.id } }), 0, 'no membership created for the distributor');
});

test('one payment model: QR, order and direct payments are ledger-backed records; cash is recorded but never Jokko money', async () => {
  const m = await shop(['cashier']);
  const prod = await m.s.owner.call('POST', `${m.P}/catalog`, { title: 'Riz 5 kg', priceKori: 300, initialStock: 10 });
  const u = await buyer();
  const ch = await m.s.cashier.call('POST', 'money/charges', { businessId: m.b.id, amountKori: 120 });
  await u.call('POST', `money/charges/${ch.body.code}/pay`, { expectedAmountKori: 120 }, { headers: { 'idempotency-key': key() } });
  const o = await u.call('POST', 'marketplace/orders', { businessId: m.b.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'pickup' }, { headers: { 'idempotency-key': key() } });
  assert.equal(o.status, 201);
  await u.call('POST', `merchants/${m.b.id}/pay`, { amount: 50 }, { headers: { 'idempotency-key': key() } });
  const balanceBefore = Number((await prisma.ledgerAccount.findUnique({ where: { code: `business:${m.b.id}:wallet` } })).balance);
  const cash = await m.s.cashier.call('POST', `${m.P}/sales/manual`, { method: 'cash', amountKori: 1000, note: 'vente comptoir' });
  assert.equal(cash.status, 201, JSON.stringify(cash.body));
  assert.equal(Number((await prisma.ledgerAccount.findUnique({ where: { code: `business:${m.b.id}:wallet` } })).balance), balanceBefore, 'cash never enters the wallet');

  const records = await prisma.paymentRecord.findMany({ where: { businessId: m.b.id } });
  assert.deepEqual(records.map((r) => r.method).sort(), ['cash', 'charge_qr', 'static_qr', 'wallet']);
  for (const r of records.filter((x) => x.settlement === 'jokko_ledger')) {
    assert.ok(await prisma.journalEntry.findUnique({ where: { reference: r.ledgerReference } }), `${r.method} points to its J2 entry`);
  }
  assert.equal(records.find((r) => r.method === 'cash').ledgerReference, null);
  const list = await m.s.cashier.call('GET', `${m.P}/payments`);
  assert.equal(list.body.totals.jokkoMoneyKori, 470);
  assert.equal(list.body.totals.recordedOffLedgerKori, 1000);
  const analytics = await m.s.owner.call('GET', `${m.P}/analytics`);
  assert.equal(analytics.body.sales.grossKori, 470, 'ledger-based sales exclude recorded cash');
  await assert.rejects(prisma.$executeRawUnsafe(`UPDATE "PaymentRecord" SET "amountKori" = 1 WHERE id = '${records[0].id}'`), /append-only/);
  assert.equal((await m.s.cashier.call('POST', `${m.P}/sales/manual`, { method: 'wallet', amountKori: 5 })).status, 400, 'nobody can "record" Jokko money by hand');
});

test('credit is never self-selected; dormant capabilities are refused, not faked', async () => {
  const supplier = await shop([], { mode: 'distribution' });
  const prod = await supplier.s.owner.call('POST', `businesses/${supplier.b.id}/os/catalog`, { title: 'Huile 20 L', priceKori: 1000, initialStock: 50 });
  const u = await buyer(0);
  for (const paymentTerm of ['cod', 'net7', 'net30', 'net60', 'net90']) {
    const r = await u.call('POST', 'marketplace/orders', { businessId: supplier.b.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'pickup', channel: 'b2b', paymentTerm }, { headers: { 'idempotency-key': key() } });
    assert.equal(r.status, 400, `${paymentTerm}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(await prisma.order.count({ where: { businessId: supplier.b.id } }), 0);
  const u2 = await buyer();
  const ff = await u2.call('POST', 'marketplace/orders', { businessId: supplier.b.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'pickup', fulfillmentOwner: 'jokko' }, { headers: { 'idempotency-key': key() } });
  assert.equal(ff.status, 409);
  assert.equal(ff.body.code, 'fulfillment_not_activated');
  const caps = await u2.call('GET', 'commerce/capabilities');
  const methods = Object.fromEntries(caps.body.paymentMethods.map((m) => [m.key, m.status]));
  assert.equal(methods.softpos_card, 'DORMANT');
  assert.equal(methods.device_tap, 'DORMANT');
  assert.equal(methods.cash, 'ACTIVE');
  assert.equal(caps.body.kabuContract.perMerchantSettlement.status, 'ACTIVE');
});

test('addresses: a home is never public; a customer’s delivery address is shared only with fulfilment roles while the order is active', async () => {
  const m = await shop(['fulfillment', 'cashier']);
  const prod = await m.s.owner.call('POST', `${m.P}/catalog`, { title: 'Gaz 6 kg', priceKori: 400, initialStock: 5 });
  const u = await buyer();
  const home = await u.call('POST', 'addresses', { ownerType: 'user', ownerId: u.id, purpose: 'home', visibility: 'public', city: 'Dakar', commune: 'Grand Yoff', landmark: 'derrière la mosquée', lat: 14.73, lng: -17.45 });
  assert.equal(home.status, 201);
  assert.equal(home.body.visibility, 'private', 'a home cannot be made public');
  const stranger = await signedIn(api, await customer());
  const seen = await stranger.call('GET', `addresses/${home.body.id}`);
  assert.deepEqual(Object.keys(seen.body).sort(), ['city', 'commune', 'country', 'id', 'purpose'].sort(), 'strangers get the area only');
  assert.equal((await stranger.call('POST', 'addresses', { ownerType: 'user', ownerId: u.id, purpose: 'home' })).status, 403);

  const o = await u.call('POST', 'marketplace/orders', { businessId: m.b.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'delivery', dropoff: { area: 'Grand Yoff', address: 'Rue GY-12' }, deliveryAddressId: home.body.id }, { headers: { 'idempotency-key': key() } });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const full = await m.s.fulfillment.call('GET', `addresses/${home.body.id}?orderId=${o.body.orderId}`);
  assert.equal(full.body.landmark, 'derrière la mosquée', 'fulfilment sees what it needs to deliver');
  const cashierView = await m.s.cashier.call('GET', `addresses/${home.body.id}?orderId=${o.body.orderId}`);
  assert.equal(cashierView.body.landmark, undefined, 'a cashier does not');
  const otherShop = await shop(['fulfillment']);
  assert.equal((await otherShop.s.fulfillment.call('GET', `addresses/${home.body.id}?orderId=${o.body.orderId}`)).body.lat, undefined, 'another business never');
  await m.s.owner.call('POST', `${m.P}/orders/${o.body.orderId}/cancel`, { reason: 'test' });
  assert.equal((await m.s.fulfillment.call('GET', `addresses/${home.body.id}?orderId=${o.body.orderId}`)).body.lat, undefined, 'not after the order ends');
  assert.equal((await stranger.call('POST', 'marketplace/orders', { businessId: m.b.id, items: [{ productId: prod.body.id, quantity: 1 }], fulfillmentType: 'delivery', dropoff: { area: 'x', address: 'y' }, deliveryAddressId: home.body.id }, { headers: { 'idempotency-key': key() } })).status, 400, 'nobody orders to someone else’s address id');
});

test('Kabu ↔ Jokko business link: owner code + partner key; no copy of Kabu data; revocable; codes single-use', async () => {
  const m = await shop(['manager']);
  assert.equal((await m.s.manager.call('POST', `${m.P}/integrations/link-code`, {})).status, 403, 'owner only');
  const c = await m.s.owner.call('POST', `${m.P}/integrations/link-code`, {});
  assert.equal(c.status, 201);
  const noKey = await api.client('POST', 'v1/business-links', { body: { code: c.body.code, external_business_id: 'kabu_shop_123' } });
  assert.equal(noKey.status, 401);
  const linked = await api.client('POST', 'v1/business-links', { headers: { 'x-api-key': PARTNER_KEY }, body: { code: c.body.code, external_business_id: 'kabu_shop_123' } });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal((await api.client('POST', 'v1/business-links', { headers: { 'x-api-key': PARTNER_KEY }, body: { code: c.body.code, external_business_id: 'other' } })).status, 404, 'single use');
  const links = await m.s.manager.call('GET', `${m.P}/integrations`);
  assert.equal(links.body[0].externalId, 'kabu_shop_123');
  // The same Kabu shop cannot be silently re-pointed to another Jokko business.
  const other = await shop();
  const c2 = await other.s.owner.call('POST', `${other.P}/integrations/link-code`, {});
  assert.equal((await api.client('POST', 'v1/business-links', { headers: { 'x-api-key': PARTNER_KEY }, body: { code: c2.body.code, external_business_id: 'kabu_shop_123' } })).status, 409);
  assert.equal((await m.s.owner.call('POST', `${m.P}/integrations/${links.body[0].id}/revoke`, {})).status, 200);
});

test('commerce outbox: every order transition commits its event; payloads carry ids/amounts only', async () => {
  const m = await shop(['fulfillment']);
  const prod = await m.s.owner.call('POST', `${m.P}/catalog`, { title: 'Pain', priceKori: 15, initialStock: 100 });
  const u = await buyer();
  const o = await u.call('POST', 'marketplace/orders', { businessId: m.b.id, items: [{ productId: prod.body.id, quantity: 2 }], fulfillmentType: 'pickup' }, { headers: { 'idempotency-key': key() } });
  for (const st of ['preparing', 'ready_for_pickup']) await m.s.fulfillment.call('POST', `${m.P}/orders/${o.body.orderId}/status`, { status: st });
  await u.call('POST', `marketplace/orders/${o.body.orderId}/confirm`, {});
  const ev = await prisma.commerceEvent.findMany({ where: { aggregateId: o.body.orderId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(ev.map((e) => e.type), ['order.paid', 'order.accepted', 'order.ready_for_fulfillment', 'order.completed']);
  for (const e of ev) assert.ok(!/name|phone|handle|address|email/i.test(e.payloadJson), e.payloadJson);
  const order = await prisma.order.findUnique({ where: { id: o.body.orderId } });
  assert.equal(order.fulfillmentOwner, 'merchant');
  assert.equal(order.sourceChannel, 'jokko_app');
  assert.ok(order.inventoryLocationId);
  assert.ok((await prisma.stockMovement.findFirst({ where: { orderId: order.id } })).inventoryLocationId === order.inventoryLocationId);
});

test('demand intelligence leaves a business only as k-anonymous aggregates (k ≥ 5); small cohorts are suppressed', async () => {
  await assert.rejects(demandAggregates({ k: 2 }), /k-anonymity/);
  const category = `cat-${crypto.randomBytes(3).toString('hex')}`;
  const region = `zone-${crypto.randomBytes(3).toString('hex')}`;
  const shops = [];
  for (let i = 0; i < 5; i++) {
    const m = await shop();
    await prisma.business.update({ where: { id: m.b.id }, data: { arrondissement: region } });
    const p = await m.s.owner.call('POST', `${m.P}/catalog`, { title: `Mil ${i}`, priceKori: 10, initialStock: 20, category });
    shops.push({ m, p: p.body });
  }
  const u = await buyer(5000);
  for (const [i, { m, p }] of shops.entries()) {
    if (i === 4) continue; // only 4 businesses sold yet
    await u.call('POST', 'marketplace/orders', { businessId: m.b.id, items: [{ productId: p.id, quantity: 2 }], fulfillmentType: 'pickup' }, { headers: { 'idempotency-key': key() } });
  }
  let agg = await demandAggregates({ since: new Date(Date.now() - 3600_000) });
  assert.equal(agg.demand.find((r) => r.category === category), undefined, '4 businesses: suppressed');
  const u2 = await buyer(5000);
  await u2.call('POST', 'marketplace/orders', { businessId: shops[4].m.b.id, items: [{ productId: shops[4].p.id, quantity: 3 }], fulfillmentType: 'pickup' }, { headers: { 'idempotency-key': key() } });
  agg = await demandAggregates({ since: new Date(Date.now() - 3600_000) });
  const cell = agg.demand.find((r) => r.category === category && r.region === region);
  assert.deepEqual(cell, { category, region, businesses: 5, orders: 5, units: 11 });
  const text = JSON.stringify(agg);
  for (const { m } of shops) assert.ok(!text.includes(m.b.id) && !text.includes(m.b.name), 'no business identity in aggregates');
});
