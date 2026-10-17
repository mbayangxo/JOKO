import { createInAppNotification } from './notify-service.js';
import { formatKori } from './kori.js';
import { MarketplaceError, productPriceNow, productShape, shopShape, stockMeta } from './marketplace-service.js';

export { MarketplaceError };

function assertBusinessOwner(db, businessId, userId) {
  return db.business.findFirst({ where: { id: businessId, ownerId: userId } });
}

async function notifyLowStock(db, business, product) {
  if (!business.lowStockAlertEnabled || !product.trackInventory) return;
  if (product.inventory > product.lowStockThreshold) return;
  const title = product.inventory <= 0 ? 'Rupture de stock' : 'Stock bas';
  const body =
    product.inventory <= 0
      ? `${product.title} est épuisé — réapprovisionne ton marché.`
      : `${product.title} : plus que ${product.inventory} unité${product.inventory > 1 ? 's' : ''}.`;
  await createInAppNotification(business.ownerId, title, body, {
    kind: 'low_stock',
    refId: product.id,
    actionLabel: 'Voir le catalogue',
  }, db);
}

export function productShapeWithStock(product, business) {
  return {
    ...productShape(product, business),
    trackInventory: product.trackInventory,
    allowBackorder: product.allowBackorder,
    lowStockThreshold: product.lowStockThreshold,
    viewCount: product.viewCount ?? 0,
    ...stockMeta(product, business),
  };
}

export async function recordProductView(db, { productId, userId }) {
  const product = await db.product.findUnique({
    where: { id: productId },
    include: { business: true },
  });
  if (!product?.businessId) return null;

  await db.$transaction([
    db.productView.create({
      data: { productId, businessId: product.businessId, userId: userId ?? null },
    }),
    db.product.update({
      where: { id: productId },
      data: { viewCount: { increment: 1 } },
    }),
  ]);
  return { productId, viewCount: (product.viewCount ?? 0) + 1 };
}

export async function listMerchantProducts(db, businessId, ownerId) {
  const business = await assertBusinessOwner(db, businessId, ownerId);
  if (!business) throw new MarketplaceError('forbidden', 'Commerce introuvable');

  const products = await db.product.findMany({
    where: { businessId, active: true },
    orderBy: { updatedAt: 'desc' },
  });
  return {
    business: shopShape(business),
    products: products.map((p) => productShapeWithStock(p, business)),
    settings: {
      acceptOrdersWhenOutOfStock: business.acceptOrdersWhenOutOfStock,
      pauseOrders: business.pauseOrders,
      lowStockAlertEnabled: business.lowStockAlertEnabled,
    },
  };
}

export async function updateMerchantProduct(db, { productId, ownerId, patch }) {
  const product = await db.product.findUnique({
    where: { id: productId },
    include: { business: true },
  });
  if (!product?.business || product.business.ownerId !== ownerId) {
    throw new MarketplaceError('forbidden', 'Produit introuvable');
  }

  // J5: stock never changes silently — a new count goes through the
  // inventory layer (guarded, with a StockMovement attributed to the owner).
  const { inventory, ...fields } = patch;
  let updated = Object.keys(fields).length ? await db.product.update({ where: { id: productId }, data: fields }) : product;
  if (inventory !== undefined && inventory !== updated.inventory) {
    const { adjustStock, InventoryError } = await import('./commerce/inventory.js');
    try {
      await adjustStock(ownerId, product.businessId, productId, { count: inventory, note: 'Mise à jour du stock (catalogue)' });
    } catch (err) {
      if (!(err instanceof InventoryError && err.code === 'not_tracked')) throw err;
    }
    updated = await db.product.findUnique({ where: { id: productId } });
  }
  await notifyLowStock(db, product.business, updated);
  return productShapeWithStock(updated, product.business);
}

export async function deactivateMerchantProduct(db, { productId, ownerId }) {
  const product = await db.product.findUnique({
    where: { id: productId },
    include: { business: true },
  });
  if (!product?.business || product.business.ownerId !== ownerId) {
    throw new MarketplaceError('forbidden', 'Produit introuvable');
  }
  await db.product.update({ where: { id: productId }, data: { active: false } });
  return { ok: true };
}

export async function updateBusinessOrderSettings(db, { businessId, ownerId, settings }) {
  const business = await assertBusinessOwner(db, businessId, ownerId);
  if (!business) throw new MarketplaceError('forbidden', 'Commerce introuvable');

  const updated = await db.business.update({
    where: { id: businessId },
    data: {
      ...(settings.acceptOrdersWhenOutOfStock != null
        ? { acceptOrdersWhenOutOfStock: settings.acceptOrdersWhenOutOfStock }
        : {}),
      ...(settings.pauseOrders != null ? { pauseOrders: settings.pauseOrders } : {}),
      ...(settings.lowStockAlertEnabled != null
        ? { lowStockAlertEnabled: settings.lowStockAlertEnabled }
        : {}),
    },
  });
  return {
    acceptOrdersWhenOutOfStock: updated.acceptOrdersWhenOutOfStock,
    pauseOrders: updated.pauseOrders,
    lowStockAlertEnabled: updated.lowStockAlertEnabled,
  };
}

function orderShape(order) {
  return {
    id: order.id,
    orderReference: order.orderReference,
    status: order.status,
    channel: order.channel ?? 'b2c',
    paymentTerm: order.paymentTerm ?? 'immediate',
    paymentStatus: order.paymentStatus ?? 'paid',
    paidAmount: order.paidAmount ?? 0,
    fulfillmentType: order.fulfillmentType,
    totalAmount: order.totalAmount,
    totalFormatted: formatKori(order.totalAmount),
    deliveryAddress: order.deliveryAddress,
    preferredDeliveryDate: order.preferredDeliveryDate?.toISOString?.()?.slice(0, 10) ?? null,
    notes: order.notes,
    createdAt: order.createdAt.toISOString(),
    buyer: order.buyer
      ? {
          id: order.buyer.id,
          name: order.buyer.name,
          handle: order.buyer.handle,
          avatarEmoji: order.buyer.avatarEmoji,
        }
      : null,
    business: order.business ? { id: order.business.id, name: order.business.name } : null,
    items: (order.items ?? []).map((li) => ({
      id: li.id,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      product: li.product
        ? { id: li.product.id, title: li.product.title, imageUrl: li.product.imageUrl }
        : null,
    })),
    delivery: order.delivery
      ? { id: order.delivery.id, status: order.delivery.status, pickupLabel: order.delivery.pickupLabel }
      : null,
    invoice: order.tradeInvoice
      ? {
          id: order.tradeInvoice.id,
          reference: order.tradeInvoice.reference,
          status: order.tradeInvoice.status,
          dueAt: order.tradeInvoice.dueAt?.toISOString?.() ?? null,
        }
      : null,
  };
}

export async function listBuyerOrders(db, buyerId, { limit = 40 } = {}) {
  const orders = await db.order.findMany({
    where: { buyerId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      business: { select: { id: true, name: true } },
      items: { include: { product: true } },
      delivery: { select: { id: true, status: true, pickupLabel: true } },
      tradeInvoice: { select: { id: true, reference: true, status: true, dueAt: true } },
    },
  });
  return orders.map(orderShape);
}

export async function listMerchantOrders(db, { businessId, ownerId, limit = 50 }) {
  const business = await assertBusinessOwner(db, businessId, ownerId);
  if (!business) throw new MarketplaceError('forbidden', 'Commerce introuvable');

  const orders = await db.order.findMany({
    where: { businessId },
    orderBy: [{ preferredDeliveryDate: 'asc' }, { createdAt: 'desc' }],
    take: limit,
    include: {
      buyer: { select: { id: true, name: true, handle: true, avatarEmoji: true } },
      items: { include: { product: true } },
      delivery: { select: { id: true, status: true, pickupLabel: true } },
      tradeInvoice: { select: { id: true, reference: true, status: true, dueAt: true } },
    },
  });
  return orders.map(orderShape);
}

export async function getMerchantAnalytics(db, { businessId, ownerId }) {
  const business = await assertBusinessOwner(db, businessId, ownerId);
  if (!business) throw new MarketplaceError('forbidden', 'Commerce introuvable');

  const since30 = new Date(Date.now() - 30 * 24 * 3600_000);

  const [orders, products, views] = await Promise.all([
    db.order.findMany({
      where: { businessId, createdAt: { gte: since30 } },
      include: {
        buyer: { select: { id: true, name: true, handle: true } },
        items: { include: { product: true } },
      },
    }),
    db.product.findMany({ where: { businessId, active: true } }),
    db.productView.findMany({
      where: { businessId, createdAt: { gte: since30 } },
      select: { productId: true },
    }),
  ]);

  const revenue30 = orders.reduce((s, o) => s + o.totalAmount, 0);
  const orderCount30 = orders.length;

  const productSales = new Map();
  for (const order of orders) {
    for (const li of order.items) {
      const key = li.productId;
      const prev = productSales.get(key) ?? { product: li.product, units: 0, revenue: 0 };
      prev.units += li.quantity;
      prev.revenue += li.unitPrice * li.quantity;
      productSales.set(key, prev);
    }
  }

  const topProducts = [...productSales.values()]
    .sort((a, b) => b.units - a.units)
    .slice(0, 8)
    .map(({ product, units, revenue }) => ({
      id: product?.id,
      title: product?.title,
      imageUrl: product?.imageUrl,
      unitsSold: units,
      revenue,
      revenueFormatted: formatKori(revenue),
    }));

  const buyerStats = new Map();
  for (const order of orders) {
    const key = order.buyerId;
    const prev = buyerStats.get(key) ?? {
      buyer: order.buyer,
      orders: 0,
      spent: 0,
      items: new Map(),
    };
    prev.orders += 1;
    prev.spent += order.totalAmount;
    for (const li of order.items) {
      const t = li.product?.title ?? 'Produit';
      prev.items.set(t, (prev.items.get(t) ?? 0) + li.quantity);
    }
    buyerStats.set(key, prev);
  }

  const topBuyers = [...buyerStats.values()]
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 8)
    .map((row) => ({
      id: row.buyer?.id,
      name: row.buyer?.name,
      handle: row.buyer?.handle,
      orderCount: row.orders,
      totalSpent: row.spent,
      totalFormatted: formatKori(row.spent),
      usualItems: [...row.items.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([title, qty]) => ({ title, qty })),
    }));

  const viewCounts = new Map();
  for (const v of views) {
    viewCounts.set(v.productId, (viewCounts.get(v.productId) ?? 0) + 1);
  }

  const mostViewed = products
    .map((p) => ({
      id: p.id,
      title: p.title,
      imageUrl: p.imageUrl,
      viewCount: p.viewCount ?? 0,
      views30: viewCounts.get(p.id) ?? 0,
      inventory: p.inventory,
      ...stockMeta(p, business),
    }))
    .sort((a, b) => b.views30 - a.views30 || b.viewCount - a.viewCount)
    .slice(0, 8);

  const lowStockProducts = products
    .filter((p) => p.trackInventory && p.inventory <= p.lowStockThreshold)
    .map((p) => productShapeWithStock(p, business));

  return {
    business: { id: business.id, name: business.name },
    periodDays: 30,
    revenue30,
    revenue30Formatted: formatKori(revenue30),
    orderCount30,
    topProducts,
    topBuyers,
    mostViewed,
    lowStockProducts,
  };
}

export { productPriceNow };
