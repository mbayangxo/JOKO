import { pegFor, PROJECTION_COLUMN } from './accounts.js';
import { isProduction } from '../runtime-safety.js';

/**
 * Read-only invariant checker (docs/JOKKO-J2-DESIGN.md §9). Every query only
 * reads; callers may wrap it in `BEGIN READ ONLY`. Returns
 * { ok, violations: [{ id, detail, rows }], warnings, stats }.
 */

const q = (db, sql, ...args) => db.$queryRawUnsafe(sql, ...args);
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

export async function checkInvariants(db, { includeUnmigrated = true } = {}) {
  const violations = [];
  const warnings = [];
  const add = (list, id, detail, rows = []) => list.push({ id, detail, rows: rows.slice(0, 20), count: rows.length });

  // I1 — every entry balances per currency and has ≥ 2 postings
  const unbalanced = await q(db, `
    SELECT "entryId", currency, SUM(CASE WHEN side='debit' THEN amount ELSE -amount END)::text AS net
    FROM "Posting" GROUP BY "entryId", currency
    HAVING SUM(CASE WHEN side='debit' THEN amount ELSE -amount END) <> 0`);
  if (unbalanced.length) add(violations, 'I1', 'Unbalanced journal entries', unbalanced);
  const thin = await q(db, `
    SELECT e.id, e.reference FROM "JournalEntry" e
    LEFT JOIN "Posting" p ON p."entryId" = e.id
    GROUP BY e.id HAVING COUNT(p.id) < 2`);
  if (thin.length) add(violations, 'I1b', 'Entries with fewer than 2 postings', thin);

  // I2 — no negative balance on non-negative accounts
  const negative = await q(db, `SELECT code, balance::text FROM "LedgerAccount" WHERE NOT "allowNegative" AND balance < 0`);
  if (negative.length) add(violations, 'I2', 'Negative balance on a non-negative account', negative);

  // I12 — materialized balance equals the sum of postings
  const drift = await q(db, `
    SELECT a.code, a.balance::text AS materialized,
           COALESCE(SUM(CASE WHEN p.side = a."normalSide" THEN p.amount ELSE -p.amount END), 0)::text AS from_postings
    FROM "LedgerAccount" a LEFT JOIN "Posting" p ON p."accountId" = a.id
    GROUP BY a.id
    HAVING a.balance <> COALESCE(SUM(CASE WHEN p.side = a."normalSide" THEN p.amount ELSE -p.amount END), 0)`);
  if (drift.length) add(violations, 'I12', 'Materialized balance differs from postings', drift);

  // Posting currency must match its account
  const curMismatch = await q(db, `
    SELECT p.id::text, a.code, p.currency, a.currency AS account_currency
    FROM "Posting" p JOIN "LedgerAccount" a ON a.id = p."accountId" WHERE p.currency <> a.currency`);
  if (curMismatch.length) add(violations, 'I1c', 'Posting currency differs from account currency', curMismatch);

  // I11 — projections equal the ledger
  for (const [table, col] of Object.entries(PROJECTION_COLUMN)) {
    const rows = await q(db, `
      SELECT a.code, a.balance::text AS ledger, t."${col}"::text AS projection
      FROM "LedgerAccount" a JOIN "${table}" t ON t.id = a."projId"
      WHERE a."projTable" = '${table}' AND t."${col}"::bigint <> a.balance`);
    if (rows.length) add(violations, 'I11', `${table}.${col} differs from its ledger account`, rows);
    if (includeUnmigrated) {
      const unmigrated = await q(db, `
        SELECT t.id, t."${col}"::text AS value FROM "${table}" t
        WHERE t."${col}" <> 0 AND NOT EXISTS (
          SELECT 1 FROM "LedgerAccount" a WHERE a."projTable" = '${table}' AND a."projId" = t.id)`);
      if (unmigrated.length) add(violations, 'I11b', `${table} rows holding value outside the ledger (not yet opened)`, unmigrated);
    }
  }
  // Legacy Wallet.balance (XOF column) must stay untouched (0)
  const legacyXof = await q(db, `SELECT id, balance FROM "Wallet" WHERE balance <> 0`);
  if (legacyXof.length) add(warnings, 'W1', 'Legacy Wallet.balance (XOF) non-zero — pre-J2 value outside the ledger', legacyXof);

  // I13 — delivery escrow accounts match held escrow rows
  const escrow = await q(db, `
    SELECT a.code, a.balance::text AS ledger, COALESCE(e."amountKoriHeld", e."amountNational", 0)::text AS held, e.status
    FROM "LedgerAccount" a
    LEFT JOIN "DeliveryEscrow" e ON e."deliveryTaskId" = a."ownerId"
    WHERE a.type = 'escrow_delivery'
      AND a.balance <> CASE WHEN e.status IN ('reserved','disputed_held') THEN COALESCE(e."amountKoriHeld", e."amountNational", 0) ELSE 0 END`);
  if (escrow.length) add(violations, 'I13', 'Delivery escrow account differs from escrow state', escrow);
  const heldNoAccount = await q(db, `
    SELECT e."deliveryTaskId", e.status FROM "DeliveryEscrow" e
    WHERE e.status IN ('reserved','disputed_held')
      AND NOT EXISTS (SELECT 1 FROM "LedgerAccount" a WHERE a.code = 'escrow:delivery:' || e."deliveryTaskId")`);
  if (heldNoAccount.length) add(violations, 'I13b', 'Held escrow without a ledger account', heldNoAccount);

  // Opening (legacy) value of an account, from its opening_balance entry.
  const OPENING = `COALESCE((SELECT SUM(p2.amount) FROM "Posting" p2 JOIN "JournalEntry" j2 ON j2.id = p2."entryId"
                    WHERE j2.reference = 'opening:' || a.code AND p2."accountId" = a.id), 0)`;

  // I14 — tontine pot = opening (legacy) + pot-entry history
  const pots = await q(db, `
    SELECT a.code, a.balance::text AS ledger, (${OPENING} + COALESCE(SUM(pe."amountKori"), 0))::text AS expected
    FROM "LedgerAccount" a LEFT JOIN "TontinePotEntry" pe ON pe."groupId" = a."ownerId"
    WHERE a.type = 'tontine_pot' GROUP BY a.id
    HAVING a.balance <> ${OPENING} + COALESCE(SUM(pe."amountKori"), 0)`);
  if (pots.length) add(violations, 'I14', 'Tontine pot differs from opening + pot entries', pots);

  // I15 — agent float = opening (legacy) + float-entry history
  const floats = await q(db, `
    SELECT a.code, a.balance::text AS ledger, (${OPENING} + COALESCE(SUM(fe."amountXof"), 0))::text AS expected
    FROM "LedgerAccount" a LEFT JOIN "AgentFloatEntry" fe ON fe."agentId" = a."ownerId"
    WHERE a.type = 'agent_float'
    GROUP BY a.id HAVING a.balance <> ${OPENING} + COALESCE(SUM(fe."amountXof"), 0)`);
  if (floats.length) add(violations, 'I15', 'Agent float differs from opening + float entries', floats);

  // I17 — peg: conversion:{CUR} = peg × conversion:KRI:{CUR}
  const conv = await q(db, `SELECT code, currency, balance::text FROM "LedgerAccount" WHERE type = 'conversion'`);
  const byCur = new Map();
  for (const c of conv) {
    const cur = c.code.startsWith('conversion:KRI:') ? c.code.slice('conversion:KRI:'.length) : c.currency;
    const e = byCur.get(cur) ?? { ext: 0, kri: 0 };
    if (c.code.startsWith('conversion:KRI:')) e.kri = num(c.balance); else e.ext = num(c.balance);
    byCur.set(cur, e);
  }
  for (const [cur, e] of byCur) {
    if (e.ext !== pegFor(cur) * e.kri) add(violations, 'I17', `Peg broken for ${cur}`, [{ currency: cur, external: e.ext, kori: e.kri, peg: pegFor(cur) }]);
  }

  // I18 — reversal uniqueness is a DB constraint; also no reversal of a reversal
  const rr = await q(db, `
    SELECT r.reference FROM "JournalEntry" r JOIN "JournalEntry" o ON o.id = r."reversesId" WHERE o."reversesId" IS NOT NULL`);
  if (rr.length) add(violations, 'I18', 'Reversal of a reversal', rr);

  // I4 — one confirmation / settlement / release per external operation
  const dupConfirm = await q(db, `
    SELECT "externalOperationId", kind, COUNT(*)::int AS n FROM "JournalEntry"
    WHERE "externalOperationId" IS NOT NULL
      AND kind IN ('cash_in_confirmed','cash_in_settled','cash_out_confirmed','cash_out_settled','cash_out_release','cash_out_hold')
    GROUP BY 1, 2 HAVING COUNT(*) > 1`);
  if (dupConfirm.length) add(violations, 'I4', 'External operation posted more than once', dupConfirm);

  // State ↔ ledger consistency for external operations
  const stateLedger = await q(db, `
    SELECT o.reference, o.direction, o.state,
      EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."externalOperationId" = o.id AND j.kind IN ('cash_in_confirmed','cash_out_confirmed')) AS confirmed_entry,
      EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."externalOperationId" = o.id AND j.kind = 'cash_out_release') AS released
    FROM "ExternalOperation" o`);
  const bad = stateLedger.filter((o) => {
    const confirmedState = ['confirmed', 'settled', 'reversed', 'refunded'].includes(o.state);
    if (confirmedState !== o.confirmed_entry && o.state !== 'reversed') return true;
    if (o.direction === 'out' && ['failed', 'cancelled'].includes(o.state) && !o.released) {
      // A failed payout must have released its hold (if it was held).
      return true;
    }
    return false;
  });
  if (bad.length) add(violations, 'I4b', 'External operation state disagrees with its ledger entries', bad);

  // I7 / I19 — no mock or test value in production
  if (isProduction()) {
    const faucet = await q(db, `SELECT COUNT(*)::int AS n FROM "Posting" p JOIN "LedgerAccount" a ON a.id = p."accountId" WHERE a.type = 'test_faucet'`);
    if (faucet[0].n > 0) add(violations, 'I19', 'Test faucet postings in production', faucet);
    const mock = await q(db, `SELECT reference FROM "ExternalOperation" WHERE "providerMode" <> 'live'`);
    if (mock.length) add(violations, 'I7', 'Non-live provider operations in production', mock);
  }

  // I6 — rewards only from the funded budget (any reward entry must debit incentives:funded)
  const unfundedRewards = await q(db, `
    SELECT j.reference FROM "JournalEntry" j
    WHERE j.kind = 'reward' AND NOT EXISTS (
      SELECT 1 FROM "Posting" p JOIN "LedgerAccount" a ON a.id = p."accountId"
      WHERE p."entryId" = j.id AND a.code = 'incentives:funded' AND p.side = 'debit')`);
  if (unfundedRewards.length) add(violations, 'I6', 'Reward not paid from the funded budget', unfundedRewards);

  // I10 — debits of customer funds need the owner as actor or an authorization basis
  const unauth = await q(db, `
    SELECT j.reference, j.kind, j."actorType", j."actorId", a.code
    FROM "Posting" p
    JOIN "LedgerAccount" a ON a.id = p."accountId"
    JOIN "JournalEntry" j ON j.id = p."entryId"
    WHERE a.type IN ('customer_available','customer_held') AND p.side = 'debit'
      AND NOT (j."actorType" = 'user' AND j."actorId" = a."ownerId")
      AND COALESCE(j.metadata->>'authorization', '') = ''`);
  if (unauth.length) add(violations, 'I10', 'Customer debited without owner or authorization basis', unauth);

  const stats = (await q(db, `
    SELECT (SELECT COUNT(*) FROM "JournalEntry")::int AS entries,
           (SELECT COUNT(*) FROM "Posting")::int AS postings,
           (SELECT COUNT(*) FROM "LedgerAccount")::int AS accounts`))[0];

  return { ok: violations.length === 0, violations, warnings, stats, checkedAt: new Date().toISOString() };
}

/** Assert helper for tests: throws with the violations listed. */
export async function assertInvariants(db, opts) {
  const r = await checkInvariants(db, opts);
  if (!r.ok) {
    const e = new Error(`Money invariants violated: ${r.violations.map((v) => `${v.id} ${v.detail} (${v.count})`).join('; ')}`);
    e.result = r;
    throw e;
  }
  return r;
}
