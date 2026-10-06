/**
 * J7.4, J7.11–J7.13, J7.21–J7.23, J7.26 — reps, territories, restock,
 * reorder suggestions, analytics authorization, demand privacy, scale, and
 * horizontal commerce privacy (merchant↔merchant, supplier↔supplier,
 * distributor↔merchant, rep↔merchant, buyer↔buyer).
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { relationshipsPage, wholesaleDemandAggregates } from '../../lib/b2b/network.js';
import { grantTerms, idemH, member, merchant, submit, supplier, withStepUp } from './fixture.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

test('field rep: only own/assigned relationship cards; no wallet, payroll, customers, orders, invoices, analytics, credentials — on the distributor or the merchant', async () => {
  const sup = await supplier(api);
  const rep = await member(api, sup.b, 'distribution_rep');
  const mine = await merchant(api, sup);
  const notMine = await merchant(api, sup);
  await prisma.merchantRelationship.update({ where: { id: mine.rel.id }, data: { assignedRepUserId: rep.id } });
  await submit(mine, sup, { packs: 1 });

  const rels = await rep.call('GET', `businesses/${sup.b.id}/b2b/relationships`);
  assert.equal(rels.status, 200, JSON.stringify(rels.body));
  assert.deepEqual(rels.body.items.map((r) => r.id), [mine.rel.id]);
  assert.ok(!JSON.stringify(rels.body).match(/balance|wallet|amount|Kori|phone/i), 'relationship card carries no money or contact data');
  const legacy = await rep.call('GET', `businesses/${sup.b.id}/distribution/relationships`);
  assert.deepEqual(legacy.body.map((r) => r.id), [mine.rel.id], 'legacy list scoped the same way');

  const forbidden = [
    `businesses/${sup.b.id}/wallet`, `businesses/${sup.b.id}/os/money`, `businesses/${sup.b.id}/payroll/employees`,
    `businesses/${sup.b.id}/os/customers`, `businesses/${sup.b.id}/os/analytics`, `businesses/${sup.b.id}/b2b/analytics`,
    `businesses/${sup.b.id}/b2b/purchase-orders?side=seller`, `businesses/${sup.b.id}/b2b/invoices?side=seller`, `businesses/${sup.b.id}/b2b/listings`,
    `businesses/${mine.b.id}/wallet`, `businesses/${mine.b.id}/os/money`, `businesses/${mine.b.id}/os/customers`, `businesses/${mine.b.id}/os/orders`,
    `businesses/${mine.b.id}/b2b/purchase-orders`, `businesses/${mine.b.id}/b2b/invoices`, `businesses/${mine.b.id}/b2b/suppliers`,
    `businesses/${mine.b.id}/b2b/suppliers/${sup.b.id}/catalog`, 'distribution/trade-accounts?businessId=' + sup.b.id,
  ];
  for (const path of forbidden) {
    const r = await rep.call('GET', path);
    assert.ok([403, 404].includes(r.status), `${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const po = await prisma.purchaseOrder.findFirst({ where: { buyerBusinessId: mine.b.id } });
  assert.equal((await rep.call('GET', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}`)).status, 404);
  assert.equal((await rep.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/accept`, {})).status, 403);
  // Rep summary: counts of their own book only.
  const sum = await rep.call('GET', `businesses/${sup.b.id}/b2b/rep-summary`);
  assert.deepEqual(sum.body, { relationships: { active: 1 }, ordersFromMyMerchants: 1 });
  // Removed rep: nothing.
  await prisma.businessMember.updateMany({ where: { businessId: sup.b.id, userId: rep.id }, data: { status: 'removed', removedAt: new Date() } });
  assert.equal((await rep.call('GET', `businesses/${sup.b.id}/b2b/relationships`)).status, 403);
  assert.ok(notMine);
});

test('territory is operational, not authority: a territory listing is invisible and unorderable outside it; a territory rep does not gain its merchants', async () => {
  const sup = await supplier(api);
  const t1 = await prisma.territory.create({ data: { distributorBusinessId: sup.b.id, name: 'Pikine' } });
  const t2 = await prisma.territory.create({ data: { distributorBusinessId: sup.b.id, name: 'Rufisque' } });
  const sku = `T1-${crypto.randomBytes(3).toString('hex')}`;
  const tl = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/listings`, { sku, title: 'Riz local — Pikine', priceKori: 700, territoryIds: [t1.id] });
  assert.equal(tl.status, 201, JSON.stringify(tl.body));
  const inT1 = await merchant(api, sup, { territoryId: t1.id });
  const inT2 = await merchant(api, sup, { territoryId: t2.id });
  const see = async (m) => (await m.owner.call('GET', `businesses/${m.b.id}/b2b/suppliers/${sup.b.id}/catalog`)).body.items.map((i) => i.sku);
  assert.ok((await see(inT1)).includes(sku));
  assert.ok(!(await see(inT2)).includes(sku));
  const order = await inT2.owner.call('POST', `businesses/${inT2.b.id}/b2b/purchase-orders`, { sellerBusinessId: sup.b.id, lines: [{ listingId: tl.body.id, packs: 1 }], expectedTotalKori: 700 }, idemH());
  assert.equal(order.status, 404);
  const rep = await member(api, sup.b, 'distribution_rep');
  const assign = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/territories/${t1.id}/reps`, { repUserId: rep.id });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  const rels = await rep.call('GET', `businesses/${sup.b.id}/b2b/relationships`);
  assert.equal(rels.body.items.length, 0, 'covering a territory grants no merchant data');
  const repAssign = await rep.call('POST', `businesses/${sup.b.id}/b2b/territories/${t1.id}/reps`, { repUserId: rep.id });
  assert.equal(repAssign.status, 403, 'a rep cannot assign themselves');
});

test('negotiated prices never leak: price-list buyer pays its price; other buyers see base; a buyer cannot forge a price-list price', async () => {
  const sup = await supplier(api, { priceKori: 1000 });
  const vip = await merchant(api, sup);
  const std = await merchant(api, sup);
  const pl = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/price-lists`, { name: 'Grossistes A', entries: [{ listingId: sup.listing.id, priceKori: 800 }] });
  assert.equal(pl.status, 201, JSON.stringify(pl.body));
  const conf = await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/relationships/${vip.rel.id}/configure`, { priceListId: pl.body.id });
  assert.equal(conf.status, 200);
  const vipCat = (await vip.owner.call('GET', `businesses/${vip.b.id}/b2b/suppliers/${sup.b.id}/catalog`)).body;
  const stdCat = (await std.owner.call('GET', `businesses/${std.b.id}/b2b/suppliers/${sup.b.id}/catalog`)).body;
  assert.equal(vipCat.items[0].priceKori, 800);
  assert.equal(stdCat.items[0].priceKori, 1000);
  assert.ok(!JSON.stringify(stdCat).includes('800'));
  const forged = await submit(std, sup, { packs: 2, expected: 1600 });
  assert.equal(forged.body.code, 'price_changed');
  assert.equal((await submit(vip, sup, { packs: 2, expected: 1600 })).status, 201);
  // Another supplier cannot attach its price list to this relationship, nor configure it.
  const sup2 = await supplier(api);
  const x = await sup2.owner.call('POST', `businesses/${sup2.b.id}/b2b/relationships/${vip.rel.id}/configure`, { priceListId: null });
  assert.equal(x.status, 404);
  const buyerConf = await vip.owner.call('POST', `businesses/${vip.b.id}/b2b/relationships/${vip.rel.id}/configure`, { priceListId: null });
  assert.ok([403, 404, 409].includes(buyerConf.status), 'the buyer cannot change its own price list');
});

test('horizontal privacy: unconnected merchant, other supplier, other buyer — 404/403 on catalog, PO, invoice, returns; analytics only for the supplier’s managers', async () => {
  const sup = await supplier(api);
  const m1 = await merchant(api, sup);
  await grantTerms(sup, m1, { limit: 50_000 });
  const po = (await submit(m1, sup, { term: 'net30', packs: 3 })).body;
  await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/accept`, {});
  for (const to of ['preparing', 'ready']) await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to });
  await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'buyer_pickup' });
  const del = (await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to: 'delivered' })).body;
  const stranger = await merchant(api, sup, { connect: false });
  const m2 = await merchant(api, sup); // connected buyer, but a different one
  const sup2 = await supplier(api);
  const attempts = [
    [stranger, 'GET', `businesses/${stranger.b.id}/b2b/suppliers/${sup.b.id}/catalog`],
    [stranger, 'POST', `businesses/${stranger.b.id}/b2b/quote`, { sellerBusinessId: sup.b.id, lines: [{ listingId: sup.listing.id, packs: 1 }] }],
    [stranger, 'GET', `businesses/${stranger.b.id}/b2b/purchase-orders/${po.id}`],
    [stranger, 'GET', `businesses/${m1.b.id}/b2b/purchase-orders/${po.id}`],
    [m2, 'GET', `businesses/${m2.b.id}/b2b/purchase-orders/${po.id}`],
    [m2, 'GET', `businesses/${m2.b.id}/b2b/invoices/${del.invoiceId}`],
    [m2, 'POST', `businesses/${m2.b.id}/b2b/invoices/${del.invoiceId}/pay`, { amountKori: 100 }],
    [m2, 'POST', `businesses/${m2.b.id}/b2b/purchase-orders/${po.id}/buyer`, { action: 'receive' }],
    [m2, 'POST', `businesses/${m2.b.id}/b2b/purchase-orders/${po.id}/returns`, { lines: [{ listingId: sup.listing.id, packs: 1 }], reason: 'tentative' }],
    [sup2, 'GET', `businesses/${sup2.b.id}/b2b/purchase-orders/${po.id}`],
    [sup2, 'GET', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}`],
    [sup2, 'POST', `businesses/${sup2.b.id}/b2b/invoices/${del.invoiceId}/credit-memos`, { amountKori: 100, reason: 'tentative', reference: 'XSUP-1' }],
    [sup2, 'GET', `businesses/${sup.b.id}/b2b/analytics`],
    [m1, 'GET', `businesses/${sup.b.id}/b2b/analytics`],
    [m1, 'GET', `businesses/${sup.b.id}/b2b/purchase-orders?side=seller`],
    [sup, 'GET', `businesses/${m1.b.id}/b2b/purchase-orders`],
    [sup, 'GET', `businesses/${m1.b.id}/b2b/suppliers`],
    [sup, 'GET', `businesses/${m1.b.id}/wallet`],
  ];
  for (const [who, method, path, body] of attempts) {
    const extra = method === 'POST' ? await withStepUp(who.owner ?? who) : undefined;
    const r = await (who.owner ?? who).call(method, path, body, extra);
    assert.ok([403, 404].includes(r.status), `${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  const an = await sup.owner.call('GET', `businesses/${sup.b.id}/b2b/analytics`);
  assert.equal(an.status, 200, JSON.stringify(an.body));
  assert.equal(an.body.receivables.outstandingKori, 3000);
  assert.ok(!JSON.stringify(an.body).match(/buyerBusinessId|merchantBusinessId|phone|handle/), 'aggregates carry no merchant identifiers');
  // The supplier's own buyer-side and seller-side lists never mix.
  const asBuyer = await sup.owner.call('GET', `businesses/${sup.b.id}/b2b/purchase-orders`);
  assert.equal(asBuyer.body.items.length, 0);
});

test('restock home + evidence-based reorder suggestions (no auto-order, no false certainty)', async () => {
  const sup = await supplier(api);
  const m = await merchant(api, sup, { fund: 100_000 });
  await grantTerms(sup, m, { limit: 50_000 });
  const home = await m.owner.call('GET', `businesses/${m.b.id}/b2b/suppliers`);
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.equal(home.body.suppliers[0].supplierBusinessId, sup.b.id);
  assert.deepEqual(home.body.suppliers[0].terms, ['due_now', 'net30']);
  assert.equal(home.body.suppliers[0].availableCreditKori, 50_000);
  // No history → no suggestion.
  assert.deepEqual((await m.owner.call('GET', `businesses/${m.b.id}/b2b/suppliers/${sup.b.id}/reorder`)).body.suggestions, []);
  // Three delivered orders 10 days apart, the last one 12 days ago.
  for (const [i, packs] of [[34, 4], [24, 6], [12, 5]]) {
    const po = (await submit(m, sup, { term: 'net30', packs })).body;
    await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/accept`, {});
    for (const to of ['preparing', 'ready']) await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to });
    await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'buyer_pickup' });
    await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to: 'delivered' });
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { deliveredAt: new Date(Date.now() - i * 86_400_000) } });
  }
  const before = await prisma.purchaseOrder.count({ where: { buyerBusinessId: m.b.id } });
  const s = (await m.owner.call('GET', `businesses/${m.b.id}/b2b/suppliers/${sup.b.id}/reorder`)).body;
  assert.equal(s.autoOrder, false);
  assert.equal(s.suggestions.length, 1);
  assert.equal(s.suggestions[0].suggestedPacks, 5);
  assert.equal(s.suggestions[0].confidence, 'low');
  assert.deepEqual(s.suggestions[0].evidence, { deliveredOrders: 3, averagePacks: 5, averageDaysBetween: 11, daysSinceLast: 12, windowDays: 180 });
  assert.equal(await prisma.purchaseOrder.count({ where: { buyerBusinessId: m.b.id } }), before, 'a suggestion never creates an order');
});

test('wholesale demand aggregates: k = 10 buyers AND ≥ 3 sellers per cell; no identifiers', async () => {
  const cat = `cat-${crypto.randomBytes(3).toString('hex')}`;
  const owner = await prisma.user.findFirst();
  const mk = (data) => prisma.business.create({ data: { ownerId: owner.id, name: `B ${crypto.randomBytes(3).toString('hex')}`, type: 'merchant', arrondissement: 'Pikine', ...data } });
  const sellers = await Promise.all([0, 1, 2].map(() => mk({ operatingMode: 'distribution' })));
  const listings = await Promise.all(sellers.map((s) => prisma.wholesaleListing.create({ data: { sellerBusinessId: s.id, sku: `S-${crypto.randomBytes(3).toString('hex')}`, title: 'x', category: cat, priceKori: 100, createdBy: owner.id } })));
  const order = async (buyer, i) => {
    const po = await prisma.purchaseOrder.create({ data: { reference: `PO-T${crypto.randomBytes(5).toString('hex')}`, buyerBusinessId: buyer.id, sellerBusinessId: sellers[i % 3].id, status: 'submitted', paymentTerm: 'due_now', subtotalKori: 100, totalKori: 100, submittedBy: owner.id } });
    await prisma.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, listingId: listings[i % 3].id, sku: 'x', title: 'x', unit: 'pack', unitsPerPack: 1, packs: 1, unitPriceKori: 100, lineTotalKori: 100, priceSource: 'base' } });
  };
  const buyers = [];
  for (let i = 0; i < 9; i++) buyers.push(await mk({}));
  for (const [i, b] of buyers.entries()) await order(b, i);
  let agg = await wholesaleDemandAggregates();
  assert.ok(!agg.demand.some((d) => d.category === cat), '9 buyers: suppressed');
  const tenth = await mk({});
  await order(tenth, 9);
  agg = await wholesaleDemandAggregates();
  const cell = agg.demand.find((d) => d.category === cat);
  assert.deepEqual(cell, { category: cat, region: 'Pikine', buyers: 10, orders: 10, packs: 10 });
  assert.ok(!JSON.stringify(agg).match(/c[a-z0-9]{24}/), 'no ids');
  await assert.rejects(wholesaleDemandAggregates({ k: 5 }), /≥ 10/);
});

test('scale: 2,000 relationships page through with a cursor, no duplicates, bounded pages; rep sees only theirs', async () => {
  const sup = await supplier(api);
  const rep = await member(api, sup.b, 'distribution_rep');
  const owner = await prisma.user.findFirst();
  const merchants = Array.from({ length: 2000 }, () => ({ id: `cm${crypto.randomBytes(11).toString('hex')}`, ownerId: owner.id, name: 'M', type: 'merchant' }));
  await prisma.business.createMany({ data: merchants });
  await prisma.merchantRelationship.createMany({ data: merchants.map((m, i) => ({ distributorBusinessId: sup.b.id, merchantBusinessId: m.id, introducedByUserId: i < 7 ? rep.id : sup.ownerC.id, status: 'active' })) });
  const seen = new Set();
  let cursor;
  let pages = 0;
  const t0 = Date.now();
  do {
    const r = await sup.owner.call('GET', `businesses/${sup.b.id}/b2b/relationships?limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length <= 200);
    for (const it of r.body.items) seen.add(it.id);
    cursor = r.body.nextCursor;
    pages += 1;
  } while (cursor && pages < 20);
  assert.equal(seen.size, 2000);
  assert.equal(pages, 10);
  const ms = Date.now() - t0;
  assert.ok(ms < 30_000, `paging took ${ms} ms`);
  const repPage = await relationshipsPage(rep.id, sup.b.id, { limit: 200 });
  assert.equal(repPage.items.length, 7);
  const plan = await prisma.$queryRawUnsafe(`EXPLAIN SELECT * FROM "MerchantRelationship" WHERE "distributorBusinessId" = '${sup.b.id}' AND status = 'active' ORDER BY id LIMIT 201`);
  assert.ok(JSON.stringify(plan).match(/Index/), `index used: ${JSON.stringify(plan)}`);
});
