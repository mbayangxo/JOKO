import '../helpers/setup.js';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConversionsFrozenError,
  ReserveInvariantError,
  applyCirculationDecrease,
  applyCirculationIncrease,
  reconcileKoriReserve,
} from '../../lib/kori-reserve.js';
import { burnKoriForCashOut, convertKoriToNational, mintKoriFromNationalDeposit } from '../../lib/kori-service.js';
import { runMoneyTransaction } from '../../lib/wallet-atomic.js';
import { createUserWithWallet, prisma, resetReserveToWallets, uniqueRef } from '../helpers/db.js';

beforeEach(() => resetReserveToWallets());
after(() => prisma.$disconnect());

async function reserve() {
  return prisma.koriReserve.findUniqueOrThrow({ where: { id: 'global' } });
}

test('minting from a national deposit raises circulation AND reserve together', async () => {
  const user = await createUserWithWallet();
  const before = await reserve();

  const result = await runMoneyTransaction(prisma, (tx) =>
    mintKoriFromNationalDeposit(tx, {
      userId: user.id,
      walletId: user.wallet.id,
      country: 'SN',
      nationalAmount: 10_000,
      reference: uniqueRef('DEP'),
    }),
  );

  assert.equal(result.koriMinted, 1_000);
  const afterState = await reserve();
  assert.equal(afterState.totalKoriInCirculation, before.totalKoriInCirculation + 1_000);
  assert.equal(afterState.totalReserveHeldXof, before.totalReserveHeldXof + 10_000);
  assert.equal(afterState.totalReserveHeldXof, afterState.totalKoriInCirculation * 10);

  const wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.koriBalance, 1_000);
});

test('burning ₭ for cash-out lowers circulation and reserve symmetrically', async () => {
  const user = await createUserWithWallet();
  await runMoneyTransaction(prisma, (tx) =>
    mintKoriFromNationalDeposit(tx, {
      userId: user.id,
      walletId: user.wallet.id,
      country: 'SN',
      nationalAmount: 10_000,
      reference: uniqueRef('DEP'),
    }),
  );
  const before = await reserve();

  // J0/J1: the cash-out burn is the only real ₭ → XOF exit (convert had no destination).
  const result = await runMoneyTransaction(prisma, (tx) =>
    burnKoriForCashOut(tx, {
      userId: user.id,
      walletId: user.wallet.id,
      country: 'SN',
      koriAmount: 500,
      reference: uniqueRef('CVT'),
    }),
  );

  assert.equal(result.koriBurned, 500);
  assert.equal(result.grossNational, 5_000);

  const afterState = await reserve();
  assert.equal(afterState.totalKoriInCirculation, before.totalKoriInCirculation - 500);
  assert.equal(afterState.totalReserveHeldXof, before.totalReserveHeldXof - 5_000);
});

test('cannot destroy more Kori than exists in circulation', async () => {
  const current = await reserve();
  await assert.rejects(
    prisma.$transaction((tx) => applyCirculationDecrease(tx, current.totalKoriInCirculation + 1)),
    ReserveInvariantError,
  );
});

test('reconciliation passes when wallets and reserve agree', async () => {
  const result = await reconcileKoriReserve(prisma);
  assert.equal(result.ok, true);
  assert.equal(result.mismatchXof, 0);
  assert.equal(result.conversionsFrozen, false);
});

test('reconciliation detects drift, freezes conversions, and blocks cash-out burns', async () => {
  const user = await createUserWithWallet();
  // Simulate an unbacked Kori increase (bug or attack): wallet up, reserve untouched.
  await prisma.wallet.update({
    where: { id: user.wallet.id },
    data: { koriBalance: { increment: 777 } },
  });

  const result = await reconcileKoriReserve(prisma);
  assert.equal(result.ok, false);
  assert.equal(result.conversionsFrozen, true);
  assert.equal(result.mismatchXof, -7_770, 'reserve is short by 777 ₭ × 10 XOF');

  await assert.rejects(
    runMoneyTransaction(prisma, (tx) =>
      burnKoriForCashOut(tx, {
        userId: user.id,
        walletId: user.wallet.id,
        country: 'SN',
        koriAmount: 10,
        reference: uniqueRef('CVT'),
      }),
    ),
    ConversionsFrozenError,
  );

  // Repair and verify conversions thaw automatically on a clean reconcile.
  await prisma.wallet.update({
    where: { id: user.wallet.id },
    data: { koriBalance: { decrement: 777 } },
  });
  const repaired = await reconcileKoriReserve(prisma);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.conversionsFrozen, false);
});

test('Kori → national conversion is refused (no destination for the value)', async () => {
  await assert.rejects(convertKoriToNational(), (e) => e.code === 'conversion_unavailable');
});

test('zero or negative circulation changes are no-ops', async () => {
  const before = await reserve();
  await prisma.$transaction(async (tx) => {
    await applyCirculationIncrease(tx, 0);
    await applyCirculationIncrease(tx, -5);
    await applyCirculationDecrease(tx, 0);
  });
  const afterState = await reserve();
  assert.equal(afterState.totalKoriInCirculation, before.totalKoriInCirculation);
  assert.equal(afterState.totalReserveHeldXof, before.totalReserveHeldXof);
});
