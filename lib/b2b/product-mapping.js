import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx } from '../business-access.js';
import { receivePurchaseInTx, tracksStock } from '../commerce/inventory.js';

/**
 * J8 pilot (D40) — buyer catalogue mapping.
 *
 * A supplier's product id is NEVER used as the buyer's catalogue id. Received
 * units go into the buyer's stock only through an explicit mapping
 * (supplier product → the buyer's own tracked product). Until a line is mapped
 * its units sit in an UnmatchedReceipt — physically received, in no stock
 * position — and the buyer resolves it once. Mapping requires
 * business.inventory.adjust on the BUYER; the supplier product must have been
 * bought by this buyer (a line on one of its purchase orders) — no probing.
 */
export class MappingError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'MappingError';
    this.code = code;
    this.status = status;
  }
}
const notFound = () => new MappingError('not_found', 'Introuvable', 404);
const auth = (tx, userId, buyerId) => assertBusinessAuthorityInTx(tx, userId, buyerId, 'business.inventory.adjust').catch((e) => {
  if (e instanceof OrgAccessError) throw notFound();
  throw e;
});

async function boughtFrom(tx, buyerId, sellerProductId) {
  const rows = await tx.$queryRaw`SELECT o."sellerBusinessId", l.sku FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" o ON o.id = l."purchaseOrderId"
    WHERE l."productId" = ${sellerProductId} AND o."buyerBusinessId" = ${buyerId} LIMIT 1`;
  return rows[0] ?? null;
}

async function ownTrackedProduct(tx, buyerId, buyerProductId) {
  const p = await tx.product.findFirst({ where: { id: buyerProductId, businessId: buyerId } });
  if (!p) throw new MappingError('product_not_found', 'Produit introuvable dans ton catalogue', 404);
  if (!tracksStock(p)) throw new MappingError('untracked_product', 'Ce produit ne suit pas de stock', 409);
  return p;
}

/** Map a supplier product to one of the buyer's own products; optionally apply pending receipts for it (once each). */
export async function upsertMapping(userId, buyerId, { sellerProductId, buyerProductId, applyPending = false }) {
  return prisma.$transaction(async (tx) => {
    await auth(tx, userId, buyerId);
    const src = await boughtFrom(tx, buyerId, sellerProductId);
    if (!src) throw notFound();
    await ownTrackedProduct(tx, buyerId, buyerProductId);
    const m = await tx.buyerProductMapping.upsert({
      where: { buyerBusinessId_sellerProductId: { buyerBusinessId: buyerId, sellerProductId } },
      create: { buyerBusinessId: buyerId, sellerBusinessId: src.sellerBusinessId, sellerProductId, buyerProductId, createdBy: userId },
      update: { buyerProductId },
    });
    let applied = 0;
    if (applyPending) {
      const pending = await tx.unmatchedReceipt.findMany({ where: { buyerBusinessId: buyerId, sellerProductId, status: 'pending' } });
      for (const r of pending) applied += await resolveInTx(tx, userId, buyerId, r.id, buyerProductId);
    }
    return { mapping: mappingView(m), appliedUnits: applied };
  });
}

async function resolveInTx(tx, userId, buyerId, receiptId, buyerProductId) {
  await tx.$executeRaw`SELECT id FROM "UnmatchedReceipt" WHERE id = ${receiptId} FOR UPDATE`;
  const r = await tx.unmatchedReceipt.findUnique({ where: { id: receiptId } });
  if (!r || r.buyerBusinessId !== buyerId) throw notFound();
  if (r.status !== 'pending') return 0;
  const product = await ownTrackedProduct(tx, buyerId, buyerProductId);
  await receivePurchaseInTx(tx, { product, quantity: r.units, note: r.shipmentRef, actorUserId: userId });
  const u = await tx.unmatchedReceipt.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'mapped', buyerProductId, resolvedBy: userId, resolvedAt: new Date() } });
  if (u.count !== 1) throw new MappingError('conflict', 'Déjà traité', 409);
  return r.units;
}

/** Resolve one unmatched receipt into one of the buyer's products (once). */
export async function resolveUnmatched(userId, buyerId, receiptId, { buyerProductId, remember = true }) {
  return prisma.$transaction(async (tx) => {
    await auth(tx, userId, buyerId);
    const r = await tx.unmatchedReceipt.findUnique({ where: { id: receiptId } });
    if (!r || r.buyerBusinessId !== buyerId) throw notFound();
    if (r.status !== 'pending') return { receipt: receiptView(r), replayed: true };
    const units = await resolveInTx(tx, userId, buyerId, r.id, buyerProductId);
    if (remember) {
      await tx.buyerProductMapping.upsert({
        where: { buyerBusinessId_sellerProductId: { buyerBusinessId: buyerId, sellerProductId: r.sellerProductId } },
        create: { buyerBusinessId: buyerId, sellerBusinessId: r.sellerBusinessId, sellerProductId: r.sellerProductId, buyerProductId, createdBy: userId },
        update: {},
      });
    }
    return { receipt: receiptView(await tx.unmatchedReceipt.findUnique({ where: { id: r.id } })), units };
  });
}

export async function listMappingState(userId, buyerId) {
  await auth(prisma, userId, buyerId);
  const [maps, pending] = await Promise.all([
    prisma.buyerProductMapping.findMany({ where: { buyerBusinessId: buyerId }, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.unmatchedReceipt.findMany({ where: { buyerBusinessId: buyerId, status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 500 }),
  ]);
  return { mappings: maps.map(mappingView), unmatched: pending.map(receiptView) };
}

/**
 * Receiving consequence for a supplier shipment (called by lib/logistics/commerce-adapter.js
 * inside the logistics transaction): mapped → buyer stock; unmapped → UnmatchedReceipt.
 */
export async function receiveSupplierLinesInTx(tx, { buyerBusinessId, sellerBusinessId, shipmentId, shipmentRef, lines, actorUserId }) {
  const out = { mapped: 0, unmatched: 0 };
  for (const l of lines.filter((x) => x.received > 0)) {
    const m = await tx.buyerProductMapping.findUnique({ where: { buyerBusinessId_sellerProductId: { buyerBusinessId, sellerProductId: l.productId } } });
    const product = m ? await tx.product.findFirst({ where: { id: m.buyerProductId, businessId: buyerBusinessId } }) : null;
    if (product && tracksStock(product)) {
      await receivePurchaseInTx(tx, { product, quantity: l.received, note: shipmentRef, actorUserId });
      out.mapped += l.received;
    } else {
      await tx.unmatchedReceipt.create({ data: { buyerBusinessId, sellerBusinessId, sellerProductId: l.productId, sku: l.sku ?? null, units: l.received, shipmentId, shipmentRef } });
      out.unmatched += l.received;
    }
  }
  return out;
}

const mappingView = (m) => ({ sellerProductId: m.sellerProductId, buyerProductId: m.buyerProductId, sellerBusinessId: m.sellerBusinessId });
const receiptView = (r) => ({ id: r.id, sellerProductId: r.sellerProductId, sku: r.sku, units: r.units, shipmentRef: r.shipmentRef, status: r.status, buyerProductId: r.buyerProductId, receivedAt: r.createdAt.toISOString() });
