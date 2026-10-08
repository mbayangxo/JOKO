import { prisma } from '../prisma.js';
import { OrgAccessError, requireBusinessCapability } from '../business-access.js';
import { recordIdentityEvent } from '../identity/audit.js';

/**
 * J8.13 — pickup points. A place holds parcels for collection / drop-off ONLY
 * after explicit enrollment by its business and approval by compliance.
 * Being a financial agent, a merchant, a distributor or a legacy hub operator
 * never makes a place a pickup point. Operators act as members of the
 * operating business; the address stays private (only name / area is shown).
 */
export class PickupPointError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'PickupPointError';
    this.code = code;
    this.status = status;
  }
}

export const PICKUP_SERVICES = ['customer_pickup', 'parcel_dropoff', 'return_dropoff'];

export async function applyPickupPoint(userId, businessId, { name, services = ['customer_pickup'], hoursText, capacityParcels, hubId }) {
  await requireBusinessCapability(userId, businessId, 'business.profile.manage');
  if (!name || String(name).trim().length < 3) throw new PickupPointError('invalid', 'Nom requis', 400);
  if (!services.length || services.some((s) => !PICKUP_SERVICES.includes(s))) throw new PickupPointError('invalid', 'Services invalides', 400);
  if (hubId) {
    const hub = await prisma.deliveryHub.findUnique({ where: { id: hubId } });
    if (!hub) throw new PickupPointError('hub_not_found', 'Point K21 introuvable', 404);
    const taken = await prisma.pickupPoint.findUnique({ where: { hubId } });
    if (taken) throw new PickupPointError('hub_taken', 'Ce point est déjà opéré', 409);
  }
  const p = await prisma.pickupPoint.create({
    data: { operatorBusinessId: businessId, hubId: hubId ?? null, name: String(name).slice(0, 80), servicesJson: JSON.stringify([...new Set(services)]), hoursText: hoursText ?? null, capacityParcels: capacityParcels ?? null, appliedBy: userId },
  });
  return pointView(p);
}

/** Compliance decision (permission pickup_points.approve). Attributed and audited. */
export async function decidePickupPoint(adminId, pointId, { status, reason }) {
  if (!['active', 'suspended', 'closed'].includes(status)) throw new PickupPointError('invalid', 'Statut invalide', 400);
  if (!(reason && String(reason).trim().length >= 5)) throw new PickupPointError('reason_required', 'Motif requis', 400);
  return prisma.$transaction(async (tx) => {
    const p = await tx.pickupPoint.findUnique({ where: { id: pointId } });
    if (!p) throw new PickupPointError('not_found', 'Point introuvable', 404);
    if (p.status === 'closed') throw new PickupPointError('invalid_state', 'Point fermé');
    const u = await tx.pickupPoint.update({ where: { id: p.id }, data: { status, decidedBy: adminId, decidedAt: new Date(), decisionReason: String(reason).slice(0, 300) } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'pickup_point_decision', subjectType: 'pickup_point', subjectId: p.id, reason, before: { status: p.status }, after: { status } });
    return pointView(u);
  });
}

/** The ACTIVE point operating a legacy hub, and the caller's authority to act for it. */
export async function requireHubOperator(userId, hubId, db = prisma) {
  const p = await db.pickupPoint.findUnique({ where: { hubId } });
  if (!p || p.status !== 'active') throw new OrgAccessError('Opérateur de point K21 requis', 403);
  await requireBusinessCapability(userId, p.operatorBusinessId, 'business.orders.fulfill', db).catch(() => {
    throw new OrgAccessError('Opérateur de point K21 requis', 403);
  });
  return p;
}

/** Operator of an active pickup point offering `service`. */
export async function requirePointOperator(userId, pointId, service, db = prisma) {
  const p = await db.pickupPoint.findUnique({ where: { id: pointId } });
  if (!p || p.status !== 'active' || !JSON.parse(p.servicesJson).includes(service)) throw new OrgAccessError('Point de retrait introuvable', 404);
  await requireBusinessCapability(userId, p.operatorBusinessId, 'business.orders.fulfill', db).catch(() => {
    throw new OrgAccessError('Point de retrait introuvable', 404);
  });
  return p;
}

export function pointView(p) {
  return { id: p.id, name: p.name, services: JSON.parse(p.servicesJson), hoursText: p.hoursText, status: p.status, hubId: p.hubId };
}

export async function listActivePickupPoints({ service = 'customer_pickup', limit = 100 } = {}) {
  const rows = await prisma.pickupPoint.findMany({ where: { status: 'active' }, orderBy: { name: 'asc' }, take: Math.min(Number(limit) || 100, 200) });
  return rows.filter((p) => JSON.parse(p.servicesJson).includes(service)).map((p) => ({ id: p.id, name: p.name, services: JSON.parse(p.servicesJson), hoursText: p.hoursText }));
}
