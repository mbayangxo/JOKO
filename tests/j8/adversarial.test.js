/**
 * J8 adversarial lab: concurrency, code brute force / misuse, offline replay,
 * privacy (precise address, cross-party reads, retention), dormant capabilities,
 * client-sent fees, invariant detection, and scale (keyset pagination, indexes).
 * J2 + logistics invariants after every test.
 */
import '../helpers/setup.js';
import crypto from 'node:crypto';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants, checkLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { promoteReleasableEarnings } from '../../lib/logistics/fees.js';
import { createRequestInTx } from '../../lib/logistics/intake.js';
import { redactPreciseDestinations } from '../../lib/logistics/shipments.js';
import { runMoneyTransaction } from '../../lib/wallet-atomic.js';
import { business, customer, operator, signedIn } from '../j3/helpers.js';
import { fleetDriver, jokkoCourier, member, readyPo, shipmentFor, stockAt } from './fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_LOGISTICS_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
});

const ok = (r, what = '') => {
  assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const idem = () => ({ headers: { 'idempotency-key': `k-${crypto.randomBytes(8).toString('hex')}` } });

async function ownFleetInTransit({ packs = 1, arrive = true } = {}) {
  const x = await readyPo(api, { packs });
  const driver = await fleetDriver(api, x.sup.b);
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }));
  const sh = await shipmentFor(x.po.id);
  ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: driver.id }));
  return { ...x, driver, sh, arrive };
}

test('concurrency: parallel pickups with one code → one handoff; parallel receivings → one record, stock credited once', async () => {
  const x = await ownFleetInTransit({ packs: 2 });
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  const ps = await Promise.all(Array.from({ length: 8 }, () => x.driver.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code })));
  assert.ok(ps.every((r) => r.status < 500), JSON.stringify(ps.map((r) => r.status)));
  assert.ok(ps.some((r) => r.status === 200 && !r.body.replayed));
  assert.equal(await prisma.shipmentEvent.count({ where: { shipmentId: x.sh.id, toStatus: 'picked_up' } }), 1);
  ok(await x.driver.call('POST', `logistics/shipments/${x.sh.id}/step`, { step: 'arrive_delivery' }));
  const rs = await Promise.all(Array.from({ length: 6 }, () => x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 24 }] })));
  assert.ok(rs.every((r) => r.status < 500), JSON.stringify(rs.map((r) => [r.status, r.body.code])));
  assert.equal(await prisma.receivingRecord.count({ where: { shipmentId: x.sh.id } }), 1);
  const held = await prisma.unmatchedReceipt.findMany({ where: { shipmentId: x.sh.id } });
  assert.equal(held.reduce((n, r) => n + r.units, 0), 24, 'received once (held unmatched until the buyer maps it)');
  assert.equal(await prisma.shipmentEvent.count({ where: { shipmentId: x.sh.id, toStatus: 'delivered' } }), 1);
});

test('concurrency: two dispatchers assign two couriers at once → one active assignment; parallel payouts → paid once', async () => {
  const x = await readyPo(api, { packs: 1 });
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'jokko_logistics' }));
  const sh = await shipmentFor(x.po.id);
  const [o1, o2] = [await operator(api, ['logistics_ops']), await operator(api, ['logistics_ops'])];
  ok(await o1.call('POST', `admin/logistics/shipments/${sh.id}/accept`, {}));
  ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/ready`, {}));
  const [c1, c2] = [await jokkoCourier(api), await jokkoCourier(api)];
  const as = await Promise.all([o1.call('POST', `admin/logistics/shipments/${sh.id}/assign`, { courierUserId: c1.id }), o2.call('POST', `admin/logistics/shipments/${sh.id}/assign`, { courierUserId: c2.id })]);
  assert.equal(as.filter((r) => r.status === 200).length, 1, JSON.stringify(as.map((r) => [r.status, r.body.code])));
  assert.ok(as.every((r) => r.status < 500));
  assert.equal(await prisma.courierAssignment.count({ where: { shipmentId: sh.id, status: 'active' } }), 1);
  const a = await prisma.courierAssignment.findFirst({ where: { shipmentId: sh.id, status: 'active' } });
  const courier = a.courierUserId === c1.id ? c1 : c2;
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' }));
  ok(await courier.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }));
  const dc = ok(await x.m.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'delivery' }));
  ok(await courier.call('POST', `logistics/shipments/${sh.id}/deliver`, { code: dc.code }));
  await prisma.courierEarning.updateMany({ where: { shipmentId: sh.id }, data: { releasableAt: new Date(Date.now() - 1000) } });
  await promoteReleasableEarnings(prisma);
  const w0 = (await prisma.wallet.findUnique({ where: { userId: courier.id } })).koriBalance;
  const pays = await Promise.all(Array.from({ length: 5 }, () => courier.call('POST', 'logistics/earnings/payout', {}, idem())));
  assert.ok(pays.every((r) => r.status < 500), JSON.stringify(pays.map((r) => [r.status, r.body])));
  assert.equal((await prisma.wallet.findUnique({ where: { userId: courier.id } })).koriBalance, w0 + 120, 'paid exactly once under concurrency');
});

test('codes: 5 wrong guesses lock the code; purpose, shipment and courier binding; expiry; single use', async () => {
  const x = await ownFleetInTransit();
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  for (let i = 0; i < 5; i += 1) assert.equal((await x.driver.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: `WRONG${i}XX` })).body.code, 'code_invalid');
  assert.equal((await x.driver.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code })).status, 423, 'locked after 5 attempts — even the right code');
  // A new code replaces the old one; an expired code is refused.
  const pc2 = ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  await prisma.custodyChallenge.updateMany({ where: { shipmentId: x.sh.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await x.driver.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc2.code })).body.code, 'code_invalid');
  const pc3 = ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  // A pickup code cannot deliver; another shipment's code does not work here.
  const y = await ownFleetInTransit();
  const ypc = ok(await y.sup.owner.call('POST', `logistics/shipments/${y.sh.id}/codes`, { purpose: 'pickup' }));
  assert.equal((await x.driver.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: ypc.code })).body.code, 'code_invalid');
  ok(await x.driver.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc3.code }));
  assert.equal((await x.driver.call('POST', `logistics/shipments/${x.sh.id}/deliver`, { code: pc3.code })).body.code, 'code_invalid', 'pickup code is not a delivery code');
  // Codes are stored hashed only.
  const rows = await prisma.custodyChallenge.findMany({ where: { shipmentId: x.sh.id } });
  assert.ok(rows.every((r) => r.codeHash.length === 64 && !JSON.stringify(r).includes(pc3.code)));
});

test('offline / retry: lost responses replay; steps are idempotent; an unassigned courier loses access at once', async () => {
  const x = await ownFleetInTransit();
  ok(await x.driver.call('POST', `logistics/shipments/${x.sh.id}/step`, { step: 'arrive_pickup' }));
  assert.equal(ok(await x.driver.call('POST', `logistics/shipments/${x.sh.id}/step`, { step: 'arrive_pickup' })).replayed, true);
  assert.equal(await prisma.shipmentEvent.count({ where: { shipmentId: x.sh.id, toStatus: 'pickup_arrived' } }), 1);
  ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/unassign`, { reason: 'chauffeur malade' }));
  assert.equal((await x.driver.call('GET', `logistics/shipments/${x.sh.id}`)).status, 404, 'no residual access after unassignment');
  assert.equal((await x.driver.call('POST', `logistics/shipments/${x.sh.id}/step`, { step: 'arrive_pickup' })).status, 404);
  assert.equal(ok(await x.driver.call('GET', 'logistics/courier/shipments')).items.length, 0);
});

test('privacy: precise destination only to the active courier; strangers and other businesses see nothing; retention redacts', async () => {
  const x = await ownFleetInTransit();
  await prisma.shipment.update({ where: { id: x.sh.id }, data: { destPrecise: 'Villa 12, Sicap Liberté 6', destLat: 14.72, destLng: -17.46 } });
  const view = ok(await x.driver.call('GET', `logistics/shipments/${x.sh.id}`));
  assert.equal(view.destination.precise, 'Villa 12, Sicap Liberté 6');
  for (const who of [x.sup.owner, x.m.owner]) {
    const v = ok(await who.call('GET', `logistics/shipments/${x.sh.id}`));
    assert.equal(v.destination.precise, undefined);
    assert.equal(v.destination.lat, undefined);
  }
  const other = await signedIn(api, await customer());
  const otherBiz = await business(other.user);
  assert.equal((await other.call('GET', `logistics/shipments/${x.sh.id}`)).status, 404);
  assert.equal((await other.call('GET', `businesses/${x.sup.b.id}/logistics/shipments`)).status, 404);
  assert.equal(ok(await other.call('GET', `businesses/${otherBiz.id}/logistics/shipments`)).items.length, 0);
  // A fleet driver of the seller is not a reader of the seller's shipment list.
  assert.equal((await x.driver.call('GET', `businesses/${x.sup.b.id}/logistics/shipments`)).status, 404);
  const list = ok(await x.sup.owner.call('GET', `businesses/${x.sup.b.id}/logistics/shipments`));
  assert.ok(list.items.every((s) => s.destination.precise === undefined));
  assert.ok(!JSON.stringify(list).includes('Villa 12'));
  // Complete, then retention: precise data is removed after the window.
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  ok(await x.driver.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code }));
  const dc = ok(await x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'delivery' }));
  ok(await x.driver.call('POST', `logistics/shipments/${x.sh.id}/deliver`, { code: dc.code }));
  await redactPreciseDestinations(prisma, new Date(Date.now() + 8 * 86_400_000));
  const s = await prisma.shipment.findUnique({ where: { id: x.sh.id } });
  assert.deepEqual([s.destPrecise, s.destLat, s.destLng], [null, null, null]);
  assert.ok(s.preciseRedactedAt);
});

test('dormant / not-activated capabilities refuse honestly: COD, intercity, fulfilment centre; client-sent fees are rejected', async () => {
  const ownerC = await customer();
  const b = await business(ownerC.user);
  const base = { sourceSystem: 'jokko_order', fulfillerBusinessId: b.id, originBusinessId: b.id, destinationUserId: ownerC.id, lines: [], createdBy: ownerC.id };
  process.env.JOKKO_LOGISTICS_ENABLED = 'true'; // this process calls the intake directly
  const tryIt = (extra) => runMoneyTransaction(prisma, (tx) => createRequestInTx(tx, { ...base, sourceId: crypto.randomUUID(), ...extra })).then(() => 'ok', (e) => e.code);
  assert.equal(await tryIt({ fulfilmentOwner: 'MERCHANT_FULFILLED', cod: true }), 'cod_not_activated');
  assert.equal(await tryIt({ fulfilmentOwner: 'JOKKO_LOGISTICS', serviceType: 'intercity' }), 'service_not_available');
  assert.equal(await tryIt({ fulfilmentOwner: 'JOKKO_FULFILLMENT_CENTER' }), 'fulfilment_not_activated');
  delete process.env.JOKKO_LOGISTICS_ENABLED;
  assert.equal(await tryIt({ fulfilmentOwner: 'JOKKO_LOGISTICS' }), 'fulfilment_not_activated', 'Jokko Logistics off unless explicitly enabled');
  // Idempotent intake: the same source key never creates a second request.
  const sourceId = crypto.randomUUID();
  const a = await runMoneyTransaction(prisma, (tx) => createRequestInTx(tx, { ...base, sourceId, fulfilmentOwner: 'MERCHANT_FULFILLED' }));
  const b2 = await runMoneyTransaction(prisma, (tx) => createRequestInTx(tx, { ...base, sourceId, fulfilmentOwner: 'MERCHANT_FULFILLED' }));
  assert.equal(b2.request.id, a.request.id);
  assert.equal(b2.replayed, true);
  // No route accepts a fee: strict schemas reject extra money fields.
  const x = await readyPo(api, { packs: 1 });
  const r = await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'jokko_logistics', feeKori: 1 });
  assert.equal(r.status, 400);
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'jokko_logistics' }));
  const sh = await shipmentFor(x.po.id);
  const ops = await operator(api, ['logistics_ops']);
  assert.equal((await ops.call('POST', `admin/logistics/shipments/${sh.id}/accept`, { feeKori: 0 })).status, 400);
});

test('roles: a courier cannot dispatch, a pickup desk cannot deliver, buyer staff without purchasing cannot receive', async () => {
  const x = await ownFleetInTransit();
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  ok(await x.driver.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code }));
  ok(await x.driver.call('POST', `logistics/shipments/${x.sh.id}/step`, { step: 'arrive_delivery' }));
  const cashier = await member(api, x.m.b, 'cashier');
  const r = await cashier.call('POST', `logistics/shipments/${x.sh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 12 }] });
  assert.ok([403, 404].includes(r.status), JSON.stringify(r.body));
  assert.equal((await x.driver.call('POST', `logistics/shipments/${x.sh.id}/unassign`, { reason: 'je pars' })).status, 404);
  assert.equal((await x.driver.call('POST', `logistics/shipments/${x.sh.id}/cancel`, { reason: 'je pars' })).status, 404);
  // A user route can never resolve a shipment dispute (no such route exists for users).
  const res = await x.m.owner.call('POST', `admin/logistics/disputes/x/resolve`, { outcome: 'upheld', note: 'je me donne raison' });
  assert.ok([401, 403].includes(res.status));
});

test('invariant checker detects tampering (inside a rolled-back transaction)', async () => {
  const x = await ownFleetInTransit();
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  ok(await x.driver.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code }));
  ok(await x.driver.call('POST', `logistics/shipments/${x.sh.id}/step`, { step: 'arrive_delivery' }));
  ok(await x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 12 }] }));
  const sh = await prisma.shipment.findUnique({ where: { id: x.sh.id } });
  const ROLLBACK = new Error('rollback');
  let seen;
  await prisma.$transaction(async (tx) => {
    await tx.unmatchedReceipt.create({ data: { buyerBusinessId: x.m.b.id, sellerBusinessId: x.sup.b.id, sellerProductId: 'phantom', units: 12, shipmentId: sh.id, shipmentRef: sh.reference } });
    await tx.courierAssignment.updateMany({ where: { shipmentId: sh.id }, data: { status: 'active' } });
    seen = await checkLogisticsInvariants(tx);
    throw ROLLBACK;
  }).catch((e) => { if (e !== ROLLBACK) throw e; });
  assert.deepEqual(seen.violations.map((v) => v.id).sort(), ['L2', 'L5']);
});

test('scale: 3 000 shipments for one business — keyset pagination is complete without duplicates; status index is usable', async () => {
  const ownerC = await customer();
  const owner = await signedIn(api, ownerC);
  const b = await business(ownerC.user);
  const N = 3000;
  const tag = crypto.randomBytes(3).toString('hex');
  const reqs = Array.from({ length: N }, (_, i) => ({ id: `fr${tag}${i}`, reference: `FR-SC-${tag}-${i}`, sourceSystem: 'jokko_order', sourceId: `${tag}-${i}`, sourceKey: `scale:${tag}:${i}`, fulfilmentOwner: 'MERCHANT_FULFILLED', fulfillerBusinessId: b.id, originBusinessId: b.id, createdBy: ownerC.id }));
  // 2 000 distinct merchant destinations (one shipment each for the first 2 000).
  const D = 2000;
  const dests = Array.from({ length: D }, (_, i) => ({ id: `bz${tag}${i}`, ownerId: ownerC.id, name: `Boutique ${tag} ${i}`, type: 'merchant' }));
  await prisma.business.createMany({ data: dests });
  reqs.forEach((r, i) => { if (i < D) r.destinationBusinessId = dests[i].id; });
  await prisma.fulfilmentRequest.createMany({ data: reqs });
  await prisma.shipment.createMany({ data: reqs.map((r, i) => ({ reference: `SH-SC-${tag}-${i}`, requestId: r.id, status: i % 3 ? 'ready_for_pickup' : 'cancelled', custody: 'source' })) });
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  const t0 = Date.now();
  do {
    const q = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : '?limit=200';
    const r = ok(await owner.call('GET', `businesses/${b.id}/logistics/shipments${q}`));
    for (const s of r.items) {
      assert.ok(!seen.has(s.id), 'no duplicates across pages');
      seen.add(s.id);
    }
    cursor = r.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(seen.size, N);
  assert.equal(pages, 15);
  const filtered = ok(await owner.call('GET', `businesses/${b.id}/logistics/shipments?status=cancelled&limit=200`));
  assert.ok(filtered.items.every((s) => s.status === 'cancelled'));
  console.log(JSON.stringify({ shipments: N, destinations: D, pages, ms: Date.now() - t0 }));
  // Authorization under scale: a stranger sees nothing; one destination owner (a separate user) sees exactly its one shipment.
  const stranger = await signedIn(api, await customer());
  assert.equal((await stranger.call('GET', `businesses/${b.id}/logistics/shipments?limit=200`)).status, 404);
  const destOwnerC = await customer();
  await prisma.business.update({ where: { id: dests[7].id }, data: { ownerId: destOwnerC.id } });
  const destOwner = await signedIn(api, destOwnerC);
  const inbound = ok(await destOwner.call('GET', `businesses/${dests[7].id}/logistics/shipments?side=destination&limit=200`));
  assert.equal(inbound.items.length, 1);
  assert.equal((await destOwner.call('GET', `businesses/${b.id}/logistics/shipments`)).status, 404);
  // Courier assigned-delivery query: 1 000 active assignments, paginated, only their own.
  const courierC = await customer();
  const courier = await signedIn(api, courierC);
  const ready = await prisma.shipment.findMany({ where: { requestId: { in: reqs.map((r) => r.id) }, status: 'ready_for_pickup' }, select: { id: true }, take: 1000 });
  await prisma.courierAssignment.createMany({ data: ready.map((x) => ({ shipmentId: x.id, courierUserId: courierC.id, courierKind: 'fleet_driver', assignedBy: ownerC.id, assignedByType: 'user' })) });
  await prisma.shipment.updateMany({ where: { id: { in: ready.map((x) => x.id) } }, data: { status: 'assigned' } });
  let cc = null;
  let mineCount = 0;
  const t1 = Date.now();
  do {
    const r = ok(await courier.call('GET', `logistics/courier/shipments?limit=200${cc ? `&cursor=${encodeURIComponent(cc)}` : ''}`));
    mineCount += r.items.length;
    cc = r.nextCursor;
  } while (cc);
  assert.equal(mineCount, ready.length);
  assert.equal(ok(await stranger.call('GET', 'logistics/courier/shipments')).items.length, 0);
  // Route stop access: a 60-stop route lists in order.
  const route = await prisma.deliveryRoute.create({ data: { reference: `RT-SC-${tag}`, ownerBusinessId: b.id, serviceDate: new Date(), driverUserId: courierC.id, createdBy: ownerC.id } });
  await prisma.routeStop.createMany({ data: ready.slice(0, 60).map((x, i) => ({ routeId: route.id, sequence: i + 1, shipmentId: x.id })) });
  await prisma.businessMember.create({ data: { businessId: b.id, userId: courierC.id, role: 'fleet_driver', status: 'active', acceptedAt: new Date() } });
  const routes = ok(await owner.call('GET', `businesses/${b.id}/logistics/routes`));
  assert.deepEqual(routes[0].stops.map((x) => x.sequence), Array.from({ length: 60 }, (_, i) => i + 1));
  assert.equal((await courier.call('GET', `businesses/${b.id}/logistics/routes`)).status, 404, 'a driver does not read the dispatch plan');
  console.log(JSON.stringify({ courierAssignments: ready.length, courierPagesMs: Date.now() - t1, routeStops: 60 }));
  const plan = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    return tx.$queryRawUnsafe(`EXPLAIN SELECT s.id FROM "Shipment" s JOIN "FulfilmentRequest" r ON r.id = s."requestId" WHERE r."originBusinessId" = '${b.id}' ORDER BY s.id LIMIT 201`);
  });
  const text = plan.map((p) => Object.values(p)[0]).join('\n');
  assert.match(text, /Index/, text);
});

test('J8.33 role combinations stay independent: agent ≠ courier, rep ≠ dispatcher, courier ≠ cash agent, support ≠ money', async () => {
  const x = await readyPo(api, { packs: 1 });
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'jokko_logistics' }));
  const sh = await shipmentFor(x.po.id);
  const ops = await operator(api, ['logistics_ops']);
  ok(await ops.call('POST', `admin/logistics/shipments/${sh.id}/accept`, {}));
  ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/ready`, {}));
  // A J6 financial agent is not a courier.
  const agentC = await customer();
  await prisma.accountRole.create({ data: { userId: agentC.id, role: 'agent', status: 'active' } });
  assert.equal((await ops.call('POST', `admin/logistics/shipments/${sh.id}/assign`, { courierUserId: agentC.id })).body.code, 'courier_inactive');
  // A distribution rep of the distributor cannot dispatch its fleet or drive.
  const rep = await member(api, x.sup.b, 'distribution_rep');
  const y = await ownFleetInTransit();
  assert.equal((await rep.call('POST', `logistics/shipments/${y.sh.id}/unassign`, { reason: 'rep tente' })).status, 404);
  assert.equal((await y.sup.owner.call('POST', `logistics/shipments/${y.sh.id}/unassign`, { reason: 'remplacement' })).status, 200);
  assert.equal((await y.sup.owner.call('POST', `logistics/shipments/${y.sh.id}/assign`, { courierUserId: rep.id })).body.code, 'not_a_driver');
  // A Jokko courier has no agent cash authority (role-gated centrally).
  const courier = await jokkoCourier(api);
  const scan = await courier.call('POST', 'agent/cash/scan', { token: 'x'.repeat(32) });
  assert.equal(scan.status, 403, JSON.stringify(scan.body));
  // Support has no logistics money authority.
  const support = await operator(api, ['support']);
  for (const [path, body] of [[`admin/logistics/shipments/${sh.id}/assign`, { courierUserId: courier.id }], [`admin/logistics/shipments/${sh.id}/cancel`, { reason: 'support tente' }]]) {
    assert.equal((await support.call('POST', path, body)).status, 403);
  }
  // A courier never sees the receiver's wallet / orders: the shipment view has no such fields.
  ok(await ops.call('POST', `admin/logistics/shipments/${sh.id}/assign`, { courierUserId: courier.id }));
  const v = ok(await courier.call('GET', `logistics/shipments/${sh.id}`));
  for (const k of ['wallet', 'balance', 'orders', 'phone', 'customer', 'buyer', 'feeKori']) assert.equal(k in v, false, k);
  assert.equal((await courier.call('GET', `businesses/${x.m.b.id}/b2b/purchase-orders/${x.po.id}`)).status, 404);
});

test('J8.28–J8.30 adapter contracts: an external source (Kabu) enters through the same contract, idempotently; events carry no PII', async () => {
  const ownerC = await customer();
  const b = await business(ownerC.user);
  const kabuOrder = `kabu-${crypto.randomBytes(4).toString('hex')}`;
  const mk = () => runMoneyTransaction(prisma, (tx) => createRequestInTx(tx, { sourceSystem: 'kabu', sourceId: kabuOrder, fulfilmentOwner: 'MERCHANT_FULFILLED', fulfillerBusinessId: b.id, originBusinessId: b.id, destinationUserId: ownerC.id, lines: [{ productId: 'p1', sku: 'KABU-1', units: 1 }], dest: { area: 'Plateau', precise: 'Rue 10' }, createdBy: ownerC.id }));
  const first = await mk();
  const again = await mk();
  assert.equal(again.request.id, first.request.id);
  assert.equal(first.request.sourceKey, `kabu:${kabuOrder}:outbound`);
  const evs = await prisma.commerceEvent.findMany({ where: { aggregateType: 'shipment', aggregateId: first.shipment.id } });
  assert.equal(evs.length, 1);
  assert.ok(!evs[0].payloadJson.includes('Rue 10'), 'outbox events never carry the precise destination');
  // The request references the source; it never copies the commercial order (no amounts, no customer fields).
  for (const k of ['totalKori', 'customerName', 'phone', 'items']) assert.equal(k in first.request, false);
});
