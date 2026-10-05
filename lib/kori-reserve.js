/**
 * Kori reserve — J2: a SNAPSHOT derived from the Money Kernel ledger.
 *
 * Pre-J2 every mint added "₭ × 10 XOF held" to a counter, so the "reserve"
 * proved only that the counter matched itself (an imaginary reserve). Now:
 *  - totalKoriInCirculation = ₭ the platform owes (ledger liabilities)
 *  - totalReserveHeldXof    = REAL external backing (provider settlement +
 *    confirmed clearing + attested cash), never inferred from mints
 *  - reconciliation = the read-only invariant checker; any integrity failure
 *    freezes conversions/cash-outs.
 * applyCirculationIncrease/Decrease are kept as no-ops for call-site
 * compatibility — the ledger is the only authority.
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
  // A missing reserve row is created unfrozen (the freeze flag is set only by
  // reconciliation); a fresh database must not turn every cash-out into a 502.
  await ensureReserve(tx);
  await lockReserve(tx);
  const reserve = await tx.koriReserve.findUniqueOrThrow({ where: { id: 'global' } });
  if (reserve.conversionsFrozen) {
    throw new ConversionsFrozenError();
  }
}

/** Deprecated (J2): circulation is derived from the ledger. No-op. */
export async function applyCirculationIncrease() {}

/** Deprecated (J2): circulation is derived from the ledger. No-op. */
export async function applyCirculationDecrease() {}

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
  // J2: every place ₭ sits is a ledger liability account.
  const rows = await tx.$queryRawUnsafe(`
    SELECT type, COALESCE(SUM(balance), 0)::text AS total FROM "LedgerAccount"
    WHERE currency = 'KRI' AND type IN ('customer_available','customer_held','business_wallet','payment_fund','voucher','tontine_pot','escrow_delivery','escrow_order','merchant_settlement','agent_commission')
    GROUP BY type`);
  const by = Object.fromEntries(rows.map((r) => [r.type, Number(r.total)]));
  const parts = {
    wallets: (by.customer_available ?? 0) + (by.customer_held ?? 0),
    businessWallets: by.business_wallet ?? 0,
    paymentFunds: by.payment_fund ?? 0,
    merchantVouchers: by.voucher ?? 0,
    tontinePots: by.tontine_pot ?? 0,
    deliveryEscrow: (by.escrow_delivery ?? 0) + (by.escrow_order ?? 0),
    other: (by.merchant_settlement ?? 0) + (by.agent_commission ?? 0),
  };
  return { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

/**
 * Reconciliation (J2): run the read-only invariant checker and re-derive the
 * reserve snapshot from the ledger. Integrity failure → conversions frozen.
 */
export async function reconcileKoriReserve(db) {
  const { reconcileFromLedger } = await import('./money-kernel/reconciliation.js');
  const r = await db.$transaction((tx) => reconcileFromLedger(tx), { timeout: 120_000 });
  const reserve = await db.koriReserve.findUniqueOrThrow({ where: { id: 'global' } });
  const custody = await custodyKoriTotals(db);
  return {
    ok: r.ok,
    custody,
    conversionsFrozen: r.conversionsFrozen,
    violations: r.integrity.violations.map((v) => ({ id: v.id, detail: v.detail, count: v.count })),
    owedKori: r.position.totalOwedKori,
    realBackingKori: r.position.realBackingKori,
    uncoveredKori: r.position.uncoveredKori,
    differences: r.position.differences,
    walletKoriTotal: r.position.totalOwedKori,
    reserveCirculation: reserve.totalKoriInCirculation,
    reserveXof: reserve.totalReserveHeldXof,
    mismatchXof: r.ok ? 0 : -1,
    circulationDrift: 0,
    checkedAt: r.checkedAt,
  };
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
