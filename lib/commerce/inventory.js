import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx } from '../business-access.js';
import { runMoneyTransaction } from '../wallet-atomic.js';

/**
 * J5 inventory (docs/JOKKO-J5-REPORT.md §6).
 *
 * - Stock lives on Product.inventory (single primary location today; the
 *   StockMovement.locationId column is ready for per-location stock).
 * - Every change is ONE conditional UPDATE … RETURNING plus one append-only
 *   StockMovement row, in the caller's transaction — no read-modify-write,
 *   so concurrent sales can never oversell.
 * - Stock never goes below zero unless the product explicitly allows
 *   backorders (Product.allowBackorder) or the business accepts orders when
 *   out of stock (Business.acceptOrdersWhenOutOfStock). Backorders are then
 *   represented honestly as negative stock, never silently dropped.
 * - Services (kind 'service') and untracked products never touch stock.
 */
export class InventoryError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.status = status;
  }
}

export const MOVEMENT_REASONS = ['sale', 'cancel_restore', 'refund_restore', 'adjustment', 'initial', 'receive_purchase', 'return_quarantine', 'return_release'];

export function tracksStock(product) {
  return product.kind !== 'service' && product.trackInventory;
}

function allowsNegative(product, business) {
  return Boolean(product.allowBackorder || business?.acceptOrdersWhenOutOfStock);
}

/** Apply `delta` atomically; refuses to go below zero unless `allowNegative`. Returns the new balance. */
async function applyDelta(tx, productId, delta, allowNegative) {
  const rows = await tx.$queryRaw`
    UPDATE "Product" SET "inventory" = "inventory" + ${delta}, "updatedAt" = now()
     WHERE "id" = ${productId} AND (${allowNegative} OR "inventory" + ${delta} >= 0)
     RETURNING "inventory"`;
  return rows.length ? Number(rows[0].inventory) : null;
}

async function primaryInventoryLocationId(tx, businessId) {
  const loc = await tx.inventoryLocation.findFirst({ where: { operatorBusinessId: businessId, isPrimary: true }, select: { id: true } });
  return loc?.id ?? null;
}

async function record(tx, { product, delta, balanceAfter, reason, note, orderId, actorUserId, inventoryLocationId }) {
  return tx.stockMovement.create({
    data: {
      productId: product.id,
      businessId: product.businessId,
      delta,
      balanceAfter,
      reason,
      note: note ?? null,
      orderId: orderId ?? null,
      actorUserId: actorUserId ?? null,
      inventoryLocationId: inventoryLocationId ?? (await primaryInventoryLocationId(tx, product.businessId)),
    },
  });
}

/**
 * J8 (D40): goods physically received from a supplier into the buyer's OWN product
 * (resolved through an explicit BuyerProductMapping). `note` carries the shipment
 * reference — the custody invariant L5 reconciles received units against it.
 */
export async function receivePurchaseInTx(tx, { product, quantity, note, actorUserId }) {
  if (!tracksStock(product)) throw new InventoryError('untracked_product', 'Ce produit ne suit pas de stock', 409);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new InventoryError('invalid', 'Quantité invalide', 400);
  const after = await applyDelta(tx, product.id, quantity, true);
  await record(tx, { product, delta: quantity, balanceAfter: after, reason: 'receive_purchase', note, actorUserId });
  return { balanceAfter: after };
}

/** Sale decrement for one order line (inside the order transaction). */
/**
 * J8 (D44): sellable units set aside for a commercial return the buyer is shipping back.
 * Out of sellable stock (never below zero — a return cannot create phantom stock), and
 * restored exactly once by releaseFromReturnInTx if the goods never leave / come back.
 * `note` is `hold:<ReturnStockHold.id>` — invariant L9 reconciles the pair.
 */
export async function quarantineForReturnInTx(tx, { product, quantity, holdId, actorUserId }) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new InventoryError('invalid', 'Quantité invalide', 400);
  const after = await applyDelta(tx, product.id, -quantity, false);
  if (after === null) throw new InventoryError('insufficient_stock', `${product.name ?? 'Produit'} — stock insuffisant pour ce retour (corrige l’inventaire d’abord)`, 409);
  await record(tx, { product, delta: -quantity, balanceAfter: after, reason: 'return_quarantine', note: `hold:${holdId}`, actorUserId });
  return { balanceAfter: after };
}

export async function releaseFromReturnInTx(tx, { product, quantity, holdId, actorUserId }) {
  const after = await applyDelta(tx, product.id, quantity, true);
  await record(tx, { product, delta: quantity, balanceAfter: after, reason: 'return_release', note: `hold:${holdId}`, actorUserId });
  return { balanceAfter: after };
}

export async function decrementForSale(tx, { product, business, quantity, orderId, actorUserId, inventoryLocationId }) {
  if (!tracksStock(product)) return { tracked: false };
  const after = await applyDelta(tx, product.id, -quantity, allowsNegative(product, business));
  if (after === null) throw new InventoryError('out_of_stock', `Stock insuffisant pour ${product.title}`);
  await record(tx, { product, delta: -quantity, balanceAfter: after, reason: 'sale', orderId, actorUserId, inventoryLocationId });
  return { tracked: true, balanceAfter: after };
}

/**
 * Put back exactly what this order's sale movements took (and has not been
 * restored yet). Orders that predate J5 have no sale movements: nothing is
 * invented — the merchant adjusts manually if goods came back.
 */
export async function restoreForOrder(tx, { orderId, reason, actorUserId }) {
  const moves = await tx.stockMovement.findMany({ where: { orderId }, include: { product: true } });
  const net = new Map();
  for (const m of moves) net.set(m.productId, { product: m.product, qty: (net.get(m.productId)?.qty ?? 0) + m.delta });
  const restored = [];
  for (const { product, qty } of net.values()) {
    if (qty >= 0) continue; // nothing outstanding for this product
    const after = await applyDelta(tx, product.id, -qty, true);
    await record(tx, { product, delta: -qty, balanceAfter: after, reason, orderId, actorUserId });
    restored.push({ productId: product.id, quantity: -qty, balanceAfter: after });
  }
  return { restored, hadSaleRecords: moves.length > 0 };
}

/**
 * Manual adjustment by staff with `business.inventory.adjust`: either a
 * relative `delta` or an absolute `count` (stock-take). A reason is required;
 * the actor is recorded. Authority is re-checked inside the transaction.
 */
export async function adjustStock(userId, businessId, productId, { delta, count, note }) {
  if (!note || String(note).trim().length < 3) throw new InventoryError('reason_required', 'Motif requis pour un ajustement de stock', 400);
  if ((delta == null) === (count == null)) throw new InventoryError('invalid', 'Indique soit une variation, soit un comptage', 400);
  return runMoneyTransaction(prisma, async (tx) => {
    await assertBusinessAuthorityInTx(tx, userId, businessId, 'business.inventory.adjust');
    const locked = await tx.$queryRaw`SELECT "id","inventory","businessId","kind","trackInventory","allowBackorder","title" FROM "Product" WHERE "id" = ${productId} FOR UPDATE`;
    const product = locked[0];
    if (!product || product.businessId !== businessId) throw new OrgAccessError('Produit introuvable', 404);
    if (!tracksStock(product)) throw new InventoryError('not_tracked', 'Ce produit ne suit pas de stock', 400);
    const d = count != null ? Number(count) - Number(product.inventory) : Number(delta);
    if (!Number.isSafeInteger(d) || d === 0) return { productId, balanceAfter: Number(product.inventory), delta: 0 };
    const business = await tx.business.findUnique({ where: { id: businessId }, select: { acceptOrdersWhenOutOfStock: true } });
    const after = await applyDelta(tx, productId, d, allowsNegative(product, business));
    if (after === null) throw new InventoryError('negative_stock', 'Le stock ne peut pas devenir négatif pour ce produit', 409);
    const m = await record(tx, { product, delta: d, balanceAfter: after, reason: 'adjustment', note: String(note).slice(0, 300), actorUserId: userId });
    return { productId, delta: d, balanceAfter: after, movementId: m.id };
  });
}

/** Stock history for one product, newest first. */
export async function stockHistory(businessId, productId, { limit = 50 } = {}) {
  const rows = await prisma.stockMovement.findMany({
    where: { businessId, productId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(limit) || 50, 200),
  });
  return rows.map((m) => ({
    id: m.id,
    delta: m.delta,
    balanceAfter: m.balanceAfter,
    reason: m.reason,
    note: m.note,
    orderId: m.orderId,
    actorUserId: m.actorUserId,
    createdAt: m.createdAt.toISOString(),
  }));
}
