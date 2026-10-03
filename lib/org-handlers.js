import { z } from 'zod';
import { koriToNational } from './kori.js';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import {
  handleOrgAccessError,
  requireBusinessAdmin,
  requireBusinessCapability,
  requireBusinessFinance,
  requireBusinessMember,
  requireBusinessPay,
  requireCommunityAffiliate,
} from './business-access.js';
import { BUSINESS_ROLE_LEVEL, OWNER_ONLY_GRANTS } from './authz/catalog.js';
import { recordIdentityEvent } from './identity/audit.js';
import {
  addPayrollEmployee,
  createPayrollGroup,
  listPayrollEmployees,
  listPayrollGroups,
  payEmployee,
  payEmployeeByHandle,
  runScheduledPayroll,
} from './payroll-service.js';
import {
  createFeePeriod,
  enrollStudent,
  feePeriodStatus,
  listFeePeriods,
  listStudents,
  parentPayFee,
  sendFeeRemindersForAdmin,
} from './school-service.js';
import {
  listDeliveries,
  logDelivery,
  payoutFarmerDeliveries,
  syncOfflineDeliveries,
  verifyDelivery,
} from './cooperative-service.js';
import {
  businessLedgerShape,
  businessWalletShape,
  ensureBusinessWallet,
  getBusinessCreditSummary,
  isMoneyError,
  moneyErrorStatus,
  runMoneyTransaction,
  transferBusinessToBusiness,
  transferBusinessToPersonal,
  transferPersonalToBusiness,
} from './business-wallet-service.js';
import { gateOrExecute } from './risk-gate.js';
import { assertStepUpForAmount } from './step-up.js';
import { createInAppNotification, notifyMoneyReceived } from './notify-service.js';
import {
  blockUser,
  listBlocks,
  submitReport,
  unblockUser,
} from './trust-safety-service.js';
import { clientErrorMessage } from './log-redact.js';

function businessIdFromReq(req) {
  return String(req.query.id ?? req.query.businessId ?? '');
}

export async function businessesMine(req, res) {
  const owned = await prisma.business.findMany({
    where: { ownerId: req.userId },
    orderBy: { name: 'asc' },
  });
  const memberOf = await prisma.businessMember.findMany({
    where: { userId: req.userId, status: 'active', business: { ownerId: { not: req.userId } } },
    include: { business: true },
  });
  res.json({
    owned,
    member: memberOf.map((m) => ({ ...m.business, memberRole: m.role })),
  });
}

export async function businessDetail(req, res) {
  const id = businessIdFromReq(req);
  try {
    await requireBusinessMember(req.userId, id);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
  const business = await prisma.business.findUnique({
    where: { id },
    include: {
      wallet: true,
      members: { include: { user: { select: { id: true, name: true, handle: true, avatarEmoji: true } } } },
      _count: { select: { payrollEmployees: true, schoolStudents: true, products: true } },
    },
  });
  if (!business) {
    res.status(404).json({ error: 'Business not found' });
    return;
  }
  if (!business.wallet) {
    await ensureBusinessWallet(business.id, prisma);
    business.wallet = await prisma.businessWallet.findUnique({ where: { businessId: business.id } });
  }
  res.json({
    ...business,
    wallet: business.wallet ? businessWalletShape(business.wallet, business) : null,
  });
}

/**
 * Business status — the same idea as a personal statusText, but for the
 * place itself: a restaurant announcing a promo, a university confirming
 * "on recrute / inscriptions ouvertes", a shop noting a closure. Owner/admin
 * only; shown on the business's public storefront (marketplace shop view).
 */
export async function businessStatusUpdate(req, res) {
  const id = businessIdFromReq(req);
  try {
    await requireBusinessAdmin(req.userId, id);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
  const schema = z.object({ statusText: z.string().max(80).optional().nullable() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const statusText = parsed.data.statusText ? parsed.data.statusText.trim() || null : null;
  const business = await prisma.business.update({ where: { id }, data: { statusText } });
  res.json({ ok: true, statusText: business.statusText });
}

const COMMUNITY_STATUS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Community status — a status posted by someone linked to the business
 * rather than the business itself: a student whose K21 Pass Étudiant points
 * here, or a staff member. Works like a WhatsApp/Instagram status, not a
 * permanent bio line: one active post per person, gone after 24h.
 */
export async function businessCommunityStatusUpdate(req, res) {
  const id = businessIdFromReq(req);
  try {
    await requireCommunityAffiliate(req.userId, id);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
  const schema = z.object({ statusText: z.string().max(80).optional().nullable() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const text = parsed.data.statusText ? parsed.data.statusText.trim() : '';
  if (!text) {
    await prisma.businessCommunityStatus.deleteMany({ where: { businessId: id, userId: req.userId } });
    res.json({ ok: true, statusText: null });
    return;
  }
  const expiresAt = new Date(Date.now() + COMMUNITY_STATUS_TTL_MS);
  const row = await prisma.businessCommunityStatus.upsert({
    where: { businessId_userId: { businessId: id, userId: req.userId } },
    create: { businessId: id, userId: req.userId, text, expiresAt },
    update: { text, expiresAt },
  });
  res.json({ ok: true, statusText: row.text, expiresAt: row.expiresAt.toISOString() });
}

export async function payrollGroupsHandler(req, res) {
  const businessId = businessIdFromReq(req);
  try {
    if (req.method === 'GET') {
      await requireBusinessMember(req.userId, businessId);
      res.json(await listPayrollGroups(businessId));
      return;
    }
    await requireBusinessAdmin(req.userId, businessId);
    const schema = z.object({ name: z.string().min(1), defaultPayAmount: z.number().int().positive().optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const group = await createPayrollGroup(businessId, parsed.data);
    res.status(201).json(group);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
}

export async function payrollEmployeesHandler(req, res) {
  const businessId = businessIdFromReq(req);
  try {
    if (req.method === 'GET') {
      await requireBusinessMember(req.userId, businessId);
      res.json(await listPayrollEmployees(businessId));
      return;
    }
    await requireBusinessAdmin(req.userId, businessId);
    const schema = z.object({
      userHandle: z.string().min(3),
      userId: z.string().optional(),
      groupId: z.string().optional(),
      groupName: z.string().optional(),
      jobTitle: z.string().optional(),
      payAmount: z.number().int().positive().optional(),
      paySchedule: z.enum(['manual', 'weekly', 'biweekly', 'monthly']).optional(),
      payDayOfWeek: z.number().int().min(0).max(6).optional(),
      payDayOfMonth: z.number().int().min(1).max(28).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const employee = await addPayrollEmployee(businessId, parsed.data);
    res.status(201).json(employee);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    if (error.message) {
      res.status(404).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function payrollPayHandler(req, res) {
  const businessId = businessIdFromReq(req);
  const schema = z.object({
    employeeId: z.string().optional(),
    employeeHandle: z.string().optional(),
    amount: z.number().int().positive().optional(),
    note: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  if (!parsed.data.employeeId && !parsed.data.employeeHandle) {
    res.status(400).json({ error: 'employeeId or employeeHandle required' });
    return;
  }

  try {
    const outcome = parsed.data.employeeId
      ? await payEmployee({ req, res, businessId, ...parsed.data, employeeId: parsed.data.employeeId })
      : await payEmployeeByHandle({ req, res, businessId, ...parsed.data, employeeHandle: parsed.data.employeeHandle });
    if (outcome.held) return;
    res.status(201).json(outcome.result);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    if (isMoneyError(error)) {
      res.status(moneyErrorStatus(error)).json({ error: error.message });
      return;
    }
    if (error.message) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function payrollRunHandler(req, res) {
  const businessId = businessIdFromReq(req);
  const schema = z.object({ groupId: z.string().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const results = await runScheduledPayroll(businessId, { ...parsed.data, req, res });
    res.status(201).json({ runs: results });
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
}

export async function schoolStudentsHandler(req, res) {
  const businessId = businessIdFromReq(req);
  try {
    if (req.method === 'GET') {
      await requireBusinessMember(req.userId, businessId);
      res.json(await listStudents(businessId));
      return;
    }
    await requireBusinessAdmin(req.userId, businessId);
    const schema = z.object({
      studentName: z.string().min(2),
      parentHandle: z.string().optional(),
      parentUserId: z.string().optional(),
      gradeLabel: z.string().optional(),
      externalId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    if (!parsed.data.parentHandle && !parsed.data.parentUserId) {
      res.status(400).json({ error: 'parentHandle or parentUserId required' });
      return;
    }
    const student = await enrollStudent(businessId, parsed.data);
    res.status(201).json(student);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    if (error.message) {
      res.status(404).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function schoolPeriodsHandler(req, res) {
  const businessId = businessIdFromReq(req);
  try {
    if (req.method === 'GET') {
      await requireBusinessMember(req.userId, businessId);
      res.json(await listFeePeriods(businessId));
      return;
    }
    await requireBusinessAdmin(req.userId, businessId);
    const schema = z.object({
      label: z.string().min(2),
      amount: z.number().int().positive(),
      dueDate: z.string(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const period = await createFeePeriod(businessId, parsed.data);
    res.status(201).json(period);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
}

export async function schoolPeriodStatusHandler(req, res) {
  const businessId = businessIdFromReq(req);
  const periodId = String(req.query.subId ?? '');
  try {
    await requireBusinessMember(req.userId, businessId);
    res.json(await feePeriodStatus(businessId, periodId));
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    if (error.message) {
      res.status(404).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function schoolPayHandler(req, res) {
  const businessId = businessIdFromReq(req);
  const schema = z.object({ studentId: z.string(), periodId: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const gate = await parentPayFee({ req, res, businessId, ...parsed.data });
    if (gate.held) return;
    res.status(201).json(gate.result);
  } catch (error) {
    if (isMoneyError(error)) {
      res.status(moneyErrorStatus(error)).json({ error: error.message });
      return;
    }
    if (error.message) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function schoolRemindHandler(req, res) {
  const businessId = businessIdFromReq(req);
  const periodId = String(req.body?.periodId ?? req.query.subId ?? '');
  if (!periodId) {
    res.status(400).json({ error: 'periodId required' });
    return;
  }
  try {
    const result = await sendFeeRemindersForAdmin(req.userId, businessId, periodId);
    res.json(result);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
}

export async function cooperativeDeliveriesHandler(req, res) {
  const businessId = businessIdFromReq(req);
  try {
    if (req.method === 'GET') {
      await requireBusinessMember(req.userId, businessId);
      const status = req.query.status ? String(req.query.status) : undefined;
      const farmerUserId = req.query.farmerUserId ? String(req.query.farmerUserId) : undefined;
      res.json(await listDeliveries(businessId, { status, farmerUserId }));
      return;
    }
    const schema = z.object({
      farmerUserId: z.string().optional(),
      farmerHandle: z.string().optional(),
      quantityTons: z.number().positive(),
      periodStart: z.string(),
      periodEnd: z.string(),
      note: z.string().optional(),
      offlineClientId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    if (!parsed.data.farmerUserId && !parsed.data.farmerHandle) {
      res.status(400).json({ error: 'farmerUserId or farmerHandle required' });
      return;
    }
    let farmerUserId = parsed.data.farmerUserId;
    if (!farmerUserId && parsed.data.farmerHandle) {
      const handle = parsed.data.farmerHandle.replace(/^@/, '').toLowerCase();
      const farmer = await prisma.user.findUnique({ where: { handle } });
      if (!farmer) {
        res.status(404).json({ error: 'Paysan introuvable sur K21' });
        return;
      }
      farmerUserId = farmer.id;
    }
    const log = await logDelivery({
      businessId,
      loggedByUserId: req.userId,
      ...parsed.data,
      farmerUserId,
    });
    res.status(201).json(log);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
}

export async function cooperativeVerifyHandler(req, res) {
  const businessId = businessIdFromReq(req);
  const deliveryId = String(req.query.subId ?? '');
  const schema = z.object({ approved: z.boolean(), note: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const log = await verifyDelivery({
      businessId,
      deliveryId,
      verifierUserId: req.userId,
      ...parsed.data,
    });
    res.json(log);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    if (error.message) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function cooperativePayoutHandler(req, res) {
  const businessId = businessIdFromReq(req);
  const schema = z.object({
    farmerUserId: z.string(),
    deliveryIds: z.array(z.string()).optional(),
    ratePerTonXof: z.number().int().positive().optional(),
    note: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const outcome = await payoutFarmerDeliveries({ req, res, businessId, ...parsed.data });
    if (outcome.held) return;
    res.status(201).json(outcome);
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    if (isMoneyError(error)) {
      res.status(moneyErrorStatus(error)).json({ error: error.message });
      return;
    }
    if (error.message) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function offlineSyncHandler(req, res) {
  const schema = z.object({
    items: z.array(
      z.object({
        clientId: z.string().min(8).max(100),
        entityType: z.string().max(40).optional(),
        payload: z.record(z.unknown()),
      }),
    ).max(100),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const results = await syncOfflineDeliveries(req.userId, parsed.data.items);
  res.json({ synced: results });
}

export async function trustBlockHandler(req, res) {
  if (req.method === 'GET') {
    res.json(await listBlocks(req.userId));
    return;
  }

  const schema = z.object({
    blockedUserId: z.string().optional(),
    blockedBusinessId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const block = await blockUser(req.userId, parsed.data);
    res.status(201).json(block);
  } catch (error) {
    res.status(400).json({ error: clientErrorMessage(error) });
  }
}

export async function trustUnblockHandler(req, res) {
  const blockId = String(req.query.id ?? '');
  try {
    res.json(await unblockUser(req.userId, blockId));
  } catch (error) {
    res.status(404).json({ error: clientErrorMessage(error) });
  }
}

export async function trustReportHandler(req, res) {
  const schema = z.object({
    targetUserId: z.string().optional(),
    targetBusinessId: z.string().optional(),
    category: z.enum(['scam', 'harassment', 'fake_merchant', 'fake_event', 'other']),
    reason: z.string().min(10).max(2000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const report = await submitReport(req.userId, parsed.data);
    res.status(201).json(report);
  } catch (error) {
    res.status(400).json({ error: clientErrorMessage(error) });
  }
}

const MEMBER_ROLES = Object.keys(BUSINESS_ROLE_LEVEL);

function memberShape(m) {
  return {
    id: m.id,
    businessId: m.businessId,
    userId: m.userId,
    role: m.role,
    status: m.status,
    invitedAt: m.invitedAt?.toISOString() ?? null,
    acceptedAt: m.acceptedAt?.toISOString() ?? null,
    removedAt: m.removedAt?.toISOString() ?? null,
    user: m.user ? { id: m.user.id, name: m.user.name, handle: m.user.handle, avatarEmoji: m.user.avatarEmoji } : undefined,
  };
}

/** Highest authority level the actor holds on the business (owner = 5). */
async function actorLevel(userId, business) {
  if (business.ownerId === userId) return BUSINESS_ROLE_LEVEL.owner;
  const rows = await prisma.businessMember.findMany({ where: { businessId: business.id, userId, status: 'active' } });
  return Math.max(-1, ...rows.map((r) => BUSINESS_ROLE_LEVEL[r.role] ?? -1));
}

/**
 * GET: active members (any active member). POST: INVITE a person — the
 * membership has no authority until the invitee accepts. Only the owner may
 * grant owner/admin/cfo/ceo; nobody may grant a role above their own level.
 */
export async function businessMembersHandler(req, res) {
  const businessId = businessIdFromReq(req);
  try {
    if (req.method === 'GET') {
      await requireBusinessMember(req.userId, businessId);
      const members = await prisma.businessMember.findMany({
        where: { businessId, status: { in: ['active', 'invited'] } },
        include: { user: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
        orderBy: { createdAt: 'asc' },
      });
      res.json(members.map(memberShape));
      return;
    }

    await requireBusinessCapability(req.userId, businessId, 'business.members.manage');
    const schema = z.object({
      userHandle: z.string().min(3),
      role: z.enum(MEMBER_ROLES).default('staff'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    const level = await actorLevel(req.userId, business);
    const role = parsed.data.role;
    if (OWNER_ONLY_GRANTS.has(role) && business.ownerId !== req.userId) {
      res.status(403).json({ error: 'Seul le propriétaire peut attribuer ce rôle.', code: 'owner_only_role' });
      return;
    }
    if ((BUSINESS_ROLE_LEVEL[role] ?? 99) > level) {
      res.status(403).json({ error: 'Tu ne peux pas attribuer un rôle supérieur au tien.', code: 'role_above_actor' });
      return;
    }

    const handle = parsed.data.userHandle.replace(/^@/, '').toLowerCase();
    const user = await prisma.user.findFirst({ where: { handle } });
    if (!user) {
      res.status(404).json({ error: 'Utilisateur K21 introuvable pour ce @handle' });
      return;
    }
    if (business.ownerId === user.id) {
      res.status(400).json({ error: 'Le propriétaire a déjà tous les droits' });
      return;
    }

    const existing = await prisma.businessMember.findUnique({
      where: { businessId_userId_role: { businessId, userId: user.id, role } },
    });
    if (existing?.status === 'active' || existing?.status === 'invited') {
      res.status(200).json(memberShape(existing));
      return;
    }
    const now = new Date();
    const member = await prisma.$transaction(async (tx) => {
      const m = existing
        ? await tx.businessMember.update({
            where: { id: existing.id },
            data: { status: 'invited', invitedBy: req.userId, invitedAt: now, acceptedAt: null, removedAt: null, removedBy: null, removedReason: null },
            include: { user: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
          })
        : await tx.businessMember.create({
            data: { businessId, userId: user.id, role, status: 'invited', invitedBy: req.userId, invitedAt: now },
            include: { user: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
          });
      await recordIdentityEvent(tx, {
        actorType: 'user',
        actorId: req.userId,
        action: 'business_member_invited',
        subjectType: 'business',
        subjectId: businessId,
        after: { memberId: m.id, userId: user.id, role },
      });
      return m;
    });
    await createInAppNotification(user.id, 'Invitation équipe', `${business.name} t'invite comme « ${role} ». Accepte depuis tes invitations.`, {
      kind: 'business_invitation',
      refId: member.id,
    }).catch(() => {});
    res.status(201).json(memberShape(member));
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
}

export async function businessInvitationsMine(req, res) {
  const rows = await prisma.businessMember.findMany({
    where: { userId: req.userId, status: 'invited' },
    include: { business: { select: { id: true, name: true, type: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(rows.map((m) => ({ ...memberShape(m), business: m.business })));
}

/** The invitee (and only the invitee) accepts. */
export async function businessMemberAccept(req, res) {
  const businessId = businessIdFromReq(req);
  const memberId = String(req.query.subId ?? '');
  const now = new Date();
  const r = await prisma.businessMember.updateMany({
    where: { id: memberId, businessId, userId: req.userId, status: 'invited' },
    data: { status: 'active', acceptedAt: now },
  });
  if (r.count === 0) {
    res.status(404).json({ error: 'Invitation introuvable' });
    return;
  }
  await recordIdentityEvent(prisma, {
    actorType: 'user',
    actorId: req.userId,
    action: 'business_member_accepted',
    subjectType: 'business',
    subjectId: businessId,
    after: { memberId },
  });
  const m = await prisma.businessMember.findUnique({ where: { id: memberId } });
  res.json(memberShape(m));
}

/**
 * Remove a member (or leave). Immediate: authority checks require
 * status 'active'. The row is kept (status 'removed') so history stays
 * attributable. Only someone at or above the member's level may remove them.
 */
export async function businessMemberRemove(req, res) {
  const businessId = businessIdFromReq(req);
  const memberId = String(req.query.subId ?? '');
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : null;
  try {
    const member = await prisma.businessMember.findFirst({ where: { id: memberId, businessId } });
    if (!member || member.status === 'removed') {
      res.status(404).json({ error: 'Membre introuvable' });
      return;
    }
    const selfLeave = member.userId === req.userId;
    if (!selfLeave) {
      await requireBusinessCapability(req.userId, businessId, 'business.members.manage');
      const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
      const level = await actorLevel(req.userId, business);
      if ((BUSINESS_ROLE_LEVEL[member.role] ?? 99) > level || (OWNER_ONLY_GRANTS.has(member.role) && business.ownerId !== req.userId)) {
        res.status(403).json({ error: 'Tu ne peux pas retirer un membre de rang supérieur.', code: 'role_above_actor' });
        return;
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.businessMember.update({
        where: { id: member.id },
        data: { status: 'removed', removedAt: new Date(), removedBy: req.userId, removedReason: reason },
      });
      await recordIdentityEvent(tx, {
        actorType: 'user',
        actorId: req.userId,
        action: selfLeave ? 'business_member_left' : 'business_member_removed',
        subjectType: 'business',
        subjectId: businessId,
        reason,
        before: { memberId: member.id, userId: member.userId, role: member.role, status: member.status },
        after: { status: 'removed' },
      });
    });
    res.json({ ok: true, memberId: member.id, status: 'removed' });
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
}

export async function businessWalletHandler(req, res) {
  const businessId = businessIdFromReq(req);
  try {
    await requireBusinessMember(req.userId, businessId);
    const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    const wallet = await ensureBusinessWallet(businessId, prisma);
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const ledger = await prisma.businessLedgerEntry.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({
      wallet: businessWalletShape(wallet, business),
      ledger: ledger.map(businessLedgerShape),
    });
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    throw error;
  }
}

export async function businessCreditSummaryHandler(req, res) {
  const businessId = businessIdFromReq(req);
  try {
    await requireBusinessMember(req.userId, businessId);
    res.json(await getBusinessCreditSummary(businessId));
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    if (error.message) {
      res.status(404).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function businessTransferHandler(req, res) {
  const businessId = businessIdFromReq(req);
  const schema = z.object({
    kind: z.enum(['capital_in', 'owner_draw', 'b2b']),
    amount: z.number().int().positive(),
    note: z.string().max(200).optional(),
    recipientBusinessId: z.string().optional(),
    recipientKebuId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { kind, amount: amountKori, note, recipientBusinessId, recipientKebuId } = parsed.data;

  try {
    const business = await requireBusinessFinance(req.userId, businessId);
    const businessWallet = await ensureBusinessWallet(businessId, prisma);
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const amountNational = koriToNational(amountKori, actor.country);
    await assertStepUpForAmount(req, amountNational);

    if (kind === 'capital_in') {
      if (business.ownerId !== req.userId) {
        res.status(403).json({ error: 'Seul le propriétaire peut alimenter le compte KEBU depuis son AFRI' });
        return;
      }
      const userWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: req.userId } });
      const gate = await gateOrExecute(
        req,
        res,
        {
          operationType: 'kebu_capital_in',
          amountNational,
          payload: { businessId, amount: amountKori },
        },
        async (ref) =>
          runMoneyTransaction(prisma, (db) =>
            transferPersonalToBusiness(db, {
              amount: amountKori,
              userWalletId: userWallet.id,
              userId: req.userId,
              businessWalletId: businessWallet.id,
              businessId,
              reference: ref,
              businessName: business.name,
              note,
            }),
          ),
      );
      if (gate.held) return;
      res.status(201).json({ ok: true, kind, amount: amountKori, reference: gate.result?.reference });
      return;
    }

    if (kind === 'owner_draw') {
      if (business.ownerId !== req.userId) {
        res.status(403).json({ error: 'Seul le propriétaire peut retirer vers son wallet AFRI' });
        return;
      }
      const userWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: req.userId } });
      const gate = await gateOrExecute(
        req,
        res,
        {
          operationType: 'kebu_owner_draw',
          amountNational,
          payload: { businessId, amount: amountKori },
        },
        async (ref) =>
          runMoneyTransaction(prisma, (db) =>
            transferBusinessToPersonal(db, {
              amount: amountKori,
              businessWalletId: businessWallet.id,
              businessId,
              userWalletId: userWallet.id,
              userId: req.userId,
              reference: ref,
              businessName: business.name,
              note,
              actingUserId: req.userId,
            }),
          ),
      );
      if (gate.held) return;
      res.status(201).json({ ok: true, kind, amount: amountKori, reference: gate.result?.reference });
      return;
    }

    // b2b
    let recipient = null;
    if (recipientBusinessId) {
      recipient = await prisma.business.findUnique({ where: { id: recipientBusinessId } });
    } else if (recipientKebuId) {
      recipient = await prisma.business.findUnique({ where: { kebuId: recipientKebuId } });
    }
    if (!recipient) {
      res.status(404).json({ error: 'Commerce destinataire introuvable (KEBU ID ou business id)' });
      return;
    }
    if (recipient.id === businessId) {
      res.status(400).json({ error: 'Impossible de payer son propre commerce' });
      return;
    }
    const recipientWallet = await ensureBusinessWallet(recipient.id, prisma);

    const gate = await gateOrExecute(
      req,
      res,
      {
        operationType: 'b2b_pay',
        amountNational,
        payload: { fromBusinessId: businessId, toBusinessId: recipient.id, amount: amountKori },
      },
      async (ref) =>
        runMoneyTransaction(prisma, (db) =>
          transferBusinessToBusiness(db, {
            amount: amountKori,
            senderWalletId: businessWallet.id,
            senderBusinessId: businessId,
            recipientWalletId: recipientWallet.id,
            recipientBusinessId: recipient.id,
            reference: ref,
            actingUserId: req.userId,
            senderLedger: {
              type: 'b2b_out',
              counterpartyName: recipient.name,
              counterpartyKebuId: recipient.kebuId,
              note,
            },
            recipientLedger: {
              type: 'b2b_in',
              counterpartyName: business.name,
              counterpartyKebuId: business.kebuId,
              note,
            },
          }),
        ),
    );
    if (gate.held) return;

    await notifyMoneyReceived(recipient.ownerId, {
      amount: amountKori,
      currency: 'kori',
      senderLabel: business.name,
    });

    res.status(201).json({
      ok: true,
      kind: 'b2b',
      amount: amountKori,
      recipient: { id: recipient.id, name: recipient.name, kebuId: recipient.kebuId },
      reference: gate.result?.reference,
    });
  } catch (error) {
    if (handleOrgAccessError(res, error)) return;
    if (isMoneyError(error)) {
      res.status(moneyErrorStatus(error)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}
