import { prisma } from './prisma.js';
import { logAdminAction } from './admin-audit.js';
import { completeCniVerification, KycError } from './kyc-service.js';
import { formatKori } from './kori.js';
import { getSupplierReceivables } from './trade-service.js';
import { getCustomerServiceContact } from './support-service.js';
import { AdminActionError } from './admin-actions-service.js';

const maskPhone = (p) => (p ? (p.startsWith('e:') ? null : `${p.slice(0, 4)}•••${p.slice(-2)}`) : null);
const maskEmail = (e) => (e ? `${e[0]}•••@${e.split('@')[1] ?? ''}` : null);

export async function searchAdminUsers(db, { q, limit = 30, sensitive = false }) {
  const query = String(q ?? '').trim();
  if (query.length < 2) return [];

  const or = [
    { phone: { contains: query.replace(/\s/g, '') } },
    { handle: { contains: query.replace(/^@/, ''), mode: 'insensitive' } },
    { name: { contains: query, mode: 'insensitive' } },
  ];
  if (query.length >= 8) or.push({ id: query });

  const rows = await db.user.findMany({
    where: { OR: or },
    take: Math.min(limit, 50),
    orderBy: { createdAt: 'desc' },
    include: {
      wallet: { select: { koriBalance: true, balance: true } },
      _count: { select: { supportTickets: true, fraudAlerts: true } },
    },
  });

  return rows.map((u) => ({
    id: u.id,
    phone: sensitive ? u.phone : maskPhone(u.phone),
    name: u.name,
    handle: u.handle,
    verificationTier: u.verificationTier,
    verificationStatus: u.verificationStatus,
    frozen: Boolean(u.frozenByAdminAt),
    koriBalance: sensitive ? u.wallet?.koriBalance ?? 0 : undefined,
    koriFormatted: sensitive ? formatKori(u.wallet?.koriBalance ?? 0) : undefined,
    ticketCount: u._count.supportTickets,
    fraudAlertCount: u._count.fraudAlerts,
    createdAt: u.createdAt.toISOString(),
  }));
}


/**
 * Operator view of one user. J3 minimum-necessary disclosure: support sees a
 * masked contact, verification state, freeze state and tickets; balances,
 * fraud alerts, full contact details and KYC outcomes need
 * `users.read.sensitive` (risk / compliance). Never hashes or documents.
 */
export async function getAdminUserDetail(db, userId, { sensitive = false } = {}) {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: {
      wallet: true,
      cniVerificationJobs: { orderBy: { createdAt: 'desc' }, take: 5 },
      supportTickets: { orderBy: { updatedAt: 'desc' }, take: 10 },
      fraudAlerts: { orderBy: { createdAt: 'desc' }, take: 10 },
      ownedBusinesses: { select: { id: true, name: true, type: true, kebuId: true, distributionEnabled: true } },
    },
  });
  if (!user) return null;

  const base = {
    id: user.id,
    phone: sensitive ? user.phone : maskPhone(user.phone),
    name: user.name,
    handle: user.handle,
    email: sensitive ? user.email : maskEmail(user.email),
    verificationTier: user.verificationTier,
    verificationStatus: user.verificationStatus,
    cniVerifiedAt: user.cniVerifiedAt?.toISOString() ?? null,
    addressVerifiedAt: user.addressVerifiedAt?.toISOString() ?? null,
    frozen: Boolean(user.frozenByAdminAt),
    freezeReason: user.adminFreezeReason,
    wallet: user.wallet
      ? { koriBalance: user.wallet.koriBalance, balance: user.wallet.balance }
      : null,
    businesses: user.ownedBusinesses,
    kycJobs: user.cniVerificationJobs.map((j) => ({
      id: j.id,
      status: j.status,
      provider: j.provider,
      submittedAt: j.submittedAt.toISOString(),
      failureReason: j.failureReason,
    })),
    tickets: user.supportTickets.map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      channel: t.channel,
      updatedAt: t.updatedAt.toISOString(),
    })),
    fraudAlerts: user.fraudAlerts.map((a) => ({
      id: a.id,
      code: a.code,
      message: a.message,
      createdAt: a.createdAt.toISOString(),
    })),
    createdAt: user.createdAt.toISOString(),
  };
  if (!sensitive) {
    delete base.wallet;
    delete base.fraudAlerts;
    delete base.freezeReason;
    base.kycJobs = base.kycJobs.map(({ failureReason, ...j }) => j);
  }
  base.disclosure = sensitive ? 'sensitive' : 'support_minimal';
  return base;
}

export async function listKycReviewQueue(db) {
  const [pendingJobs, addressPending] = await Promise.all([
    db.cniVerificationJob.findMany({
      where: { status: 'pending' },
      orderBy: { submittedAt: 'asc' },
      take: 100,
      include: {
        user: { select: { id: true, phone: true, name: true, handle: true, verificationStatus: true } },
      },
    }),
    db.user.findMany({
      where: { verificationStatus: 'address_pending' },
      orderBy: { updatedAt: 'asc' },
      take: 50,
      select: {
        id: true,
        phone: true,
        name: true,
        handle: true,
        verificationStatus: true,
        arrondissementName: true,
        updatedAt: true,
      },
    }),
  ]);

  return {
    cniJobs: pendingJobs.map((j) => ({
      id: j.id,
      userId: j.userId,
      user: j.user,
      provider: j.provider,
      submittedAt: j.submittedAt.toISOString(),
    })),
    addressReviews: addressPending.map((u) => ({
      userId: u.id,
      phone: u.phone,
      name: u.name,
      handle: u.handle,
      arrondissement: u.arrondissementName,
      submittedAt: u.updatedAt.toISOString(),
    })),
  };
}

export async function adminApproveKycJob(adminId, jobId) {
  try {
    const job = await prisma.cniVerificationJob.findUnique({
      where: { id: jobId },
      include: { user: true },
    });
    if (!job) throw new AdminActionError('not_found', 'Job not found', 404);

    await completeCniVerification(jobId, {
      approved: true,
      legalName: job.user.name ?? job.user.handle ?? 'Utilisateur K21',
    });

    await logAdminAction(adminId, 'kyc_approve', { targetType: 'cni_job', targetId: jobId, detail: { userId: job.userId } });
    return { jobId, status: 'approved' };
  } catch (err) {
    if (err instanceof KycError) throw new AdminActionError(err.code ?? 'kyc_error', err.message, 400);
    throw err;
  }
}

export async function adminRejectKycJob(adminId, jobId, reason) {
  try {
    await completeCniVerification(jobId, { approved: false, reason: reason ?? 'Refusé par l’équipe K21' });
    await logAdminAction(adminId, 'kyc_reject', { targetType: 'cni_job', targetId: jobId, detail: { reason } });
    return { jobId, status: 'rejected' };
  } catch (err) {
    if (err instanceof KycError) throw new AdminActionError(err.code ?? 'kyc_error', err.message, 400);
    throw err;
  }
}

export async function adminApproveAddress(adminId, userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AdminActionError('not_found', 'User not found', 404);
  if (user.verificationStatus !== 'address_pending') {
    throw new AdminActionError('invalid_state', 'Not awaiting address review');
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      verificationTier: 3,
      verificationStatus: 'fully_verified',
      addressVerifiedAt: new Date(),
    },
  });

  await logAdminAction(adminId, 'kyc_address_approve', { targetType: 'user', targetId: userId });
  return { userId, verificationTier: 3, status: 'fully_verified' };
}

export async function listAdminDistributors(db) {
  const rows = await db.business.findMany({
    where: { OR: [{ distributionEnabled: true }, { type: 'brand' }] },
    orderBy: { name: 'asc' },
    take: 200,
    include: {
      owner: { select: { id: true, phone: true, name: true, handle: true } },
      wallet: { select: { balance: true } },
      _count: {
        select: { products: true, orders: true, tradeAccountsSupplied: true },
      },
    },
  });

  const enriched = await Promise.all(
    rows.map(async (b) => {
      const [openInvoices, receivables] = await Promise.all([
        db.tradeInvoice.aggregate({
          where: { supplierBusinessId: b.id, status: { in: ['open', 'partial'] } },
          _sum: { amountKori: true, amountPaid: true, creditedKori: true },
          _count: true,
        }),
        getSupplierReceivables(db, { supplierBusinessId: b.id, ownerId: b.ownerId }).catch(() => null),
      ]);
      const openBalance =
        (openInvoices._sum.amountKori ?? 0) - (openInvoices._sum.amountPaid ?? 0) - (openInvoices._sum.creditedKori ?? 0);

      return {
        id: b.id,
        name: b.name,
        type: b.type,
        kebuId: b.kebuId,
        distributionEnabled: b.distributionEnabled,
        pauseOrders: b.pauseOrders,
        verified: b.verified,
        owner: b.owner,
        kebuBalance: b.wallet?.balance ?? 0,
        kebuFormatted: formatKori(b.wallet?.balance ?? 0),
        productCount: b._count.products,
        orderCount: b._count.orders,
        tradeClientCount: b._count.tradeAccountsSupplied,
        openInvoiceCount: openInvoices._count ?? 0,
        openInvoiceBalance: openBalance,
        openInvoiceFormatted: formatKori(openBalance),
        totalReceivable: receivables?.totalReceivable ?? openBalance,
        totalReceivableFormatted: receivables?.totalReceivableFormatted ?? formatKori(openBalance),
        createdAt: b.createdAt.toISOString(),
      };
    }),
  );

  return enriched;
}

export async function getAdminDistributorDetail(db, businessId) {
  const business = await db.business.findUnique({
    where: { id: businessId },
    include: {
      owner: { select: { id: true, phone: true, name: true, handle: true } },
      wallet: true,
      products: { where: { active: true }, take: 20, orderBy: { title: 'asc' } },
      tradeAccountsSupplied: {
        take: 30,
        include: { buyer: { select: { id: true, name: true, handle: true } } },
      },
    },
  });
  if (!business) return null;
  if (!business.distributionEnabled && business.type !== 'brand') return null;

  const receivables = await getSupplierReceivables(db, {
    supplierBusinessId: businessId,
    ownerId: business.ownerId,
  }).catch(() => null);

  return {
    id: business.id,
    name: business.name,
    type: business.type,
    kebuId: business.kebuId,
    pauseOrders: business.pauseOrders,
    distributionEnabled: business.distributionEnabled,
    owner: business.owner,
    kebuBalance: business.wallet?.balance ?? 0,
    products: business.products.map((p) => ({
      id: p.id,
      title: p.title,
      price: p.price,
      b2bPrice: p.b2bPrice,
      saleChannel: p.saleChannel,
    })),
    tradeClients: business.tradeAccountsSupplied.map((a) => ({
      id: a.id,
      buyer: a.buyer,
      paymentTerm: a.paymentTerm,
      creditLimitKori: a.creditLimitKori,
      codEnabled: a.codEnabled,
    })),
    receivables,
  };
}

export async function updateAdminDistributor(adminId, businessId, { pauseOrders, distributionEnabled, verified }) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new AdminActionError('not_found', 'Business not found', 404);

  const data = {};
  if (pauseOrders != null) data.pauseOrders = pauseOrders;
  if (distributionEnabled != null) data.distributionEnabled = distributionEnabled;
  if (verified != null) data.verified = verified;

  const updated = await prisma.business.update({ where: { id: businessId }, data });
  await logAdminAction(adminId, 'distributor_update', {
    targetType: 'business',
    targetId: businessId,
    detail: data,
  });
  return updated;
}

export async function getSupportOpsStats(db) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [open, pending, resolvedToday, resolvedWeek, callsToday, callsWeek, avgResolve] = await Promise.all([
    db.supportTicket.count({ where: { status: 'open' } }),
    db.supportTicket.count({ where: { status: 'pending' } }),
    db.supportTicket.count({ where: { status: { in: ['resolved', 'closed'] }, resolvedAt: { gte: today } } }),
    db.supportTicket.count({
      where: {
        status: { in: ['resolved', 'closed'] },
        resolvedAt: { gte: new Date(Date.now() - 7 * 86400000) },
      },
    }),
    db.supportCallLog.count({ where: { createdAt: { gte: today } } }),
    db.supportCallLog.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86400000) } } }),
    db.$queryRaw`
      SELECT AVG(EXTRACT(EPOCH FROM ("resolvedAt" - "createdAt")) / 3600.0)::float AS hours
      FROM "SupportTicket"
      WHERE "resolvedAt" IS NOT NULL AND "createdAt" > NOW() - INTERVAL '30 days'
    `,
  ]);

  const avgHours = avgResolve?.[0]?.hours != null ? Math.round(Number(avgResolve[0].hours) * 10) / 10 : null;

  return {
    tickets: { open, pending, resolvedToday, resolvedWeek, avgResolutionHours: avgHours },
    calls: { today: callsToday, week: callsWeek },
    contact: getCustomerServiceContact(),
  };
}

export async function logSupportCall(adminId, payload) {
  const row = await prisma.supportCallLog.create({
    data: {
      phone: payload.phone,
      userId: payload.userId ?? null,
      ticketId: payload.ticketId ?? null,
      adminUserId: adminId,
      direction: payload.direction ?? 'inbound',
      durationSec: payload.durationSec ?? null,
      outcome: payload.outcome ?? null,
      note: payload.note ?? null,
    },
  });

  await logAdminAction(adminId, 'support_call_log', {
    targetType: 'support_call',
    targetId: row.id,
    detail: { phone: payload.phone, outcome: payload.outcome },
  });

  return row;
}

export async function listSupportCalls(db, { limit = 50 } = {}) {
  const rows = await db.supportCallLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
    include: {
      user: { select: { id: true, phone: true, name: true, handle: true } },
      admin: { select: { id: true, name: true, email: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    phone: r.phone,
    direction: r.direction,
    durationSec: r.durationSec,
    outcome: r.outcome,
    note: r.note,
    user: r.user,
    admin: r.admin,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getOpsHealthOverview(db) {
  const contact = getCustomerServiceContact();
  const supportStats = await getSupportOpsStats(db);

  const [userCount, distributorCount, pendingKyc, unackedFraud, lastAuditErrors] = await Promise.all([
    db.user.count(),
    db.business.count({ where: { OR: [{ distributionEnabled: true }, { type: 'brand' }] } }),
    db.cniVerificationJob.count({ where: { status: 'pending' } }),
    db.fraudAlert.count({ where: { acknowledgedAt: null } }),
    db.apiAuditLog.count({
      where: {
        statusCode: { gte: 500 },
        createdAt: { gte: new Date(Date.now() - 86400000) },
      },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    contact,
    support: supportStats,
    platform: {
      userCount,
      distributorCount,
      pendingKycJobs: pendingKyc,
      unackedFraudAlerts: unackedFraud,
      apiErrors24h: lastAuditErrors,
      sentryConfigured: Boolean(process.env.SENTRY_DSN),
      uptimeMonitorHint: 'Configure UptimeRobot on /api/health — see docs/K21-QUALITY-CONTROL.md',
    },
  };
}

export async function listAdminAuditLogs(db, { limit = 80, action } = {}) {
  const rows = await db.adminAuditLog.findMany({
    where: action ? { action: { contains: action, mode: 'insensitive' } } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
    include: { admin: { select: { email: true, name: true } } },
  });

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    detail: r.detailJson ? JSON.parse(r.detailJson) : null,
    admin: r.admin ? { email: r.admin.email, name: r.admin.name } : null,
    createdAt: r.createdAt.toISOString(),
  }));
}
