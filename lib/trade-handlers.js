import { z } from 'zod';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import { assertStepUpForAmount, StepUpRequiredError } from './step-up.js';
import { amountToNationalXof } from './kori-primary.js';
import { marketplaceErrorStatus, MarketplaceError } from './marketplace-service.js';
import {
  listBuyerInvoices,
  listSupplierInvoices,
  listSupplierTradeAccounts,
  listBuyerPortalSuppliers,
  getBuyerPortalCatalog,
  getSupplierReceivables,
  payTradeInvoice,
  registerDistributionBrand,
  seedBrandProducts,
  upsertTradeAccount,
  getBuyerTradeSummary,
  disputeTradeInvoice,
  resolveTradeInvoiceDispute,
} from './trade-service.js';
import { buyerConfirmOrder, getOrderForUser, updateOrderStatus } from './order-fulfillment-service.js';
import { computeKebuScore } from './kebu-score-service.js';

export async function businessKebuScoreGet(req, res) {
  const businessId = String(req.query.id ?? '');
  if (!businessId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const score = await computeKebuScore(businessId, prisma);
  if (!score) {
    res.status(404).json({ error: 'Commerce introuvable' });
    return;
  }
  res.json(score);
}

export async function distributionBrandRegister(req, res) {
  const schema = z.object({
    name: z.string().min(2).max(120),
    category: z.string().optional(),
    description: z.string().max(500).optional(),
    address: z.string().optional(),
    arrondissement: z.string().optional(),
    products: z
      .array(
        z.object({
          title: z.string().min(2),
          description: z.string().optional(),
          price: z.number().int().positive(),
          b2bPrice: z.number().int().positive().optional(),
          b2bMinQty: z.number().int().min(1).optional(),
          unitLabel: z.string().optional(),
          saleChannel: z.enum(['b2c', 'b2b', 'both']).optional(),
          category: z.string().optional(),
          inventory: z.number().int().min(0).optional(),
        }),
      )
      .optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const business = await registerDistributionBrand(prisma, {
      ownerId: req.userId,
      payload: parsed.data,
    });
    let products = [];
    if (parsed.data.products?.length) {
      products = await seedBrandProducts(prisma, {
        businessId: business.id,
        ownerId: req.userId,
        products: parsed.data.products,
      });
    }
    res.status(201).json({
      business: {
        id: business.id,
        name: business.name,
        type: business.type,
        category: business.category,
        kebuId: business.kebuId,
        distributionEnabled: business.distributionEnabled,
      },
      productCount: products.length,
    });
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function distributionBrandMine(req, res) {
  const business = await prisma.business.findFirst({
    where: { ownerId: req.userId, type: 'brand', distributionEnabled: true },
    include: { wallet: true, _count: { select: { products: true, orders: true } } },
  });
  if (!business) {
    res.json({ brand: null });
    return;
  }
  res.json({
    brand: {
      id: business.id,
      name: business.name,
      kebuId: business.kebuId,
      category: business.category,
      productCount: business._count.products,
      orderCount: business._count.orders,
      kebuBalance: business.wallet?.balance ?? 0,
    },
  });
}

export async function tradeAccountsList(req, res) {
  const businessId = String(req.query.businessId ?? req.query.id ?? '');
  if (!businessId) {
    res.status(400).json({ error: 'businessId required' });
    return;
  }
  try {
    const accounts = await listSupplierTradeAccounts(prisma, {
      supplierBusinessId: businessId,
      ownerId: req.userId,
    });
    res.json({ accounts });
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function tradeAccountUpsert(req, res) {
  const businessId = String(req.query.businessId ?? req.body.businessId ?? '');
  const schema = z.object({
    buyerHandle: z.string().min(2),
    buyerLabel: z.string().optional(),
    buyerType: z.enum(['merchant', 'farm', 'consumer']).optional(),
    buyerKebuId: z.string().optional(),
    buyerBusinessId: z.string().optional(),
    paymentTerm: z.enum(['immediate', 'net7', 'net15', 'net30', 'net60', 'net90', 'monthly']).optional(),
    creditLimitKori: z.number().int().min(0).optional(),
    codEnabled: z.boolean().optional(),
    trustTier: z.enum(['new', 'trusted', 'partner']).optional(),
    codLimitKori: z.number().int().min(0).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success || !businessId) return validationError(res, parsed.error ?? { issues: [] });

  try {
    const account = await upsertTradeAccount(prisma, {
      supplierBusinessId: businessId,
      ownerId: req.userId,
      payload: parsed.data,
    });
    res.json(account);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function tradeInvoicesMine(req, res) {
  const status = req.query.status ? String(req.query.status) : undefined;
  const invoices = await listBuyerInvoices(prisma, req.userId, { status });
  res.json({ invoices });
}

export async function tradeInvoicesSupplier(req, res) {
  const businessId = String(req.query.businessId ?? '');
  const status = req.query.status ? String(req.query.status) : undefined;
  if (!businessId) {
    res.status(400).json({ error: 'businessId required' });
    return;
  }
  try {
    const invoices = await listSupplierInvoices(prisma, {
      supplierBusinessId: businessId,
      ownerId: req.userId,
      status,
    });
    res.json({ invoices });
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function tradeInvoicePay(req, res) {
  const invoiceId = String(req.query.id ?? req.body.invoiceId ?? '');
  const schema = z.object({
    paymentSource: z.enum(['personal', 'kebu']).optional(),
    buyerBusinessId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!invoiceId) {
    res.status(400).json({ error: 'invoiceId required' });
    return;
  }
  try {
    const preview = await prisma.tradeInvoice.findUnique({
      where: { id: invoiceId },
      include: { supplier: true },
    });
    if (!preview || preview.buyerUserId !== req.userId) {
      res.status(404).json({ error: 'Facture introuvable', code: 'not_found' });
      return;
    }
    const due = preview.amountKori - (preview.creditedKori ?? 0) - preview.amountPaid;
    if (due <= 0) {
      res.status(400).json({ error: 'Rien à payer', code: 'invalid_state' });
      return;
    }
    const paymentSource = parsed.success ? parsed.data.paymentSource ?? 'personal' : 'personal';
    const buyerBusinessId =
      (parsed.success ? parsed.data.buyerBusinessId : undefined) ?? preview.buyerBusinessId ?? undefined;
    if (paymentSource === 'kebu' && !buyerBusinessId) {
      res.status(400).json({ error: 'Commerce acheteur requis pour KEBU', code: 'invalid' });
      return;
    }
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    try {
      await assertStepUpForAmount(req, amountToNationalXof(due, 'kori', buyer.country));
    } catch (error) {
      if (error instanceof StepUpRequiredError) {
        res.status(403).json({ error: error.message, code: error.code, thresholdXOF: 50_000 });
        return;
      }
      throw error;
    }

    const invoice = await payTradeInvoice(prisma, {
      invoiceId,
      payerUserId: req.userId,
      paymentSource,
      buyerBusinessId,
    });
    res.json(invoice);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function tradeInvoiceDispute(req, res) {
  const invoiceId = String(req.query.id ?? req.body.invoiceId ?? '');
  const schema = z.object({ reason: z.string().min(3).max(500) });
  const parsed = schema.safeParse(req.body ?? {});
  if (!invoiceId || !parsed.success) return validationError(res, parsed.error ?? { issues: [] });

  try {
    const invoice = await disputeTradeInvoice(prisma, {
      invoiceId,
      buyerUserId: req.userId,
      reason: parsed.data.reason,
    });
    res.json(invoice);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function tradeInvoiceDisputeResolve(req, res) {
  const invoiceId = String(req.query.id ?? req.body.invoiceId ?? '');
  const schema = z.object({
    action: z.enum(['reject', 'waive', 'adjust']),
    note: z.string().max(500).optional(),
    newAmountKori: z.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!invoiceId || !parsed.success) return validationError(res, parsed.error ?? { issues: [] });

  try {
    const invoice = await resolveTradeInvoiceDispute(prisma, {
      invoiceId,
      supplierOwnerId: req.userId,
      action: parsed.data.action,
      note: parsed.data.note,
      newAmountKori: parsed.data.newAmountKori,
    });
    res.json(invoice);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function buyerPortalSuppliers(req, res) {
  try {
    const suppliers = await listBuyerPortalSuppliers(prisma, req.userId);
    res.json({ suppliers });
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function buyerPortalCatalog(req, res) {
  const businessId = String(req.query.businessId ?? '');
  if (!businessId) {
    res.status(400).json({ error: 'businessId required' });
    return;
  }
  try {
    const catalog = await getBuyerPortalCatalog(prisma, {
      buyerUserId: req.userId,
      supplierBusinessId: businessId,
    });
    res.json(catalog);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function supplierReceivables(req, res) {
  const businessId = String(req.query.businessId ?? '');
  if (!businessId) {
    res.status(400).json({ error: 'businessId required' });
    return;
  }
  try {
    const receivables = await getSupplierReceivables(prisma, {
      supplierBusinessId: businessId,
      ownerId: req.userId,
    });
    res.json(receivables);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function marketplaceOrderGet(req, res) {
  const orderId = String(req.query.id ?? '');
  if (!orderId) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  try {
    const order = await getOrderForUser(prisma, { orderId, userId: req.userId });
    res.json(order);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function marketplaceOrderStatus(req, res) {
  const orderId = String(req.query.id ?? '');
  const schema = z.object({ status: z.enum(['preparing', 'ready_for_pickup', 'out_for_delivery']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success || !orderId) return validationError(res, parsed.error);

  try {
    const order = await updateOrderStatus(prisma, {
      orderId,
      ownerId: req.userId,
      status: parsed.data.status,
    });
    res.json(order);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function tradeSummaryCheckout(req, res) {
  const businessId = String(req.query.businessId ?? '');
  if (!businessId) {
    res.status(400).json({ error: 'businessId required' });
    return;
  }
  try {
    const summary = await getBuyerTradeSummary(prisma, {
      buyerUserId: req.userId,
      supplierBusinessId: businessId,
    });
    res.json(summary);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function marketplaceOrderConfirm(req, res) {
  const orderId = String(req.query.id ?? '');
  if (!orderId) {
    res.status(400).json({ error: 'id required' });
    return;
  }

  const preview = await prisma.order.findUnique({
    where: { id: orderId },
    select: { buyerId: true, paymentTerm: true, paymentStatus: true, totalAmount: true, paidAmount: true },
  });
  if (!preview || preview.buyerId !== req.userId) {
    res.status(404).json({ error: 'Commande introuvable', code: 'not_found' });
    return;
  }

  if (preview.paymentTerm === 'cod' && preview.paymentStatus !== 'paid') {
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const due = preview.totalAmount - (preview.paidAmount ?? 0);
    try {
      await assertStepUpForAmount(req, amountToNationalXof(due, 'kori', buyer.country));
    } catch (error) {
      if (error instanceof StepUpRequiredError) {
        res.status(403).json({ error: error.message, code: error.code, thresholdXOF: 50_000 });
        return;
      }
      throw error;
    }
  }

  try {
    const order = await buyerConfirmOrder(prisma, {
      orderId,
      buyerId: req.userId,
      payerReference: `COD-${Date.now()}`,
    });
    res.json(order);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      res.status(marketplaceErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    const { OrderError } = await import('./commerce/orders.js');
    if (error instanceof OrderError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function riderActiveDeliveries(req, res) {
  const tasks = await prisma.deliveryTask.findMany({
    where: {
      assignedDriverId: req.userId,
      status: { in: ['assigned', 'picked_up', 'in_transit', 'delivered'] },
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    include: {
      order: { select: { id: true, notes: true, totalAmount: true, status: true } },
    },
  });
  res.json({
    deliveries: tasks.map((t) => ({
      id: t.id,
      status: t.status,
      pickupLabel: t.pickupLabel,
      dropoffArea: t.dropoffArea,
      orderId: t.orderId,
      orderNotes: t.order?.notes,
      orderStatus: t.order?.status,
    })),
  });
}
