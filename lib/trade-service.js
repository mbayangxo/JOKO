import { reference } from '../api/_lib/auth.js';
import { formatKori } from './kori.js';
import { createInAppNotification } from './notify-service.js';
import {
  ensureBusinessWallet,
  payInvoiceToBusinessWallet,
  spendKoriToBusinessWallet,
  transferBusinessToBusiness,
} from './business-wallet-service.js';
import { requireBusinessPay } from './business-access.js';
import { InsufficientFundsError, runMoneyTransaction } from './wallet-atomic.js';
import { MarketplaceError } from './marketplace-service.js';
import { computeKebuScore } from './kebu-score-service.js';

export const NEW_BUYER_COD_LIMIT_KORI = 25_000;
export const DEFAULT_COD_LIMIT_KORI = 50_000;

export function tradeAccountShape(row) {
  return {
    id: row.id,
    supplierBusinessId: row.supplierBusinessId,
    buyerUserId: row.buyerUserId,
    buyerBusinessId: row.buyerBusinessId ?? null,
    buyerLabel: row.buyerLabel ?? null,
    buyerType: row.buyerType,
    paymentTerm: row.paymentTerm,
    creditLimitKori: row.creditLimitKori,
    creditLimitFormatted: formatKori(row.creditLimitKori),
    codEnabled: row.codEnabled ?? false,
    trustTier: row.trustTier ?? 'new',
    codLimitKori: row.codLimitKori ?? DEFAULT_COD_LIMIT_KORI,
    codLimitFormatted: formatKori(row.codLimitKori ?? DEFAULT_COD_LIMIT_KORI),
    priceLockUntil: row.priceLockUntil?.toISOString?.() ?? null,
    active: row.active,
    buyer: row.buyer
      ? { id: row.buyer.id, name: row.buyer.name, handle: row.buyer.handle }
      : null,
    buyerBusiness: row.buyerBusiness
      ? { id: row.buyerBusiness.id, name: row.buyerBusiness.name, kebuId: row.buyerBusiness.kebuId }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function tradeInvoiceShape(row) {
  return {
    id: row.id,
    reference: row.reference,
    supplierBusinessId: row.supplierBusinessId,
    // J7.10: principal is immutable; corrections are credit memos. amountKori here is the NET billed.
    principalKori: row.amountKori,
    creditedKori: row.creditedKori ?? 0,
    amountKori: row.amountKori - (row.creditedKori ?? 0),
    amountPaid: row.amountPaid,
    amountDue: row.amountKori - (row.creditedKori ?? 0) - row.amountPaid,
    amountFormatted: formatKori(row.amountKori - (row.creditedKori ?? 0)),
    dueFormatted: formatKori(Math.max(0, row.amountKori - (row.creditedKori ?? 0) - row.amountPaid)),
    status: row.status,
    paymentTerm: row.tradeAccount?.paymentTerm ?? null,
    dueAt: row.dueAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    notes: row.notes,
    disputeReason: row.disputeReason ?? null,
    disputedAt: row.disputedAt?.toISOString() ?? null,
    disputeResolutionNote: row.disputeResolutionNote ?? null,
    orderId: row.orderId,
    supplier: row.supplier ? { id: row.supplier.id, name: row.supplier.name } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function computeDueDate(paymentTerm, from = new Date()) {
  const d = new Date(from);
  switch (paymentTerm) {
    case 'immediate':
      return d;
    case 'net7':
      d.setDate(d.getDate() + 7);
      return d;
    case 'net15':
      d.setDate(d.getDate() + 15);
      return d;
    case 'net60':
      d.setDate(d.getDate() + 60);
      return d;
    case 'net90':
      d.setDate(d.getDate() + 90);
      return d;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      d.setDate(1);
      return d;
    case 'cod':
      d.setDate(d.getDate() + 7);
      return d;
    case 'net30':
    default:
      d.setDate(d.getDate() + 30);
      return d;
  }
}

export function resolveProductUnitPrice(product, { channel = 'b2c', quantity = 1 }) {
  if (channel === 'b2b' && product.b2bPrice != null && quantity >= (product.b2bMinQty ?? 1)) {
    return product.b2bPrice;
  }
  if (product.flashPrice != null && product.flashExpiresAt && product.flashExpiresAt > new Date()) {
    return product.flashPrice;
  }
  return product.price;
}

export async function getTradeAccountForBuyer(db, { supplierBusinessId, buyerUserId }) {
  return db.tradeAccount.findUnique({
    where: { supplierBusinessId_buyerUserId: { supplierBusinessId, buyerUserId } },
    include: {
      buyer: { select: { id: true, name: true, handle: true } },
      buyerBusiness: { select: { id: true, name: true, kebuId: true } },
    },
  });
}

export async function listSupplierTradeAccounts(db, { supplierBusinessId, ownerId }) {
  const business = await db.business.findFirst({ where: { id: supplierBusinessId, ownerId } });
  if (!business) throw new MarketplaceError('forbidden', 'Commerce introuvable');

  const rows = await db.tradeAccount.findMany({
    where: { supplierBusinessId, active: true },
    include: {
      buyer: { select: { id: true, name: true, handle: true } },
      buyerBusiness: { select: { id: true, name: true, kebuId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(tradeAccountShape);
}

export async function upsertTradeAccount(db, { supplierBusinessId, ownerId, payload }) {
  const business = await db.business.findFirst({ where: { id: supplierBusinessId, ownerId } });
  if (!business) throw new MarketplaceError('forbidden', 'Commerce introuvable');

  const buyer = await db.user.findUnique({ where: { handle: payload.buyerHandle.replace(/^@/, '') } });
  if (!buyer) throw new MarketplaceError('not_found', 'Acheteur introuvable');

  let buyerBusinessId = payload.buyerBusinessId ?? null;
  if (payload.buyerKebuId) {
    const bb = await db.business.findUnique({ where: { kebuId: payload.buyerKebuId } });
    if (bb) buyerBusinessId = bb.id;
  }

  const row = await db.tradeAccount.upsert({
    where: { supplierBusinessId_buyerUserId: { supplierBusinessId, buyerUserId: buyer.id } },
    create: {
      supplierBusinessId,
      buyerUserId: buyer.id,
      buyerBusinessId,
      buyerLabel: payload.buyerLabel ?? buyer.name ?? buyer.handle,
      buyerType: payload.buyerType ?? 'merchant',
      paymentTerm: payload.paymentTerm ?? 'net30',
      creditLimitKori: payload.creditLimitKori ?? 0,
      codEnabled: payload.codEnabled ?? false,
      trustTier: payload.trustTier ?? 'new',
      codLimitKori: payload.codLimitKori ?? DEFAULT_COD_LIMIT_KORI,
      active: true,
    },
    update: {
      buyerBusinessId,
      buyerLabel: payload.buyerLabel ?? undefined,
      buyerType: payload.buyerType ?? undefined,
      paymentTerm: payload.paymentTerm ?? undefined,
      creditLimitKori: payload.creditLimitKori ?? undefined,
      codEnabled: payload.codEnabled ?? undefined,
      trustTier: payload.trustTier ?? undefined,
      codLimitKori: payload.codLimitKori ?? undefined,
      active: payload.active ?? true,
    },
    include: {
      buyer: { select: { id: true, name: true, handle: true } },
      buyerBusiness: { select: { id: true, name: true, kebuId: true } },
    },
  });

  await createInAppNotification(buyer.id, 'Compte distributeur K21', `${business.name} t’a ajouté comme client B2B`, {
    kind: 'trade_account',
    refId: row.id,
  });

  const shaped = tradeAccountShape(row);
  if (row.buyerBusinessId) {
    const buyerScore = await computeKebuScore(row.buyerBusinessId, db);
    if (buyerScore) {
      shaped.buyerKebuScore = buyerScore;
      shaped.creditLimitAboveSuggested = row.creditLimitKori > buyerScore.suggestedCreditLimitKori;
    }
  }
  return shaped;
}

export async function createTradeInvoiceInTx(tx, params) {
  const {
    supplierBusinessId,
    buyerUserId,
    buyerBusinessId,
    tradeAccountId,
    orderId,
    amountKori,
    paymentTerm,
    notes,
    invoiceReference,
  } = params;

  return tx.tradeInvoice.create({
    data: {
      supplierBusinessId,
      buyerUserId,
      buyerBusinessId: buyerBusinessId ?? null,
      tradeAccountId: tradeAccountId ?? null,
      orderId,
      reference: invoiceReference ?? reference('INV'),
      amountKori,
      amountPaid: 0,
      status: 'open',
      dueAt: computeDueDate(paymentTerm),
      notes: notes ?? null,
    },
  });
}

// "open" means "still unpaid" to every caller — an overdue or disputed
// invoice is still something the buyer owes (or is arguing about owing),
// so it must stay in the same "open" bucket rather than vanish once the
// reminder cron or a dispute flips its status.
const OUTSTANDING_STATUSES = ['open', 'partial', 'overdue', 'disputed'];

function statusFilter(status) {
  if (status === 'open') return { in: OUTSTANDING_STATUSES };
  return status ? status : undefined;
}

export async function listBuyerInvoices(db, buyerUserId, { status } = {}) {
  const rows = await db.tradeInvoice.findMany({
    where: {
      buyerUserId,
      ...(status ? { status: statusFilter(status) } : {}),
    },
    include: {
      supplier: { select: { id: true, name: true } },
      tradeAccount: { select: { paymentTerm: true } },
    },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  });
  return rows.map(tradeInvoiceShape);
}

export async function listSupplierInvoices(db, { supplierBusinessId, ownerId, status }) {
  const business = await db.business.findFirst({ where: { id: supplierBusinessId, ownerId } });
  if (!business) throw new MarketplaceError('forbidden', 'Commerce introuvable');

  const rows = await db.tradeInvoice.findMany({
    where: {
      supplierBusinessId,
      ...(status ? { status: statusFilter(status) } : {}),
    },
    include: {
      supplier: { select: { id: true, name: true } },
      tradeAccount: { select: { paymentTerm: true } },
      buyer: { select: { id: true, name: true, handle: true } },
    },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  });
  return rows.map(tradeInvoiceShape);
}

export async function paySupplierB2b(tx, params) {
  const {
    payerUserId,
    paymentSource = 'personal',
    buyerBusinessId,
    supplierBusiness,
    amountKori,
    reference: ref,
    note,
  } = params;
  const supplierBusinessId = supplierBusiness.id;
  const supplierWallet = await ensureBusinessWallet(supplierBusinessId, tx);

  if (paymentSource === 'kebu') {
    if (!buyerBusinessId) throw new MarketplaceError('invalid', 'Commerce acheteur requis pour KEBU');
    await requireBusinessPay(payerUserId, buyerBusinessId, tx);
    const buyerBiz = await tx.business.findUnique({ where: { id: buyerBusinessId } });
    if (!buyerBiz) throw new MarketplaceError('not_found', 'Commerce acheteur introuvable');
    const senderWallet = await ensureBusinessWallet(buyerBusinessId, tx);
    try {
      await transferBusinessToBusiness(tx, {
        amount: amountKori,
        senderWalletId: senderWallet.id,
        senderBusinessId: buyerBusinessId,
        recipientWalletId: supplierWallet.id,
        recipientBusinessId: supplierBusinessId,
        reference: ref,
        actingUserId: payerUserId,
        capability: 'business.pay',
        senderLedger: {
          type: 'b2b_out',
          counterpartyName: supplierBusiness.name,
          counterpartyKebuId: supplierBusiness.kebuId ?? null,
          note,
        },
        recipientLedger: {
          type: 'b2b_in',
          counterpartyName: buyerBiz.name,
          counterpartyKebuId: buyerBiz.kebuId ?? null,
          note,
        },
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        throw new MarketplaceError('insufficient', 'Solde KEBU insuffisant');
      }
      throw err;
    }
    return { paymentSource: 'kebu', buyerBusinessId };
  }

  const payer = await tx.user.findUnique({ where: { id: payerUserId }, include: { wallet: true } });
  if (!payer?.wallet) throw new MarketplaceError('invalid', 'Portefeuille introuvable');

  try {
    await payInvoiceToBusinessWallet(tx, {
      payerWalletId: payer.wallet.id,
      payerId: payerUserId,
      businessWalletId: supplierWallet.id,
      businessId: supplierBusinessId,
      amountKori,
      reference: ref,
      businessName: supplierBusiness.name,
      payerName: payer.name ?? payer.handle,
      merchantUserId: supplierBusiness.ownerId,
      note,
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw new MarketplaceError('insufficient', 'Solde C insuffisant');
    }
    throw err;
  }
  return { paymentSource: 'personal' };
}

export async function payTradeInvoice(
  db,
  { invoiceId, payerUserId, payerReference, paymentSource = 'personal', buyerBusinessId },
) {
  return runMoneyTransaction(db, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "TradeInvoice" WHERE id = ${invoiceId} FOR UPDATE`;
    const invoice = await tx.tradeInvoice.findUnique({
      where: { id: invoiceId },
      include: { supplier: { include: { owner: { include: { wallet: true } } } } },
    });
    if (!invoice || invoice.buyerUserId !== payerUserId) {
      throw new MarketplaceError('not_found', 'Facture introuvable');
    }
    if (invoice.status === 'paid') {
      throw new MarketplaceError('invalid_state', 'Facture déjà payée');
    }
    if (invoice.status === 'disputed') {
      throw new MarketplaceError('invalid_state', 'Facture contestée — en attente de réponse du fournisseur');
    }

    const due = invoice.amountKori - (invoice.creditedKori ?? 0) - invoice.amountPaid;
    if (due <= 0) {
      throw new MarketplaceError('invalid_state', 'Rien à payer');
    }

    const ref = payerReference ?? reference('INVPAY');
    // J7.10: one payment row per payment (unique ledger reference) — replays never apply twice.
    if (await tx.tradeInvoicePayment.findUnique({ where: { ledgerReference: ref } })) {
      throw new MarketplaceError('invalid_state', 'Paiement déjà appliqué');
    }
    const effectiveBuyerBusinessId = buyerBusinessId ?? invoice.buyerBusinessId ?? null;
    if (paymentSource === 'kebu' && !effectiveBuyerBusinessId) {
      throw new MarketplaceError('invalid', 'Commerce acheteur requis pour KEBU');
    }

    await paySupplierB2b(tx, {
      payerUserId,
      paymentSource,
      buyerBusinessId: effectiveBuyerBusinessId,
      supplierBusiness: invoice.supplier,
      amountKori: due,
      reference: ref,
      note: `Facture ${invoice.reference}`,
    });

    await tx.tradeInvoicePayment.create({ data: { invoiceId: invoice.id, amountKori: due, ledgerReference: ref, paidByUserId: payerUserId, paymentSource } });
    const updated = await tx.tradeInvoice.update({
      where: { id: invoice.id },
      data: {
        amountPaid: invoice.amountPaid + due,
        status: 'paid',
        paidAt: new Date(),
      },
    });
    if (invoice.purchaseOrderId) {
      await tx.purchaseOrder.update({ where: { id: invoice.purchaseOrderId }, data: { paymentStatus: 'paid' } });
    }

    if (invoice.orderId) {
      await tx.order.update({
        where: { id: invoice.orderId },
        data: {
          paymentStatus: 'paid',
          paidAmount: invoice.amountPaid + due,
          paymentSource,
          status: 'confirmed',
        },
      });
    }

    await createInAppNotification(invoice.supplier.ownerId, 'Facture payée', `${formatKori(due)} · ${invoice.reference}`, {
      kind: 'trade_invoice_paid',
      refId: invoice.id,
    }, tx);

    return tradeInvoiceShape({ ...updated, supplier: invoice.supplier, tradeAccount: null });
  });
}

// What status an invoice naturally falls back to once a dispute is
// rejected or resolved — recomputed rather than stored, so it always
// reflects the invoice's actual amountPaid/dueAt at resolution time.
function naturalInvoiceStatus({ amountKori, amountPaid, dueAt, creditedKori = 0 }) {
  if (amountPaid + creditedKori >= amountKori) return 'paid';
  if (amountPaid > 0) return 'partial';
  return dueAt < new Date() ? 'overdue' : 'open';
}

/**
 * Buyer flags an invoice as wrong before paying it. Disputing freezes the
 * invoice (payTradeInvoice refuses it while status is 'disputed') until the
 * supplier responds — no money moves here, this only applies pre-payment;
 * only the unpaid remainder can ever be disputed/waived/adjusted, so an
 * already-settled amount is never touched.
 */
export async function disputeTradeInvoice(db, { invoiceId, buyerUserId, reason }) {
  const invoice = await db.tradeInvoice.findUnique({ where: { id: invoiceId }, include: { supplier: true } });
  if (!invoice || invoice.buyerUserId !== buyerUserId) {
    throw new MarketplaceError('not_found', 'Facture introuvable');
  }
  if (!OUTSTANDING_STATUSES.filter((s) => s !== 'disputed').includes(invoice.status)) {
    throw new MarketplaceError('invalid_state', 'Cette facture ne peut pas être contestée');
  }

  const updated = await db.tradeInvoice.update({
    where: { id: invoice.id },
    data: { status: 'disputed', disputeReason: reason, disputedAt: new Date(), disputeResolutionNote: null },
  });

  await createInAppNotification(
    invoice.supplier.ownerId,
    'Facture contestée',
    `${invoice.reference} — ${reason}`,
    { kind: 'trade_invoice_disputed', refId: invoice.id },
  );

  return tradeInvoiceShape({ ...updated, supplier: invoice.supplier, tradeAccount: null });
}

/**
 * Supplier's response to a dispute: reject (invoice reverts to its natural
 * status, nothing changes), waive (forgive whatever's still unpaid), or
 * adjust (correct the billed amount to newAmountKori, which can't be set
 * below what's already been paid).
 */
export async function resolveTradeInvoiceDispute(db, { invoiceId, supplierOwnerId, action, note, newAmountKori }) {
  const { issueCreditMemoInTx } = await import('./b2b/invoices.js');
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "TradeInvoice" WHERE id = ${invoiceId} FOR UPDATE`;
    const invoice = await tx.tradeInvoice.findUnique({ where: { id: invoiceId }, include: { supplier: true } });
    if (!invoice) throw new MarketplaceError('not_found', 'Facture introuvable');
    if (invoice.supplier.ownerId !== supplierOwnerId) throw new MarketplaceError('forbidden', 'Commerce introuvable');
    if (invoice.status !== 'disputed') throw new MarketplaceError('invalid_state', 'Cette facture n’est pas contestée');

    // J7.10: the principal never changes. Waive / adjust are CREDIT MEMOS on the unpaid remainder.
    const net = invoice.amountKori - (invoice.creditedKori ?? 0);
    let credit = 0;
    if (action === 'reject') credit = 0;
    else if (action === 'waive') credit = net - invoice.amountPaid;
    else if (action === 'adjust') {
      if (!Number.isInteger(newAmountKori) || newAmountKori < invoice.amountPaid || newAmountKori > net) {
        throw new MarketplaceError('invalid', 'Nouveau montant invalide (un montant plus élevé exige une nouvelle facture)');
      }
      credit = net - newAmountKori;
    } else {
      throw new MarketplaceError('invalid', 'Action invalide');
    }
    let fresh = invoice;
    if (credit > 0) {
      fresh = await issueCreditMemoInTx(tx, { invoiceId: invoice.id, amountKori: credit, kind: action === 'waive' ? 'dispute_waive' : 'dispute_adjust', reason: note ?? `dispute ${action}`, createdByUserId: supplierOwnerId });
    }
    const updated = await tx.tradeInvoice.update({
      where: { id: invoice.id },
      data: {
        status: naturalInvoiceStatus(fresh),
        disputeResolutionNote: note ?? null,
        paidAt: naturalInvoiceStatus(fresh) === 'paid' ? fresh.paidAt ?? new Date() : fresh.paidAt,
      },
    });
    await createInAppNotification(
      invoice.buyerUserId,
      'Réponse à ta contestation',
      `${invoice.reference} — ${note ?? (action === 'reject' ? 'Refusée' : 'Résolue')}`,
      { kind: 'trade_invoice_dispute_resolved', refId: invoice.id },
      tx,
    );
    return tradeInvoiceShape({ ...updated, supplier: invoice.supplier, tradeAccount: null });
  });
}


export function parsePreferredDeliveryDate(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new MarketplaceError('invalid', 'Date de livraison invalide');
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(12, 0, 0, 0);
  if (day < today) {
    throw new MarketplaceError('invalid', 'La date de livraison doit être aujourd’hui ou plus tard');
  }
  const max = new Date(today);
  max.setDate(max.getDate() + 90);
  if (day > max) {
    throw new MarketplaceError('invalid', 'Date de livraison trop éloignée (max 90 jours)');
  }
  return day;
}

/**
 * Pay-on-delivery is trade credit (goods before money). J5 (architecture
 * requirement: "credit must be explicitly granted"): it exists ONLY under an
 * active trade account on which the SUPPLIER enabled it (codEnabled, or a
 * supplier-assigned trusted/partner tier). Pre-J5 any buyer could select
 * 'cod' and receive a default limit the supplier never granted.
 */
export async function resolveEffectiveCodLimit(db, { buyer, tradeAccount }) {
  if (!tradeAccount?.active) return 0;
  if (tradeAccount.codEnabled || tradeAccount.trustTier === 'partner') {
    return tradeAccount.codLimitKori ?? DEFAULT_COD_LIMIT_KORI;
  }
  if (tradeAccount.trustTier === 'trusted') {
    return Math.min(tradeAccount.codLimitKori ?? DEFAULT_COD_LIMIT_KORI, DEFAULT_COD_LIMIT_KORI);
  }
  return 0;
}

export async function getBuyerTradeSummary(db, { buyerUserId, supplierBusinessId }) {
  const [buyer, supplier, tradeAccount, invoiceAgg, pendingCod] = await Promise.all([
    db.user.findUnique({ where: { id: buyerUserId }, select: { id: true, verificationTier: true } }),
    db.business.findUnique({ where: { id: supplierBusinessId }, select: { id: true, name: true } }),
    getTradeAccountForBuyer(db, { supplierBusinessId, buyerUserId }),
    db.tradeInvoice.aggregate({
      where: { buyerUserId, supplierBusinessId, status: { in: OUTSTANDING_STATUSES } },
      _sum: { amountKori: true, amountPaid: true, creditedKori: true },
      _count: true,
    }),
    db.order.aggregate({
      where: {
        buyerId: buyerUserId,
        businessId: supplierBusinessId,
        paymentTerm: 'cod',
        paymentStatus: 'pending',
        status: { notIn: ['cancelled', 'completed'] },
      },
      _sum: { totalAmount: true },
      _count: true,
    }),
  ]);
  if (!supplier) throw new MarketplaceError('not_found', 'Fournisseur introuvable');

  const openInvoiceBalance = (invoiceAgg._sum.amountKori ?? 0) - (invoiceAgg._sum.amountPaid ?? 0) - (invoiceAgg._sum.creditedKori ?? 0);
  const pendingCodTotal = pendingCod._sum.totalAmount ?? 0;
  const codLimitKori = await resolveEffectiveCodLimit(db, { buyer, tradeAccount });
  const codAvailable = Math.max(0, codLimitKori - pendingCodTotal);
  const trustTier =
    tradeAccount?.trustTier ?? ((buyer?.verificationTier ?? 1) >= 2 ? 'trusted' : 'new');

  const allowedPaymentTerms = ['immediate', 'cod'];
  if (tradeAccount?.paymentTerm && !allowedPaymentTerms.includes(tradeAccount.paymentTerm)) {
    allowedPaymentTerms.push(tradeAccount.paymentTerm);
  }
  if (!tradeAccount) allowedPaymentTerms.push('net30');

  return {
    supplierBusinessId,
    supplierName: supplier.name,
    trustTier,
    codEnabled: tradeAccount?.codEnabled ?? false,
    codLimitKori,
    codLimitFormatted: formatKori(codLimitKori),
    codAvailable,
    codAvailableFormatted: formatKori(codAvailable),
    openInvoiceBalance,
    openInvoiceBalanceFormatted: formatKori(openInvoiceBalance),
    openInvoiceCount: invoiceAgg._count ?? 0,
    pendingCodTotal,
    pendingCodFormatted: formatKori(pendingCodTotal),
    totalOwed: openInvoiceBalance + pendingCodTotal,
    totalOwedFormatted: formatKori(openInvoiceBalance + pendingCodTotal),
    creditLimitKori: tradeAccount?.creditLimitKori ?? 0,
    defaultPaymentTerm: tradeAccount?.paymentTerm ?? 'net30',
    allowedPaymentTerms,
    priceLockUntil: tradeAccount?.priceLockUntil?.toISOString?.() ?? null,
  };
}

export async function validateB2bOrderPayment(
  db,
  { buyerId, supplierBusinessId, paymentTerm, orderTotalKori, paymentSource = 'personal', buyerBusinessId },
) {
  if (paymentTerm === 'immediate') {
    if (paymentSource === 'kebu') {
      if (!buyerBusinessId) throw new MarketplaceError('invalid', 'Commerce acheteur requis pour KEBU');
      await requireBusinessPay(buyerId, buyerBusinessId, db);
      const wallet = await ensureBusinessWallet(buyerBusinessId, db);
      if (wallet.balance < orderTotalKori) {
        throw new MarketplaceError('insufficient', 'Solde KEBU insuffisant');
      }
    }
    return;
  }

  if (paymentTerm === 'cod') {
    const summary = await getBuyerTradeSummary(db, { buyerUserId: buyerId, supplierBusinessId });
    if (orderTotalKori > summary.codAvailable) {
      throw new MarketplaceError(
        'insufficient',
        `Limite paiement à la livraison — disponible ${summary.codAvailableFormatted}`,
      );
    }
    return;
  }

  const tradeAccount = await getTradeAccountForBuyer(db, { supplierBusinessId, buyerUserId: buyerId });
  // Net terms exist only under an agreed, unrevoked trade account with a
  // credit limit, for the term the supplier agreed — otherwise the buyer would
  // be granting themselves unlimited unpaid credit. Called again inside the
  // order transaction under lockTradeExposure (J7.9), so the headroom check
  // below cannot be raced.
  if (!tradeAccount || !tradeAccount.active || tradeAccount.revokedAt || !(tradeAccount.creditLimitKori > 0)) {
    throw new MarketplaceError('invalid', 'Aucun crédit fournisseur accordé — paiement immédiat requis');
  }
  if (tradeAccount.paymentTerm && tradeAccount.paymentTerm !== paymentTerm) {
    throw new MarketplaceError('invalid', `Conditions convenues : ${tradeAccount.paymentTerm}`);
  }
  const { creditExposure } = await import('./b2b/credit.js');
  const exposure = await creditExposure(db, { supplierBusinessId, buyerUserId: buyerId, tradeAccountId: tradeAccount.id });
  if (exposure.total + orderTotalKori > tradeAccount.creditLimitKori) {
    throw new MarketplaceError('insufficient', 'Limite de crédit B2B dépassée');
  }
}

export async function settleCodOrderPayment(db, { orderId, buyerId, payerReference }) {
  const outcome = await runMoneyTransaction(db, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        business: { include: { owner: { include: { wallet: true } } } },
      },
    });
    if (!order || order.buyerId !== buyerId) {
      throw new MarketplaceError('not_found', 'Commande introuvable');
    }
    if (order.paymentTerm !== 'cod') {
      throw new MarketplaceError('invalid_state', 'Pas une commande à la livraison');
    }
    if (order.paymentStatus === 'paid') {
      return { updated: order, notify: null };
    }

    const due = order.totalAmount - (order.paidAmount ?? 0);
    if (due <= 0) {
      throw new MarketplaceError('invalid_state', 'Rien à payer');
    }
    const paymentSource = order.paymentSource ?? 'personal';
    const ref = payerReference ?? reference('COD');

    await paySupplierB2b(tx, {
      payerUserId: buyerId,
      paymentSource,
      buyerBusinessId: order.buyerBusinessId,
      supplierBusiness: order.business,
      amountKori: due,
      reference: ref,
      note: `Paiement à la livraison · ${order.orderReference ?? order.id}`,
    });

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: 'paid',
        paidAmount: order.totalAmount,
        status: 'completed',
      },
    });

    return {
      updated,
      notify: {
        ownerId: order.business.ownerId,
        due,
        label: order.orderReference ?? 'Commande',
        orderId: order.id,
      },
    };
  });

  if (outcome.notify) {
    await createInAppNotification(
      outcome.notify.ownerId,
      'Paiement à la livraison',
      `${formatKori(outcome.notify.due)} · ${outcome.notify.label}`,
      { kind: 'trade_cod_paid', refId: outcome.notify.orderId },
    );
  }

  return outcome.updated;
}

export async function listBuyerPortalSuppliers(db, buyerUserId) {
  const [accounts, recentOrders] = await Promise.all([
    db.tradeAccount.findMany({
      where: { buyerUserId, active: true },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            category: true,
            distributionEnabled: true,
            type: true,
            kebuId: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    db.order.findMany({
      where: { buyerId: buyerUserId, channel: 'b2b' },
      distinct: ['businessId'],
      select: {
        businessId: true,
        business: {
          select: {
            id: true,
            name: true,
            category: true,
            distributionEnabled: true,
            type: true,
            kebuId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
  ]);

  const map = new Map();
  const addSupplier = (business, account) => {
    if (!business) return;
    if (!business.distributionEnabled && business.type !== 'brand') return;
    if (map.has(business.id)) return;
    map.set(business.id, {
      supplierBusinessId: business.id,
      name: business.name,
      category: business.category,
      kebuId: business.kebuId,
      paymentTerm: account?.paymentTerm ?? 'net30',
      codEnabled: account?.codEnabled ?? false,
      creditLimitFormatted: account ? formatKori(account.creditLimitKori) : null,
      hasTradeAccount: Boolean(account),
    });
  };

  for (const row of accounts) addSupplier(row.supplier, row);
  for (const row of recentOrders) {
    const account = accounts.find((a) => a.supplierBusinessId === row.businessId);
    addSupplier(row.business, account);
  }

  return [...map.values()];
}

export async function getBuyerPortalCatalog(db, { buyerUserId, supplierBusinessId }) {
  const business = await db.business.findUnique({
    where: { id: supplierBusinessId },
    include: {
      products: {
        where: { active: true, saleChannel: { in: ['b2b', 'both'] } },
        orderBy: { title: 'asc' },
      },
    },
  });
  if (!business || (!business.distributionEnabled && business.type !== 'brand')) {
    throw new MarketplaceError('not_found', 'Portail B2B indisponible pour ce fournisseur');
  }

  const tradeSummary = await getBuyerTradeSummary(db, { buyerUserId, supplierBusinessId });

  return {
    supplier: {
      id: business.id,
      name: business.name,
      kebuId: business.kebuId,
      category: business.category,
    },
    products: business.products.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      price: p.price,
      b2bPrice: p.b2bPrice,
      b2bMinQty: p.b2bMinQty ?? 1,
      unitLabel: p.unitLabel,
      inventory: p.inventory,
      saleChannel: p.saleChannel,
    })),
    tradeSummary,
  };
}

export async function getSupplierReceivables(db, { supplierBusinessId, ownerId }) {
  const business = await db.business.findFirst({ where: { id: supplierBusinessId, ownerId } });
  if (!business) throw new MarketplaceError('forbidden', 'Commerce introuvable');

  const [invoices, codOrders] = await Promise.all([
    db.tradeInvoice.findMany({
      where: { supplierBusinessId, status: { in: OUTSTANDING_STATUSES } },
      include: {
        buyer: { select: { id: true, name: true, handle: true } },
        buyerBusiness: { select: { id: true, name: true, kebuId: true } },
      },
      orderBy: { dueAt: 'asc' },
    }),
    db.order.findMany({
      where: {
        businessId: supplierBusinessId,
        paymentTerm: 'cod',
        paymentStatus: 'pending',
        status: { notIn: ['cancelled', 'completed'] },
      },
      include: {
        buyer: { select: { id: true, name: true, handle: true } },
        buyerBusiness: { select: { id: true, name: true, kebuId: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const byBuyer = new Map();
  const upsertBuyer = (key, seed) => {
    if (!byBuyer.has(key)) {
      byBuyer.set(key, {
        buyerUserId: seed.buyerUserId,
        buyerBusinessId: seed.buyerBusinessId ?? null,
        label: seed.label,
        kebuId: seed.kebuId ?? null,
        invoiceBalance: 0,
        codBalance: 0,
        openInvoiceCount: 0,
        pendingCodCount: 0,
      });
    }
    return byBuyer.get(key);
  };

  for (const inv of invoices) {
    const key = inv.buyerBusinessId ?? inv.buyerUserId;
    const row = upsertBuyer(key, {
      buyerUserId: inv.buyerUserId,
      buyerBusinessId: inv.buyerBusinessId,
      label: inv.buyerBusiness?.name ?? inv.buyer?.name ?? inv.buyer?.handle ?? 'Client',
      kebuId: inv.buyerBusiness?.kebuId ?? null,
    });
    const due = inv.amountKori - (inv.creditedKori ?? 0) - inv.amountPaid;
    row.invoiceBalance += due;
    row.openInvoiceCount += 1;
  }

  for (const ord of codOrders) {
    const key = ord.buyerBusinessId ?? ord.buyerId;
    const row = upsertBuyer(key, {
      buyerUserId: ord.buyerId,
      buyerBusinessId: ord.buyerBusinessId,
      label: ord.buyerBusiness?.name ?? ord.buyer?.name ?? ord.buyer?.handle ?? 'Client',
      kebuId: ord.buyerBusiness?.kebuId ?? null,
    });
    row.codBalance += ord.totalAmount - (ord.paidAmount ?? 0);
    row.pendingCodCount += 1;
  }

  const buyers = [...byBuyer.values()]
    .map((b) => ({
      ...b,
      totalOwed: b.invoiceBalance + b.codBalance,
      totalOwedFormatted: formatKori(b.invoiceBalance + b.codBalance),
      invoiceBalanceFormatted: formatKori(b.invoiceBalance),
      codBalanceFormatted: formatKori(b.codBalance),
    }))
    .sort((a, b) => b.totalOwed - a.totalOwed);

  const totalReceivable = buyers.reduce((s, b) => s + b.totalOwed, 0);

  return {
    supplierBusinessId,
    totalReceivable,
    totalReceivableFormatted: formatKori(totalReceivable),
    buyerCount: buyers.length,
    buyers,
  };
}

export async function registerDistributionBrand(db, { ownerId, payload }) {
  const existing = await db.business.findFirst({
    where: { ownerId, type: 'brand', distributionEnabled: true },
  });
  if (existing) {
    await ensureBusinessWallet(existing.id, db);
    return existing;
  }

  const kebuSuffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const business = await db.business.create({
    data: {
      ownerId,
      name: payload.name,
      type: 'brand',
      category: payload.category ?? 'k21',
      description: payload.description ?? 'Distribution K21',
      address: payload.address ?? 'Dakar',
      arrondissement: payload.arrondissement ?? 'Plateau',
      lat: payload.lat ?? 14.6928,
      lng: payload.lng ?? -17.4467,
      distributionEnabled: true,
      kebuId: `KEBU-${kebuSuffix}`,
      verified: false,
    },
  });
  await ensureBusinessWallet(business.id, db);
  return business;
}

export async function seedBrandProducts(db, { businessId, ownerId, products }) {
  const business = await db.business.findFirst({ where: { id: businessId, ownerId, type: 'brand' } });
  if (!business) throw new MarketplaceError('forbidden', 'Marque introuvable');

  const created = [];
  for (const p of products) {
    const row = await db.product.create({
      data: {
        businessId,
        title: p.title,
        description: p.description ?? null,
        price: p.price,
        b2bPrice: p.b2bPrice ?? null,
        b2bMinQty: p.b2bMinQty ?? 1,
        unitLabel: p.unitLabel ?? null,
        saleChannel: p.saleChannel ?? 'both',
        category: p.category ?? business.category,
        inventory: p.inventory ?? 0,
        trackInventory: p.trackInventory ?? true,
      },
    });
    created.push(row);
  }
  return created;
}
