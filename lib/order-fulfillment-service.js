import { createInAppNotification } from './notify-service.js';
import { formatKori } from './kori.js';
import { MarketplaceError } from './marketplace-service.js';
import { settleCodOrderPayment } from './trade-service.js';

const MERCHANT_TRANSITIONS = {
  confirmed: ['preparing'],
  pending_payment: ['preparing'],
  preparing: ['ready_for_pickup', 'out_for_delivery'],
  pending_delivery: ['preparing', 'out_for_delivery'],
  ready_for_pickup: ['completed'],
  out_for_delivery: ['delivered'],
  delivered: ['completed'],
};

export function orderShapeDetailed(order) {
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
      ? { id: order.buyer.id, name: order.buyer.name, handle: order.buyer.handle }
      : null,
    business: order.business ? { id: order.business.id, name: order.business.name } : null,
    items: (order.items ?? []).map((li) => ({
      id: li.id,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      product: li.product
        ? { id: li.product.id, title: li.product.title, unitLabel: li.product.unitLabel }
        : null,
    })),
    delivery: order.delivery
      ? {
          id: order.delivery.id,
          status: order.delivery.status,
          pickupLabel: order.delivery.pickupLabel,
          dropoffArea: order.delivery.dropoffArea,
        }
      : null,
    invoice: order.tradeInvoice
      ? {
          id: order.tradeInvoice.id,
          reference: order.tradeInvoice.reference,
          status: order.tradeInvoice.status,
          dueAt: order.tradeInvoice.dueAt.toISOString(),
        }
      : null,
  };
}

async function loadOrder(db, orderId) {
  return db.order.findUnique({
    where: { id: orderId },
    include: {
      buyer: { select: { id: true, name: true, handle: true } },
      business: { select: { id: true, name: true, ownerId: true } },
      items: { include: { product: true } },
      delivery: true,
      tradeInvoice: true,
    },
  });
}

export async function getOrderForUser(db, { orderId, userId }) {
  const order = await loadOrder(db, orderId);
  if (!order) throw new MarketplaceError('not_found', 'Commande introuvable');
  if (order.buyerId !== userId && order.business?.ownerId !== userId) {
    throw new MarketplaceError('forbidden', 'Accès refusé');
  }
  return orderShapeDetailed(order);
}

export async function updateOrderStatus(db, { orderId, ownerId, status }) {
  const order = await loadOrder(db, orderId);
  if (!order?.business || order.business.ownerId !== ownerId) {
    throw new MarketplaceError('forbidden', 'Commande introuvable');
  }

  const allowed = MERCHANT_TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(status)) {
    throw new MarketplaceError('invalid_state', `Impossible: ${order.status} → ${status}`);
  }

  const updated = await db.order.update({
    where: { id: orderId },
    data: { status },
    include: {
      buyer: { select: { id: true, name: true, handle: true } },
      business: { select: { id: true, name: true } },
      items: { include: { product: true } },
      delivery: true,
      tradeInvoice: true,
    },
  });

  const statusLabels = {
    preparing: 'En préparation',
    ready_for_pickup: 'Prête à retirer',
    out_for_delivery: 'En livraison',
    completed: 'Terminée',
  };
  await createInAppNotification(
    updated.buyerId,
    'Commande mise à jour',
    `${updated.business.name} · ${statusLabels[status] ?? status}`,
    { kind: 'marketplace_order', refId: updated.id },
  );

  return orderShapeDetailed(updated);
}

export async function buyerConfirmOrder(db, { orderId, buyerId, payerReference }) {
  const order = await loadOrder(db, orderId);
  if (!order || order.buyerId !== buyerId) {
    throw new MarketplaceError('forbidden', 'Commande introuvable');
  }
  if (!['delivered', 'ready_for_pickup'].includes(order.status)) {
    throw new MarketplaceError('invalid_state', 'Commande pas encore livrée');
  }

  if (order.paymentTerm === 'cod' && order.paymentStatus !== 'paid') {
    await settleCodOrderPayment(db, { orderId, buyerId, payerReference });
    const settled = await loadOrder(db, orderId);
    return orderShapeDetailed(settled);
  }

  // J5: the same locked, evented transition as everywhere else.
  const { buyerComplete } = await import('./commerce/orders.js');
  await buyerComplete(buyerId, orderId);
  return orderShapeDetailed(await loadOrder(db, orderId));
}
