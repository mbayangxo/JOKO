/**
 * J15 decision 7 — P0-A, P0-B and F1 under lab concurrency, on the PRODUCTION BASE 7d262de, LOCAL ONLY
 * (disposable databases, no live money). The same file runs twice, copied to tests/repro/ of two worktrees:
 *   P0_LAB_MODE=legacy   7d262de as deployed             → each defect must REPRODUCE (measured)
 *   P0_LAB_MODE=patched  7d262de + the three emergency patches (tontine containment, P0-B, F1)
 *                                                         → each defect must be ABSENT under the same storm
 * Measurements are printed as one JSON line per scenario (LAB_RESULT ...) for the J15 report.
 * Runner: docs/incidents/lab-p0/run-p0-lab.sh
 */
import '../helpers/setup.js';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createUserWithWallet, createVerifiedDevice, mockReq, mockRes, prisma, resetReserveToWallets } from '../helpers/db.js';
import { deliveriesDisputeResolve, tontineGroups, tontineRelease } from '../../lib/handlers.js';
import { runTontineProcessor } from '../../lib/cron/tontine-processor.js';
import { payoutFarmerDeliveries } from '../../lib/cooperative-service.js';

const MODE = process.env.P0_LAB_MODE;
assert.ok(MODE === 'legacy' || MODE === 'patched', 'P0_LAB_MODE must be legacy or patched');
const LEGACY = MODE === 'legacy';

beforeEach(async () => { await resetReserveToWallets(); });
after(async () => { await prisma.$disconnect(); });
const call = async (h, opts) => { const req = mockReq(opts); const res = mockRes(); try { await h(req, res); } catch (e) { return { statusCode: 500, body: { error: String(e?.message ?? e).slice(0, 120) } }; } return res; };
const wallet = (userId) => prisma.wallet.findUnique({ where: { userId } });
const report = (name, data) => console.log(`LAB_RESULT ${JSON.stringify({ mode: MODE, scenario: name, ...data })}`);

test('P0-A tontine drain storm: 6 creators × 3 strangers, 4 concurrent releases each + 3 concurrent cron passes', async () => {
  const handles = async (u) => { u.handle = u.handle.replace(/^@/, ''); await prisma.user.update({ where: { id: u.id }, data: { handle: u.handle } }); return u; };
  const creators = [];
  const victims = [];
  for (let i = 0; i < 6; i += 1) {
    const c = await handles(await createUserWithWallet({ balance: 0, koriBalance: 0 }));
    const vs = [];
    for (let j = 0; j < 3; j += 1) vs.push(await handles(await createUserWithWallet({ balance: 50_000, koriBalance: 50_000 })));
    creators.push(c);
    victims.push(...vs);
    c.victims = vs;
  }
  const before = new Map(await Promise.all([...creators, ...victims].map(async (u) => [u.id, await wallet(u.id)])));
  const groups = [];
  for (const c of creators) {
    const g = await call(tontineGroups, { userId: c.id, body: { name: `Lab natt ${c.id.slice(-4)}`, amountPerMember: 20_000, frequency: 'monthly', memberHandles: c.victims.map((v) => v.handle) } });
    const id = g.body?.id ?? g.body?.group?.id;
    if (id) { groups.push({ c, id }); await prisma.tontineGroup.update({ where: { id }, data: { nextDueAt: new Date(Date.now() - 1000) } }); }
  }
  const releases = await Promise.all([
    ...groups.flatMap(({ c, id }) => [1, 2, 3, 4].map(() => call(tontineRelease, { userId: c.id, query: { id } }))),
    ...[1, 2, 3].map(() => runTontineProcessor().then(() => ({ statusCode: 'cron' }), (e) => ({ statusCode: 'cron_error', body: { error: String(e?.message ?? e).slice(0, 80) } }))),
  ]);
  const delta = async (u, f) => Number((await wallet(u.id))[f]) - Number(before.get(u.id)[f]);
  let victimLoss = 0;
  let maxVictimLoss = 0;
  for (const v of victims) { const l = -(await delta(v, 'balance')) - (await delta(v, 'koriBalance')); victimLoss += Math.max(0, l); maxVictimLoss = Math.max(maxVictimLoss, l); }
  let creatorGain = 0;
  for (const c of creators) creatorGain += Math.max(0, (await delta(c, 'balance')) + (await delta(c, 'koriBalance')));
  const statuses = {};
  for (const r of releases) statuses[r.statusCode] = (statuses[r.statusCode] ?? 0) + 1;
  report('P0-A', { groupsCreated: groups.length, victims: victims.length, victimLossTotal: victimLoss, maxLossOneVictim: maxVictimLoss, creatorGainTotal: creatorGain, releaseStatuses: statuses });
  if (LEGACY) {
    assert.ok(victimLoss > 0, 'legacy: the drain reproduces under concurrency');
    assert.ok(creatorGain > 0, 'legacy: the creators gain');
  } else {
    assert.equal(victimLoss, 0, 'patched: no stranger is debited, whatever the concurrency');
    assert.equal(creatorGain, 0, 'patched: no creator gains');
    for (const [code, n] of Object.entries(statuses)) if (code !== 'cron') assert.equal(code, '503', `patched: every release refused (${n} × ${code})`);
  }
});

async function disputedDelivery() {
  const buyer = await createUserWithWallet({ balance: 10_000, koriBalance: 0 });
  const rider = await createUserWithWallet({ balance: 0, koriBalance: 0 });
  // The buyer paid the 1 500 XOF fee into escrow at reservation (debited here, as the legacy reserve does).
  await prisma.wallet.update({ where: { userId: buyer.id }, data: { balance: { decrement: 1500 } } });
  const order = await prisma.order.create({ data: { buyerId: buyer.id, totalAmount: 1500 } });
  const task = await prisma.deliveryTask.create({ data: { orderId: order.id, buyerId: buyer.id, assignedDriverId: rider.id, dropoffArea: 'Plateau', dropoffAddress: 'Rue 2', status: 'delivered', deliveredAt: new Date() } });
  await prisma.deliveryEscrow.create({ data: { deliveryTaskId: task.id, buyerId: buyer.id, riderId: rider.id, amountNational: 1500, koriPayout: 150, status: 'disputed_held', reference: `LABESC-${task.id}` } });
  await prisma.deliveryDispute.create({ data: { deliveryTaskId: task.id, openedByUserId: buyer.id, status: 'open', holdUntil: new Date(Date.now() + 86_400_000) } });
  return { buyer, rider, task };
}

test('P0-B forged ruling storm: courier, buyer and strangers rule 12× concurrently on one open dispute (ADMIN_API_KEY unset)', async () => {
  delete process.env.ADMIN_API_KEY; // the documented production state of the shared key is "absent / unknown"
  const x = await disputedDelivery();
  const strangers = await Promise.all([1, 2].map(() => createUserWithWallet({ balance: 0, koriBalance: 0 })));
  const b0 = await wallet(x.buyer.id);
  const r0 = await wallet(x.rider.id);
  const callers = [[x.rider, 'rider'], [x.rider, 'rider'], [x.buyer, 'customer'], [x.buyer, 'customer'], [strangers[0], 'rider'], [strangers[1], 'customer']];
  const res = await Promise.all([...callers, ...callers].map(([u, outcome]) => call(deliveriesDisputeResolve, { userId: u.id, query: { id: x.task.id }, body: { outcome } })));
  const buyerRefund = (await wallet(x.buyer.id)).balance - b0.balance;
  const riderGainKori = (await wallet(x.rider.id)).koriBalance - r0.koriBalance;
  const escrow = await prisma.deliveryEscrow.findUnique({ where: { deliveryTaskId: x.task.id } });
  const statuses = {};
  for (const r of res) statuses[r.statusCode] = (statuses[r.statusCode] ?? 0) + 1;
  // 1 500 XOF were escrowed; paying the rider 150 ₭ (= 1 500 XOF) AND refunding the buyer pays it twice.
  const paidOutXof = buyerRefund + riderGainKori * 10;
  report('P0-B', { statuses, escrowStatus: escrow.status, buyerRefundXof: buyerRefund, riderGainKori, paidOutXof, escrowedXof: 1500, doublePayout: paidOutXof > 1500 });
  if (LEGACY) {
    assert.ok(statuses['200'] >= 1, 'legacy: a non-operator ruling succeeds (the P0-B defect)');
    assert.ok(paidOutXof >= 1500, 'legacy: the escrow moved on a non-operator ruling');
  } else {
    assert.deepEqual(Object.keys(statuses), ['403'], 'patched: every caller refused');
    assert.equal(paidOutXof, 0, 'patched: nothing moved');
    assert.equal(escrow.status, 'disputed_held');
  }
});

test('F1 cooperative payout storm: 3 coops × 12 concurrent payouts of the same verified deliveries', async () => {
  const coops = [];
  for (let i = 0; i < 3; i += 1) {
    const owner = await createUserWithWallet({ balance: 100_000, tier: 3 });
    await prisma.user.update({ where: { id: owner.id }, data: { stepUpVerifiedAt: new Date() } });
    const deviceId = await createVerifiedDevice(owner.id);
    const farmer = await createUserWithWallet({ balance: 0, tier: 2 });
    const b = await prisma.business.create({ data: { ownerId: owner.id, name: `Coop lab ${i} ${Date.now()}`, type: 'cooperative' } });
    const now = new Date();
    const ids = [];
    for (const t of [2, 1]) ids.push((await prisma.farmerDeliveryLog.create({ data: { businessId: b.id, farmerUserId: farmer.id, quantityTons: t, periodStart: new Date(now - 7 * 86400000), periodEnd: now, status: 'verified' } })).id);
    coops.push({ owner, deviceId, farmer, businessId: b.id, ids, o0: (await wallet(owner.id)).balance });
  }
  const pay = (c) => {
    const req = mockReq({ userId: c.owner.id, headers: { 'x-vercel-ip-country': 'SN', 'x-device-id': c.deviceId }, body: {} });
    return payoutFarmerDeliveries({ req, res: mockRes(), businessId: c.businessId, farmerUserId: c.farmer.id, ratePerTonXof: 500 }).then((r) => ({ ok: true, held: Boolean(r?.held) }), (e) => ({ ok: false, e: String(e?.message ?? e).slice(0, 80) }));
  };
  const res = await Promise.all(coops.flatMap((c) => Array.from({ length: 12 }, () => pay(c))));
  const due = 3 * 500; // 3 t × 500 XOF per coop
  const out = [];
  for (const c of coops) {
    const farmer = (await wallet(c.farmer.id)).balance;
    const ownerPaid = c.o0 - (await wallet(c.owner.id)).balance;
    out.push({ farmerReceived: farmer, ownerDebited: ownerPaid, timesPaid: farmer / due, runs: await prisma.payrollRun.count({ where: { businessId: c.businessId } }) });
  }
  report('F1', { coops: out, okCalls: res.filter((r) => r.ok && !r.held).length, refusedCalls: res.filter((r) => !r.ok).length });
  if (LEGACY) {
    assert.ok(out.some((o) => o.farmerReceived > due), `legacy: a farmer is paid more than once (${JSON.stringify(out)})`);
  } else {
    for (const o of out) {
      assert.equal(o.farmerReceived, due, 'patched: each farmer paid exactly once');
      assert.equal(o.ownerDebited, due, 'patched: conservation, owner debited once');
    }
  }
});
