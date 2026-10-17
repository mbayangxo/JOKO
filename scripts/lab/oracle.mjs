/**
 * J15 lab oracle. Every check runs inside ONE repeatable-read, read-only transaction, so the whole report
 * describes a single consistent snapshot: a violation found while load is running is a real violation,
 * never an artefact of reading two tables at different moments.
 *
 *   money       J2 kernel invariants (balanced entries, no negative non-negative accounts, materialized
 *               balances = postings, projections = ledger, ...)
 *   logistics / work / collective / affiliate   the domain invariants
 *   partner     reconcilePartnerSettlements (since the run started)
 *   exactly-once  at most one journal entry of any kind per client idempotency key (no kind books twice under
 *                 one key: verified on the gate database and on the long-lived J8 database before adopting it)
 */
import { checkInvariants } from '../../lib/money-kernel/invariants.js';
import { checkLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { checkWorkInvariants } from '../../lib/work/invariants.js';
import { checkCollectiveInvariants } from '../../lib/collective/invariants.js';
import { checkAffiliateInvariants } from '../../lib/affiliate-settlement.js';
import { reconcilePartnerSettlements } from '../../lib/integrations/partner-settlement-reconcile.js';

async function checksIn(tx, { since } = {}) {
  const findings = [];
  const add = (check, list) => {
    for (const v of list ?? []) findings.push({ check, id: v.id ?? v.code ?? v.rule ?? 'violation', detail: v.detail ?? v.message ?? v.reason ?? null, count: v.count ?? 1, sample: (v.rows ?? []).slice(0, 3) });
  };
  const money = await checkInvariants(tx);
  add('money', money.violations);
  add('logistics', (await checkLogisticsInvariants(tx)).violations);
  add('work', (await checkWorkInvariants(tx)).violations);
  add('collective', (await checkCollectiveInvariants(tx)).violations);
  add('affiliate', (await checkAffiliateInvariants(tx)).violations);
  const partner = await reconcilePartnerSettlements(tx, since ? { since } : {});
  add('partner', (partner.exceptions ?? []).map((e) => ({ id: e.problem ?? 'exception', detail: `payment ${e.paymentId} (${e.target ?? 'unknown target'})` })));
  const dup = await tx.$queryRawUnsafe(
    `SELECT kind, metadata->>'clientKey' AS key, COUNT(*)::int AS n FROM "JournalEntry"
      WHERE metadata->>'clientKey' IS NOT NULL
      GROUP BY kind, metadata->>'clientKey' HAVING COUNT(*) > 1 LIMIT 20`,
  );
  if (dup.length) findings.push({ check: 'exactly_once', id: 'duplicate_client_key', detail: 'one client key booked more than once', count: dup.length, sample: dup.slice(0, 3) });
  return findings;
}

/**
 * Run every check on one snapshot. Pass `tx` to check inside an existing transaction (seeded-defect tests);
 * otherwise a repeatable-read read-only transaction is opened.
 */
export async function runOracle(prisma, { tx, since } = {}) {
  const t0 = Date.now();
  const findings = tx
    ? await checksIn(tx, { since })
    : await prisma.$transaction(async (t) => {
      await t.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return checksIn(t, { since });
    }, { isolationLevel: 'RepeatableRead', timeout: 120_000, maxWait: 30_000 });
  return { ok: findings.length === 0, findings, ms: Date.now() - t0 };
}
