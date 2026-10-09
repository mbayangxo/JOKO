import { prisma } from '../prisma.js';

/**
 * J11 collective-money invariants (read-only; offending ids only, never personal data).
 *
 *   C1  each rotating pot account = Σ contributions − refunds − payouts − catch-ups of its group
 *       (and, per cycle, nothing may go negative: no payout or refund beyond what was paid in)
 *   C2  each goal share account = that member's contributions − withdrawals (only the owner ever draws it)
 *   C3  every CollectivePayment mirrors exactly one J2 journal entry `<reference>-J` of the same amount
 *   C4  obligation.amountPaid = Σ that member's contributions for that cycle, and never exceeds the amount due
 *   C5  a payout goes to the member whose accepted position is that cycle; `full` payouts only for a cycle
 *       whose live obligations are all settled; at most one per cycle (DB unique)
 *   C6  a started group has rules, and every member who holds a position or an obligation accepted that exact hash
 *   C7  no money in a group that never started (proposed / awaiting acceptance / cancelled before start)
 *   P1  each protected escrow = raised − released − refunded of its fund
 *   P2  fund.raised = Σ contributions; fund.refunded = Σ contribution refunds; fund.released = Σ released milestones
 *   P3  a released project milestone had ≥ approvalsRequired independent approvals and a recorded settlement reference
 *   P4  money only ever leaves escrow for released milestones or refunds (no release from a draft/failed fund)
 */
export async function checkCollectiveInvariants(db = prisma) {
  const v = [];
  const add = (id, rows) => { if (rows.length) v.push({ id, count: rows.length, sample: rows.slice(0, 5).map((r) => r.id) }); };
  const net = `SUM(CASE WHEN p.kind = 'contribution' THEN p."amountKori" WHEN p.kind IN ('refund','payout','catch_up') THEN -p."amountKori" ELSE 0 END)`;
  add('C1', await db.$queryRawUnsafe(`
    SELECT g.id FROM "CollectiveGroup" g
      LEFT JOIN "LedgerAccount" l ON l.code = 'collective:' || g.id || ':pot'
     WHERE g.kind = 'rotating'
       AND COALESCE(l.balance, 0) <> COALESCE((SELECT ${net} FROM "CollectivePayment" p WHERE p."groupId" = g.id), 0)
    UNION ALL
    SELECT p."groupId" || ':' || p.cycle AS id FROM "CollectivePayment" p JOIN "CollectiveGroup" g ON g.id = p."groupId"
     WHERE g.kind = 'rotating' GROUP BY p."groupId", p.cycle HAVING ${net} < 0`));
  add('C2', await db.$queryRaw`
    SELECT l.id FROM "LedgerAccount" l
     WHERE l.type = 'collective_share'
       AND l.balance <> COALESCE((SELECT SUM(CASE WHEN p.kind = 'contribution' THEN p."amountKori" WHEN p.kind = 'withdrawal' THEN -p."amountKori" ELSE 0 END)
             FROM "CollectivePayment" p WHERE l.code = 'collective:' || p."groupId" || ':share:' || p."userId"), 0)
    UNION ALL
    SELECT p.id FROM "CollectivePayment" p JOIN "CollectiveGroup" g ON g.id = p."groupId"
     WHERE (g.kind = 'goal' AND p.kind IN ('payout','catch_up','refund')) OR (g.kind = 'rotating' AND p.kind = 'withdrawal')`);
  add('C3', await db.$queryRaw`
    SELECT p.id FROM "CollectivePayment" p
      LEFT JOIN "JournalEntry" j ON j.reference = p.reference || '-J'
     WHERE j.id IS NULL
        OR (SELECT MAX(x.amount) FROM "Posting" x WHERE x."entryId" = j.id) <> p."amountKori"
        OR j.kind NOT LIKE 'collective_%'`);
  add('C4', await db.$queryRaw`
    SELECT o.id FROM "CollectiveObligation" o
     WHERE o."amountPaidKori" > o."amountDueKori"
        OR o."amountPaidKori" <> COALESCE((SELECT SUM(p."amountKori") FROM "CollectivePayment" p
             WHERE p."groupId" = o."groupId" AND p.cycle = o.cycle AND p."userId" = o."userId" AND p.kind = 'contribution'), 0)
        OR (o.status IN ('paid','late_paid') AND o."amountPaidKori" <> o."amountDueKori")`);
  add('C5', await db.$queryRaw`
    SELECT po.id FROM "CollectivePayout" po
      LEFT JOIN "CollectiveMember" m ON m."groupId" = po."groupId" AND m."userId" = po."recipientId"
     WHERE m.id IS NULL OR m.position IS DISTINCT FROM po.cycle
        OR (po.basis = 'full' AND EXISTS (SELECT 1 FROM "CollectiveObligation" o WHERE o."groupId" = po."groupId" AND o.cycle = po.cycle
              AND o.status NOT IN ('paid','late_paid','cancelled','refunded')))`);
  add('C6', await db.$queryRaw`
    SELECT g.id FROM "CollectiveGroup" g
     WHERE g."activatedAt" IS NOT NULL AND (g."rulesHash" IS NULL OR EXISTS (
       SELECT 1 FROM "CollectiveMember" m WHERE m."groupId" = g.id
          AND (m.position IS NOT NULL OR EXISTS (SELECT 1 FROM "CollectiveObligation" o WHERE o."groupId" = g.id AND o."userId" = m."userId"))
          AND m."acceptedRulesHash" IS DISTINCT FROM g."rulesHash"))`);
  add('C7', await db.$queryRaw`
    SELECT g.id FROM "CollectiveGroup" g
     WHERE g."activatedAt" IS NULL AND (EXISTS (SELECT 1 FROM "CollectivePayment" p WHERE p."groupId" = g.id)
        OR EXISTS (SELECT 1 FROM "CollectiveObligation" o WHERE o."groupId" = g.id))`);
  add('P1', await db.$queryRaw`
    SELECT f.id FROM "ProtectedFund" f LEFT JOIN "LedgerAccount" l ON l.code = 'protected:' || f.id || ':escrow'
     WHERE COALESCE(l.balance, 0) <> f."raisedKori" - f."releasedKori" - f."refundedKori"`);
  add('P2', await db.$queryRaw`
    SELECT f.id FROM "ProtectedFund" f
     WHERE f."raisedKori" <> COALESCE((SELECT SUM(c."amountKori") FROM "ProtectedContribution" c WHERE c."fundId" = f.id), 0)
        OR f."refundedKori" <> COALESCE((SELECT SUM(c."refundedKori") FROM "ProtectedContribution" c WHERE c."fundId" = f.id), 0)
        OR f."releasedKori" <> COALESCE((SELECT SUM(m."amountKori") FROM "ProtectedMilestone" m WHERE m."fundId" = f.id AND m.status = 'released'), 0)`);
  add('P3', await db.$queryRaw`
    SELECT m.id FROM "ProtectedMilestone" m JOIN "ProtectedFund" f ON f.id = m."fundId"
     WHERE m.status = 'released' AND (m."releaseRef" IS NULL
        OR NOT EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j.reference = m."releaseRef" || '-J' AND j.kind = 'protected_release')
        OR (f.kind = 'project' AND (SELECT COUNT(*) FROM "ProtectedApproval" a WHERE a."milestoneId" = m.id AND a.decision = 'approve') < f."approvalsRequired"))`);
  add('P4', await db.$queryRaw`
    SELECT f.id FROM "ProtectedFund" f WHERE (f.status IN ('draft','failed') AND f."releasedKori" > 0) OR (f.status = 'draft' AND f."raisedKori" > 0)`);
  return { ok: v.length === 0, violations: v };
}
