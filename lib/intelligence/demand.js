import { prisma } from '../prisma.js';

/**
 * J5 merchant demand intelligence boundary (docs/JOKKO-ECONOMIC-OS-ARCHITECTURE.md §12).
 *
 * The ONLY shape in which commerce data may leave a business towards the
 * economic graph / OpportunityOS / IAWIC: aggregates over many businesses.
 *  - no business id, name, customer, price list or individual figure;
 *  - a cell (category × region × period) is published only when at least
 *    `k` distinct businesses contribute (k-anonymity, default 5);
 *  - stock-out / backorder signals are counted, never attributed.
 * The consumer (OpportunityOS) is DORMANT: this function is the governed
 * interface it will call; there is no public route.
 */
export const DEFAULT_K = 5;

export async function demandAggregates({ since = new Date(Date.now() - 30 * 86_400_000), k = DEFAULT_K } = {}) {
  if (!Number.isInteger(k) || k < DEFAULT_K) throw new Error(`k-anonymity threshold must be ≥ ${DEFAULT_K}`);
  const rows = await prisma.$queryRaw`
    SELECT COALESCE(p."category", 'autre') AS category,
           COALESCE(b."arrondissement", 'inconnu') AS region,
           COUNT(DISTINCT o."businessId")::int AS businesses,
           COUNT(DISTINCT o."id")::int AS orders,
           SUM(oi."quantity")::int AS units
      FROM "Order" o
      JOIN "OrderItem" oi ON oi."orderId" = o."id"
      JOIN "Product" p ON p."id" = oi."productId"
      JOIN "Business" b ON b."id" = o."businessId"
     WHERE o."createdAt" >= ${since} AND o."paymentStatus" = 'paid' AND o."status" NOT IN ('cancelled', 'refunded')
     GROUP BY 1, 2`;
  const shortages = await prisma.$queryRaw`
    SELECT COALESCE(p."category", 'autre') AS category,
           COALESCE(b."arrondissement", 'inconnu') AS region,
           COUNT(DISTINCT p."businessId")::int AS businesses,
           COUNT(*)::int AS products_out_or_backordered
      FROM "Product" p JOIN "Business" b ON b."id" = p."businessId"
     WHERE p."active" AND p."kind" = 'product' AND p."trackInventory" AND p."inventory" <= 0
     GROUP BY 1, 2`;
  const keep = (r) => r.businesses >= k;
  return {
    since: since.toISOString(),
    k,
    demand: rows.filter(keep).map((r) => ({ category: r.category, region: r.region, businesses: r.businesses, orders: r.orders, units: r.units })),
    shortages: shortages.filter(keep).map((r) => ({ category: r.category, region: r.region, businesses: r.businesses, products: r.products_out_or_backordered })),
    suppressedCells: rows.filter((r) => !keep(r)).length + shortages.filter((r) => !keep(r)).length,
  };
}
