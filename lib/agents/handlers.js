import { z } from 'zod';
import { prisma } from '../prisma.js';
import { validationError } from '../../api/_lib/http.js';
import { assertStepUp, StepUpRequiredError } from '../step-up.js';
import { requestTrust } from '../identity/sessions.js';
import { TierLimitError } from '../tier-service.js';
import { AgentLifecycleError, applyAsAgent, lifecycleShape, proposeServicePoint, reportCashOnHand, updateServicePoint, requireOperatingAgent } from './lifecycle.js';
import { CashLimitError } from './limits.js';
import { CashError, agentComplete, agentDecline, applyClock, cashView, createCashIn, createCashOut, customerCancel, customerCommit, receiptOf, reissueChallenge, scanAndBind } from './cash.js';
import { CommissionError, commissionSummary, settleCommissions } from './commission.js';
import { listServicePoints } from './discovery.js';
import { AssistError, acceptAssist, declineAssist, listMyAssists, openAssist, startAssist } from '../onboarding/assisted.js';
import { OrgAccessError } from '../business-access.js';
import { explain } from '../money/user-reasons.js';

/**
 * J6 HTTP surface: customer cash-in / cash-out, agent scan → complete,
 * discovery, commissions, service points, assisted onboarding.
 *
 * J6.15 retry contract: every create takes an Idempotency-Key and returns the
 * same transaction on retry; every response carries the authoritative state
 * (`status`: pending | checking | completed | failed_cancelled) and a
 * `nextStep` that never tells anyone to repeat a physical cash handoff. After
 * a timeout, a lost response or an app restart the client reads
 * GET agent-cash/tx (or agent-cash/tx/:id) — it never re-submits.
 */
const ERRORS = [CashError, CashLimitError, AgentLifecycleError, CommissionError, AssistError, OrgAccessError];

function fail(res, error) {
  if (error instanceof StepUpRequiredError) {
    res.status(403).json({ error: 'Confirme avec ton code PIN.', code: 'step_up_required', reason: error.reason });
    return true;
  }
  if (error instanceof TierLimitError) {
    res.status(403).json({ error: error.message, code: error.code ?? 'tier_limit' });
    return true;
  }
  if (ERRORS.some((E) => error instanceof E)) {
    res.status(error.status ?? 400).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (fail(res, error)) return;
    throw error;
  }
};
const idemKey = (req) => {
  const k = req.headers['idempotency-key'] ?? req.body?.idempotencyKey;
  return k ? String(k).slice(0, 120) : null;
};
const amountSchema = z.object({ amountXof: z.number().int().positive() });

async function customerTx(req, id) {
  const row = await prisma.agentCashTransaction.findUnique({ where: { id: String(id) } });
  if (!row || row.customerId !== req.userId) throw new CashError('not_found', 'Opération introuvable', 404);
  return row;
}
async function withClock(row) {
  const clocked = await applyClock(row.id);
  return clocked;
}

// ── Customer ────────────────────────────────────────────────────────────────

export const cashInCreate = wrap(async (req, res) => {
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const key = idemKey(req);
  if (!key) return res.status(400).json({ error: 'Idempotency-Key requis', code: 'idempotency_required' });
  const { row, challenge, replayed } = await createCashIn(req.userId, { amountXof: parsed.data.amountXof, idempotencyKey: key, deviceId: requestTrust(req).deviceId });
  res.status(replayed ? 200 : 201).json({ transaction: await cashView(row, 'customer'), qr: challenge?.qr ?? null, replayed: Boolean(replayed) });
});

export const cashOutCreate = wrap(async (req, res) => {
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const key = idemKey(req);
  if (!key) return res.status(400).json({ error: 'Idempotency-Key requis', code: 'idempotency_required' });
  // Policy CASH_OUT already ran the risk engine (deny / hold) and the PIN step-up.
  const riskReasons = req.riskReview?.reasons ?? null;
  const { row, challenge, replayed, riskHeld } = await createCashOut(req.userId, { amountXof: parsed.data.amountXof, idempotencyKey: key, deviceId: requestTrust(req).deviceId, riskReasons });
  const body = { transaction: await cashView(row, 'customer'), qr: challenge?.qr ?? null, replayed: Boolean(replayed) };
  if (riskHeld) Object.assign(body, explain(['rapid_cash_in_out']));
  res.status(replayed ? 200 : 201).json(body);
});

export const cashTxList = wrap(async (req, res) => {
  const rows = await prisma.agentCashTransaction.findMany({ where: { customerId: req.userId }, orderBy: { createdAt: 'desc' }, take: 20 });
  const out = [];
  for (const r of rows) out.push(await cashView(await withClock(r), 'customer'));
  res.json({ transactions: out, open: out.filter((t) => ['pending', 'checking'].includes(t.status)) });
});

/** Party read: the customer, or the agent the transaction is bound to. Anyone else: 404. */
export const cashTxGet = wrap(async (req, res) => {
  const row = await prisma.agentCashTransaction.findUnique({ where: { id: String(req.query.id) } });
  if (!row) return res.status(404).json({ error: 'Opération introuvable', code: 'not_found' });
  if (row.customerId === req.userId) {
    const v = await cashView(await withClock(row), 'customer');
    return res.json({ transaction: v, receipt: receiptOf(v) });
  }
  const agent = await prisma.agentProfile.findUnique({ where: { userId: req.userId }, select: { id: true } });
  if (agent && row.agentId === agent.id) {
    const v = await cashView(await withClock(row), 'agent');
    return res.json({ transaction: v, receipt: receiptOf(v) });
  }
  res.status(404).json({ error: 'Opération introuvable', code: 'not_found' });
});

export const cashTxConfirm = wrap(async (req, res) => {
  const parsed = z.object({ bindingHash: z.string().length(64) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const row = await customerTx(req, req.query.id);
  // Receiving cash (cash-out) is authorized with the PIN; handing cash (cash-in) is a confirmation.
  if (row.kind === 'cash_out') await assertStepUp(req, 'cash_out_handoff');
  const updated = await customerCommit(req.userId, row.id, parsed.data);
  res.json({ transaction: await cashView(updated, 'customer') });
});

export const cashTxCancel = wrap(async (req, res) => {
  const row = await customerTx(req, req.query.id);
  const updated = await customerCancel(req.userId, row.id);
  res.json({ transaction: await cashView(updated, 'customer') });
});

export const cashTxChallenge = wrap(async (req, res) => {
  const row = await customerTx(req, req.query.id);
  const { row: updated, challenge } = await reissueChallenge(req.userId, row.id);
  res.json({ transaction: await cashView(updated, 'customer'), qr: challenge.qr });
});

export const cashPoints = wrap(async (req, res) => {
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const service = req.query.service === 'cash_out' || req.query.mode === 'withdraw' ? 'cash_out' : req.query.service === 'cash_in' || req.query.mode === 'deposit' ? 'cash_in' : null;
  const points = await listServicePoints(prisma, { lat: num(req.query.lat), lng: num(req.query.lng), service, amountXof: num(req.query.amount) });
  res.json({ servicePoints: points, agents: points, availability: 'not_live — declared hours only' });
});

// ── Agent ───────────────────────────────────────────────────────────────────

export const agentCashScan = wrap(async (req, res) => {
  const parsed = z.object({ qr: z.string().min(8).max(200) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const row = await scanAndBind(req.userId, parsed.data);
  res.json({ transaction: await cashView(row, 'agent') });
});

export const agentCashComplete = wrap(async (req, res) => {
  const parsed = z.object({ bindingHash: z.string().length(64) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  await assertStepUp(req, 'agent_cash_completion');
  const row = await agentComplete(req.userId, String(req.query.id), parsed.data);
  const v = await cashView(row, 'agent');
  res.json({ transaction: v, receipt: receiptOf(v) });
});

export const agentCashDecline = wrap(async (req, res) => {
  const parsed = z.object({ reason: z.string().max(200).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);
  const row = await agentDecline(req.userId, String(req.query.id), parsed.data);
  res.json({ transaction: await cashView(row, 'agent') });
});

export const agentCashList = wrap(async (req, res) => {
  const { agent } = await requireOperatingAgent(prisma, req.userId);
  const rows = await prisma.agentCashTransaction.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: 'desc' }, take: 30 });
  const out = [];
  for (const r of rows) out.push(await cashView(r, 'agent'));
  res.json({ transactions: out, open: out.filter((t) => ['pending', 'checking'].includes(t.status)) });
});

export const agentCashReport = wrap(async (req, res) => {
  const parsed = z.object({ amountXof: z.number().int().nonnegative(), note: z.string().max(200).optional() }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const row = await reportCashOnHand(req.userId, parsed.data);
  res.status(201).json({ id: row.id, amountXof: row.amountXof, source: 'self_reported', createdAt: row.createdAt.toISOString() });
});

export const agentCommissionsGet = wrap(async (req, res) => {
  const agent = await prisma.agentProfile.findUnique({ where: { userId: req.userId } });
  if (!agent) return res.status(403).json({ error: 'Pas agent', code: 'not_agent' });
  res.json({ summary: await commissionSummary(prisma, agent.id), note: 'Commissions financées par Jokko ; versées sur ton portefeuille quand tu le demandes.' });
});

export const agentCommissionsSettle = wrap(async (req, res) => {
  const key = idemKey(req);
  const out = await settleCommissions(req.userId, { idempotencyKey: key });
  res.status(out.replayed ? 200 : 201).json({ receipt: out });
});

export const agentLifecycleGet = wrap(async (req, res) => {
  const agent = await prisma.agentProfile.findUnique({ where: { userId: req.userId } });
  if (!agent) return res.json({ application: null });
  const sp = agent.servicePointId ? await prisma.agentServicePoint.findUnique({ where: { id: agent.servicePointId } }) : null;
  res.json({ application: { ...lifecycleShape(agent), servicePoint: sp ? { id: sp.id, name: sp.name, publicAddress: sp.publicAddress, status: sp.status } : null } });
});

const spSchema = z.object({
  name: z.string().min(2).max(80),
  publicAddress: z.string().min(5).max(160),
  area: z.string().max(80).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  hours: z.record(z.array(z.array(z.string()))).optional(),
  cashIn: z.boolean().optional(),
  cashOut: z.boolean().optional(),
});

export const agentApplyV2 = wrap(async (req, res) => {
  const parsed = z.object({
    displayName: z.string().min(2).max(80),
    agentType: z.enum(['individual', 'business']).optional(),
    businessId: z.string().optional(),
    servicePoint: spSchema.optional(),
    // legacy body
    locationLabel: z.string().max(160).optional(),
    arrondissement: z.string().max(40).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const agent = await applyAsAgent(req.userId, parsed.data);
  res.status(201).json({ agent: lifecycleShape(agent), message: 'Demande reçue — vérification d’identité puis revue par Jokko. Rien n’est actif avant l’approbation.' });
});

export const agentServicePointPropose = wrap(async (req, res) => {
  const parsed = spSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const sp = await proposeServicePoint(req.userId, parsed.data);
  res.status(201).json({ servicePoint: { id: sp.id, name: sp.name, status: sp.status } });
});

export const agentServicePointUpdate = wrap(async (req, res) => {
  const parsed = z.object({ hours: z.record(z.array(z.array(z.string()))).nullable().optional(), cashIn: z.boolean().optional(), cashOut: z.boolean().optional(), merchantAssist: z.boolean().optional() }).strict().safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const sp = await updateServicePoint(req.userId, String(req.query.id), parsed.data);
  res.json({ servicePoint: { id: sp.id, name: sp.name, status: sp.status, cashIn: sp.cashIn, cashOut: sp.cashOut, merchantAssist: sp.merchantAssist } });
});

// ── Assisted onboarding ─────────────────────────────────────────────────────

export const assistStart = wrap(async (req, res) => {
  const parsed = z.object({ introducerType: z.enum(['distribution_business', 'agent_organization']), introducerId: z.string().min(1), territoryId: z.string().optional(), proposedName: z.string().min(2).max(80), proposedCategory: z.string().max(60).optional() }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  res.status(201).json(await startAssist(req.userId, parsed.data));
});
export const assistMine = wrap(async (req, res) => res.json({ introductions: await listMyAssists(req.userId) }));
const codeSchema = z.object({ code: z.string().min(6).max(20) });
export const assistOpen = wrap(async (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  res.json(await openAssist(req.userId, parsed.data.code));
});
export const assistAccept = wrap(async (req, res) => {
  const parsed = codeSchema.extend({ businessName: z.string().min(2).max(80).optional(), category: z.string().max(60).optional(), confirmAuthority: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  res.status(201).json(await acceptAssist(req.userId, parsed.data.code, parsed.data));
});
export const assistDecline = wrap(async (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  res.json(await declineAssist(req.userId, parsed.data.code));
});

/** Legacy QR session routes (bearer-token cash) are retired: the QR alone could hand cash to whoever held it. */
export function legacyCashRetired(_req, res) {
  res.status(410).json({
    error: 'Ce parcours a été remplacé par le parcours sécurisé (confirmation dans ton application).',
    code: 'cash_flow_retired',
    use: { cashIn: 'POST /api/agent-cash/in', cashOut: 'POST /api/agent-cash/out', agentScan: 'POST /api/agent/cash/scan' },
  });
}
