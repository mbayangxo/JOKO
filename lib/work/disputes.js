import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx } from '../business-access.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { recordIdentityEvent } from '../identity/audit.js';
import { account } from '../money-kernel/flows.js';
import { DISPUTE_KINDS, EVIDENCE_KINDS, SETTLEMENT, WorkError } from './contract.js';
import { accrueInTx, classificationFor, maybeCompleteInTx, refundAssignmentInTx, reverseEarningInTx } from './money.js';

/**
 * J9 disputes, feedback, moderation.
 *
 *   open      a PARTY: the worker (nonpayment, terms breach, harassment, other) or the business
 *             (false completion, terms breach, other) — once per milestone / assignment while open
 *   effect    a submitted milestone becomes `disputed` (no auto-accept); every unpaid earning of the
 *             assignment is frozen (no promotion, no payout)
 *   evidence  both parties, append-only (DB trigger), while open
 *   resolve   an OPERATOR (work.disputes.resolve), reason required, audited, once:
 *               finding_only            no money (employment wage claims: the employer's obligation
 *                                       stands and is recorded; harassment findings)
 *               worker | business | split → awaiting_settlement: a SECOND operator holding
 *                                       work.disputes.settle (finance) executes the money once
 *   settle    disputed milestone (still in escrow): worker → earning; business → refund; split → both
 *             accepted milestone, earning unpaid: business → reversal (paid = unrecoverable, never clawed back)
 */
const notFound = () => new WorkError('not_found', 'Litige introuvable', 404);
const WORKER_KINDS = new Set(['nonpayment', 'terms_breach', 'harassment', 'other']);
const BUSINESS_KINDS = new Set(['false_completion', 'terms_breach', 'other']);

async function partyOf(db, userId, a, businessId) {
  if (businessId) {
    if (a.businessId !== businessId) throw new WorkError('not_found', 'Mission introuvable', 404);
    try {
      await assertBusinessAuthorityInTx(db, userId, businessId, 'business.staffing.manage');
    } catch (e) {
      if (e instanceof OrgAccessError) throw new WorkError('not_found', 'Mission introuvable', 404);
      throw e;
    }
    return 'business';
  }
  if (a.workerUserId !== userId) throw new WorkError('not_found', 'Mission introuvable', 404);
  return 'worker';
}

export async function openDispute(userId, assignmentId, { kind, reason, milestoneSeq, businessId = null }) {
  if (!DISPUTE_KINDS.includes(kind)) throw new WorkError('invalid', 'Type de litige inconnu', 400);
  if (!(reason && String(reason).trim().length >= 10)) throw new WorkError('reason_required', 'Explique le litige (10 caractères min.)', 400);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "WorkAssignment" WHERE id = ${assignmentId} FOR UPDATE`;
    const a = await tx.workAssignment.findUnique({ where: { id: assignmentId } });
    if (!a) throw new WorkError('not_found', 'Mission introuvable', 404);
    const role = await partyOf(tx, userId, a, businessId);
    if (!(role === 'worker' ? WORKER_KINDS : BUSINESS_KINDS).has(kind)) throw new WorkError('invalid', 'Ce type de litige ne te concerne pas', 400);
    let m = null;
    if (milestoneSeq != null) {
      m = await tx.workMilestone.findUnique({ where: { assignmentId_seq: { assignmentId: a.id, seq: Number(milestoneSeq) } } });
      if (!m) throw new WorkError('not_found', 'Étape introuvable', 404);
    }
    const open = await tx.workDispute.findFirst({ where: { assignmentId: a.id, status: { in: ['open', 'awaiting_settlement', 'appealed'] }, milestoneId: m?.id ?? null } });
    if (open) {
      if (open.openedBy === userId && open.kind === kind) return { ...view(open), replayed: true };
      throw new WorkError('dispute_open', 'Un litige est déjà ouvert', 409);
    }
    if (kind === 'false_completion') {
      if (!m) throw new WorkError('invalid', 'Indique l’étape contestée', 400);
      // A milestone already ruled on cannot be re-litigated by opening a new dispute (appeal instead).
      if (await tx.workDispute.findFirst({ where: { milestoneId: m.id, status: 'resolved' } })) throw new WorkError('already_ruled', 'Déjà tranché : utilise l’appel dans le délai', 409);
      if (m.status === 'accepted') {
        const e = await tx.workEarning.findUnique({ where: { sourceKey: `milestone:${m.id}` } });
        if (e?.status === 'paid') throw new WorkError('already_paid', 'Déjà payé : la contestation passe par le support (pas de reprise automatique)', 409);
        // The contest window is the earning's own (short after an explicit acceptance, longer after a deemed one).
        if (!e?.contestableUntil || e.contestableUntil <= new Date()) throw new WorkError('window_closed', 'Délai de contestation dépassé', 409);
      } else if (m.status !== 'submitted') {
        throw new WorkError('invalid_state', 'Étape non soumise');
      }
    }
    if (kind === 'nonpayment' && a.funding !== 'payroll') {
      if (!m || m.status !== 'submitted') throw new WorkError('invalid', 'Indique l’étape soumise et non payée', 400);
    }
    if (m && m.status === 'submitted') await tx.workMilestone.update({ where: { id: m.id }, data: { status: 'disputed' } });
    const d = await tx.workDispute.create({ data: { assignmentId: a.id, milestoneId: m?.id ?? null, openedBy: userId, openedByRole: role, kind, reason: String(reason).slice(0, 1000) } });
    await tx.workEvidence.create({ data: { assignmentId: a.id, milestoneId: m?.id ?? null, disputeId: d.id, byUserId: userId, role, kind: 'note', content: String(reason).slice(0, 1000) } });
    return view(d);
  });
}

export async function addDisputeEvidence(userId, disputeId, { kind = 'note', content, businessId = null }) {
  if (!EVIDENCE_KINDS.includes(kind) || !(content && String(content).trim().length >= 3)) throw new WorkError('invalid', 'Pièce invalide', 400);
  const d = await prisma.workDispute.findUnique({ where: { id: disputeId } });
  if (!d) throw notFound();
  const a = await prisma.workAssignment.findUnique({ where: { id: d.assignmentId } });
  const role = await partyOf(prisma, userId, a, businessId).catch(() => { throw notFound(); });
  if (d.status !== 'open') throw new WorkError('invalid_state', 'Litige clos');
  const e = await prisma.workEvidence.create({ data: { assignmentId: a.id, milestoneId: d.milestoneId, disputeId: d.id, byUserId: userId, role, kind, content: String(content).slice(0, 1000) } });
  return { id: e.id, role, kind, at: e.createdAt.toISOString() };
}

export async function getDisputeForParty(userId, disputeId, { businessId = null } = {}) {
  const d = await prisma.workDispute.findUnique({ where: { id: disputeId } });
  if (!d) throw notFound();
  const a = await prisma.workAssignment.findUnique({ where: { id: d.assignmentId } });
  await partyOf(prisma, userId, a, businessId).catch(() => { throw notFound(); });
  const ev = await prisma.workEvidence.findMany({ where: { disputeId }, orderBy: { createdAt: 'asc' } });
  return { ...view(d), evidence: ev.map((e) => ({ role: e.role, kind: e.kind, content: e.content, at: e.createdAt.toISOString() })) };
}

export const view = (d) => ({ id: d.id, assignmentId: d.assignmentId, milestoneId: d.milestoneId, kind: d.kind, openedByRole: d.openedByRole, reason: d.reason, status: d.status, resolution: d.resolution, splitWorkerKori: d.splitWorkerKori, note: d.note, rulingVersion: d.rulingVersion, executableAfter: d.executableAfter?.toISOString() ?? null, appealedByRole: d.appealedByRole ?? null, resolvedAt: d.resolvedAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString(), overdue: d.status === 'open' && d.createdAt.getTime() + SETTLEMENT.disputeSlaHours * 3600_000 < Date.now() });

/* ── operators ─────────────────────────────────────────────────────────────────────── */

export async function listDisputesForOps({ status = 'open', limit = 50 } = {}) {
  const rows = await prisma.workDispute.findMany({ where: { status: { in: status === 'all' ? ['open', 'appealed', 'awaiting_settlement', 'resolved'] : status === 'open' ? ['open', 'appealed'] : [status] } }, orderBy: { createdAt: 'asc' }, take: Math.min(Number(limit) || 50, 200) });
  const out = [];
  for (const d of rows) {
    const ev = await prisma.workEvidence.findMany({ where: { disputeId: d.id }, orderBy: { createdAt: 'asc' } });
    const m = d.milestoneId ? await prisma.workMilestone.findUnique({ where: { id: d.milestoneId } }) : null;
    const a = await prisma.workAssignment.findUnique({ where: { id: d.assignmentId }, select: { reference: true, type: true, arrangement: true, funding: true } });
    out.push({ ...view(d), assignment: a, milestone: m && { seq: m.seq, amountKori: m.amountKori, status: m.status }, evidence: ev.map((e) => ({ role: e.role, kind: e.kind, content: e.content, at: e.createdAt.toISOString() })) });
  }
  return out;
}

/** Operator ruling: records the finding once; a money consequence waits for a second (finance) operator. */
export async function resolveDispute(adminId, disputeId, { outcome, note, splitWorkerKori }) {
  if (!['worker', 'business', 'split', 'finding_only'].includes(outcome)) throw new WorkError('invalid', 'Décision inconnue', 400);
  if (!(note && String(note).trim().length >= 10)) throw new WorkError('reason_required', 'Motif requis (10 caractères min.)', 400);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "WorkDispute" WHERE id = ${disputeId} FOR UPDATE`;
    const d = await tx.workDispute.findUnique({ where: { id: disputeId } });
    if (!d) throw notFound();
    if (d.status !== 'open') {
      if (d.resolvedBy === adminId && d.resolution === outcome) return { ...view(d), replayed: true };
      throw new WorkError('already_resolved', 'Litige déjà tranché', 409);
    }
    const m = d.milestoneId ? await tx.workMilestone.findUnique({ where: { id: d.milestoneId } }) : null;
    const money = outcome !== 'finding_only';
    // Money held in escrow for a disputed milestone must go somewhere: a ruling cannot leave it parked.
    if (!money && m?.status === 'disputed') throw new WorkError('money_at_stake', 'Étape financée en litige : décide travailleur, entreprise ou partage', 400);
    if (money) {
      if (!m) throw new WorkError('invalid', 'Aucun montant en jeu : décision « constat » uniquement', 400);
      if (outcome === 'split') {
        if (m.status !== 'disputed') throw new WorkError('invalid', 'Partage possible seulement avant validation', 400);
        if (!Number.isSafeInteger(splitWorkerKori) || splitWorkerKori <= 0 || splitWorkerKori >= m.amountKori) throw new WorkError('invalid', 'Part du travailleur invalide', 400);
      }
      if (m.status === 'accepted' && outcome === 'worker') {
        // Nothing to move: the worker already holds the earning; the ruling closes the dispute.
        const u = await tx.workDispute.update({ where: { id: d.id }, data: { status: 'resolved', resolution: outcome, resolvedBy: adminId, resolvedAt: new Date(), note: String(note).slice(0, 500) } });
        await audit(tx, adminId, d, outcome, note);
        return view(u);
      }
    }
    const u = await tx.workDispute.update({
      where: { id: d.id },
      data: {
        status: money ? 'awaiting_settlement' : 'resolved', resolution: outcome, splitWorkerKori: outcome === 'split' ? splitWorkerKori : null, resolvedBy: adminId, resolvedAt: new Date(), note: String(note).slice(0, 500),
        // The money waits for the appeal window (either party may appeal once).
        executableAfter: new Date(Date.now() + SETTLEMENT.appealHours * 3600_000),
      },
    });
    await audit(tx, adminId, d, outcome, note);
    return view(u);
  });
}

async function audit(tx, adminId, d, outcome, note) {
  await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'work_dispute_resolved', subjectType: 'work_assignment', subjectId: d.assignmentId, reason: String(note).slice(0, 300), after: { outcome, disputeId: d.id } });
}

/** Executor of the `work_dispute_settle` approval (second operator, finance). Runs the money once. */
export async function executeDisputeSettlement(db, { disputeId, rulingVersion = 1 }, ctx) {
  return runMoneyTransaction(db, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "WorkDispute" WHERE id = ${disputeId} FOR UPDATE`;
    const d = await tx.workDispute.findUnique({ where: { id: disputeId } });
    if (!d) throw notFound();
    if (d.status === 'resolved' && d.settledBy) return { disputeId, replayed: true };
    if (d.status === 'appealed') throw new WorkError('appeal_pending', 'Appel en cours : le règlement attend la décision d’appel', 409);
    if (d.status !== 'awaiting_settlement') throw new WorkError('invalid_state', 'Aucun règlement en attente pour ce litige');
    if (ctx.approvedBy === d.resolvedBy || ctx.approvedBy === d.appealResolvedBy) throw new WorkError('dual_authorization', 'Un second opérateur doit valider', 403);
    if (rulingVersion !== d.rulingVersion) throw new WorkError('ruling_changed', 'La décision a changé (appel) : une nouvelle validation est requise', 409);
    if (d.executableAfter && d.executableAfter > new Date()) throw new WorkError('appeal_window_open', `Délai d’appel ouvert jusqu’au ${d.executableAfter.toISOString()}`, 409);
    await tx.$executeRaw`SELECT id FROM "WorkAssignment" WHERE id = ${d.assignmentId} FOR UPDATE`;
    const a = await tx.workAssignment.findUnique({ where: { id: d.assignmentId } });
    const m = await tx.workMilestone.findUnique({ where: { id: d.milestoneId } });
    const out = { disputeId, toWorkerKori: 0, refundedKori: 0, reversedKori: 0, unrecoverableKori: 0 };
    const from = await account(tx, 'escrowWork', a.offerId);
    if (m.status === 'disputed') {
      if (d.resolution === 'worker') {
        await tx.workMilestone.update({ where: { id: m.id }, data: { status: 'accepted', acceptedAt: new Date(), acceptedBy: 'ruling' } });
        await accrueInTx(tx, { sourceKey: `milestone:${m.id}`, from, workerUserId: a.workerUserId, payerBusinessId: a.businessId, assignmentId: a.id, milestoneId: m.id, classification: classificationFor(a, m), amountKori: m.amountKori, authorization: `dispute_ruling:${d.id}` });
        out.toWorkerKori = m.amountKori;
      } else if (d.resolution === 'business') {
        await tx.workMilestone.update({ where: { id: m.id }, data: { status: 'refunded' } });
        await refundAssignmentInTx(tx, a, m.amountKori, `M-${m.id}`, `dispute_ruling:${d.id}`);
        out.refundedKori = m.amountKori;
      } else if (d.resolution === 'split') {
        await tx.workMilestone.update({ where: { id: m.id }, data: { status: 'split', acceptedAt: new Date(), acceptedBy: 'ruling' } });
        await accrueInTx(tx, { sourceKey: `milestone:${m.id}`, from, workerUserId: a.workerUserId, payerBusinessId: a.businessId, assignmentId: a.id, milestoneId: m.id, classification: classificationFor(a, m), amountKori: d.splitWorkerKori, authorization: `dispute_ruling_split:${d.id}` });
        await refundAssignmentInTx(tx, a, m.amountKori - d.splitWorkerKori, `M-${m.id}`, `dispute_ruling_split:${d.id}`);
        out.toWorkerKori = d.splitWorkerKori;
        out.refundedKori = m.amountKori - d.splitWorkerKori;
      }
    } else if (m.status === 'accepted' && d.resolution === 'business') {
      const e = await tx.workEarning.findUnique({ where: { sourceKey: `milestone:${m.id}` } });
      if (e) {
        const r = await reverseEarningInTx(tx, e, { reason: `dispute_ruling:${d.id}` });
        out.reversedKori = r.reversed;
        out.unrecoverableKori = r.unrecoverable ?? 0;
      }
    }
    await tx.workDispute.update({ where: { id: d.id }, data: { status: 'resolved', settledBy: ctx.approvedBy, settledAt: new Date() } });
    await maybeCompleteInTx(tx, a.id);
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: ctx.approvedBy, action: 'work_dispute_settled', subjectType: 'work_assignment', subjectId: a.id, reason: ctx.reason, after: { ...out, requestedBy: ctx.requestedBy, approvedBy: ctx.approvedBy } });
    return out;
  });
}

/* ── appeals: once, by a party, within the window; decided by a DIFFERENT operator ─────── */

export async function appealDispute(userId, disputeId, { note, businessId = null }) {
  if (!(note && String(note).trim().length >= 10)) throw new WorkError('reason_required', 'Explique l’appel (10 caractères min.)', 400);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "WorkDispute" WHERE id = ${disputeId} FOR UPDATE`;
    const d = await tx.workDispute.findUnique({ where: { id: disputeId } });
    if (!d) throw notFound();
    const a = await tx.workAssignment.findUnique({ where: { id: d.assignmentId } });
    const role = await partyOf(tx, userId, a, businessId).catch(() => { throw notFound(); });
    if (d.appealedAt) {
      if (d.appealedBy === userId) return { ...view(d), replayed: true };
      throw new WorkError('already_appealed', 'Un appel a déjà été fait', 409);
    }
    if (!['awaiting_settlement', 'resolved'].includes(d.status) || d.settledAt) throw new WorkError('invalid_state', 'Rien à faire appel');
    if (!d.resolvedAt || d.resolvedAt.getTime() + SETTLEMENT.appealHours * 3600_000 < Date.now()) throw new WorkError('window_closed', 'Délai d’appel dépassé', 409);
    const won = d.resolution === role; // split / finding-only rulings may be appealed by either party
    if (won) throw new WorkError('invalid', 'Décision déjà en ta faveur', 400);
    const u = await tx.workDispute.update({ where: { id: d.id }, data: { status: 'appealed', appealedBy: userId, appealedByRole: role, appealedAt: new Date(), appealNote: String(note).slice(0, 1000) } });
    await tx.workEvidence.create({ data: { assignmentId: a.id, milestoneId: d.milestoneId, disputeId: d.id, byUserId: userId, role, kind: 'note', content: `appel: ${String(note).slice(0, 990)}` } });
    return view(u);
  });
}

/** Appeal ruling: a different operator than the original resolver; final; money (if any) executes via a NEW approval. */
export async function resolveAppeal(adminId, disputeId, { outcome, note, splitWorkerKori }) {
  if (!['worker', 'business', 'split', 'finding_only', 'upheld'].includes(outcome)) throw new WorkError('invalid', 'Décision inconnue', 400);
  if (!(note && String(note).trim().length >= 10)) throw new WorkError('reason_required', 'Motif requis (10 caractères min.)', 400);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "WorkDispute" WHERE id = ${disputeId} FOR UPDATE`;
    const d = await tx.workDispute.findUnique({ where: { id: disputeId } });
    if (!d) throw notFound();
    if (d.status !== 'appealed') throw new WorkError('invalid_state', 'Pas d’appel en cours');
    if (adminId === d.resolvedBy) throw new WorkError('dual_authorization', 'L’appel est tranché par un autre opérateur', 403);
    const m = d.milestoneId ? await tx.workMilestone.findUnique({ where: { id: d.milestoneId } }) : null;
    const resolution = outcome === 'upheld' ? d.resolution : outcome;
    if (resolution === 'split' && !(Number.isSafeInteger(outcome === 'upheld' ? d.splitWorkerKori : splitWorkerKori) && m && m.status === 'disputed')) throw new WorkError('invalid', 'Partage invalide', 400);
    if (resolution === 'finding_only' && m?.status === 'disputed') throw new WorkError('money_at_stake', 'Étape financée en litige : décide travailleur, entreprise ou partage', 400);
    const money = resolution !== 'finding_only' && Boolean(m) && !(m.status === 'accepted' && resolution === 'worker');
    const u = await tx.workDispute.update({
      where: { id: d.id },
      data: {
        status: money ? 'awaiting_settlement' : 'resolved', resolution, splitWorkerKori: resolution === 'split' ? (outcome === 'upheld' ? d.splitWorkerKori : splitWorkerKori) : null,
        appealResolvedBy: adminId, rulingVersion: d.rulingVersion + 1, executableAfter: new Date(), note: `${d.note ?? ''} | appel: ${String(note).slice(0, 300)}`.slice(0, 900),
      },
    });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'work_dispute_appeal_resolved', subjectType: 'work_assignment', subjectId: d.assignmentId, reason: String(note).slice(0, 300), after: { outcome: resolution, disputeId: d.id } });
    return view(u);
  });
}

/* ── feedback: contestable, appealable ─────────────────────────────────────────────── */

export async function leaveFeedback(userId, assignmentId, { rating, comment, businessId = null }) {
  if (!Number.isSafeInteger(rating) || rating < 1 || rating > 5) throw new WorkError('invalid', 'Note de 1 à 5', 400);
  return prisma.$transaction(async (tx) => {
    const a = await tx.workAssignment.findUnique({ where: { id: assignmentId } });
    if (!a) throw new WorkError('not_found', 'Mission introuvable', 404);
    const role = await partyOf(tx, userId, a, businessId);
    const worked = (await tx.workEarning.count({ where: { assignmentId: a.id } })) > 0 || (await tx.workMilestone.count({ where: { assignmentId: a.id, status: { in: ['accepted', 'split', 'refunded'] } } })) > 0 || a.funding === 'payroll';
    if (!['completed', 'cancelled'].includes(a.status) || !worked) throw new WorkError('invalid_state', 'Avis possible après une mission réalisée');
    const prior = await tx.workFeedback.findUnique({ where: { assignmentId_fromRole: { assignmentId: a.id, fromRole: role } } });
    if (prior) throw new WorkError('already_rated', 'Avis déjà donné', 409);
    const f = await tx.workFeedback.create({ data: { assignmentId: a.id, fromRole: role, fromUserId: userId, subjectUserId: role === 'business' ? a.workerUserId : null, subjectBusinessId: role === 'worker' ? a.businessId : null, rating, comment: comment ? String(comment).slice(0, 300) : null } });
    return { id: f.id, status: f.status };
  });
}

/** The subject (worker, or the rated business) contests: excluded from aggregates until an operator rules. */
export async function contestFeedback(userId, feedbackId, { note, businessId = null }) {
  if (!(note && String(note).trim().length >= 10)) throw new WorkError('reason_required', 'Explique (10 caractères min.)', 400);
  return prisma.$transaction(async (tx) => {
    const f = await tx.workFeedback.findUnique({ where: { id: feedbackId } });
    if (!f) throw new WorkError('not_found', 'Avis introuvable', 404);
    if (businessId) {
      if (f.subjectBusinessId !== businessId) throw new WorkError('not_found', 'Avis introuvable', 404);
      try {
        await assertBusinessAuthorityInTx(tx, userId, businessId, 'business.staffing.manage');
      } catch {
        throw new WorkError('not_found', 'Avis introuvable', 404);
      }
    } else if (f.subjectUserId !== userId) throw new WorkError('not_found', 'Avis introuvable', 404);
    if (f.status !== 'published') throw new WorkError('invalid_state', 'Avis déjà contesté ou tranché');
    await tx.workFeedback.update({ where: { id: f.id }, data: { status: 'contested', contestNote: String(note).slice(0, 500) } });
    return { id: f.id, status: 'contested' };
  });
}

export async function myFeedback(userId) {
  const rows = await prisma.workFeedback.findMany({ where: { subjectUserId: userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  return rows.map((f) => ({ id: f.id, rating: f.rating, comment: f.comment, status: f.status, createdAt: f.createdAt.toISOString() }));
}

export async function ruleFeedback(adminId, feedbackId, { decision, note }) {
  if (!['upheld', 'removed'].includes(decision)) throw new WorkError('invalid', 'Décision inconnue', 400);
  if (!(note && String(note).trim().length >= 10)) throw new WorkError('reason_required', 'Motif requis', 400);
  return prisma.$transaction(async (tx) => {
    const f = await tx.workFeedback.findUnique({ where: { id: feedbackId } });
    if (!f) throw new WorkError('not_found', 'Avis introuvable', 404);
    if (f.status !== 'contested') throw new WorkError('invalid_state', 'Avis non contesté');
    if (f.fromUserId === adminId || f.subjectUserId === adminId) throw new WorkError('conflict_of_interest', 'Opérateur partie prenante', 403);
    await tx.workFeedback.update({ where: { id: f.id }, data: { status: decision, ruledBy: adminId, ruledAt: new Date() } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'work_feedback_ruled', subjectType: 'work_feedback', subjectId: f.id, reason: String(note).slice(0, 300), after: { decision } });
    return { id: f.id, status: decision };
  });
}

/* ── moderation: opportunities held for review; qualification verification ────────── */

export async function opportunitiesForReview() {
  const rows = await prisma.workOpportunity.findMany({ where: { status: 'under_review' }, orderBy: { createdAt: 'asc' }, take: 200 });
  return rows.map((o) => ({ id: o.id, reference: o.reference, businessId: o.businessId, type: o.type, title: o.title, description: o.description, flags: o.reviewFlags?.split(',') ?? [], createdAt: o.createdAt.toISOString() }));
}

export async function reviewOpportunity(adminId, oppId, { decision, note }) {
  if (!['approve', 'reject'].includes(decision)) throw new WorkError('invalid', 'Décision inconnue', 400);
  if (!(note && String(note).trim().length >= 5)) throw new WorkError('reason_required', 'Motif requis', 400);
  return prisma.$transaction(async (tx) => {
    const o = await tx.workOpportunity.findUnique({ where: { id: oppId } });
    if (!o) throw new WorkError('not_found', 'Opportunité introuvable', 404);
    if (o.status !== 'under_review') throw new WorkError('invalid_state', 'Pas en revue');
    await tx.workOpportunity.update({ where: { id: o.id }, data: { status: decision === 'approve' ? 'open' : 'rejected', reviewedBy: adminId } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'work_opportunity_reviewed', subjectType: 'work_opportunity', subjectId: o.id, reason: String(note).slice(0, 300), after: { decision, flags: o.reviewFlags } });
    return { id: o.id, status: decision === 'approve' ? 'open' : 'rejected' };
  });
}

export async function qualificationsForReview() {
  const rows = await prisma.workQualification.findMany({ where: { status: 'self_declared', evidenceRef: { not: null } }, orderBy: { createdAt: 'asc' }, take: 200 });
  return rows.map((q) => ({ id: q.id, kind: q.kind, title: q.title, issuer: q.issuer, evidenceRef: q.evidenceRef, createdAt: q.createdAt.toISOString() }));
}

export async function reviewQualification(adminId, qualId, { decision, note }) {
  if (!['verified', 'rejected'].includes(decision)) throw new WorkError('invalid', 'Décision inconnue', 400);
  return prisma.$transaction(async (tx) => {
    const q = await tx.workQualification.findUnique({ where: { id: qualId } });
    if (!q) throw new WorkError('not_found', 'Qualification introuvable', 404);
    if (q.userId === adminId) throw new WorkError('conflict_of_interest', 'On ne vérifie pas ses propres qualifications', 403);
    if (q.status !== 'self_declared') throw new WorkError('invalid_state', 'Déjà examinée');
    await tx.workQualification.update({ where: { id: q.id }, data: { status: decision, reviewedBy: adminId, reviewedAt: new Date(), reviewNote: note ? String(note).slice(0, 300) : null } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'work_qualification_reviewed', subjectType: 'user', subjectId: q.userId, reason: note ? String(note).slice(0, 300) : decision, after: { decision, qualificationId: q.id } });
    return { id: q.id, status: decision };
  });
}
