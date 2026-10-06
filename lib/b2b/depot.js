import { prisma } from '../prisma.js';
import { requireBusinessCapability } from '../business-access.js';

/**
 * J7.14 — depot / stock-location positions.
 *
 * `DepotStock` is the position of one product at one `InventoryLocation`
 * operated by the seller: onHand and reserved (committed to accepted POs).
 * Every change is a `DepotStockMovement` row (append-only, DB trigger) written
 * in the same transaction, under FOR UPDATE on the position. The DB check
 * (onHand ≥ 0, 0 ≤ reserved ≤ onHand) makes overselling impossible even if a
 * code path forgot to check. Units are retail units (packs × unitsPerPack).
 *
 * Retail `Product.inventory` (J5, the shop's own shelf) is NOT touched: a
 * depot is the seller's wholesale stock.
 */
export class DepotError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'DepotError';
    this.code = code;
    this.status = status;
  }
}

export async function moveDepotStockInTx(tx, { locationId, productId, deltaOnHand = 0, deltaReserved = 0, reason, purchaseOrderId = null, returnId = null, actorUserId = null, note = null }) {
  await tx.$executeRaw`INSERT INTO "DepotStock" (id, "locationId", "productId", "onHand", reserved, "updatedAt")
    VALUES (${`ds_${locationId}_${productId}`.slice(0, 120)}, ${locationId}, ${productId}, 0, 0, now())
    ON CONFLICT ("locationId", "productId") DO NOTHING`;
  await tx.$executeRaw`SELECT id FROM "DepotStock" WHERE "locationId" = ${locationId} AND "productId" = ${productId} FOR UPDATE`;
  const s = await tx.depotStock.findUnique({ where: { locationId_productId: { locationId, productId } } });
  const onHand = s.onHand + deltaOnHand;
  const reserved = s.reserved + deltaReserved;
  if (onHand < 0 || reserved < 0 || reserved > onHand) {
    throw new DepotError('insufficient_stock', `Stock insuffisant au dépôt (disponible ${s.onHand - s.reserved})`);
  }
  await tx.depotStock.update({ where: { id: s.id }, data: { onHand, reserved } });
  await tx.depotStockMovement.create({
    data: { depotStockId: s.id, locationId, productId, deltaOnHand, deltaReserved, onHandAfter: onHand, reservedAfter: reserved, reason, purchaseOrderId, returnId, actorUserId, note: note ? String(note).slice(0, 200) : null },
  });
  return { onHand, reserved, available: onHand - reserved };
}

async function requireDepot(sellerId, locationId) {
  const loc = await prisma.inventoryLocation.findFirst({ where: { id: locationId, operatorBusinessId: sellerId, status: 'active' } });
  if (!loc) throw new DepotError('depot_not_found', 'Dépôt introuvable', 404);
  return loc;
}

/** Goods in (receive) or a counted correction (adjust, reason mandatory). */
export async function recordStock(userId, sellerId, { locationId, productId, units, kind = 'receive', note }) {
  await requireBusinessCapability(userId, sellerId, 'business.inventory.adjust');
  await requireDepot(sellerId, locationId);
  const p = await prisma.product.findFirst({ where: { id: productId, businessId: sellerId } });
  if (!p) throw new DepotError('product_not_found', 'Produit introuvable', 404);
  if (!Number.isSafeInteger(units) || units === 0 || Math.abs(units) > 10_000_000) throw new DepotError('invalid', 'Quantité invalide', 400);
  if (kind === 'receive' && units < 0) throw new DepotError('invalid', 'Une réception est positive', 400);
  if (kind === 'adjust' && !(note && String(note).trim().length >= 3)) throw new DepotError('reason_required', 'Motif obligatoire pour une correction', 400);
  return prisma.$transaction((tx) => moveDepotStockInTx(tx, { locationId, productId, deltaOnHand: units, reason: kind === 'adjust' ? 'adjust' : 'receive', actorUserId: userId, note }));
}

export async function depotPositions(userId, sellerId, locationId) {
  await requireBusinessCapability(userId, sellerId, 'business.orders.read');
  await requireDepot(sellerId, locationId);
  const rows = await prisma.depotStock.findMany({ where: { locationId }, orderBy: { productId: 'asc' }, take: 500 });
  return rows.map((r) => ({ productId: r.productId, onHand: r.onHand, reserved: r.reserved, available: r.onHand - r.reserved }));
}

export async function depotMovements(userId, sellerId, locationId, { productId, limit = 100 } = {}) {
  await requireBusinessCapability(userId, sellerId, 'business.orders.read');
  await requireDepot(sellerId, locationId);
  const rows = await prisma.depotStockMovement.findMany({ where: { locationId, ...(productId ? { productId } : {}) }, orderBy: { createdAt: 'desc' }, take: Math.min(Number(limit) || 100, 500) });
  return rows.map((m) => ({ productId: m.productId, deltaOnHand: m.deltaOnHand, deltaReserved: m.deltaReserved, onHandAfter: m.onHandAfter, reservedAfter: m.reservedAfter, reason: m.reason, purchaseOrderId: m.purchaseOrderId, at: m.createdAt.toISOString() }));
}
