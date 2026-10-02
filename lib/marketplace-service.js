import { distanceKm, estimateMinutesFromDistance, formatDistanceKm } from './geo.js';
import { spendKoriAtMerchant } from './kori-service.js';
import { ensureBusinessWallet, spendKoriToBusinessWallet, transferBusinessToBusiness } from './business-wallet-service.js';
import {
  createTradeInvoiceInTx,
  getTradeAccountForBuyer,
  parsePreferredDeliveryDate,
  paySupplierB2b,
  resolveProductUnitPrice,
  validateB2bOrderPayment,
} from './trade-service.js';
import { requireBusinessPay } from './business-access.js';
import { runMoneyTransaction, InsufficientFundsError } from './wallet-atomic.js';
import { createDeliveryTask } from './delivery-service.js';
import { KORI_EARN, formatKori } from './kori.js';
import { ensureDefaultHubs, findNearestHub } from './hub-service.js';
import { createInAppNotification } from './notify-service.js';
import {
  computeAffiliateCommission,
  notifyAffiliateCommission,
  recordAffiliateCommission,
  resolveAffiliateAttribution,
  spendKoriWithAffiliateSplit,
} from './affiliate-service.js';

export { ensureDefaultHubs, findNearestHub };

export function stockMeta(product, business) {
  if (business?.pauseOrders) {
    return { inStock: false, canOrder: false, outOfStock: true, lowStock: false, label: 'Commandes suspendues' };
  }
  if (!product.trackInventory) {
    return { inStock: true, canOrder: true, outOfStock: false, lowStock: false, label: 'Disponible' };
  }
  if (product.inventory <= 0) {
    const canOrder = product.allowBackorder || business?.acceptOrdersWhenOutOfStock;
    return {
      inStock: false,
      canOrder,
      outOfStock: !canOrder,
      lowStock: false,
      label: canOrder ? 'Sur commande' : 'Rupture de stock',
    };
  }
  const lowStock = product.inventory <= (product.lowStockThreshold ?? 5);
  return {
    inStock: true,
    canOrder: true,
    outOfStock: false,
    lowStock,
    label: lowStock ? `Stock bas (${product.inventory})` : `${product.inventory} en stock`,
  };
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

async function afterInventoryChange(db, business, product) {
  await notifyLowStock(db, business, product);
}

async function notifyNewMarketplaceOrder(db, { order, business, buyer, totalKori }) {
  const summary = order.notes ?? formatKori(totalKori);
  await createInAppNotification(business.ownerId, 'Nouvelle commande', `${buyer.name ?? buyer.handle} — ${summary}`, {
    kind: 'marketplace_order',
    refId: order.id,
    actionLabel: 'Voir la commande',
  }, db);
  await createInAppNotification(buyer.id, 'Commande confirmée', `${business.name} · ${summary}`, {
    kind: 'marketplace_order',
    refId: order.id,
    actionLabel: 'Suivre',
  }, db);
}

export class MarketplaceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'MarketplaceError';
  }
}

export function marketplaceErrorStatus(code) {
  switch (code) {
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'insufficient':
      return 400;
    default:
      return 400;
  }
}

export function productPriceNow(product) {
  if (product.flashPrice != null && product.flashExpiresAt && product.flashExpiresAt > new Date()) {
    return product.flashPrice;
  }
  return product.price;
}

export function shopShape(business, { lat, lng } = {}) {
  const distance =
    lat != null && lng != null && business.lat != null && business.lng != null
      ? distanceKm(lat, lng, business.lat, business.lng)
      : null;
  return {
    id: business.id,
    name: business.name,
    category: business.category,
    type: business.type,
    arrondissement: business.arrondissement,
    address: business.address,
    lat: business.lat,
    lng: business.lng,
    imageUrl: business.imageUrl,
    statusText: business.statusText ?? null,
    verified: business.verified,
    distributionEnabled: business.distributionEnabled ?? false,
    distanceKm: distance,
    distanceLabel: formatDistanceKm(distance),
    productCount: business._count?.products ?? business.productCount ?? 0,
  };
}

export function productShape(product, business) {
  const stock = business ? stockMeta(product, business) : null;
  return {
    id: product.id,
    title: product.title,
    description: product.description,
    imageUrl: product.imageUrl,
    price: product.price,
    flashPrice: product.flashPrice,
    flashExpiresAt: product.flashExpiresAt?.toISOString?.() ?? product.flashExpiresAt ?? null,
    effectivePrice: productPriceNow(product),
    b2bPrice: product.b2bPrice ?? null,
    b2bMinQty: product.b2bMinQty ?? 1,
    unitLabel: product.unitLabel ?? null,
    saleChannel: product.saleChannel ?? 'both',
    category: product.category,
    inventory: product.inventory,
    trackInventory: product.trackInventory ?? true,
    allowBackorder: product.allowBackorder ?? false,
    lowStockThreshold: product.lowStockThreshold ?? 5,
    viewCount: product.viewCount ?? 0,
    ...(stock ?? {}),
    business: business
      ? {
          id: business.id,
          name: business.name,
          arrondissement: business.arrondissement,
          lat: business.lat,
          lng: business.lng,
          pauseOrders: business.pauseOrders ?? false,
        }
      : null,
  };
}

export async function searchMarketplace(db, { q, lat, lng, category, limit = 40 }) {
  await ensureDefaultHubs(db);
  const query = String(q ?? '').trim();
  if (query.length < 2) {
    return { query, results: [], shops: [] };
  }

  const products = await db.product.findMany({
    where: {
      active: true,
      business: { pauseOrders: false },
      ...(category ? { category } : {}),
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
      ],
    },
    include: {
      business: {
        select: {
          id: true,
          name: true,
          category: true,
          type: true,
          arrondissement: true,
          address: true,
          lat: true,
          lng: true,
          imageUrl: true,
          verified: true,
          pauseOrders: true,
          acceptOrdersWhenOutOfStock: true,
        },
      },
    },
    take: limit,
    orderBy: { title: 'asc' },
  });

  const byShop = new Map();
  for (const product of products) {
    if (!product.business) continue;
    const stock = stockMeta(product, product.business);
    if (!stock.canOrder && stock.outOfStock) continue;
    const key = product.business.id;
    if (!byShop.has(key)) {
      byShop.set(key, { shop: product.business, products: [] });
    }
    byShop.get(key).products.push(productShape(product, product.business));
  }

  const shops = [...byShop.values()]
    .map(({ shop, products: shopProducts }) => ({
      ...shopShape(shop, { lat, lng }),
      matchCount: shopProducts.length,
      products: shopProducts,
    }))
    .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));

  return {
    query,
    results: products.map((p) => productShape(p, p.business)),
    shops,
  };
}

export async function listNearbyShops(db, { lat, lng, category, limit = 30 }) {
  await ensureDefaultHubs(db);
  const businesses = await db.business.findMany({
    where: {
      lat: { not: null },
      lng: { not: null },
      pauseOrders: false,
      ...(category ? { category } : {}),
      products: {
        some: {
          active: true,
          OR: [
            { trackInventory: false },
            { inventory: { gt: 0 } },
            { allowBackorder: true },
          ],
        },
      },
    },
    include: {
      _count: {
        select: {
          products: {
            where: {
              active: true,
              OR: [{ trackInventory: false }, { inventory: { gt: 0 } }, { allowBackorder: true }],
            },
          },
        },
      },
    },
    take: 100,
  });

  return businesses
    .map((b) => shopShape(b, { lat, lng }))
    .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999))
    .slice(0, limit);
}

export async function getShopCatalog(db, businessId, { lat, lng, viewerId } = {}) {
  const business = await db.business.findUnique({
    where: { id: businessId },
    include: {
      products: {
        where: { active: true },
        orderBy: { title: 'asc' },
      },
      _count: { select: { products: true } },
      communityStatuses: {
        where: { expiresAt: { gt: new Date() } },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        include: { user: { select: { id: true, name: true, handle: true, avatarUrl: true, avatarEmoji: true } } },
      },
    },
  });
  if (!business) throw new MarketplaceError('not_found', 'Commerce introuvable');

  let viewerCanPostStatus = false;
  let viewerStatusText = null;
  if (viewerId) {
    const mine = business.communityStatuses.find((c) => c.userId === viewerId);
    viewerStatusText = mine?.text ?? null;
    if (business.ownerId === viewerId) {
      viewerCanPostStatus = true;
    } else {
      const member = await db.businessMember.findFirst({ where: { businessId, userId: viewerId } });
      if (member) {
        viewerCanPostStatus = true;
      } else if (business.type === 'school') {
        const viewer = await db.user.findUnique({ where: { id: viewerId } });
        if (viewer?.studentPassBusinessId === businessId && viewer.studentPassStatus === 'active') {
          viewerCanPostStatus = true;
        }
      }
    }
  }

  return {
    shop: { ...shopShape(business, { lat, lng }), viewerCanPostStatus, viewerStatusText },
    products: business.products.map((p) => productShape(p, business)),
    communityStatuses: business.communityStatuses.map((c) => ({
      userId: c.userId,
      name: c.user?.name ?? c.user?.handle ?? 'Quelqu’un',
      avatarUrl: c.user?.avatarUrl ?? null,
      avatarEmoji: c.user?.avatarEmoji ?? null,
      text: c.text,
      updatedAt: c.updatedAt.toISOString(),
      expiresAt: c.expiresAt.toISOString(),
    })),
  };
}

function deliveryFeeFromDistance(distanceKmValue) {
  if (distanceKmValue == null) return 1500;
  return Math.max(1500, Math.min(8000, Math.round(distanceKmValue * 450 + 1000)));
}

export async function placeMarketplaceOrder(db, params) {
  const {
    buyerId,
    businessId,
    items,
    fulfillmentType,
    dropoff,
    reference,
    affiliateLinkCode,
    mboloThreadId,
    channel = 'b2c',
    paymentTerm: paymentTermOverride,
    buyerBusinessId,
    preferredDeliveryDate: preferredDeliveryDateRaw,
    paymentSource: paymentSourceRaw = 'personal',
  } = params;

  const paymentSource = paymentSourceRaw === 'kebu' ? 'kebu' : 'personal';
  const preferredDeliveryDate = parsePreferredDeliveryDate(preferredDeliveryDateRaw);

  const business = await db.business.findUnique({
    where: { id: businessId },
    include: { owner: { include: { wallet: true } } },
  });
  if (!business?.owner?.wallet) throw new MarketplaceError('not_found', 'Commerce introuvable');
  if (business.pauseOrders) {
    throw new MarketplaceError('invalid', 'Ce marché n’accepte plus de commandes pour le moment');
  }

  const tradeAccount =
    channel === 'b2b' ? await getTradeAccountForBuyer(db, { supplierBusinessId: businessId, buyerUserId: buyerId }) : null;
  // Credit is granted by the SELLER, never chosen by the buyer:
  // - b2c orders are always paid immediately;
  // - b2b credit/COD terms need an agreed trade account (validated below).
  if (channel === 'b2c' && paymentTermOverride && paymentTermOverride !== 'immediate') {
    throw new MarketplaceError('invalid', 'Paiement immédiat requis pour les commandes particuliers');
  }
  const paymentTerm =
    channel === 'b2c' ? 'immediate' : paymentTermOverride ?? tradeAccount?.paymentTerm ?? 'immediate';
  const payNow = paymentTerm === 'immediate';
  const isCod = paymentTerm === 'cod';

  const productIds = items.map((i) => i.productId);
  const products = await db.product.findMany({
    where: { id: { in: productIds }, businessId, active: true },
  });
  if (products.length !== new Set(productIds).size) {
    throw new MarketplaceError('invalid', 'Un produit n’est plus disponible');
  }

  let totalKori = 0;
  const lineItems = [];
  const summaryParts = [];
  for (const item of items) {
    const product = products.find((p) => p.id === item.productId);
    const qty = Math.max(1, Math.floor(item.quantity));
    if (!product) {
      throw new MarketplaceError('invalid', 'Produit introuvable');
    }
    if (channel === 'b2c' && product.saleChannel === 'b2b') {
      throw new MarketplaceError('invalid', `${product.title} — vente pro uniquement`);
    }
    if (channel === 'b2b' && product.saleChannel === 'b2c') {
      throw new MarketplaceError('invalid', `${product.title} — vente particulier uniquement`);
    }
    const stock = stockMeta(product, business);
    if (!stock.canOrder) {
      throw new MarketplaceError('insufficient', `${product.title} — ${stock.label}`);
    }
    if (product.trackInventory && product.inventory < qty && !stock.canOrder) {
      throw new MarketplaceError('insufficient', `Stock insuffisant pour ${product.title}`);
    }
    const unitPrice = resolveProductUnitPrice(product, { channel, quantity: qty });
    totalKori += unitPrice * qty;
    lineItems.push({
      productId: product.id,
      quantity: qty,
      unitPrice,
      decrementStock: product.trackInventory && product.inventory >= qty,
    });
    summaryParts.push(`${qty}× ${product.title}`);
  }

  const buyer = await db.user.findUnique({ where: { id: buyerId }, include: { wallet: true } });
  if (!buyer?.wallet) throw new MarketplaceError('invalid', 'Portefeuille introuvable');

  if (channel === 'b2b') {
    const effectiveBuyerBusinessId = buyerBusinessId ?? tradeAccount?.buyerBusinessId ?? null;
    if (paymentSource === 'kebu' && !effectiveBuyerBusinessId) {
      throw new MarketplaceError('invalid', 'Commerce acheteur requis pour paiement KEBU');
    }
    await validateB2bOrderPayment(db, {
      buyerId,
      supplierBusinessId: businessId,
      paymentTerm,
      orderTotalKori: totalKori,
      paymentSource,
      buyerBusinessId: effectiveBuyerBusinessId,
    });
  }

  const attribution = affiliateLinkCode
    ? await resolveAffiliateAttribution(db, { linkCode: affiliateLinkCode, buyerId })
    : null;
  const affiliateCommission = attribution
    ? computeAffiliateCommission(totalKori, attribution.commissionBps)
    : 0;

  const bizWallet = await ensureBusinessWallet(businessId, db);

  return runMoneyTransaction(db, async (tx) => {
    for (const li of lineItems) {
      if (!li.decrementStock) continue;
      const updated = await tx.product.updateMany({
        where: { id: li.productId, inventory: { gte: li.quantity } },
        data: { inventory: { decrement: li.quantity } },
      });
      if (updated.count !== 1) {
        throw new MarketplaceError('insufficient', 'Stock épuisé — réessaie');
      }
      const refreshed = await tx.product.findUnique({ where: { id: li.productId } });
      if (refreshed) await afterInventoryChange(tx, business, refreshed);
    }

    try {
      if (payNow) {
        const useKebu = business.distributionEnabled || business.type === 'brand';
        const effectiveBuyerBusinessId = buyerBusinessId ?? tradeAccount?.buyerBusinessId ?? null;

        if (channel === 'b2b' && paymentSource === 'kebu') {
          await requireBusinessPay(buyerId, effectiveBuyerBusinessId, tx);
          await paySupplierB2b(tx, {
            payerUserId: buyerId,
            paymentSource: 'kebu',
            buyerBusinessId: effectiveBuyerBusinessId,
            supplierBusiness: business,
            amountKori: totalKori,
            reference,
            note: 'Commande B2B · KEBU',
          });
        } else if (attribution && affiliateCommission > 0 && !useKebu) {
          await spendKoriWithAffiliateSplit(tx, {
            payerWalletId: buyer.wallet.id,
            merchantWalletId: business.owner.wallet.id,
            affiliateWalletId: attribution.affiliateWalletId,
            payerId: buyerId,
            merchantUserId: business.ownerId,
            affiliateUserId: attribution.affiliateUserId,
            amountKori: totalKori,
            affiliateAmountKori: affiliateCommission,
            reference,
            merchantName: business.name,
            payerName: buyer.name ?? buyer.handle ?? 'Client',
            commissionNote: `Affilié · ${attribution.linkCode}`,
          });
        } else if (useKebu) {
          await spendKoriToBusinessWallet(tx, {
            payerWalletId: buyer.wallet.id,
            payerId: buyerId,
            businessWalletId: bizWallet.id,
            businessId: business.id,
            amountKori: totalKori,
            reference,
            businessName: business.name,
            payerName: buyer.name ?? buyer.handle ?? 'Client',
            merchantUserId: business.ownerId,
            note: channel === 'b2b' ? 'Commande B2B' : 'Commande marketplace',
          });
        } else {
          await spendKoriAtMerchant(tx, {
            payerWalletId: buyer.wallet.id,
            merchantWalletId: business.owner.wallet.id,
            payerId: buyerId,
            merchantUserId: business.ownerId,
            amountKori: totalKori,
            reference,
            merchantName: business.name,
            payerName: buyer.name ?? buyer.handle ?? 'Client',
          });
        }
      }
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        throw new MarketplaceError('insufficient', 'Solde C insuffisant');
      }
      throw err;
    }

    let hub = null;
    let pickupType = 'merchant';
    let pickupLabel = business.name;
    let pickupAddress = business.address ?? business.name;
    let pickupLat = business.lat;
    let pickupLng = business.lng;

    const isBrandWarehouse = business.type === 'brand' || business.category === 'k21';

    if (fulfillmentType === 'delivery') {
      const anchorLat = dropoff?.lat ?? business.lat ?? 14.6928;
      const anchorLng = dropoff?.lng ?? business.lng ?? -17.4467;
      hub = await findNearestHub(tx, anchorLat, anchorLng);

      if (isBrandWarehouse && hub?.isWarehouse) {
        pickupType = 'warehouse';
        pickupLabel = hub.name;
        pickupAddress = hub.address;
        pickupLat = hub.lat;
        pickupLng = hub.lng;
      } else if (hub) {
        pickupType = 'hub';
        pickupLabel = `${hub.name} · collecte ${business.name}`;
        pickupAddress = `${hub.address} (via ${business.name})`;
        pickupLat = business.lat ?? hub.lat;
        pickupLng = business.lng ?? hub.lng;
      }
    }

    const order = await tx.order.create({
      data: {
        buyerId,
        businessId,
        buyerBusinessId: buyerBusinessId ?? tradeAccount?.buyerBusinessId ?? null,
        channel,
        paymentTerm,
        paymentSource: channel === 'b2b' ? paymentSource : 'personal',
        paymentStatus: payNow ? 'paid' : 'pending',
        paidAmount: payNow ? totalKori : 0,
        preferredDeliveryDate,
        orderReference: reference,
        status:
          fulfillmentType === 'pickup'
            ? payNow
              ? 'ready_for_pickup'
              : 'pending_payment'
            : payNow
              ? 'confirmed'
              : 'pending_payment',
        fulfillmentType,
        totalAmount: totalKori,
        deliveryAddress: dropoff?.address ?? null,
        hubId: hub?.id ?? null,
        notes: summaryParts.join(', '),
        affiliateLinkCode: attribution?.linkCode ?? null,
        mboloThreadId: mboloThreadId ?? null,
        items: {
          create: lineItems.map((li) => ({
            productId: li.productId,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
          })),
        },
      },
      include: { items: { include: { product: true } } },
    });

    let tradeInvoice = null;
    if (!payNow && !isCod) {
      tradeInvoice = await createTradeInvoiceInTx(tx, {
        supplierBusinessId: businessId,
        buyerUserId: buyerId,
        buyerBusinessId: buyerBusinessId ?? tradeAccount?.buyerBusinessId ?? null,
        tradeAccountId: tradeAccount?.id ?? null,
        orderId: order.id,
        amountKori: totalKori,
        paymentTerm,
        notes: summaryParts.join(', '),
        invoiceReference: `${reference}-INV`,
      });
      await createInAppNotification(
        buyerId,
        'Facture ouverte',
        `${business.name} · ${formatKori(totalKori)} · échéance ${tradeInvoice.dueAt.toLocaleDateString('fr-FR')}`,
        { kind: 'trade_invoice', refId: tradeInvoice.id },
        tx,
      );
    }

    await notifyNewMarketplaceOrder(tx, { order, business, buyer, totalKori });

    if (attribution && affiliateCommission > 0) {
      await recordAffiliateCommission(tx, {
        attribution,
        buyerId,
        orderId: order.id,
        orderTotal: totalKori,
        source: mboloThreadId ? 'mbolo' : fulfillmentType === 'delivery' ? 'delivery' : 'marketplace',
        mboloThreadId,
        reference: `${reference}-AFFREC`,
      });
      await notifyAffiliateCommission(attribution.affiliateUserId, affiliateCommission, business.name, tx);
    }

    let delivery = null;
    if (fulfillmentType === 'delivery') {
      if (!dropoff?.area || !dropoff?.address) {
        throw new MarketplaceError('invalid', 'Adresse de livraison requise');
      }
      const dist =
        pickupLat != null && pickupLng != null && dropoff.lat != null && dropoff.lng != null
          ? distanceKm(pickupLat, pickupLng, dropoff.lat, dropoff.lng)
          : null;
      delivery = await createDeliveryTask(tx, {
        orderId: order.id,
        buyerId,
        pickupType,
        pickupLabel,
        pickupAddress,
        pickupLat,
        pickupLng,
        dropoffArea: dropoff.area,
        dropoffExact: dropoff.exact ?? dropoff.address,
        dropoffLat: dropoff.lat,
        dropoffLng: dropoff.lng,
        dropoffAddress: dropoff.address,
        deliveryFeeNational: deliveryFeeFromDistance(dist),
        riderKoriEarnings: KORI_EARN.delivery,
        estimatedMinutes: estimateMinutesFromDistance(dist),
        hubId: hub?.id ?? null,
        productSummary: summaryParts.join(', '),
      });
    }

    return { order, delivery, hub, totalKori, tradeInvoice, paymentTerm, channel };
  });
}
