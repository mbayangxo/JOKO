import { z } from 'zod';
import { prisma } from './prisma.js';
import { logAdminAction } from './admin-audit.js';
import { AdminAuthzError, adminCan } from './authz/admin-authz.js';
import { approvalShape, requestApproval } from './authz/approvals.js';
import { LIMITS } from './authz/catalog.js';
import jwt from 'jsonwebtoken';
import {
  beginTotpSetup,
  bootstrapAdmin,
  confirmTotpSetup,
  getAdminFromBearer,
  loginAdmin,
  revokeAdminSession,
  verifyAdminTotp,
} from './admin-auth.js';
import {
  acknowledgeFraudAlert,
  adminApproveHeld,
  adminRejectHeld,
  AdminActionError,
  freezeUserAccount,
  getSupportTicketDetail,
  issueAdminRefund,
  releaseStuckRail,
  respondSupportTicket,
  unfreezeUserAccount,
  updateSupportTicketStatus,
} from './admin-actions-service.js';
import { getAdminDashboard, getTransactionDetail, listDailyReports } from './admin-dashboard-service.js';
import { listFraudAlerts, listHeldTransactions } from './held-transaction-service.js';
import {
  AgentError,
  agentErrorStatus,
  approveAgentProfile,
  createAgentProfile,
  getAgentReconciliation,
  listAgents,
  rejectAgentProfile,
  topUpAgentFloat,
  patchAgentProfile,
  listFloatTopUpRequests,
  approveFloatTopUpRequest,
  rejectFloatTopUpRequest,
} from './agent-service.js';
import {
  adminApproveAddress,
  adminApproveKycJob,
  adminRejectKycJob,
  getAdminDistributorDetail,
  getAdminUserDetail,
  getOpsHealthOverview,
  getSupportOpsStats,
  listAdminAuditLogs,
  listAdminDistributors,
  listKycReviewQueue,
  listSupportCalls,
  logSupportCall,
  searchAdminUsers,
  updateAdminDistributor,
} from './admin-ops-service.js';

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket?.remoteAddress ?? null;
}

/** Authentication only; authorization (permissions) is enforced centrally by lib/authz/enforce.js. */
export function assertAdminAccess(req, res) {
  if (req.adminId) return true;
  res.status(401).json({ error: 'Admin authorization required' });
  return false;
}

export async function adminAuthBootstrap(req, res) {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(12),
    name: z.string().optional(),
    bootstrapSecret: z.string().min(8),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  try {
    const admin = await bootstrapAdmin(parsed.data);
    res.status(201).json({ admin, message: 'Admin created. Log in and set up 2FA.' });
  } catch (error) {
    if (error.code === 'admin_exists') return res.status(409).json({ error: error.message });
    if (error.code === 'bootstrap_denied') return res.status(403).json({ error: error.message });
    throw error;
  }
}

export async function adminAuthLogin(req, res) {
  const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const result = await loginAdmin({
      ...parsed.data,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.json(result);
  } catch (error) {
    if (error.code === 'invalid_credentials') return res.status(401).json({ error: 'Invalid credentials' });
    throw error;
  }
}

export async function adminAuthSetup2fa(req, res) {
  const schema = z.object({ challengeToken: z.string().min(10) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const setup = await beginTotpSetup(parsed.data.challengeToken);
    res.json(setup);
  } catch (error) {
    if (error.code === 'challenge_expired') return res.status(401).json({ error: error.message });
    throw error;
  }
}

export async function adminAuthConfirm2fa(req, res) {
  const schema = z.object({ challengeToken: z.string().min(10), code: z.string().length(6) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const session = await confirmTotpSetup(parsed.data.challengeToken, parsed.data.code, {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.json({ ...session, totpEnabled: true });
  } catch (error) {
    if (error.code === 'challenge_expired' || error.code === 'invalid_totp') {
      return res.status(401).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminAuthVerify2fa(req, res) {
  const schema = z.object({ challengeToken: z.string().min(10), code: z.string().length(6) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const session = await verifyAdminTotp(parsed.data.challengeToken, parsed.data.code, {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.json(session);
  } catch (error) {
    if (error.code === 'challenge_expired' || error.code === 'invalid_totp') {
      return res.status(401).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminAuthLogout(req, res) {
  const auth = await getAdminFromBearer(req.headers.authorization);
  if (auth) {
    const token = req.headers.authorization.slice(7);
    try {
      const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET || 'dev-only-k21-admin-jwt-secret-min-32-chars!!');
      if (payload.sid) await revokeAdminSession(payload.sid);
    } catch {
      /* ignore */
    }
  }
  res.json({ ok: true });
}

export async function adminDashboard(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const data = await getAdminDashboard();
  res.json(data);
}

export async function adminTransactionDetail(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const id = req.query.id;
  const detail = await getTransactionDetail(id);
  if (!detail) return res.status(404).json({ error: 'Transaction not found' });
  res.json(detail);
}

export async function adminHeldTransactionsList(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const status = req.query.status ?? 'pending_review';
  const items = await listHeldTransactions({ status: String(status) });
  res.json(
    items.map((h) => ({
      id: h.id,
      userId: h.userId,
      operationType: h.operationType,
      status: h.status,
      amountNational: h.amountNational,
      flags: JSON.parse(h.flagsJson),
      reference: h.reference,
      expiresAt: h.expiresAt.toISOString(),
      createdAt: h.createdAt.toISOString(),
      alerts: h.fraudAlerts,
    })),
  );
}

export async function adminHeldTransactionApprove(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({ note: z.string().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const result = await adminApproveHeld(req.adminId, req.query.id, parsed.data.note);
    res.json(result);
  } catch (error) {
    if (error instanceof AdminActionError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminHeldTransactionReject(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({ reason: z.string().min(3) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const held = await adminRejectHeld(req.adminId, req.query.id, parsed.data.reason);
    res.json(held);
  } catch (error) {
    if (error instanceof AdminActionError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminFraudAlerts(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const alerts = await listFraudAlerts({ unacknowledgedOnly: true });
  res.json(alerts);
}

export async function adminFraudAlertAck(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const alert = await acknowledgeFraudAlert(req.adminId, req.query.id);
  res.json(alert);
}

export async function adminFreezeUser(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({ reason: z.string().min(3) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const result = await freezeUserAccount(req.adminId, req.query.id, parsed.data.reason);
    res.json(result);
  } catch (error) {
    if (error instanceof AdminActionError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

/**
 * Unfreezing is a high-risk identity decision (a freeze is often fraud
 * containment): it is a maker-checker request, executed only when a second
 * operator with users.unfreeze.approve approves (POST admin/approvals/:id/approve).
 */
export async function adminUnfreezeUser(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const parsed = z.object({ reason: z.string().min(10).max(500), caseRef: z.string().max(120).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', code: 'reason_required' });
  try {
    const approval = await requestApproval(prisma, req, {
      action: 'user_unfreeze',
      payload: { userId: String(req.query.id ?? req.params?.id) },
      reason: parsed.data.reason,
      caseRef: parsed.data.caseRef,
    });
    res.status(202).json({ approval: approvalShape(approval), message: 'Second approval required (maker-checker).' });
  } catch (error) {
    if (error instanceof AdminAuthzError) return res.status(error.status).json({ error: error.message, code: error.code });
    throw error;
  }
}

export async function adminReleaseRail(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({
    action: z.enum(['complete', 'failed', 'poll']),
    note: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const status = parsed.data.action === 'complete' ? 'completed' : parsed.data.action;
    const rail = await releaseStuckRail(req.adminId, req.query.id, {
      action: status,
      note: parsed.data.note,
    });
    res.json(rail);
  } catch (error) {
    if (error instanceof AdminActionError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminIssueRefund(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({
    recipientUserId: z.string().min(1),
    amount: z.number().int().positive(),
    reason: z.string().min(3),
    originalRef: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  if (parsed.data.amount > LIMITS.refundSingleMaxKori()) {
    try {
      const approval = await requestApproval(prisma, req, {
        action: 'support_refund',
        payload: { recipientUserId: parsed.data.recipientUserId, amount: parsed.data.amount, originalRef: parsed.data.originalRef ?? null },
        reason: parsed.data.reason,
      });
      return res.status(202).json({ approval: approvalShape(approval), message: 'Above the single-operator limit — second approval required.' });
    } catch (error) {
      if (error instanceof AdminAuthzError) return res.status(error.status).json({ error: error.message, code: error.code });
      throw error;
    }
  }
  try {
    const refund = await issueAdminRefund(req.adminId, parsed.data);
    res.status(201).json(refund);
  } catch (error) {
    if (error instanceof AdminActionError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminSupportTicketsList(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const status = req.query.status;
  const where = status ? { status: String(status) } : {};
  const { prisma } = await import('./prisma.js');
  const rows = await prisma.supportTicket.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: {
      user: { select: { id: true, phone: true, name: true, handle: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  res.json(rows);
}

export async function adminSupportTicketGet(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const ticket = await getSupportTicketDetail(req.query.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json(ticket);
}

export async function adminSupportTicketReply(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({ body: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const message = await respondSupportTicket(req.adminId, req.query.id, parsed.data.body);
    res.status(201).json(message);
  } catch (error) {
    if (error instanceof AdminActionError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminSupportTicketPatch(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({ status: z.enum(['open', 'pending', 'resolved', 'closed']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  const ticket = await updateSupportTicketStatus(req.adminId, req.query.id, parsed.data.status);
  res.json(ticket);
}

export async function adminDailyReports(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const reports = await listDailyReports({ date: req.query.date });
  res.json(reports);
}

export async function adminDailyReportExport(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const reports = await listDailyReports({ date: req.query.date, limit: 1 });
  if (!reports.length) return res.status(404).json({ error: 'No report for date' });

  const report = reports[0];
  const format = req.query.format ?? 'json';
  if (format === 'csv') {
    const flat = report.report;
    const lines = ['key,value', ...Object.entries(flat).map(([k, v]) => `${k},"${JSON.stringify(v).replace(/"/g, '""')}"`)];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="k21-daily-${req.query.date ?? 'latest'}.csv"`);
    return res.send(lines.join('\n'));
  }
  res.setHeader('Content-Disposition', `attachment; filename="k21-daily-${req.query.date ?? 'latest'}.json"`);
  res.json(report);
}

export async function adminAgentsList(req, res) {
  if (!assertAdminAccess(req, res)) return;
  res.json({ agents: await listAgents() });
}

export async function adminAgentsCreate(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({
    userId: z.string().min(1),
    displayName: z.string().min(2).max(80).optional(),
    locationLabel: z.string().max(120).optional(),
    floatLimit: z.number().int().positive().optional(),
    initialFloat: z.number().int().nonnegative().optional(),
    tier: z.enum(['standard', 'business']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  // J3 separation of duties: onboarding (compliance) never moves money.
  // Float is a separate finance action (admin/agents/:id/float).
  if (parsed.data.initialFloat) {
    return res.status(400).json({ error: 'Float is added separately by finance (POST admin/agents/:id/float).', code: 'initial_float_not_allowed' });
  }

  try {
    const agent = await createAgentProfile({
      ...parsed.data,
      adminId: req.adminId,
    });
    res.status(201).json({ agent });
  } catch (error) {
    if (error instanceof AgentError) {
      return res.status(agentErrorStatus(error)).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminAgentsFloat(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({
    amountXof: z.number().int().positive(),
    note: z.string().max(200).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  if (parsed.data.amountXof > LIMITS.agentFloatSingleMaxXof()) {
    try {
      const approval = await requestApproval(prisma, req, {
        action: 'agent_float_topup',
        payload: { agentId: String(req.query.id ?? req.params?.id), amountXof: parsed.data.amountXof, note: parsed.data.note ?? null },
        reason: parsed.data.note ?? '',
      });
      return res.status(202).json({ approval: approvalShape(approval), message: 'Above the single-operator limit — second approval required.' });
    } catch (error) {
      if (error instanceof AdminAuthzError) return res.status(error.status).json({ error: error.message, code: error.code });
      throw error;
    }
  }
  try {
    const result = await topUpAgentFloat(req.query.id ?? req.params?.id, parsed.data.amountXof, req.adminId, parsed.data.note);
    res.json(result);
  } catch (error) {
    if (error instanceof AgentError) {
      return res.status(agentErrorStatus(error)).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminAgentsApprove(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({ note: z.string().max(200).optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const agent = await approveAgentProfile(req.query.id ?? req.params?.id, req.adminId, parsed.data.note);
    res.json({ agent });
  } catch (error) {
    if (error instanceof AgentError) {
      return res.status(agentErrorStatus(error)).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminAgentsReject(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({ reason: z.string().min(3).max(300) });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const agent = await rejectAgentProfile(req.query.id ?? req.params?.id, req.adminId, parsed.data.reason);
    res.json({ agent });
  } catch (error) {
    if (error instanceof AgentError) {
      return res.status(agentErrorStatus(error)).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminAgentFloatRequestsList(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const status = req.query.status !== undefined ? String(req.query.status) || null : 'pending';
  res.json({ requests: await listFloatTopUpRequests(status) });
}

export async function adminAgentFloatRequestApprove(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({ note: z.string().max(200).optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  const pending = await prisma.agentFloatTopUpRequest.findUnique({ where: { id: String(req.query.id ?? req.params?.id) } });
  if (pending && pending.amountXof > LIMITS.agentFloatSingleMaxXof()) {
    return res.status(409).json({
      error: 'Above the single-operator limit — use POST admin/agents/:id/float (maker-checker).',
      code: 'dual_authorization_required',
    });
  }
  try {
    const request = await approveFloatTopUpRequest(req.query.id ?? req.params?.id, req.adminId, parsed.data.note);
    res.json({ request });
  } catch (error) {
    if (error instanceof AgentError) {
      return res.status(agentErrorStatus(error)).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminAgentFloatRequestReject(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({ reason: z.string().max(300).optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const request = await rejectFloatTopUpRequest(req.query.id ?? req.params?.id, req.adminId, parsed.data.reason);
    res.json({ request });
  } catch (error) {
    if (error instanceof AgentError) {
      return res.status(agentErrorStatus(error)).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

export async function adminAgentsReconcile(req, res) {
  if (!assertAdminAccess(req, res)) return;
  res.json(await getAgentReconciliation());
}

export async function adminUsersSearch(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const users = await searchAdminUsers(prisma, { q: req.query.q, sensitive: adminCan(req, 'users.read.sensitive') });
  res.json({ users });
}

export async function adminUserDetail(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const user = await getAdminUserDetail(prisma, String(req.query.id ?? ''), {
    sensitive: adminCan(req, 'users.read.sensitive'),
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
}

export async function adminKycQueue(req, res) {
  if (!assertAdminAccess(req, res)) return;
  res.json(await listKycReviewQueue(prisma));
}

export async function adminKycApprove(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const jobId = String(req.query.id ?? '');
  if (!jobId) return res.status(400).json({ error: 'id required' });
  try {
    res.json(await adminApproveKycJob(req.adminId, jobId));
  } catch (error) {
    if (error instanceof AdminActionError) return res.status(error.status).json({ error: error.message, code: error.code });
    throw error;
  }
}

export async function adminKycReject(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const jobId = String(req.query.id ?? '');
  const schema = z.object({ reason: z.string().min(3).max(300) });
  const parsed = schema.safeParse(req.body ?? {});
  if (!jobId || !parsed.success) return res.status(400).json({ error: 'Validation failed' });
  try {
    res.json(await adminRejectKycJob(req.adminId, jobId, parsed.data.reason));
  } catch (error) {
    if (error instanceof AdminActionError) return res.status(error.status).json({ error: error.message, code: error.code });
    throw error;
  }
}

export async function adminKycAddressApprove(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const userId = String(req.query.userId ?? req.body?.userId ?? '');
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    res.json(await adminApproveAddress(req.adminId, userId));
  } catch (error) {
    if (error instanceof AdminActionError) return res.status(error.status).json({ error: error.message, code: error.code });
    throw error;
  }
}

export async function adminDistributorsList(req, res) {
  if (!assertAdminAccess(req, res)) return;
  res.json({ distributors: await listAdminDistributors(prisma) });
}

export async function adminDistributorDetail(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const detail = await getAdminDistributorDetail(prisma, String(req.query.id ?? ''));
  if (!detail) return res.status(404).json({ error: 'Distributor not found' });
  res.json(detail);
}

export async function adminDistributorPatch(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({
    pauseOrders: z.boolean().optional(),
    distributionEnabled: z.boolean().optional(),
    verified: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  const id = String(req.query.id ?? '');
  if (!parsed.success || !id) return res.status(400).json({ error: 'Validation failed' });
  try {
    const updated = await updateAdminDistributor(req.adminId, id, parsed.data);
    res.json({ id: updated.id, pauseOrders: updated.pauseOrders, distributionEnabled: updated.distributionEnabled, verified: updated.verified });
  } catch (error) {
    if (error instanceof AdminActionError) return res.status(error.status).json({ error: error.message, code: error.code });
    throw error;
  }
}

export async function adminSupportStats(req, res) {
  if (!assertAdminAccess(req, res)) return;
  res.json(await getSupportOpsStats(prisma));
}

export async function adminSupportCallsList(req, res) {
  if (!assertAdminAccess(req, res)) return;
  res.json({ calls: await listSupportCalls(prisma) });
}

export async function adminSupportCallLog(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({
    phone: z.string().min(6).max(24),
    userId: z.string().optional(),
    ticketId: z.string().optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    durationSec: z.number().int().min(0).optional(),
    outcome: z.string().max(80).optional(),
    note: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  res.status(201).json(await logSupportCall(req.adminId, parsed.data));
}

export async function adminOpsHealth(req, res) {
  if (!assertAdminAccess(req, res)) return;
  res.json(await getOpsHealthOverview(prisma));
}

export async function adminAuditLogs(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const limit = req.query.limit != null ? Number(req.query.limit) : 80;
  const action = req.query.action ? String(req.query.action) : undefined;
  const logs = await listAdminAuditLogs(prisma, { limit, action });
  res.json({ logs });
}

export async function adminAgentsPatch(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({
    tier: z.enum(['standard', 'business']).optional(),
    maxWithdrawXof: z.number().int().positive().optional(),
    maxDepositXof: z.number().int().positive().optional(),
    floatLimit: z.number().int().positive().optional(),
    // J3: status is not patchable — activation is approve (agents.onboard),
    // deactivation is suspend/reject. Patch adjusts limits only.
  }).strict();
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  try {
    const agent = await patchAgentProfile(req.query.id ?? req.params?.id, parsed.data);
    res.json({ agent });
  } catch (error) {
    if (error instanceof AgentError) {
      return res.status(agentErrorStatus(error)).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

/**
 * POST /api/admin/users/:id/credentials/invalidate
 * Treat this account's PIN/password as compromised: invalidate them, revoke
 * sessions, require re-establishment after a fresh OTP login. Audited.
 */
export async function adminInvalidateCredentials(req, res) {
  if (!assertAdminAccess(req, res)) return;
  const schema = z.object({
    reason: z.string().min(5).max(200),
    classification: z.enum(['A', 'B']).optional(),
    revokeSessions: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  const { markCredentialsCompromised } = await import('./credential-remediation.js');
  const summary = await markCredentialsCompromised([req.query.id], {
    ...parsed.data,
    actorType: 'admin',
    actorId: req.adminId,
  });
  if (!summary.found) return res.status(404).json({ error: 'User not found' });
  await logAdminAction(req.adminId, 'invalidate_credentials', {
    targetType: 'user',
    targetId: req.query.id,
    detail: { classification: parsed.data.classification ?? null, revokeSessions: parsed.data.revokeSessions },
  }).catch(() => {});
  res.json({ ok: true, summary });
}
