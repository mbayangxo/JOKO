import { pegFor } from './accounts.js';
import { checkInvariants } from './invariants.js';

/**
 * Reserve & reconciliation (docs/JOKKO-J2-DESIGN.md §8). Answers, from the
 * ledger alone:
 *   1. How much do we owe users?            → liabilities (₭ and agent XOF)
 *   2. What externally settled value backs it? → settlement + clearing + cash
 *   3. Where is every difference?            → named accounts (migration,
 *      suspense, revenue, budgets, test/beta clearing) + open exceptions.
 * Internal mints never create an imaginary reserve: backing only moves when
 * a provider/cash account moves.
 */

const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

const LIABILITY_TYPES = [
  'customer_available',
  'customer_held',
  'business_wallet',
  'merchant_settlement',
  'escrow_delivery',
  'escrow_order',
  'tontine_pot',
  'voucher',
  'payment_fund',
  'agent_commission',
];
const PLATFORM_KRI_TYPES = ['fees', 'incentives_funded', 'refunds'];
const NON_REAL_PROVIDERS = new Set(['beta', 'partner_sandbox', 'mock']);

export async function ledgerPosition(db) {
  const accounts = await db.$queryRawUnsafe(
    `SELECT code, type, currency, "normalSide", balance::text AS balance, "ownerId" FROM "LedgerAccount"`,
  );
  const sum = (pred) => accounts.filter(pred).reduce((s, a) => s + num(a.balance), 0);

  const owedKori = Object.fromEntries(LIABILITY_TYPES.map((t) => [t, sum((a) => a.type === t && a.currency === 'KRI')]));
  const totalOwedKori = Object.values(owedKori).reduce((s, v) => s + v, 0);
  const platformKori = Object.fromEntries(PLATFORM_KRI_TYPES.map((t) => [t, sum((a) => a.type === t && a.currency === 'KRI')]));

  const currencies = [...new Set(accounts.filter((a) => a.currency !== 'KRI').map((a) => a.currency))];
  const external = {};
  for (const cur of currencies) {
    const real = (a) => a.currency === cur && !NON_REAL_PROVIDERS.has(a.ownerId);
    const settlement = sum((a) => real(a) && a.type === 'ext_settlement');
    const clearingIn = sum((a) => real(a) && a.type === 'ext_clearing_in');
    const clearingOut = sum((a) => real(a) && a.type === 'ext_clearing_out');
    const cash = sum((a) => a.currency === cur && a.type === 'cash_office');
    const nonReal = sum((a) => a.currency === cur && NON_REAL_PROVIDERS.has(a.ownerId) && a.type === 'ext_clearing_in');
    const agentFloat = sum((a) => a.currency === cur && a.type === 'agent_float');
    const backingMinor = settlement + clearingIn - clearingOut + cash;
    external[cur] = {
      peg: pegFor(cur),
      settlementMinor: settlement,
      clearingInMinor: clearingIn,
      clearingOutMinor: clearingOut,
      cashOfficeMinor: cash,
      nonRealClearingMinor: nonReal,
      agentFloatOwedMinor: agentFloat,
      revenueMinor: sum((a) => a.currency === cur && a.type === 'fees'),
      treasuryMinor: sum((a) => a.currency === cur && a.type === 'treasury'),
      /** External value available to back ₭ after paying agents what we owe them. */
      backingForKoriMinor: backingMinor - agentFloat,
      backingForKori: Math.floor((backingMinor - agentFloat) / pegFor(cur)),
    };
  }

  const migrationKori = sum((a) => a.type === 'migration' && a.currency === 'KRI');
  const suspenseKori = sum((a) => a.type === 'suspense' && a.currency === 'KRI');
  const faucetKori = sum((a) => a.type === 'test_faucet');
  const realBackingKori = Object.values(external).reduce((s, e) => s + e.backingForKori, 0);
  const nonRealKori = Object.values(external).reduce((s, e) => s + Math.floor(e.nonRealClearingMinor / e.peg), 0);

  return {
    owedKori,
    totalOwedKori,
    platformKori,
    external,
    realBackingKori,
    differences: {
      /** Legacy value of unproven provenance (opening balances). */
      migrationOpeningKori: migrationKori,
      suspenseKori,
      testFaucetKori: faucetKori,
      nonRealProviderKori: nonRealKori,
      platformOwnedKori: Object.values(platformKori).reduce((s, v) => s + v, 0),
    },
    /** Liabilities not covered by real external backing (≥ 0 means a shortfall). */
    uncoveredKori: totalOwedKori + Object.values(platformKori).reduce((s, v) => s + v, 0) - realBackingKori,
    coverageRatio: totalOwedKori === 0 ? 1 : realBackingKori / totalOwedKori,
  };
}

/**
 * Snapshot KoriReserve FROM the ledger (no authority of its own):
 *  - totalKoriInCirculation = what we owe (₭ liabilities)
 *  - totalReserveHeldXof    = real external backing (XOF), never ₭×10 by fiat
 * Integrity failures freeze conversions/cash-outs.
 */
export async function reconcileFromLedger(db) {
  const integrity = await checkInvariants(db, { includeUnmigrated: true });
  const pos = await ledgerPosition(db);
  const xof = pos.external.XOF ?? { settlementMinor: 0, clearingInMinor: 0, clearingOutMinor: 0, cashOfficeMinor: 0, agentFloatOwedMinor: 0 };
  const now = new Date();
  const ok = integrity.ok;
  await db.koriReserve.upsert({
    where: { id: 'global' },
    create: { id: 'global' },
    update: {},
  });
  await db.koriReserve.update({
    where: { id: 'global' },
    data: {
      totalKoriInCirculation: pos.totalOwedKori,
      totalReserveHeldXof: xof.settlementMinor + xof.clearingInMinor - xof.clearingOutMinor + xof.cashOfficeMinor,
      conversionsFrozen: !ok,
      lastReconciliationAt: now,
      lastReconciliationOk: ok,
      lastMismatchXof: ok ? 0 : -1,
    },
  });
  if (!ok) {
    console.error('[MONEY KERNEL ALERT] integrity violations — conversions frozen', integrity.violations.map((v) => `${v.id}:${v.count}`));
  }
  return { ok, integrity, position: pos, conversionsFrozen: !ok, checkedAt: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Provider statements → settlement
// ---------------------------------------------------------------------------

/**
 * Import provider settlement statement lines (external truth) and match them
 * to confirmed operations. Matched → settled (clearing → settlement posting).
 * Anything that does not match exactly becomes a ReconciliationException.
 */
export async function importStatement(db, { provider, statementId, lines }, { settle }) {
  const result = { imported: 0, duplicates: 0, settled: 0, exceptions: 0 };
  for (const line of lines) {
    const amountMinor = BigInt(line.amountMinor);
    const existing = await db.providerStatementLine.findUnique({
      where: { provider_providerReference_direction: { provider, providerReference: line.providerReference, direction: line.direction } },
    });
    if (existing) {
      result.duplicates += 1;
      continue;
    }
    const row = await db.providerStatementLine.create({
      data: { provider, providerReference: line.providerReference, direction: line.direction, amountMinor, currency: line.currency, settledAt: new Date(line.settledAt ?? Date.now()), statementId },
    });
    result.imported += 1;

    const op = await db.externalOperation.findUnique({
      where: { provider_providerReference: { provider, providerReference: line.providerReference } },
    });
    const exception = async (kind, detail) => {
      result.exceptions += 1;
      await db.reconciliationException.upsert({
        where: { kind_provider_providerReference: { kind, provider, providerReference: line.providerReference } },
        create: { kind, provider, providerReference: line.providerReference, operationId: op?.id ?? null, amountMinor, currency: line.currency, detail },
        update: {},
      });
    };
    if (!op) {
      await exception('unmatched_statement_line', 'Statement line with no Jokko operation');
      continue;
    }
    const expectedMinor = op.direction === 'in' ? op.amountMinor : op.amountMinor - op.feeMinor;
    if (op.direction !== line.direction || expectedMinor !== amountMinor || op.currency !== line.currency) {
      await exception('statement_mismatch', `Expected ${op.direction} ${expectedMinor} ${op.currency}`);
      continue;
    }
    if (op.state === 'settled') continue;
    if (op.state !== 'confirmed') {
      await exception('statement_before_confirmation', `Operation is ${op.state}`);
      continue;
    }
    await settle(op, row);
    await db.providerStatementLine.update({ where: { id: row.id }, data: { matchedOperationId: op.id } });
    result.settled += 1;
  }
  return result;
}
