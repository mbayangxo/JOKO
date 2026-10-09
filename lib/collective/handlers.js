import { z } from 'zod';
import { prisma } from '../prisma.js';
import { validationError } from '../validation.js';
import { assertStepUpForAmount, StepUpRequiredError } from '../step-up.js';
import { isMoneyError, moneyErrorStatus } from '../wallet-atomic.js';
import { CollectiveError, FREQUENCIES, collectiveEnabled } from './contract.js';
import * as C from './engine.js';
import * as V from './views.js';
import * as O from './ops.js';

/**
 * J11 routes (thin). Every rule — consent, rules hash, schedule, payout eligibility, votes, authority —
 * lives in lib/collective/*. A client never supplies a recipient, and amounts are capped server-side to
 * what is actually due or owned.
 */
const id = (req) => String(req.query.id ?? '');
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
    if (!collectiveEnabled()) throw new CollectiveError('collective_not_enabled', 'Les groupes d’épargne ne sont pas encore ouverts.', 503);
    await fn(req, res);
  } catch (error) {
    if (error instanceof CollectiveError) return res.status(error.status ?? 409).json({ error: error.message, code: error.code });
    if (error instanceof StepUpRequiredError) return res.status(403).json({ error: error.message, code: error.code, reason: error.reason });
    if (isMoneyError(error)) return res.status(moneyErrorStatus(error)).json({ error: error.message, code: error.code ?? 'money_error' });
    throw error;
  }
};
const idem = (req) => String(req.headers?.['idempotency-key'] ?? req.body?.idempotencyKey ?? '');
const kori = z.number().int().min(1).max(500_000);

export const collectiveGroups = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await V.myGroups(req.userId));
  const b = parse(z.object({
    kind: z.enum(['rotating', 'goal']), name: z.string().trim().min(3).max(60), contributionKori: kori,
    frequency: z.enum(Object.keys(FREQUENCIES)), graceDays: z.number().int().min(0).max(14).optional(),
    rotationMethod: z.enum(['draw', 'fixed']).optional(), cycleCount: z.number().int().min(1).max(52).optional(),
    withdrawPolicy: z.enum(['anytime', 'end']).optional(), targetKori: z.number().int().min(1).max(50_000_000).optional(),
  }).strict(), req, res);
  if (b) res.status(201).json(await C.createGroup(req.userId, b));
});
export const collectiveGroup = wrap(async (req, res) => res.json(await V.groupView(id(req), req.userId)));
export const collectiveInvite = wrap(async (req, res) => {
  const b = parse(z.object({ handles: z.array(z.string().trim().min(2).max(40)).min(1).max(30) }).strict(), req, res);
  if (b) res.json(await C.inviteMembers(id(req), req.userId, b.handles));
});
export const collectiveRespond = wrap(async (req, res) => {
  const b = parse(z.object({ accept: z.boolean() }).strict(), req, res);
  if (b) res.json(await C.respondToInvite(id(req), req.userId, b.accept));
});
export const collectiveLeave = wrap(async (req, res) => res.json(await C.leaveGroup(id(req), req.userId)));
export const collectiveRemove = wrap(async (req, res) => {
  const b = parse(z.object({ handle: z.string().trim().min(2).max(40) }).strict(), req, res);
  if (!b) return;
  const u = await prisma.user.findFirst({ where: { handle: { in: [b.handle.replace(/^@/, ''), `@${b.handle.replace(/^@/, '')}`] } }, select: { id: true } });
  if (!u) throw new CollectiveError('not_found', 'Membre introuvable', 404);
  res.json(await C.removeMember(id(req), req.userId, u.id));
});
export const collectiveProposeRules = wrap(async (req, res) => {
  const b = parse(z.object({ order: z.array(z.string().trim().min(2).max(40)).max(30).optional(), startAt: z.string().datetime().optional() }).strict(), req, res);
  if (!b) return;
  let order = null;
  if (b.order) {
    // Handles → member ids; an unknown handle simply fails the "every member exactly once" check.
    const clean = b.order.map((h) => h.replace(/^@/, ''));
    const users = await prisma.user.findMany({ where: { handle: { in: clean.flatMap((h) => [h, `@${h}`]) } }, select: { id: true, handle: true } });
    order = clean.map((h) => users.find((u) => u.handle === h || u.handle === `@${h}`)?.id ?? `unknown:${h}`);
  }
  res.json(await C.proposeRules(id(req), req.userId, { order, startAt: b.startAt ?? null }));
});
export const collectiveAcceptRules = wrap(async (req, res) => {
  const b = parse(z.object({ rulesHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), req, res);
  if (b) res.json(await C.acceptRules(id(req), req.userId, b));
});
export const collectiveDeclineRules = wrap(async (req, res) => res.json(await C.declineRules(id(req), req.userId)));
export const collectiveCancel = wrap(async (req, res) => res.json(await C.cancelBeforeStart(id(req), req.userId)));
export const collectiveContribute = wrap(async (req, res) => {
  const b = parse(z.object({ amountKori: kori.optional(), idempotencyKey: z.string().optional() }).strict(), req, res);
  if (!b) return;
  // Step-up by amount (J4 thresholds): the largest possible debit is one obligation.
  const g = await prisma.collectiveGroup.findUnique({ where: { id: id(req) }, select: { contributionKori: true } });
  await assertStepUpForAmount(req, (b.amountKori ?? g?.contributionKori ?? 0) * 10);
  res.json(await C.contribute(id(req), req.userId, { amountKori: b.amountKori ?? null, idempotencyKey: idem(req) }));
});
export const collectiveRelease = wrap(async (req, res) => res.json(await C.releaseCycle(id(req), req.userId)));
export const collectiveWithdraw = wrap(async (req, res) => {
  const b = parse(z.object({ amountKori: kori.optional(), idempotencyKey: z.string().optional() }).strict(), req, res);
  if (b) res.json(await C.withdrawShare(id(req), req.userId, { amountKori: b.amountKori ?? null, idempotencyKey: idem(req) }));
});
export const collectiveOpenVote = wrap(async (req, res) => {
  const b = parse(z.object({ topic: z.enum(['extend_grace', 'partial_release', 'cancel', 'exit']), days: z.number().int().min(1).max(14).optional() }).strict(), req, res);
  if (b) res.status(201).json(await C.openVote(id(req), req.userId, b));
});
export const collectiveBallot = wrap(async (req, res) => {
  const b = parse(z.object({ choice: z.enum(['yes', 'no']) }).strict(), req, res);
  if (b) res.json(await C.castBallot(id(req), req.userId, b.choice));
});
export const collectiveDispute = wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(10).max(1000) }).strict(), req, res);
  if (b) res.status(201).json(await C.openDispute(id(req), req.userId, b));
});

/* ── operators ──────────────────────────────────────────────────────────────────── */
export const adminCollectiveGroups = wrap(async (req, res) => res.json(await O.adminGroups({ status: req.query.status ?? null })));
export const adminCollectiveGroup = wrap(async (req, res) => res.json(await O.adminGroupDetail(id(req))));
export const adminCollectiveFreeze = wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(10).max(300) }).strict(), req, res);
  if (b) res.json(await O.freezeGroup(req.adminId, id(req), b));
});
export const adminCollectiveUnfreeze = wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(10).max(300) }).strict(), req, res);
  if (b) res.json(await O.unfreezeGroup(req.adminId, id(req), b));
});
export const adminCollectiveDisputes = wrap(async (req, res) => res.json(await O.adminDisputes({ status: req.query.status ?? 'open' })));
export const adminCollectiveRule = wrap(async (req, res) => {
  const b = parse(z.object({ outcome: z.enum(O.RULINGS), note: z.string().trim().min(10).max(500) }).strict(), req, res);
  if (!b) return;
  const r = await O.ruleDispute(req.adminId, id(req), b);
  let approval = null;
  if (r.dispute.status === 'awaiting_settlement' && !r.replayed) {
    const { requestApproval, approvalShape } = await import('../authz/approvals.js');
    approval = approvalShape(await requestApproval(prisma, req, { action: 'collective_dispute_settle', payload: { disputeId: r.dispute.id }, reason: b.note, caseRef: `collective_group:${r.dispute.groupId}` }));
  }
  res.json({ dispute: r.dispute, approval });
});

/** Scheduler: no-op unless JOKKO_COLLECTIVE_ENABLED=true. Not in vercel.json (deploy-inert). */
export async function runCollectiveCron() {
  return C.runCollectiveMaintenance();
}
