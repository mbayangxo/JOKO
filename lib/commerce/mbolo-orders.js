/**
 * J14-S5 — Mbolo order-from-conversation (seller order card). DORMANT unless MBOLO_ORDER_CARD_ENABLED=true.
 *
 * In a DIRECT conversation with a buyer, the seller (staff holding business.orders.fulfill AND
 * business.charges.create, member of the thread) composes an order from THEIR catalog. That is the seller's
 * confirmation: the server prices every line, commits stock, and creates
 *   - an Order (pending_payment, sourceChannel mbolo, buyer = the other member of the thread), and
 *   - a J4 charge bound to that order, shared as the existing J7.19 charge card.
 * The buyer pays ONLY through the existing charge flow (`POST money/charges/:code/pay`, expected amount). The
 * payment confirms the order in the SAME money transaction (lib/money/charges.js → confirmMboloOrderInTx);
 * only the intended buyer can pay it, and a cancelled order can never be paid. Text in the conversation is
 * never authority over what is owed.
 *
 *   - unpaid card orders cannot be prepared (payment first); cancelling closes the open charge and restores
 *     stock; after payment, cancellation refunds through the J5 path (the order's payment reference is the
 *     charge payment);
 *   - a charge expires (30 min) → the seller re-shares a fresh one for the SAME order (old one cancelled).
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { assertBusinessAuthorityInTx } from '../business-access.js';
import { assertCanPost } from '../mbolo-access.js';
import { postCommerceCard } from '../mbolo-receipt-service.js';
import { FLOW_LIMITS } from '../money/policy.js';
import { newChargeCode } from '../money/charges.js';
import { ensurePrimaryInventoryLocation, ensurePrimaryLocation } from '../business/identity.js';
import { decrementForSale, InventoryError } from './inventory.js';
import { emitCommerceEvent } from './events.js';

export const MBOLO_CARD_TERM = 'mbolo_card';
export const mboloOrderCardEnabled = () => process.env.MBOLO_ORDER_CARD_ENABLED === 'true';
const MAX_LINES = 30;

export class MboloOrderError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}


async function directBuyer(tx, threadId, sellerUserId) {
  const t = await tx.mboloThread.findUnique({ where: { id: String(threadId) }, select: { id: true, type: true, members: { select: { userId: true } } } });
  const ids = (t?.members ?? []).map((m) => m.userId);
  if (!t || !ids.includes(sellerUserId)) throw new MboloOrderError('not_found', 'Conversation introuvable', 404);
  if (t.type !== 'direct' || ids.length !== 2) throw new MboloOrderError('direct_only', 'Une commande se prépare dans une conversation à deux', 409);
  return ids.find((id) => id !== sellerUserId);
}

async function issueChargeInTx(tx, { order, sellerUserId }) {
  return tx.merchantCharge.create({
    data: {
      code: newChargeCode(),
      businessId: order.businessId,
      createdBy: sellerUserId,
      amountKori: order.totalAmount,
      label: 'Commande Mbolo',
      orderId: order.id,
      expiresAt: new Date(Date.now() + FLOW_LIMITS.charge.expiresAfterMinutes * 60_000),
    },
  });
}

async function postCard(sellerUserId, threadId, charge, businessName) {
  await assertCanPost(prisma, threadId, sellerUserId, { kind: 'commerce' });
  const msg = await postCommerceCard(prisma, {
    threadId: String(threadId),
    senderId: sellerUserId,
    body: `${businessName} · commande à payer`,
    payload: { type: 'charge_card', code: charge.code, version: '2026-10-j14' },
  });
  return msg.id;
}

/** Seller composes the order (= seller confirmation). Idempotent on the client's request key. */
export async function createMboloOrderCard(sellerUserId, threadId, { businessId, lines, fulfillmentType = 'pickup', requestKey }) {
  if (!mboloOrderCardEnabled()) throw new MboloOrderError('disabled', 'Commande depuis une conversation : pas activée', 403);
  if (!['pickup', 'delivery'].includes(fulfillmentType)) throw new MboloOrderError('invalid', 'Mode de remise inconnu', 400);
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_LINES) throw new MboloOrderError('invalid', `1 à ${MAX_LINES} articles`, 400);
  const merged = new Map();
  for (const l of lines) {
    if (!l?.productId || !Number.isSafeInteger(l?.quantity) || l.quantity < 1 || l.quantity > 10_000) throw new MboloOrderError('invalid', 'Article ou quantité invalide', 400);
    merged.set(String(l.productId), (merged.get(String(l.productId)) ?? 0) + l.quantity);
  }
  if (!requestKey || !/^[A-Za-z0-9_-]{8,80}$/.test(String(requestKey))) throw new MboloOrderError('invalid', 'requestKey requis', 400);
  const reference = `MBO-${crypto.createHash('sha256').update(`${sellerUserId}:${requestKey}`).digest('hex').slice(0, 16).toUpperCase()}`;

  const out = await runMoneyTransaction(prisma, async (tx) => {
    // Concurrent double taps converge on one order.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mbolo-order:${reference}`}))`;
    const prior = await tx.order.findFirst({ where: { externalOrderRef: reference, sourceChannel: 'mbolo', paymentTerm: MBOLO_CARD_TERM } });
    if (prior) {
      const charge = await tx.merchantCharge.findFirst({ where: { orderId: prior.id }, orderBy: { createdAt: 'desc' } });
      return { order: prior, charge, replayed: true };
    }
    await assertBusinessAuthorityInTx(tx, sellerUserId, businessId, 'business.orders.fulfill').catch(() => {
      throw new MboloOrderError('not_found', 'Commerce introuvable', 404);
    });
    await assertBusinessAuthorityInTx(tx, sellerUserId, businessId, 'business.charges.create').catch(() => {
      throw new MboloOrderError('forbidden', 'Tu ne peux pas demander de paiement pour ce commerce', 403);
    });
    await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${businessId} FOR SHARE`;
    const biz = await tx.business.findUnique({ where: { id: businessId } });
    if ((biz?.status ?? 'active') !== 'active') throw new MboloOrderError('business_inactive', 'Ce commerce ne peut pas recevoir de paiement pour le moment');
    const buyerId = await directBuyer(tx, threadId, sellerUserId);
    const buyerIsStaff = biz.ownerId === buyerId || (await tx.businessMember.findFirst({ where: { businessId, userId: buyerId, status: 'active' } }));
    if (buyerIsStaff) throw new MboloOrderError('self_order', 'Un commerce ne peut pas se vendre à lui-même', 400);

    const products = await tx.product.findMany({ where: { id: { in: [...merged.keys()] } } });
    if (products.length !== merged.size || products.some((p) => p.businessId !== businessId || !p.active)) {
      throw new MboloOrderError('product_not_found', 'Article introuvable dans ce commerce', 404);
    }
    const items = products.map((p) => ({ product: p, quantity: merged.get(p.id), unitPrice: p.price }));
    const total = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
    if (!Number.isSafeInteger(total) || total < FLOW_LIMITS.charge.minKori || total > FLOW_LIMITS.charge.maxKori) throw new MboloOrderError('invalid_amount', 'Montant de commande invalide', 400);
    const loc = await ensurePrimaryLocation(businessId, tx);
    const invLoc = await ensurePrimaryInventoryLocation(businessId, tx);
    const order = await tx.order.create({
      data: {
        buyerId, businessId, channel: 'b2c', paymentTerm: MBOLO_CARD_TERM, paymentStatus: 'pending', paidAmount: 0,
        status: 'pending_payment', locationId: loc.id, inventoryLocationId: invLoc.id, sourceChannel: 'mbolo', sourceSystem: 'jokko',
        fulfillmentOwner: 'merchant', fulfillmentType, totalAmount: total, externalOrderRef: reference, mboloThreadId: String(threadId),
        items: { create: items.map((i) => ({ productId: i.product.id, quantity: i.quantity, unitPrice: i.unitPrice })) },
      },
    });
    for (const i of items) {
      try {
        await decrementForSale(tx, { product: i.product, business: biz, quantity: i.quantity, orderId: order.id, actorUserId: sellerUserId, inventoryLocationId: invLoc.id });
      } catch (e) {
        if (e instanceof InventoryError) throw new MboloOrderError('out_of_stock', e.message);
        throw e;
      }
    }
    const charge = await issueChargeInTx(tx, { order, sellerUserId });
    await emitCommerceEvent(tx, { type: 'order.placed', businessId, aggregateType: 'order', aggregateId: order.id, payload: { totalKori: total, channel: 'b2c', sourceChannel: 'mbolo', fulfillmentType } });
    return { order, charge, business: biz, replayed: false };
  });
  const businessName = out.business?.name ?? (await prisma.business.findUnique({ where: { id: out.order.businessId }, select: { name: true } }))?.name;
  const messageId = out.replayed ? null : await postCard(sellerUserId, threadId, out.charge, businessName);
  return { orderId: out.order.id, status: out.order.status, totalKori: out.order.totalAmount, chargeCode: out.charge?.code ?? null, messageId, replayed: out.replayed };
}

/** The charge expired: a fresh charge for the SAME unpaid order; any open one is cancelled first. */
export async function reshareMboloOrderCard(sellerUserId, threadId, orderId) {
  if (!mboloOrderCardEnabled()) throw new MboloOrderError('disabled', 'Commande depuis une conversation : pas activée', 403);
  const out = await runMoneyTransaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${String(orderId)} FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: String(orderId) }, include: { business: { select: { name: true } } } });
    if (!order || order.paymentTerm !== MBOLO_CARD_TERM || order.mboloThreadId !== String(threadId)) throw new MboloOrderError('not_found', 'Commande introuvable', 404);
    await assertBusinessAuthorityInTx(tx, sellerUserId, order.businessId, 'business.charges.create').catch(() => {
      throw new MboloOrderError('not_found', 'Commande introuvable', 404);
    });
    if (order.status !== 'pending_payment' || order.paymentStatus !== 'pending') throw new MboloOrderError('not_payable', 'Cette commande n’est plus à payer');
    await tx.merchantCharge.updateMany({ where: { orderId: order.id, status: 'open' }, data: { status: 'cancelled' } });
    return { order, charge: await issueChargeInTx(tx, { order, sellerUserId }) };
  });
  const messageId = await postCard(sellerUserId, threadId, out.charge, out.order.business?.name);
  return { orderId: out.order.id, chargeCode: out.charge.code, messageId };
}

/**
 * Called by payCharge INSIDE its money transaction, BEFORE any money moves, for a charge bound to a card
 * order. Returns a finisher to run after the payment entry is written. Throws to refuse the payment.
 */
export async function guardMboloOrderPaymentInTx(tx, charge, payerId) {
  if (!charge.orderId) return null;
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${charge.orderId} FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id: charge.orderId } });
  if (!order || order.paymentTerm !== MBOLO_CARD_TERM) return null; // ordinary J5 charge with an order link: unchanged
  if (order.buyerId !== payerId) throw new MboloOrderError('not_your_order', 'Cette commande est destinée à une autre personne', 403);
  if (order.status !== 'pending_payment' || order.paymentStatus !== 'pending') throw new MboloOrderError('order_not_payable', 'Cette commande n’est plus à payer', 409);
  if (order.totalAmount !== charge.amountKori) throw new MboloOrderError('amount_mismatch', 'Montant de commande incohérent — paiement annulé', 409);
  return async (paymentRef) => {
    const r = await tx.order.updateMany({
      where: { id: order.id, status: 'pending_payment', paymentStatus: 'pending' },
      data: { status: 'confirmed', paymentStatus: 'paid', paidAmount: order.totalAmount, settledTo: 'business', orderReference: paymentRef },
    });
    if (r.count !== 1) throw new MboloOrderError('conflict', 'La commande a changé entre-temps', 409);
    await emitCommerceEvent(tx, { type: 'order.paid', businessId: order.businessId, aggregateType: 'order', aggregateId: order.id, payload: { totalKori: order.totalAmount, channel: 'b2c', sourceChannel: 'mbolo' } });
  };
}
