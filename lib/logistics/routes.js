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

/**
 * Route reconciliation (dispatcher): per stop — status, proof, receiving outcome and
 * units; refused units and where they are now; totals. `unaccounted` is units that left
 * the depot on this route and are neither recorded at a receiver, back at the depot,
 * nor still legitimately in transit — it must be 0 for a closed route.
 */
export async function routeReconciliation(userId, businessId, routeId) {
  await authOr404(assertBusinessAuthorityInTx(prisma, userId, businessId, 'business.fleet.dispatch'));
  const route = await prisma.deliveryRoute.findUnique({ where: { id: routeId } });
  if (!route || route.ownerBusinessId !== businessId) throw notFound();
  const stops = await prisma.routeStop.findMany({ where: { routeId }, orderBy: { sequence: 'asc' } });
  const ids = stops.map((s) => s.shipmentId);
  const [ships, pkgs, recs, refusalReqs] = await Promise.all([
    prisma.shipment.findMany({ where: { id: { in: ids } } }),
    prisma.shipmentPackage.findMany({ where: { shipmentId: { in: ids } } }),
    prisma.receivingRecord.findMany({ where: { shipmentId: { in: ids } } }),
    prisma.fulfilmentRequest.findMany({ where: { sourceSystem: 'refusal', sourceId: { in: ids } } }),
  ]);
  const refusalShips = await prisma.shipment.findMany({ where: { requestId: { in: refusalReqs.map((r) => r.id) } } });
  const refusalRecs = await prisma.receivingRecord.findMany({ where: { shipmentId: { in: refusalShips.map((s) => s.id) } } });
  const sum = (arr, k) => arr.reduce((n, l) => n + (l[k] ?? 0), 0);
  const totals = { dispatched: 0, received: 0, damaged: 0, missing: 0, refused: 0, refusedBackAtDepot: 0, refusedInTransit: 0, returnedToDepot: 0, inTransit: 0, unaccounted: 0 };
  const rows = stops.map((st) => {
    const sh = ships.find((x) => x.id === st.shipmentId);
    const dispatched = pkgs.filter((p) => p.shipmentId === sh.id).reduce((n, p) => n + JSON.parse(p.linesJson).reduce((m, l) => m + l.units, 0), 0);
    const rec = recs.find((r) => r.shipmentId === sh.id);
    const lines = rec ? JSON.parse(rec.linesJson) : [];
    const req = refusalReqs.find((r) => r.sourceId === sh.id);
    const rsh = req ? refusalShips.find((x) => x.requestId === req.id) : null;
    const rrec = rsh ? refusalRecs.find((r) => r.shipmentId === rsh.id) : null;
    const row = {
      sequence: st.sequence, shipmentId: sh.id, reference: sh.reference, status: sh.status, proof: sh.deliveryProof, failureReason: sh.failureReason,
      receiving: rec ? rec.outcome : null, dispatched,
      received: sum(lines, 'received'), damaged: sum(lines, 'damaged'), missing: sum(lines, 'missing'), refused: sum(lines, 'refused'),
      refusalReturn: rsh ? { status: rsh.status, backAtDepot: rrec ? sum(JSON.parse(rrec.linesJson), 'received') : 0 } : null,
    };
    totals.dispatched += dispatched;
    if (rec) {
      totals.received += row.received; totals.damaged += row.damaged; totals.missing += row.missing; totals.refused += row.refused;
      const back = row.refusalReturn?.backAtDepot ?? 0;
      totals.refusedBackAtDepot += back;
      if (rsh && !rrec) totals.refusedInTransit += row.refused;
      const rrLines = rrec ? JSON.parse(rrec.linesJson) : [];
      totals.missing += sum(rrLines, 'missing'); totals.damaged += sum(rrLines, 'damaged');
    } else if (sh.status === 'returned' || sh.status === 'cancelled') {
      totals.returnedToDepot += dispatched;
    } else {
      totals.inTransit += dispatched;
    }
    return row;
  });
  // Refused units are accounted for by the refusal return (back at depot / still in transit / recorded missing or damaged there).
  const accounted = totals.received + totals.damaged + totals.missing + totals.refusedBackAtDepot + totals.refusedInTransit + totals.returnedToDepot + totals.inTransit;
  totals.unaccounted = totals.dispatched - accounted;
  const open = rows.filter((r) => !['delivered', 'returned', 'cancelled'].includes(r.status) || r.refusalReturn?.status && r.refusalReturn.status !== 'delivered').length;
  return { route: routeView(route), closed: open === 0, stops: rows, totals };
}
