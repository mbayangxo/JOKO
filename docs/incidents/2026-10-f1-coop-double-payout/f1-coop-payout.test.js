/**
 * F1 hotfix regression (production base 7d262de): a cooperative payout pays the farmer exactly once,
 * whatever the concurrency; several logs pay together; a failed transfer pays nothing and leaves the
 * logs payable. Money conservation is checked on the wallets involved.
 */
import '../helpers/setup.js';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { payoutFarmerDeliveries } from '../../lib/cooperative-service.js';
import { createUserWithWallet, mockReq, mockRes, prisma, resetReserveToWallets, createVerifiedDevice } from '../helpers/db.js';

beforeEach(async () => { await resetReserveToWallets(); });
after(async () => { await prisma.$disconnect(); });

async function coop({ ownerBalance = 50_000, logs = [2] } = {}) {
  const owner = await createUserWithWallet({ balance: ownerBalance, tier: 3 });
  await prisma.user.update({ where: { id: owner.id }, data: { stepUpVerifiedAt: new Date() } });
  const deviceId = await createVerifiedDevice(owner.id);
  const farmer = await createUserWithWallet({ balance: 0, tier: 2 });
  const b = await prisma.business.create({ data: { ownerId: owner.id, name: `Coop F1 ${Date.now()}`, type: 'cooperative' } });
  const now = new Date();
  const ids = [];
  for (const t of logs) ids.push((await prisma.farmerDeliveryLog.create({ data: { businessId: b.id, farmerUserId: farmer.id, quantityTons: t, periodStart: new Date(now - 7 * 86400000), periodEnd: now, status: 'verified' } })).id);
  return { owner, deviceId, farmer, businessId: b.id, ids };
}
const pay = (c, rate = 500) => {
  const req = mockReq({ userId: c.owner.id, headers: { 'x-vercel-ip-country': 'SN', 'x-device-id': c.deviceId }, body: {} });
  return payoutFarmerDeliveries({ req, res: mockRes(), businessId: c.businessId, farmerUserId: c.farmer.id, ratePerTonXof: rate }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message }));
};
const bal = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).balance;

test('F1: 4 concurrent payouts of the same verified deliveries pay the farmer exactly once', async () => {
  const c = await coop({ logs: [2] });
  const o0 = await bal(c.owner.id);
  const res = await Promise.all([pay(c), pay(c), pay(c), pay(c)]);
  assert.equal(res.filter((x) => x.ok && !x.r.held).length, 1, JSON.stringify(res.map((x) => x.ok ? 'ok' : x.e)));
  assert.equal(await bal(c.farmer.id), 1000);
  assert.equal(await bal(c.owner.id), o0 - 1000, 'conservation: owner debited once');
  assert.equal(await prisma.payrollRun.count({ where: { businessId: c.businessId } }), 1);
  const log = await prisma.farmerDeliveryLog.findUnique({ where: { id: c.ids[0] } });
  assert.equal(log.status, 'paid');
  const again = await pay(c);
  assert.equal(again.ok, false);
  assert.equal(await bal(c.farmer.id), 1000);
});

test('F1: two logs are paid together, once (per-log references; the old code failed after paying)', async () => {
  const c = await coop({ logs: [1, 3] });
  const r = await pay(c);
  assert.ok(r.ok, r.e);
  const logs = await prisma.farmerDeliveryLog.findMany({ where: { businessId: c.businessId } });
  assert.deepEqual(logs.map((l) => l.status).sort(), ['paid', 'paid']);
  assert.equal(await bal(c.farmer.id), 2000);
  assert.equal((await pay(c)).ok, false);
  assert.equal(await bal(c.farmer.id), 2000);
});

test('F1: a failed transfer (insufficient owner funds) pays nothing and leaves the logs payable', async () => {
  const c = await coop({ ownerBalance: 100, logs: [5] });
  const r = await pay(c, 5000);
  assert.equal(r.ok, false);
  assert.equal(await bal(c.farmer.id), 0);
  const log = await prisma.farmerDeliveryLog.findUnique({ where: { id: c.ids[0] } });
  assert.deepEqual([log.status, log.payoutReference], ['verified', null]);
});
