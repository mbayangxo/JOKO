/**
 * J1 money invariants for internal flows: no value from nothing, no value
 * destroyed, exactly-once settlement. Every assertion reads the database.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createUserWithWallet, prisma, uniqueRef } from '../helpers/db.js';
import { runAgentMonthlyPayouts } from '../../lib/agent-payout-service.js';
import {
  acceptDelivery,
  confirmDelivery,
  createDeliveryTask,
  markDelivered,
  markPickedUp,
  openDispute,
  resolveDispute,
} from '../../lib/delivery-service.js';
import { creditKoriEarn } from '../../lib/kori-service.js';
// D41: the legacy open-claim courier marketplace is off by default; these tests cover it explicitly re-enabled.
process.env.LEGACY_CONSUMER_DELIVERY_ENABLED = 'true';

after(() => prisma.$disconnect());

const kori = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).koriBalance;

test('earn rewards mint nothing unless explicitly enabled outside production', async () => {
  const u = await createUserWithWallet({ koriBalance: 10 });
  const credited = await prisma.$transaction((tx) => creditKoriEarn(tx, u.id, u.wallet.id, 'send', uniqueRef('EARN')));
  assert.equal(credited, 0);
  assert.equal(await kori(u.id), 10);
});

test('agent monthly payout is recorded as an accrued liability and never mints wallet value', async () => {
  const owner = await createUserWithWallet({ koriBalance: 0 });
  const agent = await prisma.agentProfile.create({
    data: { userId: owner.id, agentCode: `AGT-J${crypto.randomInt(100000, 999999)}`, displayName: 'QA Agent', floatBalance: 0, status: 'active' },
  });
  const customer = await createUserWithWallet();
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  await prisma.agentDeposit.create({
    data: {
      reference: uniqueRef('ADEP'), token: uniqueRef('TOK'), userId: customer.id, agentId: agent.id,
      amountXof: 200_000, status: 'confirmed', expiresAt: lastMonth, confirmedAt: lastMonth,
    },
  });

  const result = await runAgentMonthlyPayouts(prisma, now);
  const mine = result.results.find((r) => r.agentId === agent.id);
  assert.equal(mine.status, 'accrued');
  assert.equal(mine.totalPaidXof, 25_000 + 1_000, 'flat fee + 0.5% bonus, in XOF');
  assert.equal(await kori(owner.id), 0, 'no ₭ minted (was 26 000 ₭ = 260 000 XOF before J1)');
  const row = await prisma.agentPayout.findFirst({ where: { agentId: agent.id } });
  assert.equal(row.status, 'accrued');

  const again = await runAgentMonthlyPayouts(prisma, now);
  assert.equal(again.results.find((r) => r.agentId === agent.id).status, 'skipped', 'never accrued twice');
});

async function deliveryFixture({ fee = 1500, buyerKori = 1000 } = {}) {
  const buyer = await createUserWithWallet({ koriBalance: buyerKori });
  const rider = await createUserWithWallet({ koriBalance: 0 });
  const merchant = await createUserWithWallet();
  const business = await prisma.business.create({ data: { ownerId: merchant.id, name: 'QA shop', type: 'merchant' } });
  const order = await prisma.order.create({
    data: { buyerId: buyer.id, businessId: business.id, totalAmount: 1000, status: 'paid', orderReference: uniqueRef('ORD') },
  });
  const task = await createDeliveryTask(prisma, {
    orderId: order.id, buyerId: buyer.id, dropoffArea: 'Plateau', dropoffAddress: 'Rue 1', deliveryFeeNational: fee,
  });
  return { buyer, rider, task };
}

test('delivery escrow conserves value: buyer pays fee→₭ once, rider receives exactly that, nothing minted', async () => {
  const { buyer, rider, task } = await deliveryFixture({ fee: 1500, buyerKori: 1000 });
  const before = (await kori(buyer.id)) + (await kori(rider.id));

  await acceptDelivery(prisma, { taskId: task.id, riderId: rider.id, reference: uniqueRef('ESC') });
  assert.equal(await kori(buyer.id), 1000 - 150, '1 500 XOF fee = 150 ₭ held (was 1 500 ₭ before J1)');

  await markPickedUp(prisma, { taskId: task.id, riderId: rider.id });
  await markDelivered(prisma, { taskId: task.id, riderId: rider.id });
  await confirmDelivery(prisma, { taskId: task.id, buyerId: buyer.id });
  assert.equal(await kori(rider.id), 150, 'rider paid the escrowed fee');
  assert.equal((await kori(buyer.id)) + (await kori(rider.id)), before, 'system total conserved');

  await assert.rejects(confirmDelivery(prisma, { taskId: task.id, buyerId: buyer.id }));
  assert.equal(await kori(rider.id), 150, 'never paid twice');
});

test('delivery: two riders accepting concurrently → one escrow, one debit', async () => {
  const { buyer, task } = await deliveryFixture({ fee: 1000, buyerKori: 1000 });
  const r1 = await createUserWithWallet();
  const r2 = await createUserWithWallet();
  const results = await Promise.allSettled([
    acceptDelivery(prisma, { taskId: task.id, riderId: r1.id, reference: uniqueRef('ESC') }),
    acceptDelivery(prisma, { taskId: task.id, riderId: r2.id, reference: uniqueRef('ESC') }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await prisma.deliveryEscrow.count({ where: { deliveryTaskId: task.id } }), 1);
  assert.equal(await kori(buyer.id), 900);
});

test('delivery dispute refund returns exactly the escrowed ₭ to the buyer', async () => {
  const { buyer, rider, task } = await deliveryFixture({ fee: 2000, buyerKori: 500 });
  await acceptDelivery(prisma, { taskId: task.id, riderId: rider.id, reference: uniqueRef('ESC') });
  await markPickedUp(prisma, { taskId: task.id, riderId: rider.id });
  await markDelivered(prisma, { taskId: task.id, riderId: rider.id });
  await openDispute(prisma, { taskId: task.id, buyerId: buyer.id, note: 'never arrived' });
  await resolveDispute(prisma, { taskId: task.id, outcome: 'customer', resolutionNote: 'refund' });
  assert.equal(await kori(buyer.id), 500);
  assert.equal(await kori(rider.id), 0);
});

test('reconciliation counts escrowed ₭ — a delivery hold no longer freezes cash-outs as false drift', async () => {
  const { reconcileKoriReserve } = await import('../../lib/kori-reserve.js');
  const { resetReserveToWallets } = await import('../helpers/db.js');
  const { buyer, rider, task } = await deliveryFixture({ fee: 1000, buyerKori: 1000 });
  await resetReserveToWallets();
  await acceptDelivery(prisma, { taskId: task.id, riderId: rider.id, reference: uniqueRef('ESC') });
  const r = await reconcileKoriReserve(prisma);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.custody.deliveryEscrow >= 100);
  assert.equal(await kori(buyer.id), 900);
});
