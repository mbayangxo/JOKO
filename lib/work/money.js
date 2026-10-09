import { prisma } from '../prisma.js';
import { account, business as businessAccount, customer as customerAccount, move } from '../money-kernel/flows.js';
import { lockProjections, runMoneyTransaction } from '../wallet-atomic.js';
import { ensureBusinessWallet } from '../business-wallet-service.js';
import { CLASSIFICATION, EARNING_HOLD_HOURS, PLATFORM_FEE_BPS, WorkError, assertWorkMoneyEnabled, contestHoursFor } from './contract.js';

/**
 * J9 money recipes (J2 is the only money authority; every posting has a deterministic reference,
 * so a retry replays and never repeats).
 *
 *   offer sent (prepaid)       business wallet ──total──▶ escrow:work:<offer>              offer.fundingStatus=held
 *   offer declined / expired   escrow ──balance──▶ business wallet                          fundingStatus=refunded
 *   milestone accepted         escrow ──amount──▶ worker:<id>:earnings   WorkEarning accrued (hold, then releasable)
 *   courier verified delivery  escrow ──rate──▶ worker:<id>:earnings     (own fleet only; never with a J8 earning)
 *   milestone refunded         escrow ──amount──▶ business wallet         assignment.refundedKori += amount
 *   rule outcome (verified)    escrow:work_rule:<rule> ──amount──▶ worker / work_business earnings
 *   payout (worker)            worker:<id>:earnings ──releasable──▶ worker wallet
 *   payout (business payee)    work_business:<id>:earnings ──▶ business wallet (automatic once releasable)
 *   ruling reversal            earnings ──unpaid amount──▶ payer business wallet  (maker/checker; paid = unrecoverable)
 */
const escrow = (tx, offerId) => account(tx, 'escrowWork', offerId);
export const ruleBudget = (tx, ruleId) => account(tx, 'workRuleBudget', ruleId);
const payeeAccount = (tx, e) => (e.workerUserId ? account(tx, 'workerEarnings', e.workerUserId) : account(tx, 'workBusinessEarnings', e.payeeBusinessId));

async function lockBiz(tx, businessId) {
  const w = await ensureBusinessWallet(businessId, tx);
  await lockProjections(tx, { BusinessWallet: [w.id] });
}

export async function escrowBalance(tx, offerId) {
  const a = await tx.ledgerAccount.findUnique({ where: { code: `escrow:work:${offerId}` }, select: { balance: true } });
  return a ? Number(a.balance) : 0;
}

export async function fundOfferInTx(tx, offer, { actorUserId }) {
  if (offer.totalKori <= 0) return offer;
  assertWorkMoneyEnabled();
  await lockBiz(tx, offer.businessId);
  await move(tx, {
    from: await businessAccount(tx, offer.businessId),
    to: await escrow(tx, offer.id),
    amount: offer.totalKori,
    reference: `WRK-FUND-${offer.id}`,
    kind: 'work_escrow_fund',
    actor: { type: 'user', id: actorUserId },
    authorization: 'business.pay:work_offer',
  });
  return tx.workOffer.update({ where: { id: offer.id }, data: { fundingStatus: 'held' } });
}

/** Refund whatever the offer escrow still holds (never-accepted offer). Once. */
export async function refundOfferInTx(tx, offer, { reason }) {
  if (offer.fundingStatus !== 'held') return offer;
  const bal = await escrowBalance(tx, offer.id);
  if (bal > 0) {
    await lockBiz(tx, offer.businessId);
    await move(tx, { from: await escrow(tx, offer.id), to: await businessAccount(tx, offer.businessId), amount: bal, reference: `WRK-REFUND-OFFER-${offer.id}`, kind: 'work_escrow_refund', actor: { type: 'system', id: 'work' }, authorization: `offer_${reason}` });
  }
  return tx.workOffer.update({ where: { id: offer.id }, data: { fundingStatus: 'refunded' } });
}

/** Return `amount` of an assignment's escrow to the business (deterministic `key`). */
export async function refundAssignmentInTx(tx, a, amount, key, reason) {
  if (amount <= 0) return;
  await lockBiz(tx, a.businessId);
  await move(tx, { from: await escrow(tx, a.offerId), to: await businessAccount(tx, a.businessId), amount, reference: `WRK-REFUND-${key}`, kind: 'work_escrow_refund', actor: { type: 'system', id: 'work' }, authorization: reason });
  await tx.workAssignment.update({ where: { id: a.id }, data: { refundedKori: { increment: amount } } });
}

/**
 * Accrue a funded earning, once per `sourceKey`. `from` is the funding account (assignment escrow or
 * rule budget). Returns null (no earning) for amount 0. The platform fee is 0 in J9.
 */
export async function accrueInTx(tx, { sourceKey, from, workerUserId = null, payeeBusinessId = null, payerBusinessId, assignmentId = null, milestoneId = null, ruleId = null, classification, amountKori, holdHours = EARNING_HOLD_HOURS, contestHours = 0, authorization }) {
  if (!Number.isSafeInteger(amountKori) || amountKori <= 0) return null;
  if (PLATFORM_FEE_BPS !== 0) throw new WorkError('fee_not_approved', 'Frais de plateforme non approuvés', 500);
  const prior = await tx.workEarning.findUnique({ where: { sourceKey } });
  if (prior) return prior;
  const to = workerUserId ? await account(tx, 'workerEarnings', workerUserId) : await account(tx, 'workBusinessEarnings', payeeBusinessId);
  await move(tx, { from, to, amount: amountKori, reference: `WRK-EARN-${sourceKey}`, kind: 'work_earning_accrue', actor: { type: 'system', id: 'work' }, authorization });
  return tx.workEarning.create({
    data: {
      sourceKey, workerUserId, payeeBusinessId, payerBusinessId, assignmentId, milestoneId, ruleId, classification, amountKori,
      // Payout eligibility never precedes the end of the contest window.
      contestableUntil: new Date(Date.now() + contestHours * 3600_000),
      releasableAt: new Date(Date.now() + Math.max(holdHours, contestHours) * 3600_000),
    },
  });
}

export function classificationFor(a, milestone) {
  if (milestone?.kind === 'reimbursement') return 'reimbursement';
  return CLASSIFICATION[a.arrangement] ?? 'contractor_payment';
}

/** Accept a submitted (or ruled) milestone: escrow → worker earnings, once. */
export async function acceptMilestoneInTx(tx, a, m, { by }) {
  const u = await tx.workMilestone.updateMany({ where: { id: m.id, status: { in: ['submitted', 'disputed'] } }, data: { status: 'accepted', acceptedAt: new Date(), acceptedBy: by } });
  if (u.count !== 1) throw new WorkError('invalid_state', 'Étape déjà traitée');
  await accrueInTx(tx, {
    sourceKey: `milestone:${m.id}`, from: await escrow(tx, a.offerId), workerUserId: a.workerUserId, payerBusinessId: a.businessId,
    assignmentId: a.id, milestoneId: m.id, classification: classificationFor(a, m), amountKori: m.amountKori, contestHours: contestHoursFor(by === 'auto' || by === 'ruling' ? by : 'business'), authorization: `milestone_accepted:${by === 'auto' ? 'auto' : by === 'ruling' ? 'ruling' : 'business'}`,
  });
  await maybeCompleteInTx(tx, a.id);
}

/** All milestones final → assignment completed; any remainder goes back to the business. */
export async function maybeCompleteInTx(tx, assignmentId) {
  const a = await tx.workAssignment.findUnique({ where: { id: assignmentId } });
  if (a.status !== 'active') return a;
  const ms = await tx.workMilestone.findMany({ where: { assignmentId } });
  if (!ms.length || ms.some((m) => !['accepted', 'refunded', 'split'].includes(m.status))) return a;
  const rest = await escrowBalance(tx, a.offerId);
  if (rest > 0) await refundAssignmentInTx(tx, a, rest, `${a.id}-REST`, 'assignment_complete_remainder');
  const earned = ms.some((m) => ['accepted', 'split'].includes(m.status));
  return tx.workAssignment.update({ where: { id: a.id }, data: earned ? { status: 'completed', completedAt: new Date() } : { status: 'cancelled', cancelledAt: new Date() } });
}

async function frozenAssignmentIds(db, assignmentIds) {
  if (!assignmentIds.length) return new Set();
  const open = await db.workDispute.findMany({ where: { assignmentId: { in: assignmentIds }, status: { in: ['open', 'awaiting_settlement', 'appealed'] } }, select: { assignmentId: true } });
  return new Set(open.map((d) => d.assignmentId));
}

/** Worker pays their releasable earnings (not frozen by an open dispute) to their own wallet. Idempotent per key. */
export async function payoutWorkerEarnings(userId, { idempotencyKey }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) throw new WorkError('idempotency_key_required', 'Clé d’idempotence requise', 400);
  assertWorkMoneyEnabled();
  const reference = `WEP-${userId}-${idempotencyKey}`.slice(0, 120);
  return runMoneyTransaction(prisma, async (tx) => {
    const done = await tx.workEarning.findMany({ where: { payoutReference: { startsWith: `${reference}#` } } });
    if (done.length) return { paidKori: done.reduce((s, e) => s + e.amountKori, 0), count: done.length, replayed: true };
    await tx.$executeRaw`SELECT id FROM "WorkEarning" WHERE "workerUserId" = ${userId} AND status = 'releasable' FOR UPDATE`;
    const cand = await tx.workEarning.findMany({ where: { workerUserId: userId, status: 'releasable' }, orderBy: { createdAt: 'asc' }, take: 200 });
    const frozen = await frozenAssignmentIds(tx, cand.map((e) => e.assignmentId).filter(Boolean));
    const rows = cand.filter((e) => !e.assignmentId || !frozen.has(e.assignmentId));
    if (!rows.length) return { paidKori: 0, count: 0 };
    const total = rows.reduce((s, e) => s + e.amountKori, 0);
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new WorkError('wallet_missing', 'Portefeuille introuvable', 404);
    await lockProjections(tx, { Wallet: [wallet.id] });
    await move(tx, { from: await account(tx, 'workerEarnings', userId), to: await customerAccount(tx, userId), amount: total, reference, kind: 'work_earning_payout', actor: { type: 'user', id: userId }, authorization: 'worker_own_releasable_earnings' });
    let i = 0;
    for (const e of rows) {
      const u = await tx.workEarning.updateMany({ where: { id: e.id, status: 'releasable' }, data: { status: 'paid', paidAt: new Date(), payoutReference: `${reference}#${i++}` } });
      if (u.count !== 1) throw new WorkError('conflict', 'Gains modifiés entre-temps — réessaie', 409);
    }
    return { paidKori: total, count: rows.length };
  });
}

/** Reverse an UNPAID earning back to the payer business (ruling, maker/checker). Paid → reported unrecoverable, never clawed back. */
export async function reverseEarningInTx(tx, e, { reason }) {
  if (e.status === 'paid') return { reversed: 0, unrecoverable: e.amountKori };
  if (e.status === 'reversed') return { reversed: 0 };
  await lockBiz(tx, e.payerBusinessId);
  await move(tx, { from: await payeeAccount(tx, e), to: await businessAccount(tx, e.payerBusinessId), amount: e.amountKori, reference: `WRK-REV-${e.sourceKey}`, kind: 'work_earning_reversal', actor: { type: 'system', id: 'work' }, authorization: reason });
  const u = await tx.workEarning.updateMany({ where: { id: e.id, status: { in: ['accrued', 'releasable'] } }, data: { status: 'reversed', reversedAt: new Date() } });
  if (u.count !== 1) throw new WorkError('conflict', 'Gain modifié entre-temps', 409);
  return { reversed: e.amountKori };
}

/**
 * Maintenance (cron): auto-accept overdue submitted milestones (the business neither accepted nor
 * disputed in the agreed window — no employer-controlled withholding), promote accrued earnings past
 * their hold without an open dispute, credit business payees, expire stale offers (refund).
 */
export async function runWorkMaintenance(db = prisma, now = new Date()) {
  const out = { autoAccepted: 0, promoted: 0, businessCredited: 0, offersExpired: 0 };
  const due = await db.workMilestone.findMany({ where: { status: 'submitted', acceptDeadline: { lte: now } }, select: { id: true, assignmentId: true }, take: 500 });
  for (const d of due) {
    try {
      await runMoneyTransaction(db, async (tx) => {
        await tx.$executeRaw`SELECT id FROM "WorkAssignment" WHERE id = ${d.assignmentId} FOR UPDATE`;
        const open = await tx.workDispute.findFirst({ where: { assignmentId: d.assignmentId, status: { in: ['open', 'awaiting_settlement', 'appealed'] } } });
        const m = await tx.workMilestone.findUnique({ where: { id: d.id } });
        if (open || m.status !== 'submitted') return;
        const a = await tx.workAssignment.findUnique({ where: { id: d.assignmentId } });
        await acceptMilestoneInTx(tx, a, m, { by: 'auto' });
        out.autoAccepted += 1;
      });
    } catch (e) {
      if (!(e instanceof WorkError)) throw e;
    }
  }
  const accrued = await db.workEarning.findMany({ where: { status: 'accrued', releasableAt: { lte: now } }, take: 1000 });
  const frozen = await frozenAssignmentIds(db, accrued.map((e) => e.assignmentId).filter(Boolean));
  const { commissionOnHold } = await import('./rules.js');
  for (const e of accrued) {
    if (e.assignmentId && frozen.has(e.assignmentId)) continue;
    if (e.classification === 'commission' && (await commissionOnHold(db, e))) continue;
    const u = await db.workEarning.updateMany({ where: { id: e.id, status: 'accrued' }, data: { status: 'releasable' } });
    out.promoted += u.count;
  }
  // Business payees (e.g. pickup-point operators): credited to the business wallet once releasable.
  const biz = await db.workEarning.findMany({ where: { status: 'releasable', payeeBusinessId: { not: null } }, take: 500 });
  for (const e of biz) {
    await runMoneyTransaction(db, async (tx) => {
      await tx.$executeRaw`SELECT id FROM "WorkEarning" WHERE id = ${e.id} FOR UPDATE`;
      const cur = await tx.workEarning.findUnique({ where: { id: e.id } });
      if (cur.status !== 'releasable') return;
      await lockBiz(tx, cur.payeeBusinessId);
      const reference = `WBP-${cur.id}`;
      await move(tx, { from: await account(tx, 'workBusinessEarnings', cur.payeeBusinessId), to: await businessAccount(tx, cur.payeeBusinessId), amount: cur.amountKori, reference, kind: 'work_earning_payout', actor: { type: 'system', id: 'work' }, authorization: 'business_payee_releasable' });
      await tx.workEarning.update({ where: { id: cur.id }, data: { status: 'paid', paidAt: new Date(), payoutReference: reference } });
      out.businessCredited += 1;
    });
  }
  const stale = await db.workOffer.findMany({ where: { status: 'sent', expiresAt: { lte: now } }, select: { id: true }, take: 500 });
  for (const s of stale) {
    await runMoneyTransaction(db, async (tx) => {
      await tx.$executeRaw`SELECT id FROM "WorkOffer" WHERE id = ${s.id} FOR UPDATE`;
      const o = await tx.workOffer.findUnique({ where: { id: s.id } });
      if (o.status !== 'sent') return;
      await tx.workOffer.update({ where: { id: o.id }, data: { status: 'expired', decidedAt: now } });
      await refundOfferInTx(tx, o, { reason: 'expired' });
      out.offersExpired += 1;
    });
  }
  return out;
}
