/**
 * J14 D-J14-3 — partner settlement reconciliation (READ ONLY; never moves money).
 *
 * Every completed partner collection must be booked exactly once, to the account its settlement target
 * names, for the amount the provider confirmed:
 *   business_wallet  → business:<settlementBusinessId>:wallet   (+ one PaymentRecord with that ledger ref)
 *   held_for_review  → partner:<partnerId>:unallocated          (+ a reconciliation exception)
 *   legacy_platform  → customer:<settlement user>:available
 * through ONE ExternalOperation `partner_<id>` (confirmed) and ONE journal entry `partner_<id>-CONFIRM`.
 * A payment that is not completed has no confirmed operation and no CONFIRM entry. Mapped and legacy never
 * mix: a mapped payment never credits a customer account, a legacy one never a business wallet.
 *
 * This is the "complete reconciliation" the decision requires before the legacy path may be closed for new
 * partners; the per-partner closure itself is `legacyPlatformSettlementAllowed(partnerId)`.
 */
import { prisma } from '../prisma.js';

const CONFIRMED_STATES = new Set(['confirmed', 'settled']);

function expectedAccount(row, op) {
  if (row.settlementTarget === 'business_wallet') return row.settlementBusinessId ? `business:${row.settlementBusinessId}:wallet` : null;
  if (row.settlementTarget === 'held_for_review') return `partner:${row.partnerId}:unallocated`;
  if (row.settlementTarget === 'legacy_platform') {
    const u = row.settlementUserId ?? op?.userId ?? null;
    return u ? `customer:${u}:available` : null;
  }
  return null;
}

export async function reconcilePartnerSettlements(db = prisma, { partnerId, since } = {}) {
  const rows = await db.partnerPayment.findMany({
    where: { ...(partnerId ? { partnerId } : {}), ...(since ? { createdAt: { gte: since } } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  const refs = rows.map((r) => `partner_${r.id}`);
  const ops = new Map((await db.externalOperation.findMany({ where: { reference: { in: refs } } })).map((o) => [o.reference, o]));
  const entries = await db.journalEntry.findMany({ where: { reference: { in: refs.map((r) => `${r}-CONFIRM`) } }, include: { postings: { include: { account: true } } } });
  const byRef = new Map();
  for (const e of entries) byRef.set(e.reference, [...(byRef.get(e.reference) ?? []), e]);
  const records = await db.paymentRecord.findMany({ where: { ledgerReference: { in: refs.map((r) => `${r}-CONFIRM`) } }, select: { ledgerReference: true, businessId: true, amountKori: true } });
  const recByRef = new Map();
  for (const p of records) recByRef.set(p.ledgerReference, [...(recByRef.get(p.ledgerReference) ?? []), p]);

  const totals = { business_wallet: { count: 0, kori: 0 }, held_for_review: { count: 0, kori: 0 }, legacy_platform: { count: 0, kori: 0 } };
  const exceptions = [];
  const flag = (row, problem) => exceptions.push({ paymentId: row.id, partnerId: row.partnerId, target: row.settlementTarget, problem });

  for (const row of rows) {
    const ref = `partner_${row.id}`;
    const op = ops.get(ref);
    const confirmEntries = byRef.get(`${ref}-CONFIRM`) ?? [];
    if (row.status !== 'completed') {
      if (op && CONFIRMED_STATES.has(op.state)) flag(row, 'operation_confirmed_but_payment_not_completed');
      if (confirmEntries.length) flag(row, 'booked_but_payment_not_completed');
      continue;
    }
    if (!op) { flag(row, 'no_operation'); continue; }
    if (!CONFIRMED_STATES.has(op.state)) flag(row, `operation_${op.state}`);
    if (confirmEntries.length !== 1) { flag(row, `confirm_entries_${confirmEntries.length}`); continue; }
    const expected = expectedAccount(row, op);
    if (!expected) { flag(row, 'no_expected_account'); continue; }
    if (op.accountCode !== expected) flag(row, `operation_account ${op.accountCode} ≠ ${expected}`);
    const credits = confirmEntries[0].postings.filter((p) => p.side === 'credit');
    const toExpected = credits.filter((p) => p.account.code === expected);
    const amount = toExpected.reduce((s, p) => s + Number(p.amount), 0);
    if (amount !== Number(op.amountKori)) flag(row, `credited ${amount} ≠ confirmed ${Number(op.amountKori)}`);
    if (credits.some((p) => p.account.code !== expected && (p.account.code.startsWith('business:') || p.account.code.startsWith('customer:')))) flag(row, 'credit_to_a_different_holder');
    if (row.settlementReference && row.settlementReference !== `${ref}-CONFIRM`) flag(row, 'settlement_reference_mismatch');
    const recs = recByRef.get(`${ref}-CONFIRM`) ?? [];
    if (row.settlementTarget === 'business_wallet') {
      if (recs.length !== 1) flag(row, `payment_records_${recs.length}`);
      else if (recs[0].businessId !== row.settlementBusinessId || recs[0].amountKori !== amount) flag(row, 'payment_record_mismatch');
    } else if (recs.length) {
      flag(row, 'payment_record_for_unmapped_target');
    }
    const t = totals[row.settlementTarget];
    if (t) {
      t.count += 1;
      t.kori += amount;
    } else {
      flag(row, 'unknown_target');
    }
  }
  return { ok: exceptions.length === 0, payments: rows.length, totals, exceptions };
}
