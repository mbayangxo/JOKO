import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx } from '../business-access.js';
import { LogisticsError } from './contract.js';
import { assignCourier } from './shipments.js';

/**
 * J8.22 / J8.23 — delivery routes and consolidation for a business's OWN fleet.
 *
 * A route is a dispatcher's plan: a service date, a driver, and an ordered list of
 * that business's ready shipments (the order is the dispatcher's; Jokko does NOT
 * claim route optimisation). Consolidation = several shipments (often to different
 * merchants) carried on one route by one driver; each shipment keeps its own
 * custody, codes and proof — consolidation never merges proofs.
 */
const notFound = () => new LogisticsError('not_found', 'Tournée introuvable', 404);
const authOr404 = (p) => p.catch((e) => {
  if (e instanceof OrgAccessError) throw notFound();
  throw e;
});

export async function createRoute(userId, businessId, { serviceDate, driverUserId, shipmentIds }) {
  if (!Array.isArray(shipmentIds) || !shipmentIds.length || shipmentIds.length > 60 || new Set(shipmentIds).size !== shipmentIds.length) throw new LogisticsError('invalid', '1 à 60 expéditions distinctes', 400);
  const date = new Date(serviceDate);
  if (Number.isNaN(date.getTime())) throw new LogisticsError('invalid', 'Date invalide', 400);
  const route = await prisma.$transaction(async (tx) => {
    await authOr404(assertBusinessAuthorityInTx(tx, userId, businessId, 'business.fleet.dispatch'));
    await assertBusinessAuthorityInTx(tx, driverUserId, businessId, 'business.fleet.drive').catch(() => {
      throw new LogisticsError('not_a_driver', 'Ce chauffeur n’est pas membre actif de la flotte', 409);
    });
    const ships = await tx.shipment.findMany({ where: { id: { in: shipmentIds } } });
    const reqs = await tx.fulfilmentRequest.findMany({ where: { id: { in: ships.map((s) => s.requestId) } } });
    if (ships.length !== shipmentIds.length || reqs.some((r) => r.fulfillerBusinessId !== businessId)) throw new LogisticsError('not_found', 'Expédition introuvable', 404);
    if (ships.some((s) => s.status !== 'ready_for_pickup' || s.routeId)) throw new LogisticsError('invalid_state', 'Toutes les expéditions doivent être prêtes et hors tournée');
    const r = await tx.deliveryRoute.create({ data: { reference: `RT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, ownerBusinessId: businessId, serviceDate: date, driverUserId, createdBy: userId } });
    let seq = 1;
    for (const id of shipmentIds) {
      await tx.routeStop.create({ data: { routeId: r.id, sequence: seq++, shipmentId: id } });
      const u = await tx.shipment.updateMany({ where: { id, routeId: null, status: 'ready_for_pickup' }, data: { routeId: r.id } });
      if (u.count !== 1) throw new LogisticsError('conflict', 'Expédition modifiée entre-temps', 409);
    }
    return r;
  });
  // Assignment per shipment: the same authoritative path as a single assignment (party checks included).
  const results = [];
  for (const id of shipmentIds) {
    try {
      await assignCourier({ type: 'user', userId }, id, { courierUserId: driverUserId });
      results.push({ shipmentId: id, assigned: true });
    } catch (e) {
      await prisma.shipment.updateMany({ where: { id, routeId: route.id, status: 'ready_for_pickup' }, data: { routeId: null } });
      results.push({ shipmentId: id, assigned: false, code: e.code ?? 'error' });
    }
  }
  return { ...routeView(route), stops: results };
}

export async function listRoutes(userId, businessId, { from } = {}) {
  await authOr404(assertBusinessAuthorityInTx(prisma, userId, businessId, 'business.fleet.dispatch'));
  const rows = await prisma.deliveryRoute.findMany({ where: { ownerBusinessId: businessId, ...(from ? { serviceDate: { gte: new Date(from) } } : {}) }, orderBy: { serviceDate: 'desc' }, take: 100 });
  const stops = await prisma.routeStop.findMany({ where: { routeId: { in: rows.map((r) => r.id) } }, orderBy: { sequence: 'asc' } });
  const ships = await prisma.shipment.findMany({ where: { id: { in: stops.map((s) => s.shipmentId) } }, select: { id: true, status: true, reference: true, destArea: true } });
  return rows.map((r) => ({ ...routeView(r), stops: stops.filter((s) => s.routeId === r.id).map((s) => ({ sequence: s.sequence, ...ships.find((x) => x.id === s.shipmentId) })) }));
}

const routeView = (r) => ({ id: r.id, reference: r.reference, serviceDate: r.serviceDate.toISOString(), status: r.status });
