/**
 * J14-S2 — partner fulfilment requests → Jokko Logistics (J8), real HTTP, production mode.
 * Linked business (owner code), mapped products (S3), zero-fee modes only (no money moves), idempotent per
 * partner order, cross-partner / cross-business refused, status back through S1 for the partner's own
 * shipments only. J2 and J8 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { business, customer, signedIn } from '../j3/helpers.js';

process.env.PARTNER_EVENTS_ENABLED = 'true';
process.env.PARTNER_EVENTS_ALLOW_LOCAL = 'true';
const DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.DATA_ENCRYPTION_KEY = DATA_ENCRYPTION_KEY;
const PE = await import('../../lib/integrations/partner-events.js');

const KEBU = `s2-kebu-${crypto.randomBytes(8).toString('hex')}`;
const RECT = `s2-rect-${crypto.randomBytes(8).toString('hex')}`;
let api;
let receiver;
const got = [];
const FLAGS = { PARTNER_PRODUCT_MAPPING_ENABLED: 'true', PARTNER_FULFILLMENT_ENABLED: 'true', PARTNER_EVENTS_ENABLED: 'true', PARTNER_EVENTS_ALLOW_LOCAL: 'true', DATA_ENCRYPTION_KEY };

before(async () => {
  receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { got.push(JSON.parse(raw)); res.writeHead(200); res.end(); });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  api = await startApiServer({ JOKO_API_KEYS: `kebu:${KEBU},rect:${RECT}`, ...FLAGS });
});
after(async () => { await Promise.all([api?.stop(), new Promise((r) => receiver.close(r))]); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
});

const hex = () => crypto.randomBytes(4).toString('hex');
const as = (key) => ({ headers: { 'x-api-key': key } });
const request = (key, body) => api.client('POST', 'v1/fulfillment-requests', { ...as(key), body });

async function mappedShop(partnerKey = KEBU) {
  const owner = await customer();
  const b = await business(owner.user);
  const s = await signedIn(api, owner);
  const code = await s.call('POST', `businesses/${b.id}/os/integrations/link-code`, {});
  const ext = `shop_${hex()}`;
  assert.equal((await api.client('POST', 'v1/business-links', { ...as(partnerKey), body: { code: code.body.code, external_business_id: ext } })).status, 201);
  const p = await prisma.product.create({ data: { businessId: b.id, title: 'Riz 5 kg', price: 4000, sku: `R-${hex()}` } });
  const m = await api.client('POST', 'v1/product-links', { ...as(partnerKey), body: { external_business_id: ext, external_product_id: 'kabu-riz', jokko_product_id: p.id } });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  return { b, s, ext, p, owner };
}
const order = (shop, over = {}) => ({ external_business_id: shop.ext, external_order_id: `ord_${hex()}`, mode: 'merchant_fleet', lines: [{ external_product_id: 'kabu-riz', qty: 2 }], destination: { area: 'Médina', precise: 'Rue 6 x 11, porte bleue' }, ...over });
const walletTotals = async () => {
  const [w, bw] = await Promise.all([prisma.wallet.aggregate({ _sum: { balance: true, koriBalance: true } }), prisma.businessWallet.aggregate({ _sum: { balance: true } })]);
  return [w._sum.balance, w._sum.koriBalance, bw._sum.balance];
};

test('disabled by default: without PARTNER_FULFILLMENT_ENABLED the route answers 403 disabled', async () => {
  const off = await startApiServer({ JOKO_API_KEYS: `kebu:${KEBU}` });
  try {
    const r = await off.client('POST', 'v1/fulfillment-requests', { ...as(KEBU), body: { external_business_id: 'a', external_order_id: 'b', mode: 'merchant_fleet', lines: [] } });
    assert.deepEqual([r.status, r.body.code], [403, 'disabled']);
  } finally {
    await off.stop();
  }
});

test('a linked shop\'s order becomes ONE J8 request + shipment (by reference); retries are idempotent; no money moves', async () => {
  const shop = await mappedShop();
  const before = await walletTotals();
  const body = order(shop);
  const r = await request(KEBU, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'merchant_fleet');
  assert.equal(r.body.shipment.status, 'ready_for_pickup');
  assert.ok(!JSON.stringify(r.body).includes('porte bleue'), 'destination never echoed back');
  const again = await Promise.all([request(KEBU, body), request(KEBU, body), request(KEBU, body)]);
  assert.ok(again.every((x) => x.status === 200 && x.body.reference === r.body.reference), again.map((x) => x.status).join(','));
  const fr = await prisma.fulfilmentRequest.findMany({ where: { sourceSystem: 'kabu', sourceId: `${shop.ext}:${body.external_order_id}` } });
  assert.equal(fr.length, 1);
  assert.deepEqual([fr[0].originBusinessId, fr[0].fulfilmentOwner, fr[0].feeKori, fr[0].feeStatus], [shop.b.id, 'MERCHANT_FULFILLED', 0, 'none']);
  assert.equal(await prisma.shipment.count({ where: { requestId: fr[0].id } }), 1);
  const sh = await prisma.shipment.findFirst({ where: { requestId: fr[0].id } });
  const pkg = await prisma.shipmentPackage.findFirst({ where: { shipmentId: sh.id } });
  assert.deepEqual(JSON.parse(pkg.linesJson).map((l) => [l.productId, l.qty]), [[shop.p.id, 2]], 'lines resolved through the product mapping');
  assert.deepEqual(await walletTotals(), before, 'no balance anywhere changed');
  const get = await api.client('GET', `v1/fulfillment-requests/${r.body.reference}`, as(KEBU));
  assert.deepEqual([get.status, get.body.external_order_id], [200, body.external_order_id]);
});

test('JOKKO_LOGISTICS (fee from the business wallet) is refused for partners — D-J14-1; nothing created', async () => {
  const shop = await mappedShop();
  const body = order(shop, { mode: 'jokko_logistics' });
  const r = await request(KEBU, body);
  assert.deepEqual([r.status, r.body.code], [409, 'requires_merchant_approval']);
  assert.equal(await prisma.fulfilmentRequest.count({ where: { sourceId: `${shop.ext}:${body.external_order_id}` } }), 0);
});

test('unmapped products, unlinked / revoked / foreign business, suspended business → refused, nothing created', async () => {
  const shop = await mappedShop();
  const un = await request(KEBU, order(shop, { lines: [{ external_product_id: 'kabu-riz', qty: 1 }, { external_product_id: 'not-mapped', qty: 1 }] }));
  assert.deepEqual([un.status, un.body.code, un.body.unmapped], [422, 'product_not_mapped', ['not-mapped']]);
  assert.equal((await request(KEBU, order(shop, { external_business_id: `shop_${hex()}` }))).status, 404);
  assert.equal((await request(RECT, order(shop))).status, 404, 'another partner cannot use my linked shop');
  await prisma.business.update({ where: { id: shop.b.id }, data: { status: 'suspended' } });
  const sus = await request(KEBU, order(shop));
  assert.deepEqual([sus.status, sus.body.code], [409, 'business_inactive']);
  await prisma.business.update({ where: { id: shop.b.id }, data: { status: 'active' } });
  const links = await shop.s.call('GET', `businesses/${shop.b.id}/os/integrations`);
  await shop.s.call('POST', `businesses/${shop.b.id}/os/integrations/${links.body.find((l) => l.objectType === 'business').id}/revoke`, {});
  assert.equal((await request(KEBU, order(shop))).status, 404, 'revoked link');
  assert.equal(await prisma.fulfilmentRequest.count({ where: { originBusinessId: shop.b.id } }), 0);
});

test('isolation: another partner cannot read my request; a Jokko-native request is invisible to partners', async () => {
  const shop = await mappedShop();
  const r = await request(KEBU, order(shop));
  assert.equal((await api.client('GET', `v1/fulfillment-requests/${r.body.reference}`, as(RECT))).status, 404);
  const native = await prisma.fulfilmentRequest.create({ data: { reference: `FR-N${hex()}`, sourceSystem: 'jokko_order', sourceId: `o_${hex()}`, sourceKey: `jokko_order:o_${hex()}:outbound`, fulfilmentOwner: 'MERCHANT_FULFILLED', fulfillerBusinessId: shop.b.id, originBusinessId: shop.b.id, createdBy: shop.owner.user.id } });
  assert.equal((await api.client('GET', `v1/fulfillment-requests/${native.reference}`, as(KEBU))).status, 404, 'a Jokko-native request of the SAME linked shop stays invisible');
  assert.equal((await api.client('POST', 'v1/fulfillment-requests', { body: {} })).status, 401);
});

test('validation: bad modes, empty / oversized / malformed lines, missing destination for the merchant fleet', async () => {
  const shop = await mappedShop();
  for (const over of [{ mode: 'drone' }, { lines: [] }, { lines: [{ external_product_id: 'kabu-riz', qty: 0 }] }, { lines: Array.from({ length: 101 }, () => ({ external_product_id: 'kabu-riz', qty: 1 })) }, { destination: {} }, { external_order_id: 'a:b' }]) {
    const r = await request(KEBU, order(shop, over));
    assert.ok(r.status === 400, `${JSON.stringify(over).slice(0, 60)} → ${r.status} ${r.body.code}`);
  }
});

test('status back through S1: the partner receives shipment.created and shipment.cancelled for ITS shipment only', async () => {
  await prisma.partnerEventSubscription.updateMany({ where: { status: 'active' }, data: { status: 'disabled' } });
  const sub = await api.client('POST', 'v1/event-subscriptions', { ...as(KEBU), body: { url: `http://127.0.0.1:${receiver.address().port}/h`, event_types: ['shipment.created', 'shipment.cancelled'] } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  const shop = await mappedShop();
  const r = await request(KEBU, order(shop));
  const sh = await prisma.shipment.findFirst({ where: { reference: r.body.shipment.reference } });
  // A Jokko-native shipment of the SAME linked business must not reach the partner.
  const nativeReq = await prisma.fulfilmentRequest.create({ data: { reference: `FR-N${hex()}`, sourceSystem: 'jokko_order', sourceId: `o_${hex()}`, sourceKey: `jokko_order:o_${hex()}:outbound`, fulfilmentOwner: 'MERCHANT_FULFILLED', fulfillerBusinessId: shop.b.id, originBusinessId: shop.b.id, createdBy: shop.owner.user.id } });
  const nativeSh = await prisma.shipment.create({ data: { reference: `SH-N${hex()}`, requestId: nativeReq.id, status: 'ready_for_pickup' } });
  await prisma.$transaction((tx) => tx.commerceEvent.create({ data: { type: 'shipment.created', businessId: shop.b.id, aggregateType: 'shipment', aggregateId: nativeSh.id, payloadJson: '{}' } }));
  const c = await shop.s.call('POST', `logistics/shipments/${sh.id}/cancel`, { reason: 'client a annulé' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  got.length = 0;
  await PE.fanOutEvents(prisma);
  await PE.deliverDue(prisma, { limit: 500 });
  const mine = got.filter((e) => e.object?.jokko_id === sh.id).map((e) => e.type).sort();
  assert.deepEqual(mine, ['shipment.cancelled', 'shipment.created']);
  assert.ok(got.every((e) => e.object?.jokko_id !== nativeSh.id), 'a shipment the partner did not request never leaves Jokko');
  const cancelled = got.find((e) => e.type === 'shipment.cancelled' && e.object.jokko_id === sh.id);
  assert.equal(cancelled.business.external_id, shop.ext);
  assert.ok(!JSON.stringify(got).includes('porte bleue'), 'no destination in events');
  const status = await api.client('GET', `v1/fulfillment-requests/${r.body.reference}`, as(KEBU));
  assert.equal(status.body.shipment.status, 'cancelled');
});
