import { z } from 'zod';
import { prisma } from '../prisma.js';
import { validationError } from '../validation.js';
import { assertStepUp, StepUpRequiredError } from '../step-up.js';
import { isMoneyError, moneyErrorStatus } from '../wallet-atomic.js';
import { WorkError, TYPES } from './contract.js';
import * as W from './service.js';
import * as D from './disputes.js';
import * as R from './rules.js';
import { payoutWorkerEarnings, runWorkMaintenance } from './money.js';

/**
 * J9 routes (thin). Every rule — authority, eligibility, funding, state — lives in lib/work/*.
 * Nobody sends an amount the server would trust beyond the terms it validates and snapshots.
 */
const id = (req) => String(req.query.id ?? '');
const sub = (req) => String(req.query.subId ?? '');
const parse = (schema, req, res) => {
  const p = schema.safeParse(req.body ?? {});
  if (!p.success) {
    validationError(res, p.error);
    return null;
  }
  return p.data;
};
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof WorkError) return res.status(error.status ?? 409).json({ error: error.message, code: error.code });
    if (error instanceof StepUpRequiredError) return res.status(403).json({ error: error.message, code: error.code, reason: error.reason });
    if (isMoneyError(error)) return res.status(moneyErrorStatus(error)).json({ error: error.message, code: error.code ?? 'money_error' });
    throw error;
  }
};
const idem = (req) => String(req.headers?.['idempotency-key'] ?? req.body?.idempotencyKey ?? '');
const str = (n) => z.string().trim().max(n);
const kori = z.number().int().min(0).max(100_000_000);
const evidenceKind = z.enum(['note', 'photo_ref', 'document_ref', 'attendance', 'receipt_ref']);

/* ── worker ─────────────────────────────────────────────────────────────────────────── */
export const workProfile = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await W.getMyProfile(req.userId));
  const b = parse(z.object({
    headline: str(120).optional(), skills: z.array(str(60)).max(20).optional(), areas: z.array(str(60)).max(10).optional(),
    availability: str(200).optional(), visibility: z.enum(['private', 'applications_only', 'discoverable']).optional(),
    portfolio: z.array(z.object({ title: str(80), ref: str(200).optional() }).strict()).max(10).optional(),
  }).strict(), req, res);
  if (b) res.json(await W.upsertMyProfile(req.userId, b));
});
export const workQualifications = wrap(async (req, res) => {
  const b = parse(z.object({ kind: z.enum(['skill', 'certificate', 'licence', 'training', 'experience']), title: str(120).min(2), issuer: str(120).optional(), evidenceRef: str(200).optional() }).strict(), req, res);
  if (b) res.status(201).json(await W.addQualification(req.userId, b));
});
export const workBlock = wrap(async (req, res) => {
  const b = parse(z.object({ businessId: z.string().min(1).max(64) }).strict(), req, res);
  if (b) res.json(await W.blockBusiness(req.userId, b.businessId));
});
export const workDiscover = wrap(async (req, res) => res.json(await W.discoverOpportunities(req.userId, { type: req.query.type, area: req.query.area, skill: req.query.skill, cursor: req.query.cursor, limit: req.query.limit })));
export const workOpportunityGet = wrap(async (req, res) => res.json(await W.getOpportunity(req.userId, id(req))));
export const workApply = wrap(async (req, res) => {
  const b = parse(z.object({ note: str(500).optional() }).strict(), req, res);
  if (b) res.status(201).json(await W.applyToOpportunity(req.userId, id(req), b));
});
export const workMyApplications = wrap(async (req, res) => res.json(await W.myApplications(req.userId)));
export const workWithdrawApplication = wrap(async (req, res) => {
  if (parse(z.object({}).strict(), req, res)) res.json(await W.withdrawApplication(req.userId, id(req)));
});
export const workMyOffers = wrap(async (req, res) => res.json(await W.myOffers(req.userId)));
export const workOfferAccept = wrap(async (req, res) => {
  const b = parse(z.object({ termsHash: z.string().length(64), ageAttested: z.boolean().optional() }).strict(), req, res);
  if (b) res.json(await W.acceptOffer(req.userId, id(req), b));
});
export const workOfferDecline = wrap(async (req, res) => {
  if (parse(z.object({}).strict(), req, res)) res.json(await W.declineOffer(req.userId, id(req)));
});
export const workMyAssignments = wrap(async (req, res) => res.json(await W.myAssignments(req.userId)));
export const workAssignmentGet = wrap(async (req, res) => res.json(await W.getAssignment(req.userId, id(req))));
export const workAttendance = wrap(async (req, res) => {
  const b = parse(z.object({ purpose: z.enum(['checkin', 'checkout']), code: z.string().min(4).max(16) }).strict(), req, res);
  if (b) res.json(await W.submitAttendance(req.userId, id(req), b));
});
export const workMilestoneSubmit = wrap(async (req, res) => {
  const b = parse(z.object({ seq: z.number().int().min(1).max(20), kind: evidenceKind.optional(), content: str(1000).min(5) }).strict(), req, res);
  if (b) res.json(await W.submitMilestone(req.userId, id(req), b.seq, b));
});
export const workAssignmentEnd = wrap(async (req, res) => {
  const b = parse(z.object({ reason: str(300).min(3) }).strict(), req, res);
  if (b) res.json(await W.endAssignment({ userId: req.userId }, id(req), b));
});
export const workDisputeOpen = wrap(async (req, res) => {
  const b = parse(z.object({ kind: z.enum(['nonpayment', 'terms_breach', 'harassment', 'other']), reason: str(1000).min(10), milestoneSeq: z.number().int().min(1).max(20).optional() }).strict(), req, res);
  if (b) res.status(201).json(await D.openDispute(req.userId, id(req), b));
});
export const workDisputeGet = wrap(async (req, res) => res.json(await D.getDisputeForParty(req.userId, id(req))));
export const workDisputeEvidence = wrap(async (req, res) => {
  const b = parse(z.object({ kind: evidenceKind.optional(), content: str(1000).min(3) }).strict(), req, res);
  if (b) res.status(201).json(await D.addDisputeEvidence(req.userId, id(req), b));
});
export const workEarnings = wrap(async (req, res) => res.json(await W.myEarnings(req.userId)));
export const workPayout = wrap(async (req, res) => {
  if (parse(z.object({ idempotencyKey: z.string().optional() }).strict(), req, res)) res.json(await payoutWorkerEarnings(req.userId, { idempotencyKey: idem(req) }));
});
export const workFeedbackLeave = wrap(async (req, res) => {
  const b = parse(z.object({ rating: z.number().int().min(1).max(5), comment: str(300).optional() }).strict(), req, res);
  if (b) res.status(201).json(await D.leaveFeedback(req.userId, id(req), b));
});
export const workMyFeedback = wrap(async (req, res) => res.json(await D.myFeedback(req.userId)));
export const workFeedbackContest = wrap(async (req, res) => {
  const b = parse(z.object({ note: str(500).min(10) }).strict(), req, res);
  if (b) res.json(await D.contestFeedback(req.userId, id(req), b));
});
export const workTypes = wrap(async (_req, res) => res.json(Object.entries(TYPES).map(([key, t]) => ({ key, label: t.label, arrangements: Object.keys(t.arrangements) }))));

/* ── business ───────────────────────────────────────────────────────────────────────── */
const oppBody = z.object({
  type: z.enum(Object.keys(TYPES)), arrangement: z.enum(['employment', 'contract', 'apprenticeship', 'coop_member']), title: str(120).min(4), description: str(2000).min(20),
  area: str(60).optional(), skills: z.array(str(60)).max(20).optional(), headcount: z.number().int().min(1).max(500).optional(),
  payKind: z.enum(['fixed', 'per_unit', 'hourly', 'stipend', 'wage', 'commission', 'fee']), rateKori: kori, units: z.number().int().min(1).max(10_000).optional(),
  hazardous: z.boolean().optional(), minAge: z.number().int().min(16).max(99).optional(), nightWork: z.boolean().optional(),
  hoursPerWeek: z.number().int().min(1).max(84).optional(), durationWeeks: z.number().int().min(1).max(520).optional(), closesAt: z.string().datetime().optional(),
}).strict();
export const bizOpportunities = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await W.listBusinessOpportunities(req.userId, id(req)));
  const b = parse(oppBody, req, res);
  if (b) res.status(201).json(await W.createOpportunity(req.userId, id(req), b));
});
export const bizOpportunityStatus = wrap(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['open', 'paused', 'closed']) }).strict(), req, res);
  if (b) res.json(await W.setOpportunityStatus(req.userId, id(req), sub(req), b));
});
export const bizApplicants = wrap(async (req, res) => res.json(await W.listApplicants(req.userId, id(req), sub(req))));
export const bizInvite = wrap(async (req, res) => {
  const b = parse(z.object({ workerHandle: str(64).min(2), note: str(500).optional() }).strict(), req, res);
  if (b) res.status(201).json(await W.inviteWorker(req.userId, id(req), sub(req), b));
});
export const bizApplicationDecide = wrap(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['shortlist', 'decline']) }).strict(), req, res);
  if (b) res.json(await W.decideApplication(req.userId, id(req), sub(req), b));
});
export const bizWorkerSearch = wrap(async (req, res) => res.json(await W.searchWorkers(req.userId, id(req), { skill: req.query.skill, area: req.query.area, limit: req.query.limit })));
export const bizOfferCreate = wrap(async (req, res) => {
  const b = parse(z.object({
    applicationId: z.string().min(1).max(64), startDate: z.string().min(8).max(30), endDate: z.string().min(8).max(30).optional(), duties: str(1000).min(10),
    schedule: str(200).optional(), evidenceRequired: evidenceKind.optional(), acceptanceWindowHours: z.number().int().min(24).max(168).optional(),
    milestones: z.array(z.object({ title: str(120).min(2), amountKori: kori, kind: z.enum(['work', 'reimbursement']).optional() }).strict()).min(1).max(20).optional(),
    rateKori: kori.optional(), units: z.number().int().min(1).max(1000).optional(), hoursPerWeek: z.number().int().min(1).max(84).optional(), durationWeeks: z.number().int().min(1).max(520).optional(),
    learningPlan: str(1000).optional(), wagePeriod: z.enum(['month', 'week', 'day']).optional(), expiresInHours: z.number().int().min(1).max(168).optional(),
  }).strict(), req, res);
  if (!b) return;
  // Funding a prepaid offer moves business money: step-up, like every J7 business payment.
  const app = await prisma.workApplication.findUnique({ where: { id: b.applicationId }, select: { opportunityId: true } });
  const opp = app && (await prisma.workOpportunity.findUnique({ where: { id: app.opportunityId }, select: { funding: true } }));
  if (opp?.funding === 'prepaid') await assertStepUp(req, 'business_payment');
  res.status(201).json(await W.createOffer(req.userId, id(req), b));
});
export const bizOfferWithdraw = wrap(async (req, res) => {
  if (parse(z.object({}).strict(), req, res)) res.json(await W.withdrawOffer(req.userId, id(req), sub(req)));
});
export const bizAssignments = wrap(async (req, res) => res.json(await W.businessAssignments(req.userId, id(req), { status: req.query.status })));
export const bizAssignmentGet = wrap(async (req, res) => res.json(await W.getAssignment(req.userId, sub(req), { businessId: id(req) })));
export const bizAttendanceCode = wrap(async (req, res) => {
  const b = parse(z.object({ purpose: z.enum(['checkin', 'checkout']) }).strict(), req, res);
  if (b) res.json(await W.issueAttendanceCode(req.userId, id(req), sub(req), b));
});
export const bizMilestoneAccept = wrap(async (req, res) => {
  const b = parse(z.object({ seq: z.number().int().min(1).max(20) }).strict(), req, res);
  if (b) res.json(await W.acceptMilestone(req.userId, id(req), sub(req), b.seq));
});
export const bizAssignmentEnd = wrap(async (req, res) => {
  const b = parse(z.object({ reason: str(300).min(3) }).strict(), req, res);
  if (b) res.json(await W.endAssignment({ userId: req.userId, businessId: id(req) }, sub(req), b));
});
export const bizDisputeOpen = wrap(async (req, res) => {
  const b = parse(z.object({ kind: z.enum(['false_completion', 'terms_breach', 'other']), reason: str(1000).min(10), milestoneSeq: z.number().int().min(1).max(20).optional() }).strict(), req, res);
  if (b) res.status(201).json(await D.openDispute(req.userId, sub(req), { ...b, businessId: id(req) }));
});
export const bizDisputeEvidence = wrap(async (req, res) => {
  const b = parse(z.object({ kind: evidenceKind.optional(), content: str(1000).min(3) }).strict(), req, res);
  if (b) res.status(201).json(await D.addDisputeEvidence(req.userId, sub(req), { ...b, businessId: id(req) }));
});
export const bizFeedbackLeave = wrap(async (req, res) => {
  const b = parse(z.object({ rating: z.number().int().min(1).max(5), comment: str(300).optional() }).strict(), req, res);
  if (b) res.status(201).json(await D.leaveFeedback(req.userId, sub(req), { ...b, businessId: id(req) }));
});
export const bizRules = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await R.listRules(req.userId, id(req)));
  const b = parse(z.object({ kind: z.enum(['rep_first_received_order', 'pickup_release_fee']), amountKori: kori.optional(), minOrderKori: kori.optional(), pickupPointId: z.string().max(64).optional() }).strict(), req, res);
  if (b) res.status(201).json(await R.proposeRule(req.userId, id(req), b));
});
export const bizRuleApprove = wrap(async (req, res) => {
  if (parse(z.object({}).strict(), req, res)) res.json(await R.approveRule(req.userId, id(req), sub(req)));
});
export const bizRuleFund = wrap(async (req, res) => {
  const b = parse(z.object({ amountKori: z.number().int().positive().max(100_000_000), idempotencyKey: z.string().optional() }).strict(), req, res);
  if (!b) return;
  await assertStepUp(req, 'business_payment');
  res.json(await R.fundRule(req.userId, id(req), sub(req), { amountKori: b.amountKori, idempotencyKey: idem(req) }));
});
export const bizRuleEnd = wrap(async (req, res) => {
  if (parse(z.object({}).strict(), req, res)) res.json(await R.endRule(req.userId, id(req), sub(req)));
});

/* ── operators ──────────────────────────────────────────────────────────────────────── */
export const adminWorkReview = wrap(async (_req, res) => res.json({ opportunities: await D.opportunitiesForReview(), qualifications: await D.qualificationsForReview() }));
export const adminWorkOpportunityReview = wrap(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['approve', 'reject']), note: str(300).min(5) }).strict(), req, res);
  if (b) res.json(await D.reviewOpportunity(req.adminId, id(req), b));
});
export const adminWorkQualificationReview = wrap(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['verified', 'rejected']), note: str(300).optional() }).strict(), req, res);
  if (b) res.json(await D.reviewQualification(req.adminId, id(req), b));
});
export const adminWorkDisputes = wrap(async (req, res) => res.json(await D.listDisputesForOps({ status: req.query.status ?? 'open', limit: req.query.limit })));
export const adminWorkDisputeResolve = wrap(async (req, res) => {
  const b = parse(z.object({ outcome: z.enum(['worker', 'business', 'split', 'finding_only']), note: str(500).min(10), splitWorkerKori: z.number().int().positive().optional() }).strict(), req, res);
  if (!b) return;
  const d = await D.resolveDispute(req.adminId, id(req), b);
  let approval = null;
  if (d.status === 'awaiting_settlement' && !d.replayed) {
    const { requestApproval, approvalShape } = await import('../authz/approvals.js');
    approval = approvalShape(await requestApproval(prisma, req, { action: 'work_dispute_settle', payload: { disputeId: d.id }, reason: b.note, caseRef: `work_assignment:${d.assignmentId}` }));
  }
  res.json({ dispute: d, approval });
});
export const adminWorkFeedbackRule = wrap(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['upheld', 'removed']), note: str(300).min(10) }).strict(), req, res);
  if (b) res.json(await D.ruleFeedback(req.adminId, id(req), b));
});
export const adminWorkContestedFeedback = wrap(async (_req, res) => {
  const rows = await prisma.workFeedback.findMany({ where: { status: 'contested' }, orderBy: { createdAt: 'asc' }, take: 200 });
  res.json(rows.map((f) => ({ id: f.id, fromRole: f.fromRole, rating: f.rating, comment: f.comment, contestNote: f.contestNote, createdAt: f.createdAt.toISOString() })));
});

/* ── cron ───────────────────────────────────────────────────────────────────────────── */
export async function runWorkCron() {
  const outcomes = await R.processWorkOutcomes();
  const maintenance = await runWorkMaintenance();
  return { outcomes, maintenance };
}
