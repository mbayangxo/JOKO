import { prisma } from '../prisma.js';
import { OrgAccessError, requireBusinessCapability } from '../business-access.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { stockMeta } from '../marketplace-service.js';
import { tracksStock } from './inventory.js';

/**
 * J5 catalog (docs/JOKKO-J5-REPORT.md §5). Products and services of ONE
 * business. Prices are integers in ₭ and are the only source of order
 * totals (orders re-price every line from here). Stock is never written
 * through the catalog: it starts with an 'initial' movement and then moves
 * only through lib/commerce/inventory.js. Variants/options are NOT modelled
 * yet (a product per variant), and say so rather than faking it.
 */
export class CatalogError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.status = status;
  }
}

const MAX_PRICE_KORI = 10_000_000;

function validatePrice(v, field = 'Prix') {
  if (v == null) return;
  if (!Number.isSafeInteger(v) || v <= 0 || v > MAX_PRICE_KORI) throw new CatalogError('invalid_price', `${field} invalide`);
}

export function catalogItemShape(p, business) {
  const stock = stockMeta(p, business);
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    description: p.description,
    sku: p.sku,
    category: p.category,
    imageUrl: p.imageUrl,
    priceKori: p.price,
    unitLabel: p.unitLabel,
    active: p.active,
    trackInventory: tracksStock(p),
    allowBackorder: p.allowBackorder,
    inventory: tracksStock(p) ? p.inventory : null,
    lowStockThreshold: p.lowStockThreshold,
    lowStock: tracksStock(p) && p.inventory <= p.lowStockThreshold,
    availability: stock.label ?? null,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function listCatalog(userId, businessId, { includeInactive = true } = {}) {
  await requireBusinessCapability(userId, businessId, 'business.read');
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  const rows = await prisma.product.findMany({
    where: { businessId, ...(includeInactive ? {} : { active: true }) },
    orderBy: [{ active: 'desc' }, { title: 'asc' }],
    take: 500,
  });
  return rows.map((p) => catalogItemShape(p, business));
}

async function assertSkuFree(db, businessId, sku, exceptId) {
  if (!sku) return;
  const clash = await db.product.findFirst({ where: { businessId, sku, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (clash) throw new CatalogError('sku_taken', 'Cette référence (SKU) existe déjà', 409);
}

export async function createCatalogItem(userId, businessId, input) {
  await requireBusinessCapability(userId, businessId, 'business.catalog.manage');
  validatePrice(input.priceKori);
  const kind = input.kind === 'service' ? 'service' : 'product';
  const track = kind === 'product' && input.trackInventory !== false;
  const initial = track ? Math.max(0, Math.floor(Number(input.initialStock ?? 0))) : 0;
  return runMoneyTransaction(prisma, async (tx) => {
    await assertSkuFree(tx, businessId, input.sku, null);
    const business = await tx.business.findUniqueOrThrow({ where: { id: businessId } });
    const p = await tx.product.create({
      data: {
        businessId,
        kind,
        title: input.title,
        description: input.description ?? null,
        sku: input.sku ?? null,
        category: input.category ?? null,
        imageUrl: input.imageUrl ?? null,
        price: input.priceKori,
        unitLabel: input.unitLabel ?? null,
        trackInventory: track,
        allowBackorder: track ? Boolean(input.allowBackorder) : false,
        lowStockThreshold: input.lowStockThreshold ?? 5,
        inventory: initial,
        active: input.active !== false,
      },
    });
    if (initial > 0) {
      await tx.stockMovement.create({ data: { productId: p.id, businessId, delta: initial, balanceAfter: initial, reason: 'initial', actorUserId: userId } });
    }
    return catalogItemShape(p, business);
  });
}

const PATCHABLE = ['title', 'description', 'sku', 'category', 'imageUrl', 'unitLabel', 'active', 'allowBackorder', 'lowStockThreshold'];

export async function updateCatalogItem(userId, businessId, productId, patch) {
  await requireBusinessCapability(userId, businessId, 'business.catalog.manage');
  if (patch.inventory !== undefined) throw new CatalogError('use_stock_adjustment', 'Le stock se modifie par un ajustement (avec motif), pas ici', 400);
  const p = await prisma.product.findUnique({ where: { id: productId } });
  if (!p || p.businessId !== businessId) throw new OrgAccessError('Produit introuvable', 404);
  validatePrice(patch.priceKori);
  if (patch.sku !== undefined) await assertSkuFree(prisma, businessId, patch.sku, productId);
  const data = {};
  for (const k of PATCHABLE) if (patch[k] !== undefined) data[k] = patch[k];
  if (patch.priceKori !== undefined) data.price = patch.priceKori;
  if (p.kind === 'service') data.allowBackorder = false;
  const updated = await prisma.product.update({ where: { id: productId }, data });
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  return catalogItemShape(updated, business);
}
