import { prisma } from '../prisma.js';
import { runMoneyTransaction, lockProjections } from '../wallet-atomic.js';
import { agentCommissionAccrue, agentCommissionClawback, agentCommissionSettle, fundBudget } from '../money-kernel/flows.js';

/**
 * J6.7 — agent commissions are FUNDED liabilities, never minted money.
 *
 *   rule (finance proposes, a different operator activates)
 *     → funding source: platform:agent_commission_budget (treasury-funded, maker/checker)
 *     → accrual: one AgentCommission per completed transaction (txId unique),
 *       posted budget → agent:<id>:commission in the completion transaction
 *     → settlement: agent:<id>:commission → the agent's own wallet (receipt)
 *     → clawback (legitimate, unsettled only): commission → budget
 *
 * The customer fee is separate (0 today, D-J4) and never funds a commission.
 * Agents cannot set or edit rules. No accrual when: no active rule, below the
 * rule minimum, any risk flag on the transaction (pair frequency, circular
 * cash, velocity…), or the budget cannot cover it ('unfunded', 0 posted).
 */
export class CommissionError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'CommissionError';
    this.code = code;
    this.status = status;
  }
}

export function commissionFor(rule, tx) {
  if (!rule) return 0;
  const variable = Math.floor((tx.amountKori * rule.bps) / 10_000);
  const total = rule.flatKori + variable;
  return rule.capKori > 0 ? Math.min(total, rule.capKori) : total;
}

/** Inside the completion transaction. Returns the ₭ accrued (0 if none). */
export async function accrueCommission(tx, row) {
  const existing = await tx.agentCommission.findUnique({ where: { txId: row.id } });
  if (existing) return existing.status === 'accrued' ? existing.amountKori : 0;
  const rule = await tx.agentCommissionRule.findFirst({ where: { purpose: row.kind, status: 'active' }, orderBy: { approvedAt: 'desc' } });
  let ineligible = null;
  if (!rule) ineligible = 'no_active_rule';
  else if (row.amountXof < rule.minAmountXof) ineligible = 'below_minimum';
  else if (row.riskReasons) ineligible = 'risk_flagged';
  const amount = ineligible ? 0 : commissionFor(rule, row);
  if (!ineligible && amount <= 0) ineligible = 'zero_amount';
  if (ineligible) {
    await tx.agentCommission.create({ data: { agentId: row.agentId, txId: row.id, ruleId: rule?.id ?? null, amountKori: 0, status: 'ineligible', ineligibleReason: ineligible } });
    return 0;
  }
  const ref = `${row.reference}-COMM`;
  const posted = await agentCommissionAccrue(tx, { agentId: row.agentId, amountKori: amount, reference: ref, txId: row.id });
  await tx.agentCommission.create({
    data: { agentId: row.agentId, txId: row.id, ruleId: rule.id, amountKori: posted ? amount : 0, status: posted ? 'accrued' : 'unfunded', ineligibleReason: posted ? null : 'budget_insufficient', ledgerReference: posted ? ref : null },
  });
  return posted;
}

/** The agent moves accrued commissions to their own wallet (one posting, a receipt). */
export async function settleCommissions(agentUserId, { idempotencyKey }) {
  if (!idempotencyKey) throw new CommissionError('idempotency_required', 'Clé d’idempotence requise', 400);
  const agent = await prisma.agentProfile.findUnique({ where: { userId: agentUserId } });
  if (!agent) throw new CommissionError('not_agent', 'Pas agent', 403);
  const ref = `ACS-${agent.id}-${String(idempotencyKey).slice(0, 60)}`;
  const wallet = await prisma.wallet.findUnique({ where: { userId: agentUserId }, select: { id: true } });
  return runMoneyTransaction(prisma, async (tx) => {
    await lockProjections(tx, { Wallet: [wallet?.id], AgentProfile: [agent.id] });
    const prior = await tx.journalEntry.findUnique({ where: { reference: ref } });
    if (prior) {
      const rows = await tx.agentCommission.findMany({ where: { settledReference: ref } });
      return { reference: ref, amountKori: rows.reduce((s, r) => s + r.amountKori, 0), count: rows.length, replayed: true };
    }
    const rows = await tx.agentCommission.findMany({ where: { agentId: agent.id, status: 'accrued' } });
    const amount = rows.reduce((s, r) => s + r.amountKori, 0);
    if (amount <= 0) throw new CommissionError('nothing_to_settle', 'Aucune commission à verser', 409);
    await agentCommissionSettle(tx, { agentId: agent.id, agentUserId, amountKori: amount, reference: ref, actor: { type: 'user', id: agentUserId } });
    await tx.agentCommission.updateMany({ where: { id: { in: rows.map((r) => r.id) }, status: 'accrued' }, data: { status: 'settled', settledReference: ref, settledAt: new Date() } });
    await tx.ledgerEntry.create({ data: { walletId: wallet.id, userId: agentUserId, type: 'agent_commission', amount, note: `Commissions agent (${rows.length})`, reference: ref } });
    return { reference: ref, amountKori: amount, count: rows.length };
  });
}

/** Executed by maker-checker approval `agent_commission_clawback`. Unsettled only. */
export async function clawbackCommissionInTx(tx, commissionId, { requestedBy, approvedBy, reason }) {
  await tx.$executeRaw`SELECT id FROM "AgentCommission" WHERE id = ${commissionId} FOR UPDATE`;
  const c = await tx.agentCommission.findUnique({ where: { id: commissionId } });
  if (!c) throw new CommissionError('not_found', 'Commission introuvable', 404);
  if (c.status === 'clawed_back') return c;
  if (c.status !== 'accrued') throw new CommissionError('not_clawable', `Commission ${c.status} — non récupérable ici`);
  const ref = `${c.ledgerReference}-CLAWBACK`;
  await agentCommissionClawback(tx, { agentId: c.agentId, amountKori: c.amountKori, reference: ref, actor: { type: 'admin', id: approvedBy }, reason: `${reason} (maker ${requestedBy})` });
  return tx.agentCommission.update({ where: { id: c.id }, data: { status: 'clawed_back', clawbackReference: ref } });
}

/** Executed by maker-checker approval `agent_commission_rule_activate`: one active rule per purpose. */
export async function activateRuleInTx(tx, ruleId, { approvedBy }) {
  const rule = await tx.agentCommissionRule.findUnique({ where: { id: ruleId } });
  if (!rule) throw new CommissionError('not_found', 'Règle introuvable', 404);
  if (rule.status === 'active') return rule;
  if (rule.status !== 'proposed') throw new CommissionError('not_proposed', 'Règle non proposée');
  if (approvedBy === rule.createdBy) throw new CommissionError('same_operator', 'Le créateur de la règle ne l’active pas', 403);
  await tx.agentCommissionRule.updateMany({ where: { purpose: rule.purpose, status: 'active' }, data: { status: 'retired', retiredAt: new Date() } });
  return tx.agentCommissionRule.update({ where: { id: rule.id }, data: { status: 'active', approvedBy, approvedAt: new Date() } });
}

export async function proposeRule(adminId, { purpose, bps = 0, flatKori = 0, minAmountXof = 0, capKori = 0 }) {
  if (!['cash_in', 'cash_out'].includes(purpose)) throw new CommissionError('invalid_purpose', 'purpose: cash_in | cash_out', 400);
  for (const [k, v] of Object.entries({ bps, flatKori, minAmountXof, capKori })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new CommissionError('invalid_rule', `${k} invalide`, 400);
  }
  if (bps > 200) throw new CommissionError('invalid_rule', 'bps ≤ 200 (2 %)', 400);
  return prisma.agentCommissionRule.create({ data: { purpose, bps, flatKori, minAmountXof, capKori, createdBy: adminId } });
}

/** Executed by maker-checker approval `agent_commission_budget_fund` (real treasury money). */
export async function fundCommissionBudgetInTx(tx, { amountKori, approvalId, approvedBy }) {
  return fundBudget(tx, { budget: 'agentCommissionBudget', amountKori, reference: `approval:${approvalId}`, adminId: approvedBy });
}

export async function commissionSummary(db, agentId) {
  const groups = await db.agentCommission.groupBy({ by: ['status'], where: { agentId }, _sum: { amountKori: true }, _count: true });
  const by = Object.fromEntries(groups.map((g) => [g.status, { amountKori: g._sum.amountKori ?? 0, count: g._count }]));
  return { accrued: by.accrued ?? { amountKori: 0, count: 0 }, settled: by.settled ?? { amountKori: 0, count: 0 }, unfunded: by.unfunded ?? { amountKori: 0, count: 0 }, ineligible: by.ineligible ?? { amountKori: 0, count: 0 }, clawedBack: by.clawed_back ?? { amountKori: 0, count: 0 } };
}
