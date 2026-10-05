import { z } from 'zod';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import { OrgAccessError } from './business-access.js';
import {
  adminDecideVerification,
  businessAccess,
  businessProfile,
  createLocation,
  requestVerification,
  switchSettlementToBusiness,
  updateBusinessProfile,
  updateLocation,
} from './business/identity.js';
import { businessAnalytics, businessCustomers, businessMoney, businessToday } from './business/operations.js';
import { CatalogError, createCatalogItem, listCatalog, updateCatalogItem } from './commerce/catalog.js';
import { InventoryError, adjustStock, stockHistory } from './commerce/inventory.js';
import {
  OrderError,
  ORDER_LABELS,
  businessOrderDetail,
  buyerComplete,
  cancelOrder,
  listBusinessOrders,
  merchantTransition,
  refundOrder,
} from './commerce/orders.js';
import { listBusinessCharges } from './money/charges.js';
import { imageRef } from './commerce/media.js';

/**
 * J5 Merchant + Business OS routes (docs/JOKKO-J5-REPORT.md). Thin: every
 * rule lives in lib/business/* and lib/commerce/*; every route re-checks the
 * caller's business capability server-side.
 */
const bid = (req) => String(req.query.id ?? '');
const httpsUrl = imageRef;
const sub = (req) => String(req.query.subId ?? '');

function fail(res, error) {
  if (error instanceof OrgAccessError) {
    res.status(error.status).json({ error: error.message, code: error.status === 404 ? 'not_found' : 'not_authorized' });
    return true;
  }
  if (error instanceof OrderError || error instanceof InventoryError || error instanceof CatalogError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (fail(res, error)) return;
    throw error;
  }
};

const parse = (schema, req, res) => {
  const p = schema.safeParse(req.body ?? {});
  if (!p.success) {
    validationError(res, p.error);
    return null;
  }
  return p.data;
};

// ── Identity / profile / locations ──────────────────────────────────────────
export const bizAccessHandler = wrap(async (req, res) => res.json(await businessAccess(req.userId, bid(req))));
export const bizProfileHandler = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await businessProfile(req.userId, bid(req)));
  const body = parse(
    z.object({
      name: z.string().min(2).max(80).optional(),
      category: z.string().max(60).optional(),
      description: z.string().max(1000).optional(),
      address: z.string().max(200).optional(),
      phone: z.string().max(30).optional(),
      imageUrl: httpsUrl.optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
    }),
    req,
    res,
  );
  if (body) res.json(await updateBusinessProfile(req.userId, bid(req), body));
});
const locationBody = z.object({ name: z.string().min(2).max(80), address: z.string().max(200).optional(), lat: z.number().optional(), lng: z.number().optional() });
export const bizLocationCreateHandler = wrap(async (req, res) => {
  const body = parse(locationBody, req, res);
  if (body) res.status(201).json(await createLocation(req.userId, bid(req), body));
});
export const bizLocationUpdateHandler = wrap(async (req, res) => {
  const body = parse(locationBody.partial().extend({ active: z.boolean().optional() }), req, res);
  if (body) res.json(await updateLocation(req.userId, bid(req), sub(req), body));
});
export const bizSettlementHandler = wrap(async (req, res) => res.json(await switchSettlementToBusiness(req.userId, bid(req))));
export const bizVerificationRequestHandler = wrap(async (req, res) => {
  const body = parse(z.object({ note: z.string().max(500).optional() }), req, res);
  if (body) res.json(await requestVerification(req.userId, bid(req), body));
});

// ── Catalog / stock ─────────────────────────────────────────────────────────
const itemBody = z.object({
  kind: z.enum(['product', 'service']).default('product'),
  title: z.string().min(2).max(120),
  description: z.string().max(2000).optional(),
  sku: z.string().min(1).max(40).optional(),
  category: z.string().max(60).optional(),
  imageUrl: httpsUrl.optional(),
  priceKori: z.number().int().positive(),
  unitLabel: z.string().max(32).optional(),
  trackInventory: z.boolean().optional(),
  allowBackorder: z.boolean().optional(),
  lowStockThreshold: z.number().int().min(0).max(9999).optional(),
  initialStock: z.number().int().min(0).max(1_000_000).optional(),
  active: z.boolean().optional(),
});
export const bizCatalogHandler = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await listCatalog(req.userId, bid(req)));
  const body = parse(itemBody, req, res);
  if (body) res.status(201).json(await createCatalogItem(req.userId, bid(req), body));
});
export const bizCatalogItemHandler = wrap(async (req, res) => {
  const body = parse(
    itemBody.omit({ kind: true, initialStock: true, trackInventory: true }).partial().extend({ sku: z.string().min(1).max(40).nullable().optional(), inventory: z.number().optional() }),
    req,
    res,
  );
  if (body) res.json(await updateCatalogItem(req.userId, bid(req), sub(req), body));
});
export const bizStockAdjustHandler = wrap(async (req, res) => {
  const body = parse(z.object({ delta: z.number().int().optional(), count: z.number().int().min(-1_000_000).max(1_000_000).optional(), note: z.string().min(3).max(300) }), req, res);
  if (body) res.json(await adjustStock(req.userId, bid(req), sub(req), body));
});
export const bizStockHistoryHandler = wrap(async (req, res) => {
  const { requireBusinessCapability } = await import('./business-access.js');
  await requireBusinessCapability(req.userId, bid(req), 'business.catalog.manage').catch(() => requireBusinessCapability(req.userId, bid(req), 'business.inventory.adjust'));
  res.json(await stockHistory(bid(req), sub(req), { limit: req.query.limit }));
});

// ── Orders ──────────────────────────────────────────────────────────────────
export const bizOrdersHandler = wrap(async (req, res) => res.json(await listBusinessOrders(req.userId, bid(req), { status: req.query.status, limit: req.query.limit, before: req.query.before })));
export const bizOrderHandler = wrap(async (req, res) => res.json(await businessOrderDetail(req.userId, bid(req), sub(req))));

async function assertOrderInBusiness(req) {
  const o = await prisma.order.findFirst({ where: { id: sub(req), businessId: bid(req) }, select: { id: true } });
  if (!o) throw new OrderError('not_found', 'Commande introuvable', 404);
}
export const bizOrderStatusHandler = wrap(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['preparing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'completed']) }), req, res);
  if (!body) return;
  await assertOrderInBusiness(req);
  res.json(await merchantTransition(req.userId, sub(req), body.status));
});
export const bizOrderCancelHandler = wrap(async (req, res) => {
  const body = parse(z.object({ reason: z.string().min(3).max(300) }), req, res);
  if (!body) return;
  await assertOrderInBusiness(req);
  res.json(await cancelOrder(req.userId, sub(req), { as: 'merchant', reason: body.reason }));
});
export const bizOrderRefundHandler = wrap(async (req, res) => {
  const body = parse(z.object({ reason: z.string().min(3).max(300), restock: z.boolean().optional() }), req, res);
  if (!body) return;
  await assertOrderInBusiness(req);
  res.json(await refundOrder(req.userId, sub(req), body));
});
/** Buyer side. */
export const buyerOrderCancelHandler = wrap(async (req, res) => {
  const body = parse(z.object({ reason: z.string().min(3).max(300) }), req, res);
  if (body) res.json(await cancelOrder(req.userId, String(req.query.id ?? ''), { as: 'buyer', reason: body.reason }));
});
export const buyerOrderCompleteHandler = wrap(async (req, res) => res.json(await buyerComplete(req.userId, String(req.query.id ?? ''))));

/** Legacy `PATCH marketplace/orders/:id/status` → the same locked, capability-checked state machine. */
export const legacyOrderStatusHandler = wrap(async (req, res) => {
  const body = parse(z.object({ status: z.string() }), req, res);
  if (!body) return;
  const out = await merchantTransition(req.userId, String(req.query.id ?? ''), body.status);
  res.json({ id: out.orderId, status: out.status, statusLabel: ORDER_LABELS[out.status] });
});

// ── Money / analytics / customers / today / charges ─────────────────────────
export const bizMoneyHandler = wrap(async (req, res) => res.json(await businessMoney(req.userId, bid(req), { limit: req.query.limit, before: req.query.before })));
export const bizAnalyticsHandler = wrap(async (req, res) => res.json(await businessAnalytics(req.userId, bid(req), { period: String(req.query.period ?? '30d') })));
export const bizCustomersHandler = wrap(async (req, res) => res.json(await businessCustomers(req.userId, bid(req), { limit: req.query.limit })));
export const bizTodayHandler = wrap(async (req, res) => res.json(await businessToday(req.userId, bid(req))));
export const bizChargesHandler = wrap(async (req, res) => res.json(await listBusinessCharges(req.userId, bid(req), { status: req.query.status, limit: req.query.limit })));

// ── Operator support (read-only) + verification decision ────────────────────
/**
 * Locate a business by id, Kebu id, name, an order reference or a charge
 * code. Returns verification, settlement, authority history, order/charge
 * states and money position — never customer PII, never a write.
 */
export async function adminBusinessLookupHandler(req, res) {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3) return res.status(400).json({ error: 'Requête trop courte' });
  let business =
    (await prisma.business.findFirst({ where: { OR: [{ id: q }, { kebuId: q }] } })) ??
    (await prisma.order.findFirst({ where: { OR: [{ id: q }, { orderReference: q }] }, select: { business: true } }))?.business ??
    (await prisma.merchantCharge.findFirst({ where: { code: q }, select: { businessId: true } }).then((c) => (c ? prisma.business.findUnique({ where: { id: c.businessId } }) : null)));
  if (!business) {
    const matches = await prisma.business.findMany({ where: { name: { contains: q, mode: 'insensitive' } }, select: { id: true, name: true, kebuId: true, verificationStatus: true }, take: 10 });
    return matches.length ? res.json({ matches }) : res.status(404).json({ error: 'Commerce introuvable' });
  }
  const b = business;
  const [owner, members, events, orderStates, refunded, charges, acc] = await Promise.all([
    prisma.user.findUnique({ where: { id: b.ownerId }, select: { handle: true } }),
    prisma.businessMember.findMany({ where: { businessId: b.id }, include: { user: { select: { handle: true } } }, orderBy: { createdAt: 'asc' } }),
    prisma.identityAuditEvent.findMany({ where: { subjectType: 'business', subjectId: b.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.order.groupBy({ by: ['status'], where: { businessId: b.id }, _count: true }),
    prisma.order.findMany({ where: { businessId: b.id, refundReference: { not: null } }, select: { id: true, orderReference: true, status: true, refundReference: true, refundedAt: true }, orderBy: { refundedAt: 'desc' }, take: 20 }),
    prisma.merchantCharge.groupBy({ by: ['status'], where: { businessId: b.id }, _count: true }),
    prisma.ledgerAccount.findUnique({ where: { code: `business:${b.id}:wallet` }, select: { balance: true } }),
  ]);
  // Settlement integrity for this business: the legacy projection must equal the ledger.
  const projection = await prisma.businessWallet.findUnique({ where: { businessId: b.id }, select: { balance: true } });
  res.json({
    business: { id: b.id, name: b.name, kebuId: b.kebuId, type: b.type, category: b.category, createdAt: b.createdAt.toISOString() },
    owner: { handle: owner?.handle ?? null },
    verification: { status: b.verificationStatus, verified: b.verified, verifiedAt: b.verifiedAt?.toISOString() ?? null, note: b.verificationNote },
    settlement: b.settlementMode,
    walletBalanceKori: acc ? Number(acc.balance) : 0,
    staff: members.map((m) => ({ handle: m.user?.handle ?? null, role: m.role, status: m.status, invitedAt: m.invitedAt?.toISOString() ?? null, acceptedAt: m.acceptedAt?.toISOString() ?? null, removedAt: m.removedAt?.toISOString() ?? null, removedReason: m.removedReason })),
    authorityHistory: events.map((e) => ({ action: e.action, actorType: e.actorType, at: e.createdAt.toISOString(), reason: e.reason, before: e.beforeJson ? JSON.parse(e.beforeJson) : null, after: e.afterJson ? JSON.parse(e.afterJson) : null })),
    orders: Object.fromEntries(orderStates.map((o) => [o.status, o._count])),
    refunds: refunded.map((o) => ({ orderId: o.id, orderReference: o.orderReference, status: o.status, refundReference: o.refundReference, refundedAt: o.refundedAt?.toISOString() ?? null })),
    charges: Object.fromEntries(charges.map((c) => [c.status, c._count])),
    settlementIntegrity: {
      ledgerKori: acc ? Number(acc.balance) : 0,
      projectionKori: projection?.balance ?? 0,
      ok: (acc ? Number(acc.balance) : 0) === (projection?.balance ?? 0),
      note: 'Les opérations de commerce ne passent pas par un prestataire : une exception de rapprochement serait un écart grand livre / projection.',
    },
    canSupportChangeAnything: false,
    hint: 'Pour une référence de paiement précise : GET admin/money/lookup?reference=…',
  });
}

export async function adminBusinessVerificationHandler(req, res) {
  const body = parse(z.object({ decision: z.enum(['verified', 'rejected', 'unverified']), note: z.string().min(3).max(500) }), req, res);
  if (!body) return;
  try {
    res.json(await adminDecideVerification(req.adminId, String(req.query.id ?? ''), body));
  } catch (error) {
    if (fail(res, error)) return;
    throw error;
  }
}

// ── J5 economic-OS contracts ────────────────────────────────────────────────
import {
  DistributionError,
  createTerritory,
  distributorRelationships,
  endRelationship,
  inviteMerchant,
  listTerritories,
  merchantRelationships,
  myDistributionInvitations,
  respondToRelationship,
} from './business/distribution.js';
import { AcceptanceError, acceptanceCatalog, listBusinessPayments, recordManualSale } from './commerce/acceptance.js';
import { CHANNELS } from './commerce/channels.js';
import { AddressError, createAddress, listMyAddresses, viewAddress } from './geo/address.js';
import { IntegrationError, KABU_CONTRACT, createBusinessLinkCode, listBusinessLinks, partnerLinkBusiness, revokeBusinessLink } from './integrations/kabu.js';
import { recordIdentityEvent } from './identity/audit.js';

function failMore(res, error) {
  for (const C of [DistributionError, AcceptanceError, AddressError, IntegrationError]) {
    if (error instanceof C) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return true;
    }
  }
  return fail(res, error);
}
const wrap2 = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (failMore(res, error)) return;
    throw error;
  }
};

/** Owner-only: the operating mode changes what the business can do (e.g. distribution). */
export const bizOperatingModeHandler = wrap2(async (req, res) => {
  const body = parse(z.object({ mode: z.enum(['retail', 'services', 'restaurant', 'distribution', 'wholesale', 'manufacturer', 'cooperative']) }), req, res);
  if (!body) return;
  const b = await prisma.business.findUnique({ where: { id: bid(req) } });
  if (!b) throw new OrgAccessError('Business not found', 404);
  if (b.ownerId !== req.userId) throw new OrgAccessError('Seul le propriétaire change le mode d’activité');
  await prisma.$transaction(async (tx) => {
    await tx.business.update({ where: { id: b.id }, data: { operatingMode: body.mode } });
    await recordIdentityEvent(tx, { actorType: 'user', actorId: req.userId, action: 'business_operating_mode_changed', subjectType: 'business', subjectId: b.id, before: { mode: b.operatingMode }, after: { mode: body.mode } });
  });
  res.json({ mode: body.mode });
});

export const distTerritoriesHandler = wrap2(async (req, res) => {
  if (req.method === 'GET') return res.json(await listTerritories(req.userId, bid(req)));
  const body = parse(z.object({ name: z.string().min(2).max(80), region: z.string().max(60).optional(), department: z.string().max(60).optional(), communes: z.string().max(400).optional() }), req, res);
  if (body) res.status(201).json(await createTerritory(req.userId, bid(req), body));
});
export const distRelationshipsHandler = wrap2(async (req, res) => {
  if (req.method === 'GET') return res.json(await distributorRelationships(req.userId, bid(req)));
  const body = parse(z.object({ merchantBusinessId: z.string().optional(), merchantHandle: z.string().min(3).optional(), territoryId: z.string().optional(), assisted: z.boolean().optional() }), req, res);
  if (body) res.status(201).json(await inviteMerchant(req.userId, bid(req), body));
});
export const merchantRelationshipsHandler = wrap2(async (req, res) => res.json(await merchantRelationships(req.userId, bid(req))));
export const merchantRelationshipRespondHandler = wrap2(async (req, res) => {
  const body = parse(z.object({ accept: z.boolean() }), req, res);
  if (!body) return;
  const r = await prisma.merchantRelationship.findFirst({ where: { id: sub(req), merchantBusinessId: bid(req) } });
  if (!r) throw new DistributionError('not_found', 'Invitation introuvable', 404);
  res.json(await respondToRelationship(req.userId, r.id, body));
});
export const merchantRelationshipEndHandler = wrap2(async (req, res) => {
  const r = await prisma.merchantRelationship.findFirst({ where: { id: sub(req), OR: [{ merchantBusinessId: bid(req) }, { distributorBusinessId: bid(req) }] } });
  if (!r) throw new DistributionError('not_found', 'Relation introuvable', 404);
  res.json(await endRelationship(req.userId, r.id));
});
export const myDistributionInvitationsHandler = wrap2(async (req, res) => res.json(await myDistributionInvitations(req.userId)));
export const myDistributionInvitationRespondHandler = wrap2(async (req, res) => {
  const body = parse(z.object({ accept: z.boolean(), merchantBusinessId: z.string().optional() }), req, res);
  if (body) res.json(await respondToRelationship(req.userId, String(req.query.id ?? ''), body));
});

export const bizPaymentsHandler = wrap2(async (req, res) => res.json(await listBusinessPayments(req.userId, bid(req), { limit: req.query.limit })));
export const bizManualSaleHandler = wrap2(async (req, res) => {
  const body = parse(z.object({ method: z.enum(['cash', 'manual']).default('cash'), amountKori: z.number().int().positive(), note: z.string().max(200).optional(), externalRef: z.string().max(60).optional() }), req, res);
  if (body) res.status(201).json(await recordManualSale(req.userId, bid(req), body));
});
/** What can be offered as payment / channel — DORMANT items are listed as such, never as available. */
export const commerceCapabilitiesHandler = wrap2(async (_req, res) =>
  res.json({ paymentMethods: acceptanceCatalog(), channels: Object.entries(CHANNELS).map(([key, c]) => ({ key, ...c })), kabuContract: KABU_CONTRACT }),
);

const addressBody = z.object({
  ownerType: z.enum(['user', 'business']),
  ownerId: z.string().min(1),
  purpose: z.enum(['home', 'business', 'store', 'warehouse', 'pickup_point', 'delivery_destination', 'farm', 'factory', 'fulfillment_center']),
  visibility: z.enum(['private', 'counterparty', 'public']).optional(),
  country: z.string().length(2).optional(),
  region: z.string().max(60).optional(),
  department: z.string().max(60).optional(),
  city: z.string().max(80).optional(),
  commune: z.string().max(80).optional(),
  neighborhood: z.string().max(80).optional(),
  street: z.string().max(120).optional(),
  building: z.string().max(80).optional(),
  landmark: z.string().max(160).optional(),
  instructions: z.string().max(300).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
export const addressesHandler = wrap2(async (req, res) => {
  if (req.method === 'GET') return res.json(await listMyAddresses(req.userId));
  const body = parse(addressBody, req, res);
  if (body) res.status(201).json(await createAddress(req.userId, body));
});
export const addressViewHandler = wrap2(async (req, res) => res.json(await viewAddress(req.userId, String(req.query.id ?? ''), { orderId: req.query.orderId ? String(req.query.orderId) : undefined })));

export const bizLinkCodeHandler = wrap2(async (req, res) => res.status(201).json(await createBusinessLinkCode(req.userId, bid(req), 'kebu')));
export const bizLinksHandler = wrap2(async (req, res) => res.json(await listBusinessLinks(req.userId, bid(req))));
export const bizLinkRevokeHandler = wrap2(async (req, res) => res.json(await revokeBusinessLink(req.userId, bid(req), sub(req))));
/** Partner (Kabu) side — partner-key authenticated. */
export async function partnerBusinessLinkHandler(req, res) {
  const { requirePartner } = await import('./partner-handlers.js');
  if (!requirePartner(req, res)) return;
  const body = req.body ?? {};
  try {
    res.status(201).json(await partnerLinkBusiness(req.partnerId, { code: body.code, externalBusinessId: body.external_business_id }));
  } catch (error) {
    if (failMore(res, error)) return;
    throw error;
  }
}
