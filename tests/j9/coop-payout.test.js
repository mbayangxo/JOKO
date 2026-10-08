/**
 * J9.0 audit finding — cooperative produce payout (legacy, live route).
 * Paying a farmer for verified deliveries must happen exactly once, even under
 * concurrent or retried requests: the logs are claimed in the SAME transaction as
 * the transfer. J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { businessesCreate } from '../../lib/handlers.js';
import { businessTransferHandler, cooperativeDeliveriesHandler, cooperativeVerifyHandler, cooperativePayoutHandler } from '../../lib/org-handlers.js';
import { ensureAfriId } from '../../lib/afri-id.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { createUserWithWallet, mockReq, mockRes, prisma, resetReserveToWallets, createVerifiedDevice } from '../helpers/db.js';

beforeEach(async () => { await resetReserveToWallets(); });
afterEach(async () => { await assertInvariants(prisma); });
after(async () => { await prisma.$disconnect(); });

async function call(handler, { userId, body, query, method = 'POST', deviceId } = {}) {
  const req = mockReq({ userId, body, query, method, headers: { 'x-vercel-ip-country': 'SN', ...(deviceId ? { 'x-device-id': deviceId } : {}) } });
  const res = mockRes();
  await handler(req, res);
  return res;
}

async function coopWithVerifiedDelivery({ tons = 2 } = {}) {
  const owner = await createUserWithWallet({ koriBalance: 30_000, tier: 3 });
  await ensureAfriId(owner.id);
  await prisma.user.update({ where: { id: owner.id }, data: { stepUpVerifiedAt: new Date() } });
  const deviceId = await createVerifiedDevice(owner.id);
  const farmer = await createUserWithWallet({ koriBalance: 0, tier: 2, handle: `farmer${Date.now()}${Math.floor(Math.random() * 1e4)}` });
  const biz = await call(businessesCreate, { userId: owner.id, deviceId, body: { name: 'Coop Payout', type: 'cooperative', category: 'agriculture' } });
  const businessId = biz.body.id;
  await call(businessTransferHandler, { userId: owner.id, deviceId, query: { id: businessId }, body: { kind: 'capital_in', amount: 10_000 } });
  const now = new Date();
  const log = await call(cooperativeDeliveriesHandler, { userId: owner.id, query: { id: businessId }, body: { farmerHandle: farmer.handle, quantityTons: tons, periodStart: new Date(now - 7 * 86400000).toISOString(), periodEnd: now.toISOString() } });
  assert.equal(log.statusCode, 201, JSON.stringify(log.body));
  const v = await call(cooperativeVerifyHandler, { userId: owner.id, query: { id: businessId, subId: log.body.id }, body: { approved: true } });
  assert.equal(v.statusCode, 200);
  return { owner, deviceId, farmer, businessId, logId: log.body.id };
}

const farmerBalance = async (id) => (await prisma.wallet.findUnique({ where: { userId: id } })).koriBalance;
const paidRuns = async (c) => prisma.payrollRun.count({ where: { businessId: c.businessId } });

test('concurrent payouts of the same verified deliveries pay the farmer exactly once', async () => {
  const c = await coopWithVerifiedDelivery({ tons: 2 });
  const pay = () => call(cooperativePayoutHandler, { userId: c.owner.id, deviceId: c.deviceId, query: { id: c.businessId }, body: { farmerUserId: c.farmer.id, ratePerTonXof: 500 } });
  const res = await Promise.all([pay(), pay(), pay(), pay()]);
  assert.equal(res.filter((r) => r.statusCode === 201).length, 1, JSON.stringify(res.map((r) => [r.statusCode, r.body?.error])));
  const once = await farmerBalance(c.farmer.id);
  assert.ok(once > 0);
  assert.equal(await paidRuns(c), 1);
  const log = await prisma.farmerDeliveryLog.findUnique({ where: { id: c.logId } });
  assert.equal(log.status, 'paid');
  assert.match(log.payoutReference, new RegExp(`:${c.logId}$`));
  // A retry after success pays nothing more.
  const again = await pay();
  assert.notEqual(again.statusCode, 201);
  assert.equal(await farmerBalance(c.farmer.id), once);
  assert.equal(await paidRuns(c), 1);
});

test('several verified deliveries are paid together, once (per-log payout references)', async () => {
  const c = await coopWithVerifiedDelivery({ tons: 1 });
  const now = new Date();
  const log2 = await call(cooperativeDeliveriesHandler, { userId: c.owner.id, query: { id: c.businessId }, body: { farmerHandle: (await prisma.user.findUnique({ where: { id: c.farmer.id } })).handle, quantityTons: 3, periodStart: new Date(now - 86400000).toISOString(), periodEnd: now.toISOString() } });
  await call(cooperativeVerifyHandler, { userId: c.owner.id, query: { id: c.businessId, subId: log2.body.id }, body: { approved: true } });
  const r = await call(cooperativePayoutHandler, { userId: c.owner.id, deviceId: c.deviceId, query: { id: c.businessId }, body: { farmerUserId: c.farmer.id, ratePerTonXof: 500 } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(r.body.deliveryCount, 2);
  const logs = await prisma.farmerDeliveryLog.findMany({ where: { businessId: c.businessId } });
  assert.deepEqual(logs.map((l) => l.status), ['paid', 'paid']);
  assert.equal(await paidRuns(c), 1);
  const again = await call(cooperativePayoutHandler, { userId: c.owner.id, deviceId: c.deviceId, query: { id: c.businessId }, body: { farmerUserId: c.farmer.id, ratePerTonXof: 500 } });
  assert.notEqual(again.statusCode, 201);
  assert.equal(await paidRuns(c), 1);
});

test('a failed transfer (insufficient business funds) releases the claim: nothing paid, logs payable again', async () => {
  const c = await coopWithVerifiedDelivery({ tons: 100 });
  const r = await call(cooperativePayoutHandler, { userId: c.owner.id, deviceId: c.deviceId, query: { id: c.businessId }, body: { farmerUserId: c.farmer.id, ratePerTonXof: 5000 } });
  assert.notEqual(r.statusCode, 201);
  assert.equal(await farmerBalance(c.farmer.id), 0);
  const log = await prisma.farmerDeliveryLog.findUnique({ where: { id: c.logId } });
  assert.deepEqual([log.status, log.payoutReference], ['verified', null]);
});
