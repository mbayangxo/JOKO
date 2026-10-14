/**
 * J14-S3 — partner product mapping (ExternalLink objectType=product) over real HTTP, production mode.
 * Consented business links (owner one-time code + partner key), then the partner maps ITS product ids to Jokko
 * products of THAT business. Ids only, no catalog copy. Authorization, idempotency, concurrency, isolation.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { resolveExternalProduct } from '../../lib/integrations/product-links.js';
import { business, customer, signedIn } from '../j3/helpers.js';

const KEBU = `s3-kebu-${crypto.randomBytes(8).toString('hex')}`;
const RECT = `s3-rect-${crypto.randomBytes(8).toString('hex')}`;
let api;
before(async () => { api = await startApiServer({ JOKO_API_KEYS: `kebu:${KEBU},rect:${RECT}`, PARTNER_PRODUCT_MAPPING_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const hex = () => crypto.randomBytes(4).toString('hex');
const as = (key) => ({ headers: { 'x-api-key': key } });
const map = (key, body) => api.client('POST', 'v1/product-links', { ...as(key), body });

async function linkedShop(partnerKey = KEBU) {
  const owner = await customer();
  const b = await business(owner.user);
  const s = await signedIn(api, owner);
  const code = await s.call('POST', `businesses/${b.id}/os/integrations/link-code`, {});
  const ext = `shop_${hex()}`;
  const l = await api.client('POST', 'v1/business-links', { ...as(partnerKey), body: { code: code.body.code, external_business_id: ext } });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  const product = (over = {}) => prisma.product.create({ data: { businessId: b.id, title: `P ${hex()}`, price: 1500, sku: `SKU-${hex()}`, ...over } });
  return { b, s, ext, product };
}

test('disabled by default: without PARTNER_PRODUCT_MAPPING_ENABLED every product-link route answers 403 disabled', async () => {
  const off = await startApiServer({ JOKO_API_KEYS: `kebu:${KEBU}` });
  try {
    const r = await off.client('POST', 'v1/product-links', { ...as(KEBU), body: { external_business_id: 'x', external_product_id: 'y', jokko_product_id: 'z' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'disabled');
    assert.equal((await off.client('GET', 'v1/product-links?external_business_id=x', as(KEBU))).body.code, 'disabled');
  } finally {
    await off.stop();
  }
});

test('map by id and by SKU; idempotent; re-pointing refused; unlink then re-map; ids only (no catalog copy)', async () => {
  const shop = await linkedShop();
  const p1 = await shop.product();
  const p2 = await shop.product();
  const a = await map(KEBU, { external_business_id: shop.ext, external_product_id: 'kabu-1', jokko_product_id: p1.id });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual(Object.keys(a.body).sort(), ['created_at', 'external_business_id', 'external_product_id', 'id', 'jokko_product_id', 'revoked_at', 'status']);
  assert.ok(!JSON.stringify(a.body).includes(p1.title) && !JSON.stringify(a.body).includes('1500'), 'no title / price crosses');
  const again = await map(KEBU, { external_business_id: shop.ext, external_product_id: 'kabu-1', jokko_product_id: p1.id });
  assert.deepEqual([again.status, again.body.id], [200, a.body.id], 'idempotent');
  const repoint = await map(KEBU, { external_business_id: shop.ext, external_product_id: 'kabu-1', jokko_product_id: p2.id });
  assert.equal(repoint.status, 409);
  assert.equal(repoint.body.code, 'already_mapped');
  const bySku = await map(KEBU, { external_business_id: shop.ext, external_product_id: 'kabu-2', jokko_sku: p2.sku });
  assert.equal(bySku.status, 201);
  assert.equal(bySku.body.jokko_product_id, p2.id);
  const un = await api.client('POST', `v1/product-links/${a.body.id}/unlink`, { ...as(KEBU), body: {} });
  assert.deepEqual([un.status, un.body.status], [200, 'revoked']);
  assert.equal(await resolveExternalProduct(prisma, 'kebu', shop.ext, 'kabu-1'), null, 'unlinked never resolves');
  const remap = await map(KEBU, { external_business_id: shop.ext, external_product_id: 'kabu-1', jokko_product_id: p2.id });
  assert.equal(remap.status, 201);
  assert.equal(remap.body.id, a.body.id, 'same row reactivated');
  assert.deepEqual(await resolveExternalProduct(prisma, 'kebu', shop.ext, 'kabu-1'), { productId: p2.id, businessId: shop.b.id });
  const list = await api.client('GET', `v1/product-links?external_business_id=${shop.ext}`, as(KEBU));
  assert.equal(list.body.links.length, 2);
});

test('only the linked business\'s products: another business\'s product, an unlinked shop, a revoked link → 404, nothing stored', async () => {
  const shop = await linkedShop();
  const other = await linkedShop();
  const foreign = await other.product();
  const r = await map(KEBU, { external_business_id: shop.ext, external_product_id: 'x1', jokko_product_id: foreign.id });
  assert.deepEqual([r.status, r.body.code], [404, 'product_not_found']);
  const sku = await map(KEBU, { external_business_id: shop.ext, external_product_id: 'x2', jokko_sku: foreign.sku });
  assert.equal(sku.status, 404, 'a SKU only resolves inside the linked business');
  assert.equal((await map(KEBU, { external_business_id: `shop_${hex()}`, external_product_id: 'x3', jokko_product_id: foreign.id })).status, 404);
  const p = await shop.product();
  const ok = await map(KEBU, { external_business_id: shop.ext, external_product_id: 'x4', jokko_product_id: p.id });
  assert.equal(ok.status, 201);
  // The OWNER revokes the business link in Jokko → mapping and resolution stop at once.
  const links = await shop.s.call('GET', `businesses/${shop.b.id}/os/integrations`);
  const biz = links.body.find((l) => l.objectType === 'business');
  assert.ok(links.body.some((l) => l.objectType === 'product'), 'the owner sees product links');
  assert.equal((await shop.s.call('POST', `businesses/${shop.b.id}/os/integrations/${biz.id}/revoke`, {})).status, 200);
  assert.equal(await resolveExternalProduct(prisma, 'kebu', shop.ext, 'x4'), null);
  assert.equal((await map(KEBU, { external_business_id: shop.ext, external_product_id: 'x5', jokko_product_id: p.id })).status, 404);
  assert.equal(await prisma.externalLink.count({ where: { objectType: 'product', externalId: { in: [`${shop.ext}::x1`, `${shop.ext}::x2`, `${shop.ext}::x5`] } } }), 0);
});

test('owner revokes ONE product link in Jokko → it no longer resolves; the partner cannot silently re-point it elsewhere either', async () => {
  const shop = await linkedShop();
  const p = await shop.product();
  const a = await map(KEBU, { external_business_id: shop.ext, external_product_id: 'own-1', jokko_product_id: p.id });
  assert.equal((await shop.s.call('POST', `businesses/${shop.b.id}/os/integrations/${a.body.id}/revoke`, {})).status, 200);
  assert.equal(await resolveExternalProduct(prisma, 'kebu', shop.ext, 'own-1'), null);
});

test('cross-partner isolation: another partner cannot map into my shop, list my links or unlink them', async () => {
  const shop = await linkedShop(KEBU);
  const p = await shop.product();
  const a = await map(KEBU, { external_business_id: shop.ext, external_product_id: 'iso-1', jokko_product_id: p.id });
  assert.equal((await map(RECT, { external_business_id: shop.ext, external_product_id: 'iso-2', jokko_product_id: p.id })).status, 404);
  assert.equal((await api.client('GET', `v1/product-links?external_business_id=${shop.ext}`, as(RECT))).status, 404);
  assert.equal((await api.client('POST', `v1/product-links/${a.body.id}/unlink`, { ...as(RECT), body: {} })).status, 404);
  assert.equal((await prisma.externalLink.findUnique({ where: { id: a.body.id } })).status, 'active');
  assert.equal((await api.client('POST', 'v1/product-links', { body: {} })).status, 401);
});

test('namespacing: two shops reusing the same SKU string map to their own products', async () => {
  const s1 = await linkedShop();
  const s2 = await linkedShop();
  const p1 = await s1.product();
  const p2 = await s2.product();
  assert.equal((await map(KEBU, { external_business_id: s1.ext, external_product_id: 'SAME', jokko_product_id: p1.id })).status, 201);
  assert.equal((await map(KEBU, { external_business_id: s2.ext, external_product_id: 'SAME', jokko_product_id: p2.id })).status, 201);
  assert.equal((await resolveExternalProduct(prisma, 'kebu', s1.ext, 'SAME')).productId, p1.id);
  assert.equal((await resolveExternalProduct(prisma, 'kebu', s2.ext, 'SAME')).productId, p2.id);
  assert.equal(await resolveExternalProduct(prisma, 'rect', s1.ext, 'SAME'), null, 'another partner never resolves it');
});

test('concurrency: identical parallel maps → one row; parallel maps of one external id to different products → exactly one wins', async () => {
  const shop = await linkedShop();
  const p = await shop.product();
  const same = await Promise.all(Array.from({ length: 6 }, () => map(KEBU, { external_business_id: shop.ext, external_product_id: 'race-1', jokko_product_id: p.id })));
  assert.ok(same.every((r) => [200, 201].includes(r.status)), same.map((r) => r.status).join(','));
  assert.equal(new Set(same.map((r) => r.body.id)).size, 1);
  assert.equal(same.filter((r) => r.status === 201).length, 1, 'created once');
  const prods = await Promise.all(Array.from({ length: 5 }, () => shop.product()));
  const race = await Promise.all(prods.map((x) => map(KEBU, { external_business_id: shop.ext, external_product_id: 'race-2', jokko_product_id: x.id })));
  assert.equal(race.filter((r) => r.status === 201).length, 1, race.map((r) => r.status).join(','));
  assert.equal(race.filter((r) => r.status === 409).length, 4);
  assert.equal(await prisma.externalLink.count({ where: { system: 'kebu', objectType: 'product', externalId: `${shop.ext}::race-2` } }), 1);
});

test('validation: missing / malformed ids are refused', async () => {
  const shop = await linkedShop();
  for (const body of [{ external_business_id: shop.ext }, { external_business_id: shop.ext, external_product_id: 'a::b', jokko_product_id: 'x' }, { external_business_id: shop.ext, external_product_id: 'ok' }, { external_product_id: 'ok', jokko_product_id: 'x' }]) {
    const r = await map(KEBU, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
  }
});
