import { z } from 'zod';
import { imageRef } from './commerce/media.js';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import { gateOrExecute } from './risk-gate.js';
import { assertStepUpForAmount, StepUpRequiredError } from './step-up.js';
import { amountToNationalXof } from './kori-primary.js';
import { supportedOriginCountries } from './hub-parcel-service.js';
import { listDeliveryHubs } from './hub-service.js';
import {
  getShopCatalog,
  listNearbyShops,
  marketplaceErrorStatus,
  MarketplaceError,
  placeMarketplaceOrder,
  searchMarketplace,
} from './marketplace-service.js';
import {
  deactivateMerchantProduct,
  getMerchantAnalytics,
  listBuyerOrders,
  listMerchantOrders,
  listMerchantProducts,
  recordProductView,
  updateBusinessOrderSettings,
  updateMerchantProduct,
} from './marketplace-merchant-service.js';

function ref(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function parseCoords(req) {
  const lat = req.query.lat != null ? Number(req.query.lat) : null;
  const lng = req.query.lng != null ? Number(req.query.lng) : null;
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

export async function marketplaceSearch(req, res) {
  const q = String(req.query.q ?? '').trim();
  const category = req.query.category ? String(req.query.category) : undefined;
  const { lat, lng } = parseCoords(req);
  const data = await searchMarketplace(prisma, { q, lat, lng, category });
  res.json(data);
}

export async function marketplaceShopsNearby(req, res) {
  const category = req.query.category ? String(req.query.category) : undefined;
  const { lat, lng } = parseCoords(req);
  const shops = await listNearbyShops(prisma, { lat, lng, category });
  res.json({ shops });
}

export async function marketplaceShopGet(req, res) {
  const businessId = String(req.query.id ?? '');
  if (!businessId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  try {
    const { lat, lng } = parseCoords(req);
    const catalog = await getShopCatalog(prisma, businessId, { lat, lng, viewerId: req.userId });
    res.json(catalog);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function marketplaceHubsList(req, res) {
  const { lat, lng } = parseCoords(req);
  const hubs = await listDeliveryHubs(prisma, { lat, lng, country: req.query.country ? String(req.query.country) : undefined });
  res.json({ hubs, originCountries: supportedOriginCountries() });
}

export async function marketplaceOrderCreate(req, res) {
  const schema = z.object({
    businessId: z.string().min(1),
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.number().int().min(1).max(20),
        }),
      )
      .min(1)
      .max(20),
    fulfillmentType: z.enum(['pickup', 'delivery']),
    dropoff: z
      .object({
        area: z.string().min(2),
        address: z.string().min(2),
        exact: z.string().optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
      })
      .optional(),
    mboloThreadId: z.string().optional(),
    affiliateLinkCode: z.string().min(4).max(32).optional(),
    channel: z.enum(['b2c', 'b2b']).default('b2c'),
    // Terms are only ever what the SUPPLIER granted on a trade account
    // (validateB2bOrderPayment); listing a term here grants nothing.
    paymentTerm: z.enum(['immediate', 'net7', 'net15', 'net30', 'net60', 'net90', 'monthly', 'cod']).optional(),
    // J5 fulfilment contract: Jokko Fulfilment is DORMANT and refused.
    fulfillmentOwner: z.enum(['merchant', 'jokko']).optional(),
    deliveryAddressId: z.string().optional(),
    buyerBusinessId: z.string().optional(),
    preferredDeliveryDate: z.string().optional(),
    paymentSource: z.enum(['personal', 'kebu']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  if (parsed.data.fulfillmentOwner === 'jokko') {
    res.status(409).json({ error: 'Jokko Fulfilment n’est pas encore activé — le commerce prépare lui-même la commande.', code: 'fulfillment_not_activated' });
    return;
  }
  if (parsed.data.deliveryAddressId) {
    const addr = await prisma.address.findUnique({ where: { id: parsed.data.deliveryAddressId } });
    if (!addr || addr.ownerType !== 'user' || addr.ownerId !== req.userId) {
      res.status(400).json({ error: 'Adresse de livraison invalide', code: 'invalid_address' });
      return;
    }
  }
  if (parsed.data.fulfillmentType === 'delivery' && !parsed.data.dropoff) {
    res.status(400).json({ error: 'Adresse de livraison requise', code: 'dropoff_required' });
    return;
  }

  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, include: { wallet: true } });
  const channel = parsed.data.channel ?? 'b2c';
  const paymentTerm = parsed.data.paymentTerm ?? (channel === 'b2b' ? undefined : 'immediate');
  const paymentSource = parsed.data.paymentSource === 'kebu' ? 'kebu' : 'personal';
  const payNow = (paymentTerm ?? 'immediate') === 'immediate';

  const previewProducts = await prisma.product.findMany({
    where: { id: { in: parsed.data.items.map((i) => i.productId) }, businessId: parsed.data.businessId, active: true },
  });
  let previewTotal = 0;
  for (const item of parsed.data.items) {
    const p = previewProducts.find((x) => x.id === item.productId);
    if (!p) continue;
    const unit =
      channel === 'b2b' && p.b2bPrice != null && item.quantity >= (p.b2bMinQty ?? 1)
        ? p.b2bPrice
        : p.flashPrice != null && p.flashExpiresAt && p.flashExpiresAt > new Date()
          ? p.flashPrice
          : p.price;
    previewTotal += unit * item.quantity;
  }

  if (payNow) {
    try {
      await assertStepUpForAmount(req, amountToNationalXof(previewTotal, 'kori', buyer.country));
    } catch (error) {
      if (error instanceof StepUpRequiredError) {
        res.status(403).json({ error: error.message, code: error.code, thresholdXOF: 50_000 });
        return;
      }
      throw error;
    }
  }

  const reference = ref('MKT');

  try {
    const gate = await gateOrExecute(
      req,
      res,
      {
        operationType: 'marketplace_order',
        amountNational: amountToNationalXof(previewTotal, 'kori', buyer.country),
        recipientId: parsed.data.businessId,
        payload: {
          buyerId: req.userId,
          businessId: parsed.data.businessId,
          items: parsed.data.items,
          fulfillmentType: parsed.data.fulfillmentType,
          dropoff: parsed.data.dropoff,
          reference,
          affiliateLinkCode: parsed.data.affiliateLinkCode,
          mboloThreadId: parsed.data.mboloThreadId,
          channel,
          paymentTerm,
          buyerBusinessId: parsed.data.buyerBusinessId,
          preferredDeliveryDate: parsed.data.preferredDeliveryDate,
          paymentSource,
        },
      },
      async (heldRef) => {
        const result = await placeMarketplaceOrder(prisma, {
          buyerId: req.userId,
          businessId: parsed.data.businessId,
          items: parsed.data.items,
          fulfillmentType: parsed.data.fulfillmentType,
          dropoff: parsed.data.dropoff,
          reference: heldRef ?? reference,
          affiliateLinkCode: parsed.data.affiliateLinkCode,
          mboloThreadId: parsed.data.mboloThreadId,
          channel,
          paymentTerm,
          buyerBusinessId: parsed.data.buyerBusinessId,
          preferredDeliveryDate: parsed.data.preferredDeliveryDate,
          paymentSource,
          deliveryAddressId: parsed.data.deliveryAddressId,
        });
        return {
          orderId: result.order.id,
          status: result.order.status,
          fulfillmentType: result.order.fulfillmentType,
          totalKori: result.totalKori,
          hub: result.hub
            ? { id: result.hub.id, name: result.hub.name, address: result.hub.address }
            : null,
          delivery: result.delivery
            ? {
                id: result.delivery.id,
                status: result.delivery.status,
                deliveryFeeNational: result.delivery.deliveryFeeNational,
                pickupType: result.delivery.pickupType,
                pickupLabel: result.delivery.pickupLabel,
              }
            : null,
          invoice: result.tradeInvoice
            ? { id: result.tradeInvoice.id, reference: result.tradeInvoice.reference, dueAt: result.tradeInvoice.dueAt }
            : null,
          channel: result.channel,
          paymentTerm: result.paymentTerm,
        };
      },
    );
    if (gate.held) return;
    res.status(201).json(gate.result);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function marketplaceOrdersMine(req, res) {
  const orders = await listBuyerOrders(prisma, req.userId);
  res.json({ orders });
}

export async function marketplaceOrdersMerchant(req, res) {
  const businessId = String(req.query.businessId ?? '');
  if (!businessId) {
    res.status(400).json({ error: 'businessId required' });
    return;
  }
  try {
    const orders = await listMerchantOrders(prisma, { businessId, ownerId: req.userId });
    res.json({ orders });
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function marketplaceCatalogMine(req, res) {
  const businessId = String(req.query.businessId ?? '');
  if (!businessId) {
    res.status(400).json({ error: 'businessId required' });
    return;
  }
  try {
    const catalog = await listMerchantProducts(prisma, businessId, req.userId);
    res.json(catalog);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function marketplaceProductPatch(req, res) {
  const productId = String(req.query.id ?? '');
  if (!productId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const schema = z.object({
    title: z.string().min(2).optional(),
    description: z.string().optional(),
    price: z.number().int().positive().optional(),
    inventory: z.number().int().min(0).optional(),
    category: z.string().optional(),
    imageUrl: imageRef.optional(),
    trackInventory: z.boolean().optional(),
    allowBackorder: z.boolean().optional(),
    lowStockThreshold: z.number().int().min(0).max(9999).optional(),
    b2bPrice: z.number().int().positive().optional().nullable(),
    b2bMinQty: z.number().int().min(1).optional(),
    unitLabel: z.string().max(40).optional().nullable(),
    saleChannel: z.enum(['b2c', 'b2b', 'both']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const product = await updateMerchantProduct(prisma, {
      productId,
      ownerId: req.userId,
      patch: parsed.data,
    });
    res.json(product);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function marketplaceProductDelete(req, res) {
  const productId = String(req.query.id ?? '');
  if (!productId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  try {
    const result = await deactivateMerchantProduct(prisma, { productId, ownerId: req.userId });
    res.json(result);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function marketplaceProductView(req, res) {
  const productId = String(req.query.id ?? '');
  if (!productId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const result = await recordProductView(prisma, { productId, userId: req.userId });
  res.json(result ?? { ok: true });
}

export async function marketplaceAnalytics(req, res) {
  const businessId = String(req.query.businessId ?? '');
  if (!businessId) {
    res.status(400).json({ error: 'businessId required' });
    return;
  }
  try {
    const analytics = await getMerchantAnalytics(prisma, { businessId, ownerId: req.userId });
    res.json(analytics);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function marketplaceBusinessSettings(req, res) {
  const businessId = String(req.query.id ?? '');
  if (!businessId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const schema = z.object({
    acceptOrdersWhenOutOfStock: z.boolean().optional(),
    pauseOrders: z.boolean().optional(),
    lowStockAlertEnabled: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const settings = await updateBusinessOrderSettings(prisma, {
      businessId,
      ownerId: req.userId,
      settings: parsed.data,
    });
    res.json(settings);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}
