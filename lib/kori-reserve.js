/**
 * Kori reserve accounting — invariant: totalReserveHeldXof === totalKoriInCirculation × 10 XOF
 * (also must match SUM(wallet.koriBalance) × 10, verified hourly).
 */

import { RESERVE_XOF_PER_KORI } from './kori.js';

export class ConversionsFrozenError extends Error {
  constructor(message = 'Kori conversions are temporarily frozen pending reserve reconciliation') {
    super(message);
    this.name = 'ConversionsFrozenError';
    this.code = 'conversions_frozen';
  }
}

export class ReserveInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReserveInvariantError';
    this.code = 'reserve_invariant';
  }
}

export function expectedReserveXof(circulationKori) {
  return circulationKori * RESERVE_XOF_PER_KORI;
}

export function assertReserveInvariant(circulationKori, reserveXof) {
  const expected = expectedReserveXof(circulationKori);
  if (reserveXof !== expected) {
    throw new ReserveInvariantError(
      `Reserve invariant violated: ${circulationKori} ₭ requires ${expected} XOF reserve, got ${reserveXof}`,
    );
  }
}

export async function lockReserve(tx) {
  await tx.$executeRaw`SELECT id FROM "KoriReserve" WHERE id = 'global' FOR UPDATE`;
}

export async function ensureReserve(db) {
  return db.koriReserve.upsert({
    where: { id: 'global' },
    update: {},
    create: { id: 'global' },
  });
}

/** Block ₭→national conversion when reserve reconciliation failed. */
export async function assertConversionsAllowed(tx) {
  await lockReserve(tx);
  const reserve = await tx.koriReserve.findUniqueOrThrow({ where: { id: 'global' } });
  if (reserve.conversionsFrozen) {
    throw new ConversionsFrozenError();
  }
}

/**
 * Every Kori creation (mint, earn) must increase circulation AND reserve XOF together.
 */
export async function applyCirculationIncrease(tx, koriAmount) {
  if (koriAmount <= 0) return;

  await ensureReserve(tx);
  await lockReserve(tx);

  const reserve = await tx.koriReserve.findUniqueOrThrow({ where: { id: 'global' } });
  const newCirculation = reserve.totalKoriInCirculation + koriAmount;
  const newReserveXof = reserve.totalReserveHeldXof + koriAmount * RESERVE_XOF_PER_KORI;

  assertReserveInvariant(newCirculation, newReserveXof);

  await tx.koriReserve.update({
    where: { id: 'global' },
    data: {
      totalKoriInCirculation: newCirculation,
      totalReserveHeldXof: newReserveXof,
    },
  });
}

/**
 * Every Kori destruction (conversion to national) must decrease circulation AND reserve XOF.
 */
export async function applyCirculationDecrease(tx, koriAmount) {
  if (koriAmount <= 0) return;

  await lockReserve(tx);

  const reserve = await tx.koriReserve.findUniqueOrThrow({ where: { id: 'global' } });
  if (reserve.totalKoriInCirculation < koriAmount) {
    throw new ReserveInvariantError('Cannot destroy more Kori than in circulation');
  }

  const newCirculation = reserve.totalKoriInCirculation - koriAmount;
  const newReserveXof = reserve.totalReserveHeldXof - koriAmount * RESERVE_XOF_PER_KORI;

  assertReserveInvariant(newCirculation, newReserveXof);

  await tx.koriReserve.update({
    where: { id: 'global' },
    data: {
      totalKoriInCirculation: newCirculation,
      totalReserveHeldXof: newReserveXof,
    },
  });
}

/**
 * Hourly reconciliation:
 * SUM(wallet.koriBalance) × 10 must equal totalReserveHeldXof.
 * On mismatch: alert + freeze conversions.
 */
/**
 * Every place ₭ can legitimately sit. Reconciling against personal wallets
 * alone reported any escrowed/pot/business balance as "drift" and froze all
 * cash-outs. Keep this list in sync with the money-mutation map (J2: replaced
 * by ledger accounts).
 */
export async function custodyKoriTotals(tx) {
  const [wallets, business, funds, vouchers, tontinePots, escrowNew, escrowLegacy] = await Promise.all([
    tx.wallet.aggregate({ _sum: { koriBalance: true } }),
    tx.businessWallet.aggregate({ _sum: { balance: true } }),
    tx.paymentFund.aggregate({ _sum: { balanceKori: true } }),
    tx.merchantVoucher.aggregate({ _sum: { balanceKori: true } }),
    tx.tontineGroup.aggregate({ _sum: { potBalance: true } }),
    tx.deliveryEscrow.aggregate({
      where: { status: { in: ['reserved', 'disputed_held'] }, amountKoriHeld: { not: null } },
      _sum: { amountKoriHeld: true },
    }),
    tx.deliveryEscrow.aggregate({
      where: { status: { in: ['reserved', 'disputed_held'] }, amountKoriHeld: null },
      _sum: { amountNational: true },
    }),
  ]);
  const parts = {
    wallets: wallets._sum.koriBalance ?? 0,
    businessWallets: business._sum.balance ?? 0,
    paymentFunds: funds._sum.balanceKori ?? 0,
    merchantVouchers: vouchers._sum.balanceKori ?? 0,
    tontinePots: tontinePots._sum.potBalance ?? 0,
    deliveryEscrow: (escrowNew._sum.amountKoriHeld ?? 0) + (escrowLegacy._sum.amountNational ?? 0),
  };
  return { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

export async function reconcileKoriReserve(db) {
  return db.$transaction(async (tx) => {
    await ensureReserve(tx);
    await lockReserve(tx);

    const custody = await custodyKoriTotals(tx);
    const walletKoriTotal = custody.total;

    const reserve = await tx.koriReserve.findUniqueOrThrow({ where: { id: 'global' } });
    const expectedXof = expectedReserveXof(walletKoriTotal);
    const mismatchXof = reserve.totalReserveHeldXof - expectedXof;
    const circulationDrift = reserve.totalKoriInCirculation - walletKoriTotal;
    const ok = mismatchXof === 0 && circulationDrift === 0;

    const now = new Date();

    if (!ok) {
      console.error('[KORI RESERVE ALERT] Reconciliation failed', {
        walletKoriTotal,
        reserveCirculation: reserve.totalKoriInCirculation,
        reserveXof: reserve.totalReserveHeldXof,
        expectedReserveXof: expectedXof,
        mismatchXof,
        circulationDrift,
      });

      await tx.koriReserve.update({
        where: { id: 'global' },
        data: {
          conversionsFrozen: true,
          lastReconciliationAt: now,
          lastReconciliationOk: false,
          lastMismatchXof: mismatchXof,
        },
      });
    } else {
      await tx.koriReserve.update({
        where: { id: 'global' },
        data: {
          conversionsFrozen: false,
          lastReconciliationAt: now,
          lastReconciliationOk: true,
          lastMismatchXof: 0,
        },
      });
    }

    return {
      ok,
      walletKoriTotal,
      reserveCirculation: reserve.totalKoriInCirculation,
      reserveXof: reserve.totalReserveHeldXof,
      expectedReserveXof: expectedXof,
      mismatchXof,
      circulationDrift,
      conversionsFrozen: !ok,
      custody,
      checkedAt: now.toISOString(),
    };
  });
}

export function reserveShape(reserve) {
  return {
    id: reserve.id,
    totalKoriInCirculation: reserve.totalKoriInCirculation,
    totalReserveHeldXof: reserve.totalReserveHeldXof,
    expectedReserveXof: expectedReserveXof(reserve.totalKoriInCirculation),
    conversionsFrozen: reserve.conversionsFrozen,
    lastReconciliationAt: reserve.lastReconciliationAt?.toISOString() ?? null,
    lastReconciliationOk: reserve.lastReconciliationOk,
    lastMismatchXof: reserve.lastMismatchXof,
    lastUpdated: reserve.lastUpdated.toISOString(),
  };
}
