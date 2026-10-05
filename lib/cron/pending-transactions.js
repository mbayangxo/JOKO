import { getRailStatus } from '../julaya.js';
import { prisma } from '../prisma.js';
import { settleRailFromWebhook } from '../rail-service.js';
import { writeSecureLog } from '../secure-log.js';
import { expireOverdue, transition } from '../money-kernel/external-ops.js';

const STALE_MS = 30 * 60 * 1000;
const ABANDON_MS = 2 * 60 * 60 * 1000;

/**
 * Every 5 min: resolve PENDING rail transactions older than 30 minutes.
 * Polls partner API when externalId exists; otherwise fails safely (refund cash-out debits).
 */
export async function runPendingTransactionResolver(db = prisma) {
  // J2: operations past their outcome deadline go to 'expired' (review) —
  // never failed, never confirmed. A late provider outcome still applies.
  const expiry = await expireOverdue(db);
  // J6: expire / review agent cash transactions on the same schedule (also applied on every read).
  const { sweepCash } = await import('../agents/cash.js');
  const agentCash = await sweepCash().catch((e) => ({ error: String(e?.message ?? e) }));
  const staleBefore = new Date(Date.now() - STALE_MS);
  const pending = await db.railTransaction.findMany({
    where: { status: { in: ['pending', 'review'] }, createdAt: { lt: staleBefore } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  const results = [];

  for (const rail of pending) {
    const ageMs = Date.now() - rail.createdAt.getTime();
    try {
      if (rail.externalId) {
        const partner = await getRailStatus(rail.externalId);
        const settled = await settleRailFromWebhook(db, {
          reference: rail.reference,
          status: partner.status,
          amount: partner.amount ?? undefined,
          externalId: partner.externalId ?? rail.externalId,
          failureReason: partner.status === 'failed' ? partner.message : undefined,
          source: 'status_poll',
          signatureOk: false,
        });
        results.push({
          railId: rail.id,
          reference: rail.reference,
          action: 'polled',
          status: settled?.status ?? partner.status,
        });
        continue;
      }

      if (rail.status === 'review') {
        results.push({ railId: rail.id, reference: rail.reference, action: 'review', status: 'review' });
        continue;
      }

      if (ageMs >= ABANDON_MS) {
        const op = await db.externalOperation.findUnique({ where: { reference: rail.reference } });
        if (op) {
          // A timeout is not an outcome: review, keep any hold, credit nothing.
          if (['authorized', 'submitted'].includes(op.state)) {
            await db.$transaction((tx) => transition(tx, op.id, 'expired', { source: 'job', reviewReason: 'no_provider_outcome_after_2h' }));
          }
          await db.railTransaction.update({ where: { id: rail.id }, data: { status: 'review', failureReason: 'no_provider_outcome_after_2h' } });
          results.push({ railId: rail.id, reference: rail.reference, action: 'review', status: 'review' });
          continue;
        }
        if (rail.direction === 'out' && rail.walletDebited) {
          // Outcome unknown and the request may have reached the provider:
          // refunding could pay the user twice. Park for human review.
          await db.railTransaction.update({
            where: { id: rail.id },
            data: { status: 'review', failureReason: 'no_provider_confirmation_after_2h' },
          });
          results.push({ railId: rail.id, reference: rail.reference, action: 'review', status: 'review' });
          continue;
        }
        const settled = await settleRailFromWebhook(db, {
          reference: rail.reference,
          status: 'failed',
          failureReason: 'Partner timeout — no confirmation after 2 hours',
        });
        results.push({
          railId: rail.id,
          reference: rail.reference,
          action: 'abandoned',
          status: settled?.status ?? 'failed',
        });
        continue;
      }

      results.push({
        railId: rail.id,
        reference: rail.reference,
        action: 'waiting',
        status: 'pending',
        message: 'No externalId yet — still within partner window',
      });
    } catch (error) {
      console.error('[CRON pending_transaction_resolver]', rail.id, error);
      results.push({
        railId: rail.id,
        reference: rail.reference,
        action: 'error',
        error: error instanceof Error ? error.message : 'failed',
      });
    }
  }

  if (results.some((r) => r.action === 'abandoned' || r.action === 'review' || r.status === 'failed')) {
    await writeSecureLog({
      category: 'pending_resolver',
      severity: 'warn',
      title: `Resolved ${results.length} stale pending rails`,
      payload: { results },
    });
  }

  return {
    job: 'pending_transaction_resolver',
    expiredOperations: expiry.expired,
    agentCash,
    scanned: pending.length,
    results,
    ranAt: new Date().toISOString(),
  };
}
