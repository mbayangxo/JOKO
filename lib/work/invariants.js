import { prisma } from '../prisma.js';

/**
 * J9 money invariants (read-only; offending ids only, never personal data).
 *
 *   W1  escrow:work:<offer> = what the offer / assignment still owes:
 *         sent + held → total; declined | withdrawn | expired → 0;
 *         accepted → total − Σ earnings drawn from it − refunded (and 0 once the assignment is closed)
 *   W2  each earnings account (worker or business payee) = Σ its accrued + releasable earnings
 *   W3  milestone ⇔ earning: accepted (amount > 0) ⇒ exactly one earning of the milestone amount;
 *       split ⇒ one earning < amount; pending / submitted / disputed / refunded ⇒ none
 *   W4  employment (payroll) and outcome engagements never hold escrow and never earn from an assignment
 *   W5  an outcome earning exists ⇔ its WorkOutcome is `accrued` and points to it (once per outcome)
 *   W6  no worker earns from a business they own (self-dealing)
 *   W7  every earning's accrual posting exists with its exact amount (deterministic reference)
 */
export async function checkWorkInvariants(db = prisma) {
  const v = [];
  const add = (id, rows) => { if (rows.length) v.push({ id, count: rows.length, sample: rows.slice(0, 5).map((r) => r.id) }); };
  add('W1', await db.$queryRaw`
    SELECT o.id FROM "WorkOffer" o
      LEFT JOIN "LedgerAccount" l ON l.code = 'escrow:work:' || o.id
      LEFT JOIN "WorkAssignment" a ON a."offerId" = o.id
     WHERE COALESCE(l.balance, 0) <> CASE
       WHEN o.status = 'sent' AND o."fundingStatus" = 'held' THEN o."totalKori"
       WHEN o.status IN ('declined','withdrawn','expired','sent') THEN 0
       WHEN a.id IS NULL OR a.funding <> 'prepaid' OR a.status IN ('completed','cancelled') THEN 0
       ELSE a."totalKori" - a."refundedKori" - COALESCE((SELECT SUM(e."amountKori") FROM "WorkEarning" e WHERE e."assignmentId" = a.id), 0) END`);
  add('W2', await db.$queryRaw`
    SELECT l.id FROM "LedgerAccount" l
     WHERE l.type = 'worker_earnings'
       AND l.balance <> COALESCE((SELECT SUM(e."amountKori") FROM "WorkEarning" e
             WHERE e.status IN ('accrued','releasable')
               AND ((l."ownerType" = 'user' AND e."workerUserId" = l."ownerId") OR (l."ownerType" = 'business' AND e."payeeBusinessId" = l."ownerId"))), 0)
    UNION ALL
    SELECT e.id FROM "WorkEarning" e
     WHERE e.status IN ('accrued','releasable')
       AND NOT EXISTS (SELECT 1 FROM "LedgerAccount" l WHERE l.code = CASE WHEN e."workerUserId" IS NOT NULL THEN 'worker:' || e."workerUserId" || ':earnings' ELSE 'work_business:' || e."payeeBusinessId" || ':earnings' END)`);
  add('W3', await db.$queryRaw`
    SELECT m.id FROM "WorkMilestone" m LEFT JOIN "WorkEarning" e ON e."sourceKey" = 'milestone:' || m.id
     WHERE (m.status = 'accepted' AND m."amountKori" > 0 AND (e.id IS NULL OR e."amountKori" <> m."amountKori"))
        OR (m.status = 'accepted' AND m."amountKori" = 0 AND e.id IS NOT NULL)
        OR (m.status = 'split' AND (e.id IS NULL OR e."amountKori" >= m."amountKori"))
        OR (m.status IN ('pending','submitted','disputed','refunded') AND e.id IS NOT NULL)`);
  add('W4', await db.$queryRaw`
    SELECT a.id FROM "WorkAssignment" a
     WHERE a.funding IN ('payroll','outcome')
       AND (EXISTS (SELECT 1 FROM "WorkEarning" e WHERE e."assignmentId" = a.id)
         OR EXISTS (SELECT 1 FROM "LedgerAccount" l WHERE l.code = 'escrow:work:' || a."offerId" AND l.balance <> 0)
         OR EXISTS (SELECT 1 FROM "WorkMilestone" m WHERE m."assignmentId" = a.id AND m."amountKori" > 0))`);
  add('W5', await db.$queryRaw`
    SELECT e.id FROM "WorkEarning" e
     WHERE e."sourceKey" LIKE 'outcome:%'
       AND NOT EXISTS (SELECT 1 FROM "WorkOutcome" o WHERE o."earningId" = e.id AND o.status = 'accrued' AND 'outcome:' || o."outcomeKey" = e."sourceKey")
    UNION ALL
    SELECT o.id FROM "WorkOutcome" o
     WHERE (o.status = 'accrued') <> (o."earningId" IS NOT NULL)`);
  add('W6', await db.$queryRaw`
    SELECT e.id FROM "WorkEarning" e JOIN "Business" b ON b.id = e."payerBusinessId"
     WHERE e."workerUserId" = b."ownerId" OR e."payeeBusinessId" = e."payerBusinessId"`);
  add('W7', await db.$queryRaw`
    SELECT e.id FROM "WorkEarning" e
     WHERE NOT EXISTS (
       SELECT 1 FROM "JournalEntry" j JOIN "Posting" p ON p."entryId" = j.id JOIN "LedgerAccount" l ON l.id = p."accountId"
        WHERE j.reference = 'WRK-EARN-' || e."sourceKey" AND l.type = 'worker_earnings' AND p.amount = e."amountKori")`);
  return { ok: v.length === 0, violations: v };
}

export async function assertWorkInvariants(db = prisma) {
  const r = await checkWorkInvariants(db);
  if (!r.ok) throw new Error(`work invariants violated: ${JSON.stringify(r.violations)}`);
  return r;
}
