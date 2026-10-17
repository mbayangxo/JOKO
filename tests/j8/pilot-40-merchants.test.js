/**
 * J8 internal-pilot scenario (deterministic): 1 distributor, 1 dispatch depot,
 * 40 merchants, 40 separate purchase orders (due-now and net-30 mixed), 1 planned
 * route of 40 stops with one driver, a second driver for re-deliveries, and 40
 * independently verified merchant receiving events.
 *
 * Outcome mix (by merchant index mod 10):
 *   0 full at the door            5 partial refusal (6 refused, rest received)
 *   1 partial (2 missing)         6 WRONG-MERCHANT code attempt first, then the right code
 *   2 damaged (3)                 7 network retry: the same delivery submitted twice
 *   3 refused entirely            8 failed (merchant closed) → back to depot → re-delivered (route 2)
 *   4 code delivery + DUPLICATE   9 mixed: 1 missing + 2 damaged
 *     receiving confirmation
 *
 * Proven: delivered never means "accepted every item"; stock and money are
 * conserved; each order keeps its own invoice / payment; the routes reconcile to
 * zero unaccounted units; J2 and custody invariants hold.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { bizBal, grantTerms, merchant, submit, supplier, withStepUp } from '../j7/fixture.js';
import { fleetDriver, shipmentFor, stockAt } from './fixture.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

const N = 40;
/**
 * D42: the distributor uses BATCH endpoints and the dispatch budget — no account-wide
 * limiter is cleared, and the test asserts at the end that no account was ever blocked.
 * The only "time passes" step: a script enters a driver's custody codes faster than a
 * human can (custody budget 60/min); between stops we reset that one budget window.
 */
const pace = () => prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'user-custody:' } } });
const ok = (r, what = '') => {
  assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

test('40-merchant distribution pilot: one route, 40 verified receivings, conservation of goods and money, separate invoices', { timeout: 900_000 }, async () => {
  const START = 3000;
  const sup = await supplier(api, { stock: START, unitsPerPack: 12, priceKori: 1000 });
  const P = (path) => `businesses/${sup.b.id}/b2b/${path}`;
  const drv1 = await fleetDriver(api, sup.b);
  const drv2 = await fleetDriver(api, sup.b);
  const supBefore = await bizBal(sup.b.id);

  // ── 40 merchants, 40 orders ─────────────────────────────────────────────
  const ms = [];
  for (let i = 0; i < N; i += 1) {
    const m = await merchant(api, sup);
    const term = i % 4 === 3 ? 'net30' : 'due_now';
    if (term === 'net30') await grantTerms(sup, m, { term: 'net30', limit: 100_000 });
    const packs = 1 + (i % 3); // 12 / 24 / 36 units
    const po = ok(await submit(m, sup, { packs, term }), `submit ${i}`);
    // Half the merchants already mapped the supplier's product to their OWN product (D40).
    let own = null;
    if (i % 2 === 0) {
      own = await prisma.product.create({ data: { businessId: m.b.id, title: `Huile — rayon ${i}`, price: 1500, inventory: 0 } });
      await prisma.buyerProductMapping.create({ data: { buyerBusinessId: m.b.id, sellerBusinessId: sup.b.id, sellerProductId: sup.product.id, buyerProductId: own.id, createdBy: m.owner.id } });
    }
    ms.push({ i, m, po, term, units: packs * 12, own });
  }
  assert.equal(new Set(ms.map((x) => x.po.id)).size, N, '40 separate commercial orders');

  // Accept all 40 in one batch (per-item authorization), merchants pay their own, then pick / ready / hand off in batches.
  const batch = async (items) => {
    const r = ok(await sup.owner.call('POST', P('purchase-orders/batch'), { items }), 'batch');
    assert.ok(r.items.every((i) => !i.error), JSON.stringify(r.items.filter((i) => i.error).slice(0, 3)));
  };
  await batch(ms.map((x) => ({ poId: x.po.id, action: 'accept' })));
  for (const x of ms) {
    if (x.term === 'due_now') ok(await x.m.owner.call('POST', `businesses/${x.m.b.id}/b2b/purchase-orders/${x.po.id}/pay`, { expectedAmountKori: x.po.totalKori }, await withStepUp(x.m.owner)), `pay ${x.i}`);
  }
  await batch(ms.map((x) => ({ poId: x.po.id, action: 'advance', to: 'preparing' })));
  await batch(ms.map((x) => ({ poId: x.po.id, action: 'advance', to: 'ready' })));
  await batch(ms.map((x) => ({ poId: x.po.id, action: 'advance', to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true })));
  for (const x of ms) {
    x.sh = await shipmentFor(x.po.id);
    assert.ok(x.sh, `shipment ${x.i}`);
  }
  const dispatched1 = ms.reduce((n, x) => n + x.units, 0);
  assert.equal((await stockAt(sup.depot.id, sup.product.id)).onHand, START - dispatched1, 'dispatch decremented once per order');

  // ── one planned route: 40 stops, driver 1 (the dispatcher's order) ─────
  await pace();
  const route1 = ok(await sup.owner.call('POST', `businesses/${sup.b.id}/logistics/routes`, { serviceDate: new Date().toISOString(), driverUserId: drv1.id, shipmentIds: ms.map((x) => x.sh.id) }), 'route 1');
  assert.equal(route1.stops.filter((s) => s.assigned).length, N);

  // Loading: the depot gives each pickup code; a network retry (same code twice) never double-picks.
  const codes = ok(await sup.owner.call('POST', 'logistics/shipments/batch/codes', { shipmentIds: ms.map((x) => x.sh.id), purpose: 'pickup' }), 'codes for the load');
  for (const x of ms) {
    await pace();
    const pc = codes.items.find((c) => c.shipmentId === x.sh.id);
    ok(await drv1.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code }), `pickup ${x.i}`);
    if (x.i % 10 === 7) assert.equal(ok(await drv1.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code })).replayed, true);
  }
  assert.equal(await prisma.shipmentEvent.count({ where: { shipmentId: { in: ms.map((x) => x.sh.id) }, toStatus: 'picked_up' } }), N);

  // ── the round ───────────────────────────────────────────────────────────
  const pid = sup.product.id;
  const receive = (x, line) => x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/receiving`, { lines: [{ productId: pid, ...line }] });
  const refusalReturns = [];
  for (const x of ms) {
    await pace();
    const u = x.units;
    const kind = x.i % 10;
    if (kind === 8) {
      ok(await drv1.call('POST', `logistics/shipments/${x.sh.id}/fail`, { reason: 'merchant_closed' }));
      ok(await drv1.call('POST', `logistics/shipments/${x.sh.id}/return/start`, {}));
      continue; // handled after the round
    }
    ok(await drv1.call('POST', `logistics/shipments/${x.sh.id}/step`, { step: 'arrive_delivery' }), `arrive ${x.i}`);
    if (kind === 4 || kind === 6 || kind === 7) {
      if (kind === 6) {
        // Wrong merchant: the NEXT merchant's code cannot deliver this merchant's goods.
        const other = ms[(x.i + 1) % N];
        const wrong = await other.m.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'delivery' });
        assert.equal(wrong.status, 404, 'another merchant is not a party to this shipment');
        const otherCode = ok(await other.m.owner.call('POST', `logistics/shipments/${other.sh.id}/codes`, { purpose: 'delivery' })).code;
        assert.equal((await drv1.call('POST', `logistics/shipments/${x.sh.id}/deliver`, { code: otherCode })).body.code, 'code_invalid');
      }
      const dc = ok(await x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'delivery' }));
      ok(await drv1.call('POST', `logistics/shipments/${x.sh.id}/deliver`, { code: dc.code }), `deliver ${x.i}`);
      if (kind === 7) assert.equal(ok(await drv1.call('POST', `logistics/shipments/${x.sh.id}/deliver`, { code: dc.code })).replayed, true, 'network retry replays');
      ok(await receive(x, { received: u }), `receive ${x.i}`);
      if (kind === 4) {
        const dup = ok(await receive(x, { received: u - 1, damaged: 1 }));
        assert.equal(dup.replayed, true, 'a duplicate confirmation never overwrites the first');
        assert.equal(dup.receiving.outcome, 'full');
      }
      continue;
    }
    const line = {
      0: { received: u },
      1: { received: u - 2, missing: 2 },
      2: { received: u - 3, damaged: 3 },
      3: { received: 0, refused: u },
      5: { received: u - 6, refused: 6 },
      9: { received: u - 3, missing: 1, damaged: 2 },
    }[kind];
    const r = ok(await receive(x, line), `receive ${x.i}`);
    if (line.refused) refusalReturns.push({ x, shipmentId: r.refusalReturnShipmentId, refused: line.refused });
  }

  // Refused goods ride back with the same driver; the depot receives them per line (one carton lost on the way back).
  for (const [k, rr] of refusalReturns.entries()) {
    await pace();
    ok(await drv1.call('POST', `logistics/shipments/${rr.shipmentId}/step`, { step: 'arrive_delivery' }));
    const back = k === 0 ? { received: rr.refused - 1, missing: 1 } : { received: rr.refused };
    ok(await sup.owner.call('POST', `logistics/shipments/${rr.shipmentId}/receiving`, { lines: [{ productId: pid, ...back }] }), `depot receives refusal ${k}`);
  }

  // Failed deliveries come back to the depot, then go out again on route 2 with driver 2.
  const failed = ms.filter((x) => x.i % 10 === 8);
  for (const x of failed) {
    await pace();
    const rc = ok(await sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'return_delivery' }));
    ok(await drv1.call('POST', `logistics/shipments/${x.sh.id}/return/complete`, { code: rc.code }));
    assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } })).status, 'ready', 'back to ready, stock re-reserved');
    ok(await sup.owner.call('POST', P(`purchase-orders/${x.po.id}/advance`), { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }));
    x.firstSh = x.sh;
    x.sh = await shipmentFor(x.po.id);
    assert.notEqual(x.sh.id, x.firstSh.id);
  }
  await pace();
  const route2 = ok(await sup.owner.call('POST', `businesses/${sup.b.id}/logistics/routes`, { serviceDate: new Date().toISOString(), driverUserId: drv2.id, shipmentIds: failed.map((x) => x.sh.id) }), 'route 2');
  for (const x of failed) {
    await pace();
    const pc = ok(await sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
    ok(await drv2.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code }));
    const dc = ok(await x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'delivery' }));
    ok(await drv2.call('POST', `logistics/shipments/${x.sh.id}/deliver`, { code: dc.code }));
    ok(await receive(x, { received: x.units }), `re-delivery receive ${x.i}`);
  }

  // ── 40 independently verified receiving events ─────────────────────────
  const recs = await prisma.receivingRecord.findMany({ where: { shipmentId: { in: ms.map((x) => x.sh.id) } } });
  assert.equal(recs.length, N, '40 merchant receiving events');
  assert.equal(new Set(recs.map((r) => r.receiverBusinessId)).size, N, 'each by its own merchant');
  const proofs = await prisma.shipment.findMany({ where: { id: { in: ms.map((x) => x.sh.id) } }, select: { deliveryProof: true, status: true } });
  assert.ok(proofs.every((s) => s.status === 'delivered' && ['receiver_receiving', 'receiver_challenge'].includes(s.deliveryProof)), 'every delivery proven by its receiver');

  // Delivered never means "accepted every item".
  for (const x of ms) {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } });
    const full = [0, 4, 6, 7, 8].includes(x.i % 10);
    assert.equal(po.status, full ? 'received' : 'disputed', `PO ${x.i} (${x.i % 10})`);
  }

  await pace();
  // ── merchant inventory: own products only, no supplier ids in buyer stock ──
  for (const x of ms) {
    const rec = recs.find((r) => r.receiverBusinessId === x.m.b.id);
    const got = JSON.parse(rec.linesJson)[0].received;
    if (x.own) {
      assert.equal((await prisma.product.findUnique({ where: { id: x.own.id } })).inventory, got, `mapped merchant ${x.i} stock = received`);
    } else {
      const um = await prisma.unmatchedReceipt.findMany({ where: { buyerBusinessId: x.m.b.id, status: 'pending' } });
      assert.equal(um.reduce((n, r) => n + r.units, 0), got, `unmapped merchant ${x.i} holds received units as unmatched`);
    }
  }
  const leaked = await prisma.depotStock.count({ where: { productId: pid, locationId: { not: sup.depot.id } } });
  assert.equal(leaked, 0, 'the supplier product never appears in any other location');

  // ── conservation of goods at the depot ──────────────────────────────────
  const sum = (lines, k) => lines.reduce((n, l) => n + (l[k] ?? 0), 0);
  const allLines = recs.flatMap((r) => JSON.parse(r.linesJson));
  const rrRecs = await prisma.receivingRecord.findMany({ where: { shipmentId: { in: refusalReturns.map((r) => r.shipmentId) } } });
  const rrLines = rrRecs.flatMap((r) => JSON.parse(r.linesJson));
  const depot = await stockAt(sup.depot.id, sup.product.id);
  const leftDepot = START - depot.onHand;
  const terminal = sum(allLines, 'received') + sum(allLines, 'damaged') + sum(allLines, 'missing') + sum(rrLines, 'missing') + sum(rrLines, 'damaged');
  assert.equal(leftDepot, terminal, `every unit that left the depot is received, damaged or missing — exactly once (left ${leftDepot}, accounted ${terminal})`);
  assert.equal(depot.reserved, 0, 'no stale reservation');

  // ── routes reconcile ────────────────────────────────────────────────────
  await pace();
  const r1 = ok(await sup.owner.call('GET', `businesses/${sup.b.id}/logistics/routes/${route1.id}/reconciliation`));
  const r2 = ok(await sup.owner.call('GET', `businesses/${sup.b.id}/logistics/routes/${route2.id}/reconciliation`));
  assert.equal(r1.closed, true);
  assert.equal(r2.closed, true);
  assert.equal(r1.totals.unaccounted, 0);
  assert.equal(r2.totals.unaccounted, 0);
  assert.equal(r1.totals.dispatched, dispatched1);
  assert.equal(r1.totals.returnedToDepot, failed.reduce((n, x) => n + x.units, 0));

  // ── money: separate obligations, conserved ─────────────────────────────
  const dueNow = ms.filter((x) => x.term === 'due_now');
  const net = ms.filter((x) => x.term === 'net30');
  assert.equal(await bizBal(sup.b.id), supBefore + dueNow.reduce((n, x) => n + x.po.totalKori, 0), 'distributor paid exactly the due-now orders, once each');
  const invoices = await prisma.purchaseOrder.findMany({ where: { id: { in: net.map((x) => x.po.id) } }, select: { invoiceId: true, totalKori: true } });
  assert.ok(invoices.every((p) => p.invoiceId), 'each net-30 order invoiced at verified delivery');
  assert.equal(new Set(invoices.map((p) => p.invoiceId)).size, net.length, 'one invoice per order — never merged');
  const inv = await prisma.tradeInvoice.findMany({ where: { id: { in: invoices.map((p) => p.invoiceId) } } });
  assert.deepEqual(inv.map((v) => v.amountKori).sort(), invoices.map((p) => p.totalKori).sort(), 'invoice principal = order total (corrections are J7 credit memos, not overwrites)');
  assert.equal(await prisma.paymentRecord.count({ where: { businessId: sup.b.id, sourceChannel: 'b2b_purchase_order' } }), dueNow.length, 'one payment record per due-now order');
  for (const x of dueNow) assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } })).paymentStatus, 'paid');

  // D42: a full depot day on one account never triggered the account-wide block.
  assert.equal(await prisma.userRateLimit.count({ where: { userId: { in: [sup.owner.id, drv1.id, drv2.id] }, blockedUntil: { gt: new Date() } } }), 0, 'no account lockout');
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
  process.stdout.write(`# pilot ${JSON.stringify({ merchants: N, orders: N, dispatched: dispatched1, routes: 2, receivings: recs.length, refusalReturns: refusalReturns.length, redeliveries: failed.length, depotLeft: leftDepot, route1: r1.totals })}\n`);
});
