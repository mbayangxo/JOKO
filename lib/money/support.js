import { prisma } from '../prisma.js';
import { LIMITS } from '../authz/catalog.js';

/**
 * J4 supportability: locate any money reference and say exactly where it is —
 * without raw DB access, and without any power to change balances.
 *
 * stage: pending_at_jokko | submitted_to_provider | confirmed | settled |
 *        failed | reversed | refunded | in_review | reconciliation_exception |
 *        completed (internal transfer)
 */
const OP_STAGE = {
  created: 'pending_at_jokko',
  authorized: 'pending_at_jokko',
  submitted: 'submitted_to_provider',
  expired: 'in_review',
  confirmed: 'confirmed',
  settled: 'settled',
  failed: 'failed',
  cancelled: 'failed',
  reversed: 'reversed',
  refunded: 'refunded',
};

const maskPhoneish = (s) => (s ? `${String(s).slice(0, 4)}…` : null);

export async function lookupMoneyReference(q, db = prisma) {
  const ref = String(q ?? '').trim().slice(0, 120);
  if (ref.length < 4) return null;
  // References are stable: op reference, entry reference (with -J/-R/-CONFIRM suffixes), charge code.
  const base = ref.replace(/-(J|R|P|B|HOLD|CONFIRM|SETTLE|RELEASE|KORI)$/, '');
  const op = await db.externalOperation.findFirst({ where: { OR: [{ reference: ref }, { reference: base }, { providerReference: ref }] } });
  const entries = await db.journalEntry.findMany({
    where: { OR: [{ reference: ref }, { reference: { startsWith: `${base}-` } }, { reference: base }, ...(op ? [{ externalOperationId: op.id }] : [])] },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { id: true, reference: true, kind: true, createdAt: true, reversesId: true, actorType: true, metadata: true, reversedBy: { select: { reference: true } } },
  });
  const exceptions = op
    ? await db.reconciliationException.findMany({ where: { OR: [{ operationId: op.id }, { providerReference: op.providerReference ?? '__none__' }] } }).catch(() => [])
    : [];
  const refunds = entries.length
    ? await db.journalEntry.findMany({ where: { kind: 'merchant_refund', metadata: { path: ['originalReference'], in: entries.map((e) => e.reference) } }, select: { reference: true, createdAt: true } }).catch(() => [])
    : [];
  const charge = await db.merchantCharge.findFirst({ where: { OR: [{ code: ref }, { paymentRef: base }] } });
  if (!op && !entries.length && !charge) return null;

  let stage = 'completed';
  if (op) stage = OP_STAGE[op.state] ?? 'pending_at_jokko';
  if (entries.some((e) => e.reversedBy)) stage = 'reversed';
  else if (refunds.length) stage = 'refunded';
  if (exceptions.some((x) => x.status === 'open')) stage = 'reconciliation_exception';
  if (!op && !entries.length && charge) stage = charge.status === 'paid' ? 'completed' : charge.status;

  return {
    reference: op?.reference ?? entries[0]?.reference ?? charge?.code,
    stage,
    operation: op
      ? {
          direction: op.direction,
          provider: op.provider,
          state: op.state,
          amountKori: Number(op.amountKori),
          amountMinor: Number(op.amountMinor),
          currency: op.currency,
          providerReference: maskPhoneish(op.providerReference),
          reviewReason: op.reviewReason,
          failureReason: op.failureReason,
          createdAt: op.createdAt.toISOString(),
          submittedAt: op.submittedAt?.toISOString() ?? null,
          confirmedAt: op.confirmedAt?.toISOString() ?? null,
          settledAt: op.settledAt?.toISOString() ?? null,
          userId: op.userId,
        }
      : null,
    ledger: entries.map((e) => ({
      reference: e.reference,
      kind: e.kind,
      at: e.createdAt.toISOString(),
      reversedBy: e.reversedBy?.reference ?? null,
      actorType: e.actorType,
    })),
    refunds: refunds.map((r) => ({ reference: r.reference, at: r.createdAt.toISOString() })),
    exceptions: exceptions.map((x) => ({ kind: x.kind, status: x.status, createdAt: x.createdAt.toISOString() })),
    charge: charge ? { code: charge.code, status: charge.status, amountKori: charge.amountKori, expiresAt: charge.expiresAt.toISOString() } : null,
    canSupportChangeBalance: false,
  };
}

/**
 * D15 instrumentation: how the maker-checker ceilings are actually used, so
 * they can be calibrated from evidence. Counts only — no personal data.
 */
export async function limitsUsage(db = prisma, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 864e5);
  const single = LIMITS.adjustmentSingleMaxKori();
  const refundMax = LIMITS.refundSingleMaxKori();
  const floatMax = LIMITS.agentFloatSingleMaxXof();
  const [adjustments, approvals, refunds, floats] = await Promise.all([
    db.moneyAdjustmentRequest.findMany({ where: { createdAt: { gte: since } }, select: { amount: true, status: true, approvedBy: true } }),
    db.adminApproval.groupBy({ by: ['action', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    db.adminRefund.findMany({ where: { createdAt: { gte: since } }, select: { amount: true } }),
    db.agentFloatEntry.findMany({ where: { createdAt: { gte: since }, adminId: { not: null } }, select: { amountXof: true } }).catch(() => []),
  ]);
  const near = (v, max) => v > max * 0.8 && v <= max;
  return {
    windowDays: days,
    thresholds: { adjustmentSingleMaxKori: single, refundSingleMaxKori: refundMax, agentFloatSingleMaxXof: floatMax },
    adjustments: {
      total: adjustments.length,
      singleOperatorPosted: adjustments.filter((a) => a.status === 'posted' && !a.approvedBy).length,
      dualAuthorized: adjustments.filter((a) => a.approvedBy).length,
      nearSingleCeiling: adjustments.filter((a) => near(Number(a.amount), single)).length,
    },
    refunds: { singleOperator: refunds.length, nearSingleCeiling: refunds.filter((r) => near(r.amount, refundMax)).length },
    agentFloat: { singleOperator: floats.length, nearSingleCeiling: floats.filter((f) => near(Math.abs(f.amountXof), floatMax)).length },
    approvals: approvals.map((a) => ({ action: a.action, status: a.status, count: a._count._all })),
  };
}
