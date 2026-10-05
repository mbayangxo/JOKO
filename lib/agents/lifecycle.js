import { prisma } from '../prisma.js';
import { reference } from '../../api/_lib/auth.js';
import { recordIdentityEvent } from '../identity/audit.js';
import { createInAppNotification } from '../notify-service.js';

/**
 * J6.1 / J6.2 — agent identity, lifecycle, organizations and service points.
 *
 *   applied → under_review → approved → active ⇄ suspended → terminated
 *                 (identity      (review     (activation:
 *                  verified)      decision)   maker ≠ checker)
 *   rejected  from applied / under_review / approved
 *
 * Rules:
 *  - nobody activates themselves; an application, a float top-up, a service
 *    point or a business role never activates an agent;
 *  - every transition names its operator, time and reason (AgentStatusEvent,
 *    append-only) and is mirrored in the identity audit;
 *  - an individual agent operates a service point of their own individual
 *    organization; a business agent belongs to an organization backed by a
 *    VERIFIED J5 Business (its business wallet is never the agent's float);
 *  - an agent operates only at an ACTIVE, approved service point assigned to
 *    them; a service point is a public place (no home address) and offers
 *    merchant assistance only when compliance separately permits it.
 *
 * Legacy rows: status 'pending' is treated as 'applied', 'revoked' as
 * 'terminated', 'rejected' stays. Rows are never rewritten.
 */
export class AgentLifecycleError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'AgentLifecycleError';
    this.code = code;
    this.status = status;
  }
}

export const AGENT_STATES = ['applied', 'under_review', 'approved', 'active', 'suspended', 'terminated', 'rejected'];
const LEGACY = { pending: 'applied', revoked: 'terminated' };
export const normalizeStatus = (s) => LEGACY[s] ?? s;
const TERMINAL = new Set(['terminated', 'rejected']);

const TRANSITIONS = {
  applied: ['under_review', 'rejected'],
  under_review: ['approved', 'rejected'],
  approved: ['active', 'rejected'],
  active: ['suspended', 'terminated'],
  suspended: ['active', 'terminated'],
  terminated: [],
  rejected: [],
};

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Rounded (~1.1 km) coordinates: enough to sort by distance, never to locate a person. */
export const approxCoord = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);

/** Validate declared hours {mon:[["08:00","20:00"]], …}. Returns canonical JSON or null. */
export function parseHours(hours) {
  if (hours == null) return null;
  if (typeof hours !== 'object' || Array.isArray(hours)) throw new AgentLifecycleError('invalid_hours', 'Horaires invalides', 400);
  const out = {};
  for (const [day, ranges] of Object.entries(hours)) {
    if (!DAYS.includes(day) || !Array.isArray(ranges) || ranges.length > 3) throw new AgentLifecycleError('invalid_hours', 'Horaires invalides', 400);
    out[day] = ranges.map((r) => {
      if (!Array.isArray(r) || r.length !== 2 || !HHMM.test(r[0]) || !HHMM.test(r[1]) || r[0] >= r[1]) throw new AgentLifecycleError('invalid_hours', 'Horaires invalides', 400);
      return [r[0], r[1]];
    });
  }
  return JSON.stringify(out);
}

const ADDRESS_FORBIDDEN = /\b(domicile|maison|chez moi|home|appartement|appt|chambre)\b/i;

function servicePointData(input = {}) {
  const name = String(input.name ?? '').trim();
  const publicAddress = String(input.publicAddress ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new AgentLifecycleError('invalid_service_point', 'Nom du point de service requis', 400);
  if (publicAddress.length < 5 || publicAddress.length > 160) throw new AgentLifecycleError('invalid_service_point', 'Adresse publique du point de service requise', 400);
  if (ADDRESS_FORBIDDEN.test(publicAddress)) {
    throw new AgentLifecycleError('private_address', 'Un point de service est un lieu public (boutique, kiosque) — pas une adresse privée', 400);
  }
  return {
    name,
    publicAddress,
    area: input.area ? String(input.area).trim().slice(0, 80) : null,
    approxLat: approxCoord(input.lat),
    approxLng: approxCoord(input.lng),
    hoursJson: parseHours(input.hours ?? null),
    cashIn: input.cashIn !== false,
    cashOut: input.cashOut !== false,
    merchantAssist: false, // only compliance can permit it (permitMerchantAssist)
  };
}

async function recordStatus(tx, agent, to, { actorType, actorId, reason, data = {} }) {
  const from = normalizeStatus(agent.status);
  await tx.agentProfile.update({ where: { id: agent.id }, data: { status: to, ...data } });
  await tx.agentStatusEvent.create({ data: { agentId: agent.id, fromStatus: from, toStatus: to, actorType, actorId: actorId ?? null, reason: reason ?? null } });
  await recordIdentityEvent(tx, {
    actorType, actorId: actorId ?? null, action: `agent_${to}`, subjectType: 'agent', subjectId: agent.id,
    reason: reason ?? null, before: { status: from }, after: { status: to },
  });
}

async function lockAgent(tx, agentId) {
  await tx.$executeRaw`SELECT id FROM "AgentProfile" WHERE id = ${agentId} FOR UPDATE`;
  const agent = await tx.agentProfile.findUnique({ where: { id: agentId } });
  if (!agent) throw new AgentLifecycleError('not_found', 'Agent introuvable', 404);
  return agent;
}

function assertTransition(agent, to) {
  const from = normalizeStatus(agent.status);
  if (from === to) return false;
  if (!TRANSITIONS[from]?.includes(to)) throw new AgentLifecycleError('invalid_transition', `Transition ${from} → ${to} refusée`);
  return true;
}

const requireReason = (reason, min = 5) => {
  if (!reason || String(reason).trim().length < min) throw new AgentLifecycleError('reason_required', `Motif requis (≥ ${min} caractères)`, 400);
  return String(reason).trim().slice(0, 300);
};

// ── Applications ────────────────────────────────────────────────────────────

/**
 * A user applies to become an agent. Creates (idempotently) the
 * organization, a PENDING service point and an `applied` profile. Nothing is
 * active and no role is granted.
 */
export async function applyAsAgent(userId, input = {}) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, phone: true } });
  if (!user) throw new AgentLifecycleError('user_not_found', 'Utilisateur introuvable', 404);
  const existing = await prisma.agentProfile.findUnique({ where: { userId } });
  if (existing) return existing;

  const agentType = input.agentType === 'business' ? 'business' : 'individual';
  let business = null;
  if (agentType === 'business') {
    if (!input.businessId) throw new AgentLifecycleError('business_required', 'Un agent business est rattaché à un commerce vérifié', 400);
    business = await prisma.business.findUnique({ where: { id: String(input.businessId) }, select: { id: true, ownerId: true, name: true } });
    // Only the OWNER can make a business an agent network — staff roles never do.
    if (!business || business.ownerId !== userId) throw new AgentLifecycleError('not_owner', 'Seul le propriétaire du commerce peut le déclarer réseau d’agents', 403);
  }
  const displayName = String(input.displayName ?? user.name ?? 'Point Jokko').trim().slice(0, 80);
  const sp = servicePointData({
    name: input.servicePoint?.name ?? displayName,
    publicAddress: input.servicePoint?.publicAddress ?? input.locationLabel ?? '',
    area: input.servicePoint?.area ?? input.arrondissement,
    lat: input.servicePoint?.lat ?? input.lat,
    lng: input.servicePoint?.lng ?? input.lng,
    hours: input.servicePoint?.hours,
    cashIn: input.servicePoint?.cashIn,
    cashOut: input.servicePoint?.cashOut,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      const org = business
        ? (await tx.agentOrganization.findUnique({ where: { businessId: business.id } }))
          ?? (await tx.agentOrganization.create({ data: { kind: 'business', name: business.name, businessId: business.id, ownerUserId: userId } }))
        : await tx.agentOrganization.create({ data: { kind: 'individual', name: displayName, ownerUserId: userId } });
      if (org.ownerUserId !== userId) throw new AgentLifecycleError('not_owner', 'Organisation d’un autre propriétaire', 403);
      const point = await tx.agentServicePoint.create({ data: { ...sp, organizationId: org.id, createdBy: userId } });
      const agentCode = `${agentType === 'business' ? 'BAG' : 'AGT'}-${reference('').replace(/[^A-Z0-9]/gi, '').slice(-8).toUpperCase()}`;
      const profile = await tx.agentProfile.create({
        data: {
          userId, agentCode, displayName, agentType, organizationId: org.id, servicePointId: point.id,
          locationLabel: sp.publicAddress, arrondissement: sp.area, lat: sp.approxLat, lng: sp.approxLng,
          tier: 'standard', floatBalance: 0, floatLimit: 500_000, maxDepositXof: 500_000, maxWithdrawXof: 500_000, status: 'applied',
        },
      });
      await tx.agentStatusEvent.create({ data: { agentId: profile.id, fromStatus: null, toStatus: 'applied', actorType: 'user', actorId: userId, reason: 'application' } });
      return profile;
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      const again = await prisma.agentProfile.findUnique({ where: { userId } });
      if (again) return again;
    }
    throw error;
  }
}

// ── Operator transitions (compliance / risk) ────────────────────────────────

/**
 * Identity verification: the applicant's own J3 KYC (tier ≥ 2: verified
 * national ID) — the operator records that it was checked, never overrides it.
 * Business agents: the backing J5 business must be verified too.
 */
export async function verifyAgentIdentity(adminId, agentId, { reason } = {}) {
  return prisma.$transaction(async (tx) => {
    const agent = await lockAgent(tx, agentId);
    if (!assertTransition(agent, 'under_review')) return agent;
    const user = await tx.user.findUnique({ where: { id: agent.userId }, select: { verificationTier: true, cniVerifiedAt: true } });
    if ((user?.verificationTier ?? 1) < 2) throw new AgentLifecycleError('identity_unverified', 'Identité du candidat non vérifiée (CNI, palier 2 requis)');
    if (agent.agentType === 'business') {
      const org = agent.organizationId ? await tx.agentOrganization.findUnique({ where: { id: agent.organizationId } }) : null;
      const b = org?.businessId ? await tx.business.findUnique({ where: { id: org.businessId }, select: { verificationStatus: true, status: true } }) : null;
      if (!b || b.verificationStatus !== 'verified' || b.status !== 'active') throw new AgentLifecycleError('business_unverified', 'Le commerce rattaché doit être vérifié et actif');
    }
    await recordStatus(tx, agent, 'under_review', { actorType: 'admin', actorId: adminId, reason: reason ?? 'identity verified (KYC tier ≥ 2)', data: { identityVerifiedAt: new Date(), identityVerifiedBy: adminId } });
    return tx.agentProfile.findUnique({ where: { id: agentId } });
  });
}

export async function approveAgent(adminId, agentId, { reason } = {}) {
  const why = requireReason(reason);
  return prisma.$transaction(async (tx) => {
    const agent = await lockAgent(tx, agentId);
    if (!assertTransition(agent, 'approved')) return agent;
    if (!agent.identityVerifiedAt) throw new AgentLifecycleError('identity_unverified', 'Vérification d’identité requise avant approbation');
    if (agent.identityVerifiedBy === adminId) {
      // Review is a second look: the operator who verified identity does not approve.
      throw new AgentLifecycleError('same_operator', 'L’approbation doit venir d’un autre opérateur que la vérification', 403);
    }
    await recordStatus(tx, agent, 'approved', { actorType: 'admin', actorId: adminId, reason: why, data: { approvedBy: adminId, approvedAt: new Date() } });
    return tx.agentProfile.findUnique({ where: { id: agentId } });
  });
}

/**
 * Activation (executed by the maker-checker approval `agent_activation`):
 * needs an approved profile, an active service point assigned to the agent,
 * an active organization, and an activator different from the approver.
 */
export async function activateAgentInTx(tx, agentId, { activatedBy, requestedBy, reason }) {
  const agent = await lockAgent(tx, agentId);
  const from = normalizeStatus(agent.status);
  if (from === 'active') return agent;
  if (from !== 'approved' && from !== 'suspended') throw new AgentLifecycleError('invalid_transition', `Activation impossible depuis ${from}`);
  if (from === 'approved' && agent.approvedBy && [activatedBy, requestedBy].includes(agent.approvedBy)) {
    throw new AgentLifecycleError('same_operator', 'L’activation doit venir d’opérateurs différents de l’approbateur', 403);
  }
  const point = agent.servicePointId ? await tx.agentServicePoint.findUnique({ where: { id: agent.servicePointId } }) : null;
  if (!point || point.status !== 'active' || point.organizationId !== agent.organizationId) throw new AgentLifecycleError('service_point_required', 'Point de service approuvé requis');
  const org = await tx.agentOrganization.findUnique({ where: { id: agent.organizationId } });
  if (!org || org.status === 'suspended' || org.status === 'terminated') throw new AgentLifecycleError('organization_inactive', 'Organisation inactive');
  if (org.status === 'applied') await tx.agentOrganization.update({ where: { id: org.id }, data: { status: 'active', approvedBy: activatedBy, approvedAt: new Date() } });
  await tx.accountRole.upsert({
    where: { userId_role: { userId: agent.userId, role: 'agent' } },
    create: { userId: agent.userId, role: 'agent', status: 'active', statusChangedBy: `admin:${activatedBy}`, statusChangedAt: new Date() },
    update: { status: 'active', statusChangedBy: `admin:${activatedBy}`, statusChangedAt: new Date(), statusReason: reason ?? null },
  });
  await recordStatus(tx, agent, 'active', {
    actorType: 'admin', actorId: activatedBy, reason: reason ?? 'activation (maker-checker)',
    data: { activatedBy, activatedAt: new Date(), suspendedAt: null, suspensionReason: null },
  });
  await createInAppNotification(agent.userId, 'Agent Jokko activé', 'Ton point de service est actif.', { kind: 'agent_approved', refId: agent.id }).catch(() => {});
  return tx.agentProfile.findUnique({ where: { id: agentId } });
}

export async function rejectAgent(adminId, agentId, { reason }) {
  const why = requireReason(reason);
  return prisma.$transaction(async (tx) => {
    const agent = await lockAgent(tx, agentId);
    if (!assertTransition(agent, 'rejected')) return agent;
    await recordStatus(tx, agent, 'rejected', { actorType: 'admin', actorId: adminId, reason: why });
    await tx.accountRole.updateMany({ where: { userId: agent.userId, role: 'agent' }, data: { status: 'inactive', statusReason: why } });
    return tx.agentProfile.findUnique({ where: { id: agentId } });
  });
}

/** Protective: one operator, immediate. Open cash transactions are released / sent to review (lib/agents/cash.js). */
export async function suspendAgent(adminId, agentId, { reason }) {
  const why = requireReason(reason, 3);
  const out = await prisma.$transaction(async (tx) => {
    const agent = await lockAgent(tx, agentId);
    const from = normalizeStatus(agent.status);
    if (from === 'suspended') return agent;
    if (TERMINAL.has(from)) throw new AgentLifecycleError('invalid_transition', `Agent ${from}`);
    // Suspension also applies to a not-yet-active applicant (blocks activation).
    await tx.agentProfile.update({ where: { id: agent.id }, data: { status: 'suspended', suspendedAt: new Date(), suspensionReason: why } });
    await tx.agentStatusEvent.create({ data: { agentId: agent.id, fromStatus: from, toStatus: 'suspended', actorType: 'admin', actorId: adminId, reason: why } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'agent_suspended', subjectType: 'user', subjectId: agent.userId, reason: why, before: { status: from }, after: { status: 'suspended' } });
    await tx.accountRole.updateMany({
      where: { userId: agent.userId, role: 'agent' },
      data: { status: 'suspended', statusChangedAt: new Date(), statusChangedBy: `admin:${adminId}`, statusReason: why },
    });
    return tx.agentProfile.findUnique({ where: { id: agentId } });
  });
  const { closeOpenCashForAgent } = await import('./cash.js');
  await closeOpenCashForAgent(agentId, { actorId: adminId, reason: 'agent_suspended' });
  return out;
}

export async function terminateAgent(adminId, agentId, { reason }) {
  const why = requireReason(reason, 10);
  const out = await prisma.$transaction(async (tx) => {
    const agent = await lockAgent(tx, agentId);
    const from = normalizeStatus(agent.status);
    if (from === 'terminated') return agent;
    if (from === 'rejected') throw new AgentLifecycleError('invalid_transition', 'Agent refusé');
    await tx.agentProfile.update({ where: { id: agent.id }, data: { status: 'terminated', terminatedAt: new Date(), terminationReason: why } });
    await tx.agentStatusEvent.create({ data: { agentId: agent.id, fromStatus: from, toStatus: 'terminated', actorType: 'admin', actorId: adminId, reason: why } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'agent_terminated', subjectType: 'agent', subjectId: agent.id, reason: why, before: { status: from }, after: { status: 'terminated' } });
    await tx.accountRole.updateMany({ where: { userId: agent.userId, role: 'agent' }, data: { status: 'revoked', statusChangedAt: new Date(), statusChangedBy: `admin:${adminId}`, statusReason: why } });
    return tx.agentProfile.findUnique({ where: { id: agentId } });
  });
  const { closeOpenCashForAgent } = await import('./cash.js');
  await closeOpenCashForAgent(agentId, { actorId: adminId, reason: 'agent_terminated' });
  return out;
}

/**
 * Legacy agents (pre-J6, no organization / service point) stay fail-closed:
 * they cannot operate. Compliance ADOPTS one into the J6 model: an individual
 * organization + a PENDING service point. Nothing is activated and no role is
 * granted here — the point still needs approval (decideServicePoint), and a
 * non-active profile still needs the activation maker-checker.
 */
export async function adoptLegacyAgent(adminId, agentId, { servicePoint, reason }) {
  const why = requireReason(reason);
  const sp = servicePointData(servicePoint ?? {});
  return prisma.$transaction(async (tx) => {
    const agent = await lockAgent(tx, agentId);
    if (agent.organizationId) throw new AgentLifecycleError('already_adopted', 'Agent déjà rattaché à une organisation');
    const org = await tx.agentOrganization.create({ data: { kind: 'individual', name: agent.displayName, ownerUserId: agent.userId, status: normalizeStatus(agent.status) === 'active' ? 'active' : 'applied', approvedBy: adminId, approvedAt: new Date() } });
    const point = await tx.agentServicePoint.create({ data: { ...sp, organizationId: org.id, createdBy: `admin:${adminId}` } });
    await tx.agentProfile.update({ where: { id: agent.id }, data: { organizationId: org.id, servicePointId: point.id, locationLabel: sp.publicAddress, arrondissement: sp.area, lat: sp.approxLat, lng: sp.approxLng } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'agent_legacy_adopted', subjectType: 'agent', subjectId: agent.id, reason: why, after: { organizationId: org.id, servicePointId: point.id, status: normalizeStatus(agent.status) } });
    return { agentId: agent.id, organizationId: org.id, servicePointId: point.id, servicePointStatus: point.status };
  });
}

// ── Service points ──────────────────────────────────────────────────────────

/** The organization owner proposes another service point (pending until compliance approves). */
export async function proposeServicePoint(userId, input) {
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent?.organizationId) throw new AgentLifecycleError('not_agent', 'Pas d’organisation agent', 403);
  const org = await prisma.agentOrganization.findUnique({ where: { id: agent.organizationId } });
  if (org.ownerUserId !== userId) throw new AgentLifecycleError('not_owner', 'Seul le responsable de l’organisation propose un point de service', 403);
  return prisma.agentServicePoint.create({ data: { ...servicePointData(input), organizationId: org.id, createdBy: userId } });
}

export async function decideServicePoint(adminId, servicePointId, { status, reason }) {
  if (!['active', 'inactive', 'closed'].includes(status)) throw new AgentLifecycleError('invalid_status', 'status: active | inactive | closed', 400);
  const why = requireReason(reason);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "AgentServicePoint" WHERE id = ${servicePointId} FOR UPDATE`;
    const sp = await tx.agentServicePoint.findUnique({ where: { id: servicePointId } });
    if (!sp) throw new AgentLifecycleError('not_found', 'Point de service introuvable', 404);
    if (sp.status === 'closed') throw new AgentLifecycleError('closed_final', 'Point de service fermé définitivement');
    const updated = await tx.agentServicePoint.update({
      where: { id: sp.id },
      data: { status, ...(status === 'active' && !sp.approvedAt ? { approvedBy: adminId, approvedAt: new Date() } : {}) },
    });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'service_point_status', subjectType: 'service_point', subjectId: sp.id, reason: why, before: { status: sp.status }, after: { status } });
    return updated;
  });
}

/** Merchant assistance at a service point is a separate compliance permission. */
export async function permitMerchantAssist(adminId, servicePointId, { permitted, reason }) {
  const why = requireReason(reason);
  return prisma.$transaction(async (tx) => {
    const sp = await tx.agentServicePoint.findUnique({ where: { id: servicePointId } });
    if (!sp) throw new AgentLifecycleError('not_found', 'Point de service introuvable', 404);
    const updated = await tx.agentServicePoint.update({ where: { id: sp.id }, data: { merchantAssistPermitted: Boolean(permitted), merchantAssist: Boolean(permitted) && sp.merchantAssist } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'service_point_merchant_assist', subjectType: 'service_point', subjectId: sp.id, reason: why, after: { permitted: Boolean(permitted) } });
    return updated;
  });
}

/** The organization owner edits public details (hours, services). Merchant assist only if permitted. */
export async function updateServicePoint(userId, servicePointId, input) {
  const sp = await prisma.agentServicePoint.findUnique({ where: { id: servicePointId } });
  const org = sp ? await prisma.agentOrganization.findUnique({ where: { id: sp.organizationId } }) : null;
  if (!sp || org?.ownerUserId !== userId) throw new AgentLifecycleError('not_found', 'Point de service introuvable', 404);
  const data = {};
  if (input.hours !== undefined) data.hoursJson = parseHours(input.hours);
  if (input.cashIn !== undefined) data.cashIn = Boolean(input.cashIn);
  if (input.cashOut !== undefined) data.cashOut = Boolean(input.cashOut);
  if (input.merchantAssist !== undefined) {
    if (input.merchantAssist && !sp.merchantAssistPermitted) throw new AgentLifecycleError('merchant_assist_not_permitted', 'Assistance marchands non autorisée pour ce point', 403);
    data.merchantAssist = Boolean(input.merchantAssist);
  }
  return prisma.agentServicePoint.update({ where: { id: sp.id }, data });
}

/** Compliance assigns an agent to another approved service point of the SAME organization. */
export async function assignServicePoint(adminId, agentId, servicePointId, { reason }) {
  const why = requireReason(reason);
  return prisma.$transaction(async (tx) => {
    const agent = await lockAgent(tx, agentId);
    const sp = await tx.agentServicePoint.findUnique({ where: { id: servicePointId } });
    if (!sp || sp.organizationId !== agent.organizationId) throw new AgentLifecycleError('wrong_organization', 'Point de service d’une autre organisation', 403);
    await tx.agentProfile.update({ where: { id: agent.id }, data: { servicePointId: sp.id, locationLabel: sp.publicAddress, arrondissement: sp.area, lat: sp.approxLat, lng: sp.approxLng } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'agent_service_point_assigned', subjectType: 'agent', subjectId: agent.id, reason: why, after: { servicePointId: sp.id } });
    return tx.agentProfile.findUnique({ where: { id: agentId } });
  });
}

/**
 * The single operational check every financial agent action uses: the user
 * holds the ACTIVE agent role, the profile is active, and the assigned
 * service point is active and offers `service` (cash_in | cash_out).
 */
export async function requireOperatingAgent(db, userId, service) {
  const role = await db.accountRole.findFirst({ where: { userId, role: 'agent', status: 'active' } });
  if (!role) throw new AgentLifecycleError('not_agent', 'Rôle agent requis', 403);
  const agent = await db.agentProfile.findUnique({ where: { userId } });
  if (!agent || normalizeStatus(agent.status) !== 'active') throw new AgentLifecycleError('agent_inactive', 'Profil agent inactif', 403);
  const sp = agent.servicePointId ? await db.agentServicePoint.findUnique({ where: { id: agent.servicePointId } }) : null;
  if (!sp || sp.status !== 'active' || sp.organizationId !== agent.organizationId) throw new AgentLifecycleError('service_point_inactive', 'Point de service non actif', 403);
  if (service === 'cash_in' && !sp.cashIn) throw new AgentLifecycleError('service_not_offered', 'Dépôt non proposé à ce point', 403);
  if (service === 'cash_out' && !sp.cashOut) throw new AgentLifecycleError('service_not_offered', 'Retrait non proposé à ce point', 403);
  const org = agent.organizationId ? await db.agentOrganization.findUnique({ where: { id: agent.organizationId } }) : null;
  if (!org || org.status !== 'active') throw new AgentLifecycleError('organization_inactive', 'Organisation agent inactive', 403);
  return { agent, servicePoint: sp, organization: org };
}

/** Physical cash on hand, as reported by the agent (never authoritative). */
export async function reportCashOnHand(userId, { amountXof, note }) {
  if (!Number.isSafeInteger(amountXof) || amountXof < 0 || amountXof > 100_000_000) throw new AgentLifecycleError('invalid_amount', 'Montant invalide', 400);
  const { agent, servicePoint } = await requireOperatingAgent(prisma, userId);
  return prisma.agentCashReport.create({ data: { agentId: agent.id, servicePointId: servicePoint.id, amountXof, note: note ? String(note).slice(0, 200) : null } });
}

export function lifecycleShape(agent) {
  return {
    id: agent.id,
    agentCode: agent.agentCode,
    displayName: agent.displayName,
    agentType: agent.agentType,
    status: normalizeStatus(agent.status),
    identityVerifiedAt: agent.identityVerifiedAt?.toISOString() ?? null,
    approvedAt: agent.approvedAt?.toISOString() ?? null,
    activatedAt: agent.activatedAt?.toISOString() ?? null,
    suspendedAt: agent.suspendedAt?.toISOString() ?? null,
    terminatedAt: agent.terminatedAt?.toISOString() ?? null,
  };
}
