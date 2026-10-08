import { z } from 'zod';
import { prisma } from '../prisma.js';
import { validationError } from '../validation.js';
import { OrgAccessError } from '../business-access.js';
import { DepotError } from '../b2b/depot.js';
import { PurchaseOrderError } from '../b2b/purchase-orders.js';
import { AdminAuthzError } from '../authz/admin-authz.js';
import { isMoneyError, moneyErrorStatus } from '../wallet-atomic.js';
import { FAILURE_REASONS, LogisticsError, shipmentView } from './contract.js';
import { PickupPointError, applyPickupPoint, decidePickupPoint, listActivePickupPoints } from './pickup-points.js';
import * as S from './shipments.js';
import * as D from './disputes.js';
import { createTransfer, listTransfers } from './transfers.js';
import { createRoute, listRoutes, routeReconciliation } from './routes.js';
import { MappingError, listMappingState, resolveUnmatched, upsertMapping } from '../b2b/product-mapping.js';
import { payoutEarnings, promoteReleasableEarnings } from './fees.js';
import { processLogisticsOutbox } from './intake.js';

/** J8 logistics routes (thin). Every rule — authority, custody, proof, money — lives in lib/logistics/*. */
const id = (req) => String(req.query.id ?? '');
const ERRORS = [LogisticsError, PickupPointError, DepotError, PurchaseOrderError, AdminAuthzError, MappingError];
const parse = (schema, req, res) => {
  const p = schema.safeParse(req.body ?? {});
  if (!p.success) {
    validationError(res, p.error);
    return null;
  }
  return p.data;
};
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof OrgAccessError) return res.status(error.status).json({ error: error.message, code: error.status === 404 ? 'not_found' : 'not_authorized' });
    if (ERRORS.some((C) => error instanceof C)) return res.status(error.status ?? 409).json({ error: error.message, code: error.code });
    if (isMoneyError(error)) return res.status(moneyErrorStatus(error)).json({ error: error.message, code: error.code ?? 'money_error' });
    throw error;
  }
};
const code = z.object({ code: z.string().min(4).max(16) }).strict();
const reason = z.object({ reason: z.string().min(3).max(300) }).strict();
const empty = z.object({}).strict();

/* ── shipments: parties ─────────────────────────────────────────────────── */
export const shipmentGet = wrap(async (req, res) => res.json(await S.getShipment(req.userId, id(req))));
export const myShipments = wrap(async (req, res) => res.json(await S.listMyShipments(req.userId, { limit: req.query.limit })));
export const courierShipments = wrap(async (req, res) => res.json(await S.listCourierShipments(req.userId, { cursor: req.query.cursor, limit: req.query.limit })));
export const businessShipments = wrap(async (req, res) => res.json(await S.listBusinessShipments(req.userId, id(req), { side: req.query.side === 'destination' ? 'destination' : 'origin', status: req.query.status, cursor: req.query.cursor, limit: req.query.limit })));

export const shipmentReady = wrap(async (req, res) => {
  if (parse(empty, req, res)) res.json(await S.markReady(req.userId, id(req)));
});
export const shipmentAssign = wrap(async (req, res) => {
  const b = parse(z.object({ courierUserId: z.string().min(1).max(64) }).strict(), req, res);
  if (b) res.json(await S.assignCourier({ type: 'user', userId: req.userId }, id(req), b));
});
export const shipmentUnassign = wrap(async (req, res) => {
  const b = parse(reason, req, res);
  if (b) res.json(await S.unassignCourier({ type: 'user', userId: req.userId }, id(req), b));
});
export const shipmentCode = wrap(async (req, res) => {
  const b = parse(z.object({ purpose: z.enum(['pickup', 'delivery', 'collection', 'return_delivery']) }).strict(), req, res);
  if (b) res.status(201).json(await S.issueCode(req.userId, id(req), b.purpose));
});
export const shipmentPickup = wrap(async (req, res) => {
  const b = parse(code, req, res);
  if (b) res.json(await S.courierPickup(req.userId, id(req), b));
});
export const shipmentStep = wrap(async (req, res) => {
  const b = parse(z.object({ step: z.enum(['arrive_pickup', 'depart', 'arrive_delivery']) }).strict(), req, res);
  if (b) res.json(await S.courierStep(req.userId, id(req), b.step));
});
export const shipmentDeliver = wrap(async (req, res) => {
  const b = parse(code, req, res);
  if (b) res.json(await S.courierDeliver(req.userId, id(req), b));
});
export const shipmentFail = wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.enum(Object.keys(FAILURE_REASONS)), note: z.string().max(300).optional() }).strict(), req, res);
  if (b) res.json(await S.courierFail(req.userId, id(req), b));
});
export const shipmentException = wrap(async (req, res) => {
  const b = parse(z.object({ note: z.string().min(10).max(300) }).strict(), req, res);
  if (b) res.json(await S.courierException(req.userId, id(req), b));
});
export const shipmentReturnStart = wrap(async (req, res) => {
  if (parse(empty, req, res)) res.json(await S.courierReturnStart(req.userId, id(req)));
});
export const shipmentReturnComplete = wrap(async (req, res) => {
  const b = parse(code, req, res);
  if (b) res.json(await S.courierReturnComplete(req.userId, id(req), b));
});
const qty = z.number().int().min(0).max(10_000_000);
export const shipmentReceiving = wrap(async (req, res) => {
  const b = parse(z.object({
    lines: z.array(z.object({ productId: z.string().min(1).max(64), received: qty, damaged: qty.optional(), missing: qty.optional(), refused: qty.optional() }).strict()).min(1).max(100),
    note: z.string().max(300).optional(),
  }).strict(), req, res);
  if (b) res.json(await S.recordReceiving(req.userId, id(req), b));
});
export const shipmentDrop = wrap(async (req, res) => {
  if (parse(empty, req, res)) res.json(await S.dropAtPoint(req.userId, id(req)));
});
export const shipmentRelease = wrap(async (req, res) => {
  const b = parse(code, req, res);
  if (b) res.json(await S.releaseCollection(req.userId, id(req), b));
});
export const shipmentCancel = wrap(async (req, res) => {
  const b = parse(reason, req, res);
  if (b) res.json(await S.cancelShipment({ type: 'user', userId: req.userId }, id(req), b));
});

export const shipmentRespond = wrap(async (req, res) => {
  const b = parse(z.object({ accept: z.boolean(), reason: z.string().max(150).optional() }).strict(), req, res);
  if (b) res.json(await S.courierRespond(req.userId, id(req), b));
});
export const shipmentFailureRespond = wrap(async (req, res) => {
  const b = parse(z.object({ agree: z.boolean() }).strict(), req, res);
  if (b) res.json(await S.respondToFailure(req.userId, id(req), b));
});
export const shipmentEmergencyReassign = wrap(async (req, res) => {
  const b = parse(z.object({ courierUserId: z.string().min(1).max(64), reason: z.string().min(10).max(300) }).strict(), req, res);
  if (b) res.json(await S.emergencyReassign({ type: 'user', userId: req.userId }, id(req), b));
});
export const shipmentHandoffCode = wrap(async (req, res) => {
  if (parse(empty, req, res)) res.status(201).json(await S.issueHandoffCode({ type: 'user', userId: req.userId }, id(req)));
});
export const shipmentHandoff = wrap(async (req, res) => {
  const b = parse(code, req, res);
  if (b) res.json(await S.acceptHandoff(req.userId, id(req), b));
});
export const routeReconcile = wrap(async (req, res) => res.json(await routeReconciliation(req.userId, id(req), String(req.query.subId ?? ''))));
export const productMappings = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await listMappingState(req.userId, id(req)));
  const b = parse(z.object({ sellerProductId: z.string().min(1).max(64), buyerProductId: z.string().min(1).max(64), applyPending: z.boolean().optional() }).strict(), req, res);
  if (b) res.json(await upsertMapping(req.userId, id(req), b));
});
export const unmatchedResolve = wrap(async (req, res) => {
  const b = parse(z.object({ buyerProductId: z.string().min(1).max(64), remember: z.boolean().optional() }).strict(), req, res);
  if (b) res.json(await resolveUnmatched(req.userId, id(req), String(req.query.subId ?? ''), b));
});

/* ── disputes: parties ──────────────────────────────────────────────────── */
export const shipmentDisputeOpen = wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(10).max(500) }).strict(), req, res);
  if (b) res.status(201).json(await D.openDispute(req.userId, id(req), b));
});
export const disputeGet = wrap(async (req, res) => res.json(await D.getDisputeForParty(req.userId, id(req))));
export const disputeEvidence = wrap(async (req, res) => {
  const b = parse(z.object({ kind: z.enum(['note', 'photo_ref', 'document_ref']).optional(), content: z.string().min(3).max(1000) }).strict(), req, res);
  if (b) res.status(201).json(await D.addEvidence(req.userId, id(req), b));
});

/* ── courier earnings (own only) ────────────────────────────────────────── */
export const earningsMine = wrap(async (req, res) => {
  const rows = await prisma.courierEarning.findMany({ where: { courierUserId: req.userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  const sum = (s) => rows.filter((e) => e.status === s).reduce((a, e) => a + e.amountKori, 0);
  res.json({ accruedKori: sum('accrued'), releasableKori: sum('releasable'), paidKori: sum('paid'), items: rows.map((e) => ({ shipmentId: e.shipmentId, amountKori: e.amountKori, status: e.status, releasableAt: e.releasableAt.toISOString() })) });
});
export const earningsPayout = wrap(async (req, res) => {
  if (!parse(empty, req, res)) return;
  res.json(await payoutEarnings(req.userId, { idempotencyKey: String(req.headers?.['idempotency-key'] ?? '') }));
});

/* ── business: transfers, routes, pickup point enrollment ───────────────── */
export const businessTransfers = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await listTransfers(req.userId, id(req), { status: req.query.status }));
  const b = parse(z.object({
    fromLocationId: z.string().min(1).max(64), toLocationId: z.string().min(1).max(64),
    lines: z.array(z.object({ productId: z.string().min(1).max(64), units: z.number().int().positive().max(1_000_000) }).strict()).min(1).max(100),
    note: z.string().max(300).optional(),
  }).strict(), req, res);
  if (b) res.status(201).json(await createTransfer(req.userId, id(req), b));
});
export const businessRoutes = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await listRoutes(req.userId, id(req), { from: req.query.from }));
  const b = parse(z.object({ serviceDate: z.string().min(8).max(40), driverUserId: z.string().min(1).max(64), shipmentIds: z.array(z.string().min(1).max(64)).min(1).max(60) }).strict(), req, res);
  if (b) res.status(201).json(await createRoute(req.userId, id(req), b));
});
export const businessPickupPointApply = wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(3).max(80), services: z.array(z.enum(['customer_pickup', 'parcel_dropoff', 'return_dropoff'])).min(1).max(3).optional(), hoursText: z.string().max(120).optional(), capacityParcels: z.number().int().positive().max(100_000).optional(), hubId: z.string().max(64).optional() }).strict(), req, res);
  if (b) res.status(201).json(await applyPickupPoint(req.userId, id(req), b));
});
export const pickupPointsList = wrap(async (req, res) => res.json({ items: await listActivePickupPoints({ service: req.query.service ? String(req.query.service) : 'customer_pickup' }) }));

/* ── operators (J3 permissions enforced centrally before these run) ─────── */
export const adminShipments = wrap(async (req, res) => {
  const take = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
  const where = { ...(req.query.status ? { status: String(req.query.status) } : {}) };
  const rows = await prisma.shipment.findMany({ where, orderBy: { id: 'asc' }, take: take + 1, ...(req.query.cursor ? { cursor: { id: String(req.query.cursor) }, skip: 1 } : {}) });
  const page = rows.slice(0, take);
  res.json({ items: page.map((s) => shipmentView(s, { role: 'operator' })), nextCursor: rows.length > take ? page[page.length - 1].id : null });
});
export const adminShipmentAccept = wrap(async (req, res) => {
  if (parse(empty, req, res)) res.json(await S.opsAccept(req.adminId, id(req)));
});
export const adminShipmentAssign = wrap(async (req, res) => {
  const b = parse(z.object({ courierUserId: z.string().min(1).max(64) }).strict(), req, res);
  if (b) res.json(await S.assignCourier({ type: 'admin', adminId: req.adminId }, id(req), b));
});
export const adminShipmentUnassign = wrap(async (req, res) => {
  const b = parse(reason, req, res);
  if (b) res.json(await S.unassignCourier({ type: 'admin', adminId: req.adminId }, id(req), b));
});
export const adminShipmentCancel = wrap(async (req, res) => {
  const b = parse(reason, req, res);
  if (b) res.json(await S.cancelShipment({ type: 'admin', adminId: req.adminId }, id(req), b));
});
export const adminShipmentRule = wrap(async (req, res) => {
  const b = parse(z.object({ outcome: z.enum(['delivered', 'failed']), evidence: z.string().min(10).max(300) }).strict(), req, res);
  if (b) res.json(await S.ruleException(req.adminId, id(req), b));
});
export const adminShipmentFailureRule = wrap(async (req, res) => {
  const b = parse(z.object({ side: z.enum(['receiver', 'source', 'courier', 'safety', 'platform']), confirmed: z.boolean(), note: z.string().min(10).max(300) }).strict(), req, res);
  if (b) res.json(await S.ruleFailure(req.adminId, id(req), b));
});
export const adminShipmentEmergencyReassign = wrap(async (req, res) => {
  const b = parse(z.object({ courierUserId: z.string().min(1).max(64), reason: z.string().min(10).max(300) }).strict(), req, res);
  if (b) res.json(await S.emergencyReassign({ type: 'admin', adminId: req.adminId }, id(req), b));
});
export const adminShipmentHandoffCode = wrap(async (req, res) => {
  if (parse(empty, req, res)) res.status(201).json(await S.issueHandoffCode({ type: 'admin', adminId: req.adminId }, id(req)));
});
export const adminDisputes = wrap(async (req, res) => res.json(await D.listOpenDisputes({ cursor: req.query.cursor, limit: req.query.limit })));
/** Ruling; `upheld_reverse` also files the maker/checker request a finance operator must approve. */
export const adminDisputeResolve = wrap(async (req, res) => {
  const b = parse(z.object({ outcome: z.enum(['rejected', 'upheld', 'upheld_reverse']), note: z.string().min(10).max(300) }).strict(), req, res);
  if (!b) return;
  const d = await D.resolveDispute(req.adminId, id(req), b);
  let approval = null;
  if (b.outcome === 'upheld_reverse' && d.status === 'awaiting_reversal') {
    const { requestApproval, approvalShape } = await import('../authz/approvals.js');
    approval = approvalShape(await requestApproval(prisma, req, { action: 'shipment_earning_reverse', payload: { disputeId: d.id }, reason: b.note, caseRef: `shipment:${d.shipmentId}` }));
  }
  res.json({ dispute: d, approval });
});
export const adminPickupPointDecide = wrap(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['active', 'suspended', 'closed']), reason: z.string().min(5).max(300) }).strict(), req, res);
  if (b) res.json(await decidePickupPoint(req.adminId, id(req), b));
});

/* ── cron: outbox intake, earnings hold release, precise-address retention ─ */
export async function runLogisticsCron() {
  const intake = await processLogisticsOutbox();
  const earnings = await promoteReleasableEarnings();
  const redaction = await S.redactPreciseDestinations();
  return { intake, earnings, redaction };
}
