import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConversionsFrozenError,
  applyCirculationDecrease,
  applyCirculationIncrease,
  reconcileKoriReserve,
} from '../../lib/kori-reserve.js';
import { burnKoriForCashOut, convertKoriToNational, mintKoriFromNationalDeposit } from '../../lib/kori-service.js';
import { runMoneyTransaction } from '../../lib/wallet-atomic.js';
import { cashOutConfirmed } from '../../lib/money-kernel/index.js';
import { ledgerPosition } from '../../lib/money-kernel/reconciliation.js';
import { createUserWithWallet, prisma, uniqueRef } from '../helpers/db.js';

/**
 * J2: the reserve is derived from the ledger. Value is "backed" only when an
 * external account (provider clearing/settlement, attested cash) moves —
 * never because ₭ was created internally.
 */

after(() => prisma.$disconnect());

const position = () => prisma.$transaction((tx) => ledgerPosition(tx));

test('a provider-confirmed cash-in raises what we owe AND real external backing together', async () => {
  const user = await createUserWithWallet();
  const before = await position();

  const result = await runMoneyTransaction(prisma, (tx) =>
    mintKoriFromNationalDeposit(tx, { userId: user.id, walletId: user.wallet.id, country: 'SN', nationalAmount: 10_000, reference: uniqueRef('DEP') }),
  );

  assert.equal(result.koriMinted, 1_000);
  const afterPos = await position();
  assert.equal(afterPos.totalOwedKori - before.totalOwedKori, 1_000);
  assert.equal(afterPos.external.XOF.clearingInMinor - (before.external.XOF?.clearingInMinor ?? 0), 10_000, 'provider owes us 10 000 XOF');
  assert.equal(afterPos.realBackingKori - before.realBackingKori, 1_000);

  const wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.koriBalance, 1_000);
});

test('cash-out: authorization holds (still owed), provider confirmation retires the ₭ and books the payout', async () => {
  const user = await createUserWithWallet();
  await runMoneyTransaction(prisma, (tx) =>
    mintKoriFromNationalDeposit(tx, { userId: user.id, walletId: user.wallet.id, country: 'SN', nationalAmount: 10_000, reference: uniqueRef('DEP') }),
  );
  const before = await position();
  const reference = uniqueRef('CVT');

  const result = await runMoneyTransaction(prisma, (tx) =>
    burnKoriForCashOut(tx, { userId: user.id, walletId: user.wallet.id, country: 'SN', koriAmount: 500, reference }),
  );
  assert.equal(result.koriBurned, 500);
  assert.equal(result.grossNational, 5_000);

  const held = await position();
  assert.equal(held.totalOwedKori, before.totalOwedKori, 'held ₭ are still owed to the customer');
  assert.equal(held.owedKori.customer_held - before.owedKori.customer_held, 500);
  assert.equal((await prisma.wallet.findUnique({ where: { id: user.wallet.id } })).koriBalance, 500, 'not spendable');

  await runMoneyTransaction(prisma, (tx) =>
    cashOutConfirmed(tx, { userId: user.id, provider: 'julaya', currency: 'XOF', amountKori: 500, reference: `${reference}-CONFIRM` }),
  );
  const done = await position();
  assert.equal(before.totalOwedKori - done.totalOwedKori, 500);
  assert.equal(done.external.XOF.clearingOutMinor - (before.external.XOF?.clearingOutMinor ?? 0), 5_000, 'we owe the provider what it paid out');
});

test('internal funding creates NO reserve: it shows up as a named, unbacked difference', async () => {
  const before = await position();
  await createUserWithWallet({ koriBalance: 777 }); // test faucet (non-production)
  const afterPos = await position();
  assert.equal(afterPos.totalOwedKori - before.totalOwedKori, 777);
  assert.equal(afterPos.realBackingKori, before.realBackingKori, 'backing unchanged');
  assert.equal(afterPos.differences.testFaucetKori - before.differences.testFaucetKori, 777);
});

test('reconciliation passes when the ledger is intact', async () => {
  const result = await reconcileKoriReserve(prisma);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.conversionsFrozen, false);
  const snap = await prisma.koriReserve.findUniqueOrThrow({ where: { id: 'global' } });
  assert.equal(snap.totalKoriInCirculation, result.owedKori, 'snapshot = ledger liabilities');
});

test('tampering below the application (DDL access) is detected, freezes conversions and blocks cash-out', async () => {
  const user = await createUserWithWallet({ koriBalance: 100 });
  // An attacker with DDL rights disables the guard and inflates a projection.
  await prisma.$executeRawUnsafe('ALTER TABLE "Wallet" DISABLE TRIGGER j2_projection_guard');
  try {
    await prisma.$executeRawUnsafe(`UPDATE "Wallet" SET "koriBalance" = "koriBalance" + 777 WHERE id = '${user.wallet.id}'`);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "Wallet" ENABLE TRIGGER j2_projection_guard');
  }

  const result = await reconcileKoriReserve(prisma);
  assert.equal(result.ok, false);
  assert.equal(result.conversionsFrozen, true);
  assert.ok(result.violations.some((v) => v.id === 'I11'), 'projection drift named');

  await assert.rejects(
    runMoneyTransaction(prisma, (tx) =>
      burnKoriForCashOut(tx, { userId: user.id, walletId: user.wallet.id, country: 'SN', koriAmount: 10, reference: uniqueRef('CVT') }),
    ),
    ConversionsFrozenError,
  );

  // Repair (same DDL route) and verify conversions thaw on a clean reconcile.
  await prisma.$executeRawUnsafe('ALTER TABLE "Wallet" DISABLE TRIGGER j2_projection_guard');
  try {
    await prisma.$executeRawUnsafe(`UPDATE "Wallet" SET "koriBalance" = "koriBalance" - 777 WHERE id = '${user.wallet.id}'`);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "Wallet" ENABLE TRIGGER j2_projection_guard');
  }
  const repaired = await reconcileKoriReserve(prisma);
  assert.equal(repaired.ok, true, JSON.stringify(repaired.violations));
  assert.equal(repaired.conversionsFrozen, false);
});

test('Kori → national conversion is refused (no destination for the value)', async () => {
  await assert.rejects(convertKoriToNational(), (e) => e.code === 'conversion_unavailable');
});

test('legacy circulation counters are inert (the ledger is the only authority)', async () => {
  const before = await prisma.koriReserve.findUniqueOrThrow({ where: { id: 'global' } });
  await prisma.$transaction(async (tx) => {
    await applyCirculationIncrease(tx, 1_000_000);
    await applyCirculationDecrease(tx, 5);
  });
  const afterState = await prisma.koriReserve.findUniqueOrThrow({ where: { id: 'global' } });
  assert.equal(afterState.totalKoriInCirculation, before.totalKoriInCirculation);
  assert.equal(afterState.totalReserveHeldXof, before.totalReserveHeldXof);
});
