import { z } from 'zod';
import { validationError } from '../validation.js';
import { OrgAccessError } from '../business-access.js';
import { assertStepUp, StepUpRequiredError } from '../step-up.js';
import { isMoneyError, moneyErrorStatus } from '../wallet-atomic.js';
import { CatalogB2bError, buyerCatalog, configureRelationship, createPriceList, listSellerListings, upsertListing, UNITS, AVAILABILITY } from './catalog.js';
import { CreditError } from './credit.js';
import { DepotError, depotMovements, depotPositions, recordStock } from './depot.js';
import { InvoiceError } from './invoices.js';
import { NetworkError, assignTerritoryRep, distributionAnalytics, relationshipsPage, reorderSuggestions, repSummary, restockOverview } from './network.js';
import {
  PurchaseOrderError,
  PO_TERMS_ALL,
  acceptPurchaseOrder,
  advancePurchaseOrder,
  buyerActOnPurchaseOrder,
  cancelPurchaseOrder,
  getInvoiceForBusiness,
  getPurchaseOrder,
  listInvoicesForBusiness,
  listPurchaseOrders,
  payInvoiceFromBusiness,
  payPurchaseOrder,
  quotePurchaseOrder,
  rejectPurchaseOrder,
  resolvePurchaseOrderDispute,
  sellerCreditMemo,
  submitPurchaseOrder,
} from './purchase-orders.js';
import { ReturnError, decideReturn, listReturns, receiveReturn, requestReturn, resolveReturn, shipReturn } from './returns.js';

/**
 * J7 B2B routes (thin). Every rule — authority, relationship, price, credit,
 * stock, state — lives in lib/b2b/*. Client-sent prices are not part of any
 * schema; the client sends only the total it was shown.
 */
const bid = (req) => String(req.query.id ?? '');
const sub = (req) => String(req.query.subId ?? '');
const ERRORS = [CatalogB2bError, CreditError, DepotError, InvoiceError, NetworkError, PurchaseOrderError, ReturnError];

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
    if (ERRORS.some((C) => error instanceof C)) return res.status(error.status).json({ error: error.message, code: error.code, ...(error.totalKori != null ? { totalKori: error.totalKori } : {}) });
    if (error instanceof StepUpRequiredError) return res.status(403).json({ error: error.message, code: error.code, reason: error.reason });
    if (isMoneyError(error)) return res.status(moneyErrorStatus(error)).json({ error: error.message, code: error.code ?? 'money_error' });
    throw error;
  }
};

const idem = (req) => String(req.headers?.['idempotency-key'] ?? req.body?.idempotencyKey ?? '');
const lines = z.array(z.object({ listingId: z.string().min(1).max(64), packs: z.number().int().positive().max(100_000) }).strict()).min(1).max(100);

/* seller: catalog & network */
export const b2bListingsHandler = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await listSellerListings(req.userId, bid(req), { cursor: req.query.cursor, limit: req.query.limit }));
  const body = parse(z.object({
    sku: z.string().min(1).max(40), title: z.string().min(2).max(120), category: z.string().max(60).optional(), productId: z.string().optional(),
    unit: z.enum(UNITS).optional(), unitsPerPack: z.number().int().positive().max(10_000).optional(), priceKori: z.number().int().positive(),
    tiers: z.array(z.object({ minPacks: z.number().int().min(2), priceKori: z.number().int().positive() })).max(10).optional(),
    moqPacks: z.number().int().positive().optional(), stepPacks: z.number().int().positive().optional(), availability: z.enum(AVAILABILITY).optional(),
    territoryIds: z.array(z.string()).max(50).optional(), depotLocationId: z.string().optional(), effectiveFrom: z.string().datetime().optional(), effectiveTo: z.string().datetime().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  }).strict(), req, res);
  if (body) res.status(201).json(await upsertListing(req.userId, bid(req), body));
});
export const b2bPriceListsHandler = wrap(async (req, res) => {
  const body = parse(z.object({ name: z.string().min(2).max(80), entries: z.array(z.object({ listingId: z.string(), priceKori: z.number().int().positive() })).min(1).max(500) }), req, res);
  if (body) res.status(201).json(await createPriceList(req.userId, bid(req), body));
});
export const b2bRelationshipConfigureHandler = wrap(async (req, res) => {
  const body = parse(z.object({ priceListId: z.string().nullable().optional(), assignedRepUserId: z.string().nullable().optional() }).strict(), req, res);
  if (body) res.json(await configureRelationship(req.userId, bid(req), sub(req), body));
});
export const b2bRelationshipsPageHandler = wrap(async (req, res) => res.json(await relationshipsPage(req.userId, bid(req), { cursor: req.query.cursor, limit: req.query.limit, status: req.query.status })));
export const b2bTerritoryRepHandler = wrap(async (req, res) => {
  const body = parse(z.object({ repUserId: z.string(), active: z.boolean().optional() }).strict(), req, res);
  if (body) res.json(await assignTerritoryRep(req.userId, bid(req), sub(req), body));
});
export const b2bDepotStockHandler = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await depotPositions(req.userId, bid(req), sub(req)));
  const body = parse(z.object({ productId: z.string(), units: z.number().int(), kind: z.enum(['receive', 'adjust']).optional(), note: z.string().max(200).optional() }).strict(), req, res);
  if (body) res.status(201).json(await recordStock(req.userId, bid(req), { locationId: sub(req), ...body }));
});
export const b2bDepotMovementsHandler = wrap(async (req, res) => res.json(await depotMovements(req.userId, bid(req), sub(req), { productId: req.query.productId, limit: req.query.limit })));
export const b2bAnalyticsHandler = wrap(async (req, res) => res.json(await distributionAnalytics(req.userId, bid(req))));
export const b2bRepSummaryHandler = wrap(async (req, res) => res.json(await repSummary(req.userId, bid(req))));

/* buyer: restock */
export const b2bSuppliersHandler = wrap(async (req, res) => res.json(await restockOverview(req.userId, bid(req))));
export const b2bSupplierCatalogHandler = wrap(async (req, res) => res.json(await buyerCatalog(req.userId, bid(req), sub(req), { cursor: req.query.cursor, limit: req.query.limit })));
export const b2bReorderHandler = wrap(async (req, res) => res.json(await reorderSuggestions(req.userId, bid(req), sub(req))));
export const b2bQuoteHandler = wrap(async (req, res) => {
  const body = parse(z.object({ sellerBusinessId: z.string(), lines }).strict(), req, res);
  if (body) res.json(await quotePurchaseOrder(req.userId, bid(req), body));
});

/* purchase orders (either side; :id decides which) */
export const b2bPurchaseOrdersHandler = wrap(async (req, res) => {
  if (req.method === 'GET') return res.json(await listPurchaseOrders(req.userId, bid(req), { side: req.query.side === 'seller' ? 'seller' : 'buyer', status: req.query.status, cursor: req.query.cursor, limit: req.query.limit }));
  const body = parse(z.object({ sellerBusinessId: z.string(), lines, paymentTerm: z.enum(PO_TERMS_ALL).default('due_now'), expectedTotalKori: z.number().int().nonnegative(), note: z.string().max(300).optional(), idempotencyKey: z.string().optional() }).strict(), req, res);
  if (!body) return;
  const out = await submitPurchaseOrder(req.userId, bid(req), { ...body, idempotencyKey: idem(req) });
  res.status(out.replayed ? 200 : 201).json(out);
});
export const b2bPurchaseOrderHandler = wrap(async (req, res) => res.json(await getPurchaseOrder(req.userId, bid(req), sub(req))));
export const b2bPoAcceptHandler = wrap(async (req, res) => {
  const body = parse(z.object({ depotLocationId: z.string().optional() }).strict(), req, res);
  if (body) res.json(await acceptPurchaseOrder(req.userId, bid(req), sub(req), body));
});
export const b2bPoRejectHandler = wrap(async (req, res) => {
  const body = parse(z.object({ reason: z.string().min(3).max(300) }).strict(), req, res);
  if (body) res.json(await rejectPurchaseOrder(req.userId, bid(req), sub(req), body));
});
export const b2bPoPayHandler = wrap(async (req, res) => {
  const body = parse(z.object({ expectedAmountKori: z.number().int().positive() }).strict(), req, res);
  if (!body) return;
  await assertStepUp(req, 'business_payment');
  res.json(await payPurchaseOrder(req.userId, bid(req), sub(req), body));
});
export const b2bPoAdvanceHandler = wrap(async (req, res) => {
  const body = parse(z.object({ to: z.enum(['preparing', 'ready', 'fulfilment_requested', 'delivered']), fulfilmentMode: z.string().max(40).optional(), note: z.string().max(300).optional() }).strict(), req, res);
  if (body) res.json(await advancePurchaseOrder(req.userId, bid(req), sub(req), body));
});
export const b2bPoBuyerHandler = wrap(async (req, res) => {
  const body = parse(z.object({ action: z.enum(['receive', 'complete', 'dispute']), reason: z.string().max(300).optional() }).strict(), req, res);
  if (body) res.json(await buyerActOnPurchaseOrder(req.userId, bid(req), sub(req), body));
});
export const b2bPoResolveHandler = wrap(async (req, res) => {
  const body = parse(z.object({ note: z.string().min(5).max(300) }).strict(), req, res);
  if (body) res.json(await resolvePurchaseOrderDispute(req.userId, bid(req), sub(req), body));
});
export const b2bPoCancelHandler = wrap(async (req, res) => {
  const body = parse(z.object({ reason: z.string().min(3).max(300) }).strict(), req, res);
  if (body) res.json(await cancelPurchaseOrder(req.userId, bid(req), sub(req), body));
});
export const b2bPoReturnHandler = wrap(async (req, res) => {
  const body = parse(z.object({ lines, reason: z.string().min(5).max(300), idempotencyKey: z.string().optional() }).strict(), req, res);
  if (!body) return;
  const out = await requestReturn(req.userId, bid(req), sub(req), { ...body, idempotencyKey: idem(req) });
  res.status(out.replayed ? 200 : 201).json(out);
});

/* invoices */
export const b2bInvoicesHandler = wrap(async (req, res) => res.json(await listInvoicesForBusiness(req.userId, bid(req), { side: req.query.side === 'seller' ? 'seller' : 'buyer', cursor: req.query.cursor, limit: req.query.limit, pastDueOnly: req.query.pastDue === '1' })));
export const b2bInvoiceHandler = wrap(async (req, res) => res.json(await getInvoiceForBusiness(req.userId, bid(req), sub(req))));
export const b2bInvoicePayHandler = wrap(async (req, res) => {
  const body = parse(z.object({ amountKori: z.number().int().positive(), idempotencyKey: z.string().optional() }).strict(), req, res);
  if (!body) return;
  await assertStepUp(req, 'business_payment');
  res.json(await payInvoiceFromBusiness(req.userId, bid(req), sub(req), { amountKori: body.amountKori, idempotencyKey: idem(req) }));
});
export const b2bCreditMemoHandler = wrap(async (req, res) => {
  const body = parse(z.object({ amountKori: z.number().int().positive(), reason: z.string().min(5).max(300), reference: z.string().min(4).max(60) }).strict(), req, res);
  if (body) res.status(201).json(await sellerCreditMemo(req.userId, bid(req), sub(req), body));
});

/* returns */
export const b2bReturnsHandler = wrap(async (req, res) => res.json(await listReturns(req.userId, bid(req), { side: req.query.side === 'seller' ? 'seller' : 'buyer' })));
export const b2bReturnDecideHandler = wrap(async (req, res) => {
  const body = parse(z.object({ approve: z.boolean(), note: z.string().max(300).optional() }).strict(), req, res);
  if (body) res.json(await decideReturn(req.userId, bid(req), sub(req), body));
});
export const b2bReturnShipHandler = wrap(async (req, res) => res.json(await shipReturn(req.userId, bid(req), sub(req))));
export const b2bReturnReceiveHandler = wrap(async (req, res) => {
  const body = parse(z.object({ restock: z.boolean().optional() }).strict(), req, res);
  if (body) res.json(await receiveReturn(req.userId, bid(req), sub(req), body));
});
export const b2bReturnResolveHandler = wrap(async (req, res) => {
  const body = parse(z.object({ resolution: z.enum(['credit_memo', 'refund', 'none']), note: z.string().max(300).optional() }).strict(), req, res);
  if (body) res.json(await resolveReturn(req.userId, bid(req), sub(req), body));
});
