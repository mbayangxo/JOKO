import { PROJECTION_COLUMN, specs } from './accounts.js';
import { ensureAccount } from './ledger.js';

/**
 * Opening-balance backfill (docs/JOKKO-J2-DESIGN.md §10, step 2–5).
 *
 * For every legacy row that holds value but has no ledger account yet, open
 * the account; the resolver posts ONE `opening_balance` entry from
 * `migration:opening:{CUR}` with the legacy value and its provenance
 * (table, id, value, snapshot time). No history is invented.
 * After posting, the ledger balance is compared to the legacy value for every
 * row; any mismatch stops the batch.
 *
 * Value that is NOT migrated (needs a decision) is reported, never moved:
 *  - legacy Wallet.balance (XOF column);
 *  - legacy money-bearing tables (Kebu investments, redemptions, Ñu Lekk,
 *    promo uses) — see docs/JOKKO-LEGACY-SCHEMA.md.
 */

const SPEC_FOR = {
  Wallet: async (tx, row) => specs.customerAvailable((await tx.wallet.findUniqueOrThrow({ where: { id: row.id } })).userId, row.id),
  BusinessWallet: async (tx, row) => specs.businessWallet((await tx.businessWallet.findUniqueOrThrow({ where: { id: row.id } })).businessId, row.id),
  PaymentFund: async (_tx, row) => specs.paymentFund(row.id),
  MerchantVoucher: async (_tx, row) => specs.voucher(row.id),
  AgentProfile: async (_tx, row) => specs.agentFloat(row.id, 'XOF'),
  TontineGroup: async (_tx, row) => specs.tontinePot(row.id),
};

const LEGACY_VALUE_TABLES = [
  ['KebuInvestment', 'amountKori'],
  ['KebuInvestmentPayout', 'amountKori'],
  ['KoriRedemption', 'costKori'],
  ['NuLekkShare', 'amountKori'],
  ['MerchantPromoUse', 'discountKori'],
];

async function pendingRows(db) {
  const out = [];
  for (const [table, col] of Object.entries(PROJECTION_COLUMN)) {
    const rows = await db.$queryRawUnsafe(`
      SELECT t.id, t."${col}"::bigint AS value FROM "${table}" t
      WHERE t."${col}" <> 0 AND NOT EXISTS (
        SELECT 1 FROM "LedgerAccount" a WHERE a."projTable" = '${table}' AND a."projId" = t.id)
      ORDER BY t.id`);
    for (const r of rows) out.push({ table, id: r.id, value: Number(r.value) });
  }
  const escrows = await db.$queryRawUnsafe(`
    SELECT e."deliveryTaskId" AS id, COALESCE(e."amountKoriHeld", e."amountNational")::bigint AS value
    FROM "DeliveryEscrow" e
    WHERE e.status IN ('reserved','disputed_held')
      AND NOT EXISTS (SELECT 1 FROM "LedgerAccount" a WHERE a.code = 'escrow:delivery:' || e."deliveryTaskId")`);
  for (const r of escrows) out.push({ table: 'DeliveryEscrow', id: r.id, value: Number(r.value) });
  return out;
}

async function legacyReport(db) {
  const xof = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS rows, COALESCE(SUM(balance),0)::bigint AS total FROM "Wallet" WHERE balance <> 0`);
  const tables = [];
  for (const [t, col] of LEGACY_VALUE_TABLES) {
    const exists = await db.$queryRawUnsafe(`SELECT to_regclass('public."${t}"') IS NOT NULL AS ok`);
    if (!exists[0].ok) continue;
    const r = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS rows, COALESCE(SUM("${col}"),0)::bigint AS total FROM "${t}"`);
    tables.push({ table: t, rows: r[0].rows, totalKori: Number(r[0].total) });
  }
  return { legacyWalletXof: { rows: xof[0].rows, totalXof: Number(xof[0].total) }, legacyValueTables: tables, note: 'Reported only — never migrated without a reviewed decision.' };
}

export async function runBackfill(db, { execute = false, batchSize = 200 } = {}) {
  const pending = await pendingRows(db);
  const summary = {
    mode: execute ? 'EXECUTE' : 'DRY_RUN',
    pendingRows: pending.length,
    pendingByTable: {},
    pendingValue: {},
    opened: 0,
    mismatches: [],
    legacy: await legacyReport(db),
  };
  for (const p of pending) {
    summary.pendingByTable[p.table] = (summary.pendingByTable[p.table] ?? 0) + 1;
    const cur = p.table === 'AgentProfile' ? 'XOF' : 'KRI';
    summary.pendingValue[cur] = (summary.pendingValue[cur] ?? 0) + p.value;
  }
  if (!execute) return summary;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    await db.$transaction(async (tx) => {
      for (const p of batch) {
        const spec = p.table === 'DeliveryEscrow' ? specs.escrowDelivery(p.id) : await SPEC_FOR[p.table](tx, p);
        const account = await ensureAccount(tx, spec);
        const ledger = Number(account.balance);
        if (ledger !== p.value) {
          summary.mismatches.push({ table: p.table, id: p.id, legacy: p.value, ledger });
          throw new Error(`Backfill mismatch on ${p.table}.${p.id}: legacy ${p.value} vs ledger ${ledger}`);
        }
        summary.opened += 1;
      }
    }, { timeout: 120_000 });
  }
  summary.remainingRows = (await pendingRows(db)).length;
  return summary;
}
