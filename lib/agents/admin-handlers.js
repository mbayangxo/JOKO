import { z } from 'zod';
import { prisma } from '../prisma.js';
import { validationError } from '../../api/_lib/http.js';
import { logAdminAction } from '../admin-audit.js';
import { AdminAuthzError } from '../authz/admin-authz.js';
import { approvalShape, requestApproval } from '../authz/approvals.js';
import { AgentLifecycleError, approveAgent, assignServicePoint, decideServicePoint, lifecycleShape, permitMerchantAssist, rejectAgent, suspendAgent, terminateAgent, verifyAgentIdentity } from './lifecycle.js';
import { CashError, resolveReviewInTx, sweepCash } from './cash.js';
import { CommissionError, proposeRule } from './commission.js';
import { agentOverview, liquidityView, reconcileAgents } from './ops.js';
import { runMoneyTransaction } from '../wallet-atomic.js';

/**
 * J6.1 / J6.11 operator surface. Separation of duties (lib/authz/catalog.js):
 *   compliance  identity, review, activation request/approval (different operators), service points, termination
 *   risk        suspension, risk holds, review-resolution REQUESTS, clawback requests
 *   finance     float (existing caps + maker-checker), commission rules + budget, review-resolution APPROVAL
 *   support     read-only inspection (overview, liquidity) — cannot change balances or status
 * Nothing here sets a balance; corrections are maker-checker approvals.
 */
const json = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
const ERR = [AgentLifecycleError, CashError, CommissionError, AdminAuthzError];
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (ERR.some((E) => error instanceof E)) return res.status(error.status ?? 400).json({ error: error.message, code: error.code });
    throw error;
  }
};
const reasonBody = z.object({ reason: z.string().min(3).max(300) });
const id = (req) => String(req.query.id);

async function audit(req, action, targetType, targetId, detail) {
  await logAdminAction(req.adminId, action, { targetType, targetId, detail });
}

export const adminAgentVerifyIdentity = wrap(async (req, res) => {
  const parsed = z.object({ reason: z.string().max(300).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);
  const a = await verifyAgentIdentity(req.adminId, id(req), parsed.data);
  await audit(req, 'agent_identity_verified', 'agent', id(req));
  res.json({ agent: lifecycleShape(a) });
});

export const adminAgentApprove = wrap(async (req, res) => {
  const parsed = z.object({ reason: z.string().min(5).max(300).optional(), note: z.string().max(300).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);
  const a = await approveAgent(req.adminId, id(req), { reason: parsed.data.reason ?? parsed.data.note });
  await audit(req, 'agent_approved', 'agent', id(req));
  res.json({ agent: lifecycleShape(a) });
});

/** Activation (and reactivation after suspension) is maker-checker: this creates the request. */
export const adminAgentActivate = wrap(async (req, res) => {
  const parsed = reasonBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const a = await prisma.agentProfile.findUnique({ where: { id: id(req) } });
  if (!a) return res.status(404).json({ error: 'Agent introuvable', code: 'not_found' });
  const approval = await requestApproval(prisma, req, { action: 'agent_activation', payload: { agentId: a.id }, reason: parsed.data.reason.length >= 10 ? parsed.data.reason : `${parsed.data.reason} (activation)` });
  res.status(202).json({ approval: approvalShape(approval), message: 'Activation en attente d’un second opérateur.' });
});

export const adminAgentReject = wrap(async (req, res) => {
  const parsed = reasonBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const a = await rejectAgent(req.adminId, id(req), parsed.data);
  await audit(req, 'agent_rejected', 'agent', id(req));
  res.json({ agent: lifecycleShape(a) });
});

export const adminAgentSuspend = wrap(async (req, res) => {
  const parsed = reasonBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const a = await suspendAgent(req.adminId, id(req), parsed.data);
  res.json({ agentId: a.id, status: 'suspended' });
});

export const adminAgentTerminate = wrap(async (req, res) => {
  const parsed = z.object({ reason: z.string().min(10).max(300) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const a = await terminateAgent(req.adminId, id(req), parsed.data);
  await audit(req, 'agent_terminated', 'agent', id(req));
  res.json({ agent: lifecycleShape(a) });
});

export const adminAgentAssignServicePoint = wrap(async (req, res) => {
  const parsed = z.object({ servicePointId: z.string().min(1), reason: z.string().min(5).max(300) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const a = await assignServicePoint(req.adminId, id(req), parsed.data.servicePointId, parsed.data);
  res.json({ agent: lifecycleShape(a), servicePointId: a.servicePointId });
});

export const adminServicePointStatus = wrap(async (req, res) => {
  const parsed = z.object({ status: z.enum(['active', 'inactive', 'closed']), reason: z.string().min(5).max(300) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const sp = await decideServicePoint(req.adminId, id(req), parsed.data);
  res.json({ servicePoint: { id: sp.id, status: sp.status } });
});

export const adminServicePointMerchantAssist = wrap(async (req, res) => {
  const parsed = z.object({ permitted: z.boolean(), reason: z.string().min(5).max(300) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const sp = await permitMerchantAssist(req.adminId, id(req), parsed.data);
  res.json({ servicePoint: { id: sp.id, merchantAssistPermitted: sp.merchantAssistPermitted } });
});

export const adminAgentOverview = wrap(async (req, res) => {
  const o = await agentOverview(prisma, id(req));
  if (!o) return res.status(404).json({ error: 'Agent introuvable', code: 'not_found' });
  res.json(json(o));
});

export const adminAgentLiquidity = wrap(async (_req, res) => res.json(json(await liquidityView(prisma))));

/** Read-only reconciliation report (GET) — nothing is written. */
export const adminAgentReconcileView = wrap(async (_req, res) => res.json(json(await reconcileAgents(prisma, { record: false }))));
/** Run and record exceptions (POST). Still no correction: exceptions are for finance to resolve. */
export const adminAgentReconcileRun = wrap(async (req, res) => {
  const r = await reconcileAgents(prisma, { record: true });
  await audit(req, 'agent_reconciliation_run', 'agent_network', 'all', { ok: r.ok, exceptions: r.exceptions.length });
  res.json(json(r));
});

/** needs_review → release | complete: maker (risk) here, checker (finance approver) via admin/approvals. */
export const adminCashResolveRequest = wrap(async (req, res) => {
  const parsed = z.object({ outcome: z.enum(['release', 'complete']), reason: z.string().min(10).max(300) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const row = await prisma.agentCashTransaction.findUnique({ where: { id: id(req) } });
  if (!row) return res.status(404).json({ error: 'Opération introuvable', code: 'not_found' });
  if (row.state !== 'needs_review') return res.status(409).json({ error: 'Opération non en revue', code: 'not_in_review' });
  const approval = await requestApproval(prisma, req, { action: 'agent_cash_resolve', payload: { txId: row.id, outcome: parsed.data.outcome }, reason: parsed.data.reason });
  res.status(202).json({ approval: approvalShape(approval) });
});

/** risk_hold → resume | release (protective decision by one risk operator; money only returns to its owner). */
export const adminCashRiskDecision = wrap(async (req, res) => {
  const parsed = z.object({ outcome: z.enum(['resume', 'release']), reason: z.string().min(10).max(300) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const row = await prisma.agentCashTransaction.findUnique({ where: { id: id(req) } });
  if (!row || row.state !== 'risk_hold') return res.status(409).json({ error: 'Opération non en revue risque', code: 'not_in_review' });
  const out = await runMoneyTransaction(prisma, (tx) => resolveReviewInTx(tx, row.id, { outcome: parsed.data.outcome, requestedBy: req.adminId, approvedBy: req.adminId }));
  await audit(req, 'cash_risk_decision', 'agent_cash', row.id, { outcome: parsed.data.outcome });
  res.json({ txId: out.id, state: out.state });
});

export const adminCommissionRules = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json({ rules: await prisma.agentCommissionRule.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }) });
  const parsed = z.object({ purpose: z.enum(['cash_in', 'cash_out']), bps: z.number().int().min(0).max(200).optional(), flatKori: z.number().int().min(0).optional(), minAmountXof: z.number().int().min(0).optional(), capKori: z.number().int().min(0).optional() }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const rule = await proposeRule(req.adminId, parsed.data);
  await audit(req, 'commission_rule_proposed', 'commission_rule', rule.id, parsed.data);
  res.status(201).json({ rule });
});

export const adminCommissionRuleActivate = wrap(async (req, res) => {
  const parsed = reasonBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const approval = await requestApproval(prisma, req, { action: 'agent_commission_rule_activate', payload: { ruleId: id(req) }, reason: parsed.data.reason.padEnd(10, '.') });
  res.status(202).json({ approval: approvalShape(approval) });
});

export const adminCommissionBudgetFund = wrap(async (req, res) => {
  const parsed = z.object({ amountKori: z.number().int().positive(), reason: z.string().min(10).max(300) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const approval = await requestApproval(prisma, req, { action: 'agent_commission_budget_fund', payload: { amountKori: parsed.data.amountKori }, reason: parsed.data.reason });
  res.status(202).json({ approval: approvalShape(approval) });
});

export const adminCommissionClawback = wrap(async (req, res) => {
  const parsed = z.object({ reason: z.string().min(10).max(300) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const approval = await requestApproval(prisma, req, { action: 'agent_commission_clawback', payload: { commissionId: id(req) }, reason: parsed.data.reason });
  res.status(202).json({ approval: approvalShape(approval) });
});

export async function cronAgentCashSweep(_req, res) {
  res.json(await sweepCash());
}
