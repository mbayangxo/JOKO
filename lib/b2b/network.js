import { prisma } from '../prisma.js';
import { OrgAccessError, requireBusinessCapability } from '../business-access.js';
import { businessAccess } from '../business/identity.js';
import { DISTRIBUTION_MODES } from '../business/distribution.js';
import { activeRelationship } from './catalog.js';
import { creditSummary } from './credit.js';

/**
 * J7.4 / J7.11–J7.13 / J7.21–J7.23 — the distribution network around a
 * supplier: reps and territories, the merchant's restock view, evidence-based
 * reorder suggestions, the supplier's own analytics and privacy-preserving
 * demand aggregates.
 *
 * Territories are OPERATIONAL (who covers which merchants, which listings are
 * offered where). They are never a security grant: every read still checks
 * business capability + relationship; a rep assigned to a territory sees only
 * the relationships they introduced or were assigned, and nothing about the
 * merchant beyond the relationship card.
 */
export class NetworkError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
    this.status = status;
  }
}

async function requireDistributor(userId, sellerId, capability) {
  const b = await requireBusinessCapability(userId, sellerId, capability);
  if (!DISTRIBUTION_MODES.has(b.operatingMode)) throw new NetworkError('not_a_distributor', 'Activez le mode distribution / grossiste pour ce commerce');
  return b;
}

/* ── Reps & territories (J7.4, J7.13) ──────────────────────────────────── */

export async function assignTerritoryRep(userId, sellerId, territoryId, { repUserId, active = true }) {
  await requireDistributor(userId, sellerId, 'business.distribution.manage');
  const t = await prisma.territory.findFirst({ where: { id: territoryId, distributorBusinessId: sellerId } });
  if (!t) throw new NetworkError('not_found', 'Territoire introuvable', 404);
  const m = await prisma.businessMember.findFirst({ where: { businessId: sellerId, userId: repUserId, status: 'active' } });
  if (!m) throw new NetworkError('not_a_member', 'Ce commercial n’est pas membre actif', 400);
  const row = await prisma.territoryRep.upsert({
    where: { territoryId_repUserId: { territoryId, repUserId } },
    create: { territoryId, repUserId, assignedBy: userId, status: active ? 'active' : 'ended' },
    update: { status: active ? 'active' : 'ended', assignedBy: userId },
  });
  return { territoryId, status: row.status };
}

function relCard(r, merchants, territories) {
  const m = merchants.get(r.merchantBusinessId);
  return {
    id: r.id,
    status: r.status,
    merchant: m ? { name: m.name, category: m.category, verified: m.verified } : { pendingOnboarding: true },
    territory: territories.get(r.territoryId)?.name ?? null,
    assistedOnboarding: r.assistedOnboarding,
    scopes: JSON.parse(r.scopesJson),
    invitedAt: r.invitedAt.toISOString(),
  };
}

/**
 * Paginated relationship list for a distributor (scales to thousands).
 * Managers: all. Reps (distribution.invite only): introduced by them OR
 * assigned to them — never every merchant of the territory.
 */
export async function relationshipsPage(userId, sellerId, { cursor, limit = 100, status } = {}) {
  await requireDistributor(userId, sellerId, 'business.distribution.invite');
  const caps = new Set((await businessAccess(userId, sellerId)).capabilities);
  const scope = caps.has('business.distribution.manage') ? {} : { OR: [{ introducedByUserId: userId }, { assignedRepUserId: userId }] };
  const take = Math.min(Math.max(1, Number(limit) || 100), 200);
  const rows = await prisma.merchantRelationship.findMany({
    where: { distributorBusinessId: sellerId, ...(status ? { status: String(status) } : {}), ...scope },
    orderBy: { id: 'asc' },
    take: take + 1,
    ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
  });
  const page = rows.slice(0, take);
  const [merchants, territories] = await Promise.all([
    prisma.business.findMany({ where: { id: { in: page.map((r) => r.merchantBusinessId).filter(Boolean) } }, select: { id: true, name: true, category: true, verified: true } }),
    prisma.territory.findMany({ where: { id: { in: page.map((r) => r.territoryId).filter(Boolean) } }, select: { id: true, name: true } }),
  ]);
  const mm = new Map(merchants.map((m) => [m.id, m]));
  const tm = new Map(territories.map((t) => [t.id, t]));
  return { items: page.map((r) => relCard(r, mm, tm)), nextCursor: rows.length > take ? page[page.length - 1].id : null };
}

/* ── Restock (J7.11) and reorder suggestions (J7.12) ──────────────────── */

/** Merchant's restock home: connected suppliers, credit headroom, open orders. Phone-first, small payload. */
export async function restockOverview(userId, buyerId) {
  await requireBusinessCapability(userId, buyerId, 'business.purchasing');
  const buyer = await prisma.business.findUnique({ where: { id: buyerId }, select: { ownerId: true } });
  const rels = await prisma.merchantRelationship.findMany({ where: { merchantBusinessId: buyerId, status: 'active' }, take: 100 });
  const ordering = rels.filter((r) => JSON.parse(r.scopesJson).includes('wholesale_catalog'));
  const sellers = await prisma.business.findMany({ where: { id: { in: ordering.map((r) => r.distributorBusinessId) } }, select: { id: true, name: true, verified: true, status: true } });
  const out = [];
  for (const s of sellers) {
    const [credit, open] = await Promise.all([
      creditSummary(prisma, { supplierBusinessId: s.id, buyerUserId: buyer.ownerId }),
      prisma.purchaseOrder.count({ where: { buyerBusinessId: buyerId, sellerBusinessId: s.id, status: { notIn: ['completed', 'cancelled', 'rejected'] } } }),
    ]);
    out.push({ supplierBusinessId: s.id, name: s.name, verified: s.verified, accepting: s.status === 'active', terms: credit.terms, availableCreditKori: credit.availableKori, openOrders: open });
  }
  return { suppliers: out };
}

/**
 * Suggestions from THIS merchant's own delivered purchase history with this
 * supplier. Never an order: the merchant reviews, edits and submits. Each
 * suggestion carries its evidence; confidence is at most "medium" — demand
 * at the merchant's shelf is not observed, only past purchases.
 */
export async function reorderSuggestions(userId, buyerId, sellerId, { now = new Date() } = {}) {
  await requireBusinessCapability(userId, buyerId, 'business.purchasing');
  const rel = await activeRelationship(prisma, { sellerId, buyerId, scope: 'wholesale_catalog' });
  if (!rel) throw new OrgAccessError('Fournisseur introuvable', 404);
  const since = new Date(now.getTime() - 180 * 86_400_000);
  const pos = await prisma.purchaseOrder.findMany({
    where: { buyerBusinessId: buyerId, sellerBusinessId: sellerId, status: { in: ['delivered', 'received', 'completed'] }, deliveredAt: { gte: since } },
    select: { id: true, deliveredAt: true },
    orderBy: { deliveredAt: 'asc' },
  });
  const lines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: { in: pos.map((p) => p.id) } } });
  const listings = await prisma.wholesaleListing.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.listingId))] }, sellerBusinessId: sellerId, status: 'active' } });
  const byListing = new Map();
  for (const l of lines) {
    const at = pos.find((p) => p.id === l.purchaseOrderId).deliveredAt;
    if (!byListing.has(l.listingId)) byListing.set(l.listingId, []);
    byListing.get(l.listingId).push({ at, packs: l.packs });
  }
  const suggestions = [];
  for (const [listingId, hist] of byListing) {
    const listing = listings.find((x) => x.id === listingId);
    if (!listing || listing.availability === 'out_of_stock') continue;
    hist.sort((a, b) => a.at - b.at);
    const n = hist.length;
    const avgPacks = hist.reduce((a, h) => a + h.packs, 0) / n;
    const intervals = hist.slice(1).map((h, i) => (h.at - hist[i].at) / 86_400_000);
    const avgInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null;
    const daysSinceLast = (now - hist[n - 1].at) / 86_400_000;
    if (n < 2 || avgInterval === null || daysSinceLast < 0.8 * avgInterval) continue;
    let packs = Math.max(listing.moqPacks, Math.round(avgPacks));
    const over = (packs - listing.moqPacks) % listing.stepPacks;
    if (over) packs += listing.stepPacks - over;
    suggestions.push({
      listingId,
      sku: listing.sku,
      title: listing.title,
      suggestedPacks: packs,
      confidence: n >= 4 ? 'medium' : 'low',
      evidence: { deliveredOrders: n, averagePacks: Math.round(avgPacks * 10) / 10, averageDaysBetween: Math.round(avgInterval), daysSinceLast: Math.round(daysSinceLast), windowDays: 180 },
      basis: 'past_purchases_only',
    });
  }
  return { suggestions, autoOrder: false, note: 'Suggestions basées sur tes achats passés uniquement — vérifie ton stock avant de commander.' };
}

/* ── Supplier analytics (J7.22) ──────────────────────────────────────── */

/**
 * The supplier's OWN trade: its relationships, its purchase orders, its
 * listings' volumes, its receivables. Never a merchant's retail sales,
 * wallet, customers or other suppliers. Managers (distribution.manage or
 * analytics.read) only; reps get `repSummary` (counts of their own book).
 */
export async function distributionAnalytics(userId, sellerId, { since = new Date(Date.now() - 90 * 86_400_000) } = {}) {
  const b = await prisma.business.findUnique({ where: { id: sellerId }, select: { operatingMode: true } });
  if (!b) throw new OrgAccessError('Business not found', 404);
  await requireBusinessCapability(userId, sellerId, 'business.distribution.manage').catch(() => requireBusinessCapability(userId, sellerId, 'business.analytics.read'));
  const [rels, pos, top, recv, pastDue] = await Promise.all([
    prisma.merchantRelationship.groupBy({ by: ['status'], where: { distributorBusinessId: sellerId }, _count: true }),
    prisma.purchaseOrder.groupBy({ by: ['status'], where: { sellerBusinessId: sellerId, createdAt: { gte: since } }, _count: true, _sum: { totalKori: true } }),
    prisma.$queryRaw`
      SELECT l."sku", l."title", SUM(l."packs")::int AS packs, SUM(l."lineTotalKori")::int AS "amountKori", COUNT(DISTINCT po."buyerBusinessId")::int AS buyers
        FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" po ON po.id = l."purchaseOrderId"
       WHERE po."sellerBusinessId" = ${sellerId} AND po."createdAt" >= ${since} AND po.status NOT IN ('rejected', 'cancelled')
       GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 20`,
    prisma.tradeInvoice.aggregate({ where: { supplierBusinessId: sellerId, status: { in: ['open', 'partial', 'overdue', 'disputed'] } }, _sum: { amountKori: true, amountPaid: true, creditedKori: true }, _count: true }),
    prisma.tradeInvoice.aggregate({ where: { supplierBusinessId: sellerId, status: { in: ['open', 'partial', 'overdue'] }, dueAt: { lt: new Date() } }, _sum: { amountKori: true, amountPaid: true, creditedKori: true }, _count: true }),
  ]);
  const net = (a) => (a._sum.amountKori ?? 0) - (a._sum.amountPaid ?? 0) - (a._sum.creditedKori ?? 0);
  return {
    since: since.toISOString(),
    relationships: Object.fromEntries(rels.map((r) => [r.status, r._count])),
    purchaseOrders: Object.fromEntries(pos.map((p) => [p.status, { count: p._count, totalKori: p._sum.totalKori ?? 0 }])),
    topListings: top,
    receivables: { openInvoices: recv._count, outstandingKori: net(recv), pastDueInvoices: pastDue._count, pastDueKori: net(pastDue) },
  };
}

/** A rep's own book: counts only. */
export async function repSummary(userId, sellerId) {
  await requireDistributor(userId, sellerId, 'business.distribution.invite');
  const mine = { distributorBusinessId: sellerId, OR: [{ introducedByUserId: userId }, { assignedRepUserId: userId }] };
  const [byStatus, active] = await Promise.all([
    prisma.merchantRelationship.groupBy({ by: ['status'], where: mine, _count: true }),
    prisma.merchantRelationship.findMany({ where: { ...mine, status: 'active' }, select: { merchantBusinessId: true }, take: 5000 }),
  ]);
  const orders = await prisma.purchaseOrder.count({ where: { sellerBusinessId: sellerId, buyerBusinessId: { in: active.map((a) => a.merchantBusinessId).filter(Boolean) }, status: { notIn: ['rejected', 'cancelled'] } } });
  return { relationships: Object.fromEntries(byStatus.map((r) => [r.status, r._count])), ordersFromMyMerchants: orders };
}

/* ── Wholesale demand aggregates (J7.21) ─────────────────────────────── */

export const WHOLESALE_K = 10;
export const WHOLESALE_MIN_SELLERS = 3;

/**
 * Category × region wholesale demand for route-to-market planning
 * (OpportunityOS / IAWIC — not built). Privacy: a cell is published only when
 * at least k = 10 distinct BUYER businesses AND at least 3 distinct SELLERS
 * contribute (B2B volumes are commercially sensitive and few-seller cells
 * would reveal one supplier's sales). No business, merchant, rep or listing
 * ids, no prices. Internal function: no public route.
 */
export async function wholesaleDemandAggregates({ since = new Date(Date.now() - 30 * 86_400_000), k = WHOLESALE_K } = {}) {
  if (!Number.isInteger(k) || k < WHOLESALE_K) throw new Error(`k-anonymity threshold must be ≥ ${WHOLESALE_K}`);
  const rows = await prisma.$queryRaw`
    SELECT COALESCE(wl."category", 'autre') AS category,
           COALESCE(b."arrondissement", 'inconnu') AS region,
           COUNT(DISTINCT po."buyerBusinessId")::int AS buyers,
           COUNT(DISTINCT po."sellerBusinessId")::int AS sellers,
           COUNT(DISTINCT po.id)::int AS orders,
           SUM(l."packs")::int AS packs
      FROM "PurchaseOrderLine" l
      JOIN "PurchaseOrder" po ON po.id = l."purchaseOrderId"
      JOIN "WholesaleListing" wl ON wl.id = l."listingId"
      JOIN "Business" b ON b.id = po."buyerBusinessId"
     WHERE po."createdAt" >= ${since} AND po.status NOT IN ('rejected', 'cancelled')
     GROUP BY 1, 2`;
  const keep = (r) => r.buyers >= k && r.sellers >= WHOLESALE_MIN_SELLERS;
  return {
    since: since.toISOString(),
    k,
    minSellers: WHOLESALE_MIN_SELLERS,
    demand: rows.filter(keep).map((r) => ({ category: r.category, region: r.region, buyers: r.buyers, orders: r.orders, packs: r.packs })),
    suppressedCells: rows.filter((r) => !keep(r)).length,
  };
}
