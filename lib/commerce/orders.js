import { prisma } from '../prisma.js';
import { formatKori } from '../kori.js';
import { OrgAccessError, assertBusinessAuthorityInTx, requireBusinessCapability } from '../business-access.js';
import { createInAppNotification } from '../notify-service.js';
import { InsufficientFundsError, runMoneyTransaction } from '../wallet-atomic.js';
import { RefundError, refundInTx } from '../money/refunds.js';
import { restoreForOrder } from './inventory.js';
import { orderPaymentEntry } from './payments.js';
import { ORDER_STATUS_EVENTS, emitCommerceEvent } from './events.js';

/**
 * J5 order lifecycle (docs/JOKKO-J5-REPORT.md §7–8).
 *
 *   pending_payment ─┐ (B2B credit / COD only)
 *   confirmed (paid, awaiting the merchant)
 *     → preparing (merchant accepted)
 *       → ready_for_pickup → completed
 *       → out_for_delivery → delivered → completed
 *   exceptions: cancelled (before dispatch, full refund + stock back)
 *               refunded  (after delivery/completion, full refund)
 *
 * Every transition: order row locked FOR UPDATE, allowed only from the
 * listed states for that actor, written conditionally on the old state, and
 * — for money — a J2 compensating entry with a deterministic reference
 * (`order-refund:<orderId>`), so a retry or a concurrent second request can
 * never refund twice. The original payment entry is never touched.
 *
 * Partial order refunds are NOT implemented (classified, not faked). The J4
 * payment-refund primitive (`POST money/payments/:ref/refund`) remains for
 * amount-only refunds of a payment.
 */
export class OrderError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
    this.status = status;
  }
}

export const ORDER_STATES = ['pending_payment', 'confirmed', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'completed', 'cancelled', 'refunded'];

export const ORDER_LABELS = {
  pending_payment: 'En attente de paiement',
  confirmed: 'Nouvelle commande',
  pending_delivery: 'En attente de livraison',
  preparing: 'En préparation',
  ready_for_pickup: 'Prête à retirer',
  out_for_delivery: 'En livraison',
  delivered: 'Livrée',
  completed: 'Terminée',
  cancelled: 'Annulée',
  refunded: 'Remboursée',
};

/** Merchant fulfilment moves (capability business.orders.fulfill). */
export const MERCHANT_TRANSITIONS = {
  confirmed: ['preparing'],
  pending_payment: ['preparing'], // B2B credit / COD: goods before payment by agreement
  pending_delivery: ['preparing', 'out_for_delivery'],
  preparing: ['ready_for_pickup', 'out_for_delivery'],
  ready_for_pickup: ['completed'],
  out_for_delivery: ['delivered'],
  delivered: ['completed'],
};

/** States from which each party may cancel (cancellation = full refund when paid). */
export const CANCELLABLE = {
  buyer: ['pending_payment', 'confirmed'], // before the merchant starts
  merchant: ['pending_payment', 'confirmed', 'preparing', 'ready_for_pickup', 'pending_delivery'],
};
/** States from which the merchant may refund a fulfilled order. */
export const REFUNDABLE_STATES = ['delivered', 'completed'];

async function lockOrder(tx, orderId) {
  const rows = await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  if (!rows.length) throw new OrderError('not_found', 'Commande introuvable', 404);
  return tx.order.findUnique({
    where: { id: orderId },
    include: { business: { select: { id: true, name: true, ownerId: true } }, delivery: true, tradeInvoice: true, items: { include: { product: true } } },
  });
}

async function setStatus(tx, order, to, extra = {}) {
  const r = await tx.order.updateMany({ where: { id: order.id, status: order.status }, data: { status: to, ...extra } });
  if (r.count !== 1) throw new OrderError('conflict', 'La commande a changé entre-temps — recharge', 409);
}

function notify(userId, title, body, refId) {
  return createInAppNotification(userId, title, body, { kind: 'marketplace_order', refId }).catch(() => {});
}

/** Merchant staff fulfilment step. */
export async function merchantTransition(userId, orderId, to) {
  const out = await runMoneyTransaction(prisma, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order.businessId) throw new OrderError('not_found', 'Commande introuvable', 404);
    await assertBusinessAuthorityInTx(tx, userId, order.businessId, 'business.orders.fulfill').catch(() => {
      throw new OrderError('forbidden', 'Commande introuvable', 404);
    });
    const allowed = MERCHANT_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(to)) throw new OrderError('invalid_state', `Impossible : ${ORDER_LABELS[order.status] ?? order.status} → ${ORDER_LABELS[to] ?? to}`);
    if (to === 'ready_for_pickup' && order.fulfillmentType !== 'pickup') throw new OrderError('invalid_state', 'Commande à livrer, pas à retirer');
    if (to === 'out_for_delivery' && order.fulfillmentType !== 'delivery') throw new OrderError('invalid_state', 'Commande à retirer, pas à livrer');
    await setStatus(tx, order, to);
    await emitCommerceEvent(tx, { type: ORDER_STATUS_EVENTS[to] ?? `order.${to}`, businessId: order.businessId, aggregateType: 'order', aggregateId: order.id, payload: { to, fulfillmentType: order.fulfillmentType, fulfillmentOwner: order.fulfillmentOwner } });
    return { order, to };
  });
  await notify(out.order.buyerId, 'Commande mise à jour', `${out.order.business.name} · ${ORDER_LABELS[out.to]}`, out.order.id);
  return { orderId, status: out.to, statusLabel: ORDER_LABELS[out.to] };
}

/** Buyer confirms receipt (delivered / ready for pickup → completed). COD settlement stays in trade-service. */
export async function buyerComplete(userId, orderId) {
  return runMoneyTransaction(prisma, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.buyerId !== userId) throw new OrderError('not_found', 'Commande introuvable', 404);
    if (!['delivered', 'ready_for_pickup'].includes(order.status)) throw new OrderError('invalid_state', 'Commande pas encore livrée');
    if (order.paymentTerm === 'cod' && order.paymentStatus !== 'paid') throw new OrderError('cod_unpaid', 'Paiement à la livraison à régler d’abord');
    await setStatus(tx, order, 'completed');
    await emitCommerceEvent(tx, { type: 'order.completed', businessId: order.businessId, aggregateType: 'order', aggregateId: order.id, payload: { by: 'buyer' } });
    return { orderId, status: 'completed', statusLabel: ORDER_LABELS.completed };
  });
}

/**
 * Full refund of an order's payment as a compensating entry, inside the
 * order transaction. Returns null when nothing was paid.
 */
async function refundOrderPayment(tx, order, { actorUserId, reason, policy, capability }) {
  if (order.paymentStatus !== 'paid' || order.paidAmount <= 0) return null;
  if (order.tradeInvoice || order.paymentTerm !== 'immediate') {
    throw new OrderError('refund_unsupported', 'Commande B2B à crédit / facture : remboursement à traiter via la facture (non pris en charge ici)', 409);
  }
  const payment = await orderPaymentEntry(tx, order.orderReference);
  if (!payment) throw new OrderError('refund_unsupported', 'Paiement de la commande introuvable — contacte le support', 409);
  try {
    return await refundInTx(tx, {
      actorUserId,
      originalReference: payment.reference,
      amountKori: order.paidAmount,
      reason,
      policy,
      capability,
      reference: `order-refund:${order.id}`,
      metadata: { orderId: order.id },
    });
  } catch (err) {
    if (err instanceof RefundError) {
      if (err.code === 'not_refundable') throw new OrderError('refund_unsupported', 'Paiement partagé (commission) : remboursement à traiter par le support', 409);
      throw new OrderError(err.code === 'not_payee' ? 'forbidden' : err.code, err.message, err.status);
    }
    if (err instanceof InsufficientFundsError) {
      throw new OrderError('merchant_insufficient_funds', 'Le portefeuille qui a reçu ce paiement n’a pas assez de fonds pour rembourser', 409);
    }
    throw err;
  }
}

/** Delivery: only an unassigned delivery (no rider, no escrow) can be cancelled with the order. */
async function cancelDeliveryIfAny(tx, order) {
  if (!order.delivery) return;
  const r = await tx.deliveryTask.updateMany({ where: { id: order.delivery.id, status: 'open' }, data: { status: 'cancelled' } });
  if (r.count !== 1) throw new OrderError('delivery_in_progress', 'Un livreur a déjà pris la commande — passe par la livraison / le litige', 409);
}

/**
 * Cancel before dispatch. Buyer: only before the merchant starts
 * (system-authorized refund). Merchant staff: `business.orders.cancel`.
 * Paid → full refund to the buyer; stock recorded for this order goes back.
 */
export async function cancelOrder(actorUserId, orderId, { as, reason }) {
  if (!reason || String(reason).trim().length < 3) throw new OrderError('reason_required', 'Motif requis', 400);
  const out = await runMoneyTransaction(prisma, async (tx) => {
    const order = await lockOrder(tx, orderId);
    // Authority first: an idempotent replay is answered only to someone who may cancel this order.
    if (as === 'buyer') {
      if (order.buyerId !== actorUserId) throw new OrderError('not_found', 'Commande introuvable', 404);
    } else {
      if (!order.businessId) throw new OrderError('not_found', 'Commande introuvable', 404);
      await assertBusinessAuthorityInTx(tx, actorUserId, order.businessId, 'business.orders.cancel').catch(() => {
        throw new OrderError('forbidden', 'Commande introuvable', 404);
      });
    }
    if (order.status === 'cancelled') return { order, replayed: true };
    if (!CANCELLABLE[as].includes(order.status)) {
      throw new OrderError('invalid_state', as === 'buyer' ? 'Le commerçant a déjà commencé — demande-lui d’annuler' : `Impossible d’annuler une commande « ${ORDER_LABELS[order.status] ?? order.status} »`);
    }
    await cancelDeliveryIfAny(tx, order);
    const refund = await refundOrderPayment(tx, order, {
      actorUserId,
      reason: `Annulation : ${reason}`,
      policy: as === 'buyer' ? 'buyer_cancellation_before_fulfilment' : null,
      capability: 'business.orders.cancel',
    });
    const stock = await restoreForOrder(tx, { orderId: order.id, reason: 'cancel_restore', actorUserId });
    const now = new Date();
    await setStatus(tx, order, 'cancelled', {
      cancelledAt: now,
      cancelledBy: actorUserId,
      cancelReason: String(reason).slice(0, 300),
      ...(refund ? { paymentStatus: 'refunded', refundedAt: now, refundedBy: actorUserId, refundReference: refund.reference } : {}),
    });
    await emitCommerceEvent(tx, { type: 'order.cancelled', businessId: order.businessId, aggregateType: 'order', aggregateId: order.id, payload: { by: as, refundedKori: refund ? order.paidAmount : 0, restored: stock.restored } });
    return { order, refund, stock };
  });
  const o = out.order;
  if (!out.replayed && as === 'merchant') {
    await notify(o.buyerId, 'Commande annulée', `${o.business?.name ?? 'Commerce'} · ${out.refund ? `${formatKori(o.paidAmount)} remboursés` : 'aucun débit'}`, o.id);
  }
  if (!out.replayed && as === 'buyer' && o.business) {
    await notify(o.business.ownerId, 'Commande annulée par le client', `${formatKori(o.totalAmount)}`, o.id);
  }
  return {
    orderId,
    status: 'cancelled',
    replayed: Boolean(out.replayed),
    refund: out.refund ? { reference: out.refund.reference, amountKori: o.paidAmount } : null,
    stockRestored: out.stock?.restored ?? [],
  };
}

/**
 * Refund a delivered / completed order in full (`business.refund`).
 * `restock` only when the goods actually came back.
 */
export async function refundOrder(actorUserId, orderId, { reason, restock = false }) {
  if (!reason || String(reason).trim().length < 3) throw new OrderError('reason_required', 'Motif requis', 400);
  const out = await runMoneyTransaction(prisma, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order.businessId) throw new OrderError('not_found', 'Commande introuvable', 404);
    await assertBusinessAuthorityInTx(tx, actorUserId, order.businessId, 'business.refund').catch(() => {
      throw new OrderError('forbidden', 'Commande introuvable', 404);
    });
    if (order.status === 'refunded') return { order, replayed: true, refund: { reference: order.refundReference } };
    if (!REFUNDABLE_STATES.includes(order.status)) {
      throw new OrderError('invalid_state', order.status === 'cancelled' ? 'Commande déjà annulée (et remboursée si payée)' : 'Annule la commande plutôt que de la rembourser');
    }
    const refund = await refundOrderPayment(tx, order, { actorUserId, reason: `Remboursement : ${reason}`, policy: null, capability: 'business.refund' });
    if (!refund) throw new OrderError('nothing_paid', 'Rien à rembourser sur cette commande');
    const stock = restock ? await restoreForOrder(tx, { orderId: order.id, reason: 'refund_restore', actorUserId }) : { restored: [] };
    const now = new Date();
    await setStatus(tx, order, 'refunded', { paymentStatus: 'refunded', refundedAt: now, refundedBy: actorUserId, refundReference: refund.reference });
    await emitCommerceEvent(tx, { type: 'order.refunded', businessId: order.businessId, aggregateType: 'order', aggregateId: order.id, payload: { refundedKori: order.paidAmount, restocked: Boolean(restock) } });
    return { order, refund, stock };
  });
  if (!out.replayed) await notify(out.order.buyerId, 'Commande remboursée', `${out.order.business.name} · ${formatKori(out.order.paidAmount)}`, out.order.id);
  return { orderId, status: 'refunded', replayed: Boolean(out.replayed), refund: { reference: out.refund.reference, amountKori: out.order.paidAmount }, stockRestored: out.stock?.restored ?? [] };
}

/**
 * Order as merchant staff see it: what is needed to fulfil, nothing more.
 * Buyer name/handle; the delivery address only for roles that fulfil.
 */
export function merchantOrderShape(order, caps) {
  const canFulfil = caps.has('business.orders.fulfill') || caps.has('business.customers.read');
  return {
    id: order.id,
    reference: order.orderReference,
    status: order.status,
    statusLabel: ORDER_LABELS[order.status] ?? order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentType: order.fulfillmentType,
    totalKori: order.totalAmount,
    paidKori: order.paidAmount,
    settledTo: order.settledTo ?? null,
    createdAt: order.createdAt.toISOString(),
    customer: order.buyer ? { name: order.buyer.name || null, handle: order.buyer.handle || null } : null,
    deliveryAddress: canFulfil ? order.deliveryAddress : undefined,
    items: (order.items ?? []).map((li) => ({ productId: li.productId, title: li.product?.title ?? null, quantity: li.quantity, unitPriceKori: li.unitPrice })),
    cancelReason: order.cancelReason ?? null,
    refundReference: order.refundReference ?? null,
    actions: {
      next: MERCHANT_TRANSITIONS[order.status]?.filter((s) => !(s === 'ready_for_pickup' && order.fulfillmentType !== 'pickup') && !(s === 'out_for_delivery' && order.fulfillmentType !== 'delivery')) ?? [],
      cancel: CANCELLABLE.merchant.includes(order.status),
      refund: REFUNDABLE_STATES.includes(order.status) && order.paymentStatus === 'paid',
    },
  };
}

export async function listBusinessOrders(userId, businessId, { status, limit = 50, before } = {}) {
  await requireBusinessCapability(userId, businessId, 'business.orders.read');
  const { businessAccess } = await import('../business/identity.js');
  const caps = new Set((await businessAccess(userId, businessId)).capabilities);
  const rows = await prisma.order.findMany({
    where: { businessId, ...(status ? { status: String(status) } : {}), ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(limit) || 50, 100),
    include: { buyer: { select: { name: true, handle: true } }, items: { include: { product: { select: { title: true } } } } },
  });
  return rows.map((o) => merchantOrderShape(o, caps));
}

export async function businessOrderDetail(userId, businessId, orderId) {
  await requireBusinessCapability(userId, businessId, 'business.orders.read');
  const order = await prisma.order.findFirst({
    where: { id: orderId, businessId },
    include: { buyer: { select: { name: true, handle: true } }, items: { include: { product: { select: { title: true } } } } },
  });
  if (!order) throw new OrgAccessError('Commande introuvable', 404);
  const { businessAccess } = await import('../business/identity.js');
  const caps = new Set((await businessAccess(userId, businessId)).capabilities);
  return merchantOrderShape(order, caps);
}
