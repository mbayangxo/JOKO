import crypto from 'crypto';
import { prisma } from '../prisma.js';
import { AdminAuthzError, adminCan } from './admin-authz.js';
import { recordIdentityEvent } from '../identity/audit.js';

/**
 * Generic maker-checker for high-risk operator actions
 * (docs/JOKKO-J3-DESIGN.md §9). A request is created by one operator holding
 * `requestPermission`, and executed only when a DIFFERENT operator holding
 * `approvePermission` approves it. The database refuses self-approval, payload
 * changes and re-deciding (prisma/sql/identity-guards.sql).
 *
 * Executors must be idempotent on `approval:{id}` so a retried approval never
 * acts twice.
 */
const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

export const APPROVAL_ACTIONS = {
  admin_role_grant: {
    requestPermission: 'admin.roles.manage',
    approvePermission: 'admin.roles.manage',
    validate: (p, requestedBy) => {
      if (!p?.adminUserId || !p?.role) throw new AdminAuthzError('invalid_payload', 'adminUserId and role are required', 400);
      if (p.adminUserId === requestedBy) throw new AdminAuthzError('self_grant', 'An operator cannot request a role for themself');
    },
    execute: async (tx, p, ctx) => {
      if (p.adminUserId === ctx.approvedBy) throw new AdminAuthzError('self_grant', 'An operator cannot approve a role for themself');
      const { grantAdminRole } = await import('./admin-authz.js');
      return grantAdminRole(tx, { adminUserId: p.adminUserId, role: p.role, grantedBy: ctx.requestedBy, approvedBy: ctx.approvedBy, reason: ctx.reason });
    },
  },
  user_unfreeze: {
    requestPermission: 'users.unfreeze.request',
    approvePermission: 'users.unfreeze.approve',
    validate: (p) => {
      if (!p?.userId) throw new AdminAuthzError('invalid_payload', 'userId is required', 400);
    },
    execute: async (tx, p, ctx) => {
      const user = await tx.user.findUnique({ where: { id: p.userId }, select: { id: true, frozenByAdminAt: true } });
      if (!user) throw new AdminAuthzError('user_not_found', 'User not found', 404);
      await tx.user.update({ where: { id: p.userId }, data: { frozenByAdminAt: null, adminFreezeReason: null } });
      await recordIdentityEvent(tx, {
        actorType: 'admin',
        actorId: ctx.approvedBy,
        action: 'user_unfrozen',
        subjectType: 'user',
        subjectId: p.userId,
        reason: ctx.reason,
        before: { frozen: Boolean(user.frozenByAdminAt) },
        after: { frozen: false, requestedBy: ctx.requestedBy, approvedBy: ctx.approvedBy },
      });
      return { userId: p.userId, frozen: false };
    },
  },
  agent_float_topup: {
    requestPermission: 'finance.agent_float',
    approvePermission: 'finance.agent_float.approve',
    validate: (p) => {
      if (!p?.agentId || !Number.isSafeInteger(p?.amountXof) || p.amountXof <= 0) {
        throw new AdminAuthzError('invalid_payload', 'agentId and a positive integer amountXof are required', 400);
      }
    },
    executeOutsideTx: true,
    execute: async (_tx, p, ctx) => {
      const { topUpAgentFloat } = await import('../agent-service.js');
      return topUpAgentFloat(p.agentId, p.amountXof, ctx.approvedBy, p.note ?? 'Recharge (double validation)', { reference: `approval:${ctx.id}` });
    },
  },
  // ── J6 cash network ──────────────────────────────────────────────────────
  agent_activation: {
    requestPermission: 'agents.onboard',
    approvePermission: 'agents.activate',
    validate: (p) => {
      if (!p?.agentId) throw new AdminAuthzError('invalid_payload', 'agentId is required', 400);
    },
    execute: async (tx, p, ctx) => {
      const { activateAgentInTx, lifecycleShape } = await import('../agents/lifecycle.js');
      return lifecycleShape(await activateAgentInTx(tx, p.agentId, { activatedBy: ctx.approvedBy, requestedBy: ctx.requestedBy, reason: ctx.reason }));
    },
  },
  agent_cash_resolve: {
    requestPermission: 'risk.held.decide',
    approvePermission: 'finance.adjust.approve',
    validate: (p) => {
      if (!p?.txId || !['release', 'complete'].includes(p?.outcome)) throw new AdminAuthzError('invalid_payload', 'txId and outcome (release | complete) are required', 400);
    },
    executeOutsideTx: true,
    execute: async (db, p, ctx) => {
      const { runMoneyTransaction } = await import('../wallet-atomic.js');
      const { resolveReviewInTx } = await import('../agents/cash.js');
      const row = await runMoneyTransaction(db, (tx) => resolveReviewInTx(tx, p.txId, { outcome: p.outcome, requestedBy: ctx.requestedBy, approvedBy: ctx.approvedBy, approvalId: ctx.id }));
      return { txId: row.id, state: row.state };
    },
  },
  agent_commission_rule_activate: {
    requestPermission: 'finance.commission.propose',
    approvePermission: 'finance.commission.approve',
    validate: (p) => {
      if (!p?.ruleId) throw new AdminAuthzError('invalid_payload', 'ruleId is required', 400);
    },
    execute: async (tx, p, ctx) => {
      const { activateRuleInTx } = await import('../agents/commission.js');
      const r = await activateRuleInTx(tx, p.ruleId, { approvedBy: ctx.approvedBy });
      return { ruleId: r.id, status: r.status };
    },
  },
  agent_commission_budget_fund: {
    requestPermission: 'finance.adjust.request',
    approvePermission: 'finance.adjust.approve',
    validate: (p) => {
      if (!Number.isSafeInteger(p?.amountKori) || p.amountKori <= 0 || p.amountKori > 10_000_000) throw new AdminAuthzError('invalid_payload', 'amountKori: positive integer ≤ 10 000 000', 400);
    },
    executeOutsideTx: true,
    execute: async (db, p, ctx) => {
      const { runMoneyTransaction } = await import('../wallet-atomic.js');
      const { fundCommissionBudgetInTx } = await import('../agents/commission.js');
      await runMoneyTransaction(db, (tx) => fundCommissionBudgetInTx(tx, { amountKori: p.amountKori, approvalId: ctx.id, approvedBy: ctx.approvedBy }));
      return { funded: p.amountKori };
    },
  },
  agent_commission_clawback: {
    requestPermission: 'risk.held.decide',
    approvePermission: 'finance.adjust.approve',
    validate: (p) => {
      if (!p?.commissionId) throw new AdminAuthzError('invalid_payload', 'commissionId is required', 400);
    },
    executeOutsideTx: true,
    execute: async (db, p, ctx) => {
      const { runMoneyTransaction } = await import('../wallet-atomic.js');
      const { clawbackCommissionInTx } = await import('../agents/commission.js');
      const c = await runMoneyTransaction(db, (tx) => clawbackCommissionInTx(tx, p.commissionId, { requestedBy: ctx.requestedBy, approvedBy: ctx.approvedBy, reason: ctx.reason }));
      return { commissionId: c.id, status: c.status };
    },
  },
  // ── J8 logistics ─────────────────────────────────────────────────────────
  shipment_earning_reverse: {
    requestPermission: 'logistics.disputes.resolve',
    approvePermission: 'logistics.disputes.reverse',
    validate: (p) => {
      if (!p?.disputeId) throw new AdminAuthzError('invalid_payload', 'disputeId is required', 400);
    },
    executeOutsideTx: true,
    execute: async (db, p, ctx) => {
      const { executeEarningReversal } = await import('../logistics/disputes.js');
      return executeEarningReversal(db, p, ctx);
    },
  },
  /** J9: the money consequence of a work-dispute ruling — a second (finance) operator executes it once. */
  work_dispute_settle: {
    requestPermission: 'work.disputes.resolve',
    approvePermission: 'work.disputes.settle',
    validate: (p) => {
      if (!p?.disputeId) throw new AdminAuthzError('invalid_payload', 'disputeId is required', 400);
    },
    executeOutsideTx: true,
    execute: async (db, p, ctx) => {
      const { executeDisputeSettlement } = await import('../work/disputes.js');
      return executeDisputeSettlement(db, p, ctx);
    },
  },
  support_refund: {
    requestPermission: 'finance.refund',
    approvePermission: 'finance.refund.approve',
    validate: (p) => {
      if (!p?.recipientUserId || !Number.isSafeInteger(p?.amount) || p.amount <= 0) {
        throw new AdminAuthzError('invalid_payload', 'recipientUserId and a positive integer amount are required', 400);
      }
    },
    executeOutsideTx: true,
    execute: async (_tx, p, ctx) => {
      const { issueAdminRefund } = await import('../admin-actions-service.js');
      return issueAdminRefund(ctx.approvedBy, {
        recipientUserId: p.recipientUserId,
        amount: p.amount,
        reason: ctx.reason,
        originalRef: p.originalRef,
        reference: `approval:${ctx.id}`,
        dualAuthorization: { requestedBy: ctx.requestedBy, approvedBy: ctx.approvedBy },
      });
    },
  },
};

function canonical(payload) {
  const sort = (v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
      : v;
  return JSON.stringify(sort(payload ?? {}));
}

export async function requestApproval(db, req, { action, payload, reason, caseRef }) {
  const def = APPROVAL_ACTIONS[action];
  if (!def) throw new AdminAuthzError('unknown_action', `Unknown approval action ${action}`, 400);
  if (!adminCan(req, def.requestPermission)) {
    throw new AdminAuthzError('permission_denied', `Missing operator permission: ${def.requestPermission}`);
  }
  if (!reason || String(reason).trim().length < 10) throw new AdminAuthzError('reason_required', 'A reason (≥ 10 characters) is required', 400);
  def.validate(payload, req.adminId);
  const payloadJson = canonical(payload);
  const payloadHash = crypto.createHash('sha256').update(`${action}:${payloadJson}`).digest('hex');
  const pending = await db.adminApproval.findFirst({ where: { action, payloadHash, status: 'requested', expiresAt: { gt: new Date() } } });
  if (pending) return pending;
  const row = await db.adminApproval.create({
    data: {
      action,
      payloadJson,
      payloadHash,
      reason: String(reason).slice(0, 500),
      caseRef: caseRef ? String(caseRef).slice(0, 120) : null,
      requestedBy: req.adminId,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    },
  });
  await recordIdentityEvent(db, {
    actorType: 'admin',
    actorId: req.adminId,
    action: 'approval_requested',
    subjectType: 'approval',
    subjectId: row.id,
    reason,
    caseRef,
    after: { action },
  });
  return row;
}

/** Approve and execute. The approver must differ from the requester and hold the approve permission. */
export async function approveApproval(db, req, approvalId) {
  const row = await db.adminApproval.findUnique({ where: { id: approvalId } });
  if (!row) throw new AdminAuthzError('not_found', 'Approval not found', 404);
  const def = APPROVAL_ACTIONS[row.action];
  if (!def) throw new AdminAuthzError('unknown_action', `Unknown approval action ${row.action}`, 400);
  if (!adminCan(req, def.approvePermission)) {
    throw new AdminAuthzError('permission_denied', `Missing operator permission: ${def.approvePermission}`);
  }
  if (row.status === 'executed') return row;
  if (row.status !== 'requested') throw new AdminAuthzError('not_pending', `Approval is ${row.status}`, 409);
  if (row.expiresAt <= new Date()) {
    await db.adminApproval.updateMany({ where: { id: row.id, status: 'requested' }, data: { status: 'expired', decidedAt: new Date() } });
    throw new AdminAuthzError('expired', 'Approval request expired', 409);
  }
  if (row.requestedBy === req.adminId) {
    throw new AdminAuthzError('dual_authorization', 'A second, different operator must approve');
  }
  const payload = JSON.parse(row.payloadJson);
  const ctx = { id: row.id, requestedBy: row.requestedBy, approvedBy: req.adminId, reason: row.reason };

  const finish = async (tx, result) => {
    const done = await tx.adminApproval.updateMany({
      where: { id: row.id, status: 'requested' },
      data: { status: 'executed', decidedBy: req.adminId, decidedAt: new Date(), resultJson: JSON.stringify(result ?? null).slice(0, 4000) },
    });
    if (done.count === 0) throw new AdminAuthzError('not_pending', 'Approval was decided concurrently', 409);
    await recordIdentityEvent(tx, {
      actorType: 'admin',
      actorId: req.adminId,
      action: 'approval_executed',
      subjectType: 'approval',
      subjectId: row.id,
      reason: row.reason,
      caseRef: row.caseRef,
      after: { action: row.action, requestedBy: row.requestedBy, approvedBy: req.adminId },
    });
    return tx.adminApproval.findUnique({ where: { id: row.id } });
  };

  if (def.executeOutsideTx) {
    // Money executors run their own atomic money transaction, idempotent on approval:{id}.
    const result = await def.execute(db, payload, ctx);
    return db.$transaction((tx) => finish(tx, result));
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "AdminApproval" WHERE id = ${row.id} FOR UPDATE`;
    const result = await def.execute(tx, payload, ctx);
    return finish(tx, result);
  });
}

export async function rejectApproval(db, req, approvalId, reason) {
  const row = await db.adminApproval.findUnique({ where: { id: approvalId } });
  if (!row) throw new AdminAuthzError('not_found', 'Approval not found', 404);
  const def = APPROVAL_ACTIONS[row.action];
  if (!adminCan(req, def?.approvePermission) && row.requestedBy !== req.adminId) {
    throw new AdminAuthzError('permission_denied', 'Only an approver or the requester may reject');
  }
  const r = await db.adminApproval.updateMany({
    where: { id: row.id, status: 'requested' },
    data: { status: 'rejected', decidedBy: req.adminId, decidedAt: new Date(), resultJson: JSON.stringify({ reason: reason ?? null }) },
  });
  if (r.count === 0) throw new AdminAuthzError('not_pending', 'Approval is not pending', 409);
  await recordIdentityEvent(db, {
    actorType: 'admin',
    actorId: req.adminId,
    action: 'approval_rejected',
    subjectType: 'approval',
    subjectId: row.id,
    reason,
  });
  return db.adminApproval.findUnique({ where: { id: row.id } });
}

export function approvalShape(a) {
  return {
    id: a.id,
    action: a.action,
    payload: JSON.parse(a.payloadJson),
    reason: a.reason,
    caseRef: a.caseRef,
    status: a.status,
    requestedBy: a.requestedBy,
    decidedBy: a.decidedBy,
    createdAt: a.createdAt.toISOString(),
    decidedAt: a.decidedAt?.toISOString() ?? null,
    expiresAt: a.expiresAt.toISOString(),
  };
}
