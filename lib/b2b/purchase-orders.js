import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx, requireBusinessCapability } from '../business-access.js';
import { assertBusinessCanReceive } from '../business/eligibility.js';
import { ensureBusinessWallet, transferBusinessToBusiness } from '../business-wallet-service.js';
import { recordPayment } from '../commerce/acceptance.js';
import { emitCommerceEvent } from '../commerce/events.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { activeRelationship, quoteInDb } from './catalog.js';
import { CreditError, accountGrantsCredit, assertCreditAvailableInTx, lockTradeExposure } from './credit.js';
export { PO_TERMS as PO_TERMS_ALL } from './credit.js';
import { moveDepotStockInTx } from './depot.js';
import { applyInvoicePaymentInTx, invoicePurchaseOrderInTx, issueCreditMemoInTx, invoiceView, InvoiceError } from './invoices.js';

/**
 * J7.7 — B2B purchase order lifecycle (docs/JOKKO-J7-COMMERCE.md §3).
 *
 *   (quote = draft, never persisted)
 *   submitted → accepted (due now: awaiting payment) → confirmed → preparing → ready
 *             ↘ confirmed directly on acceptance for a granted Net term (credit already reserved)
 *   ready → fulfilment_requested (seller records HOW: own delivery, buyer pickup, third party)
 *         → delivered (recorded by the seller) → received (buyer) → completed (buyer)
 *   submitted → rejected (seller)            submitted / accepted-unpaid → cancelled (buyer)
 *   submitted / accepted / confirmed → cancelled (seller, before preparing; refunds a paid order)
 *   delivered / received → disputed (buyer) → completed (seller resolves; corrections are credit memos / returns)
 *
 * Every transition: one transaction, the PO row locked FOR UPDATE, the actor's
 * business authority re-checked in the transaction, a conditional status
 * update (so a concurrent duplicate transition fails), an append-only
 * PurchaseOrderEvent, and a CommerceEvent (`po.<status>`) in the outbox.
 * Payment is NOT delivery: paying confirms the order; only the seller's
 * delivery record moves it to delivered, and only the buyer receives it.
 */
export class PurchaseOrderError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'PurchaseOrderError';
    this.code = code;
    this.status = status;
  }
}

const SELLER_FLOW = { confirmed: 'preparing', preparing: 'ready', ready: 'fulfilment_requested', fulfilment_requested: 'delivered' };
export const FULFILMENT_MODES = {
  seller_delivery: { status: 'ACTIVE', label: 'Livraison par le fournisseur' },
  buyer_pickup: { status: 'ACTIVE', label: 'Retrait par l’acheteur' },
  third_party: { status: 'ACTIVE', label: 'Transporteur choisi par le fournisseur (hors Jokko)' },
  jokko_logistics: { status: 'DORMANT', label: 'Jokko Logistics (J8)' },
};
const SELLER_CAPS = ['business.orders.fulfill', 'business.distribution.manage'];
const SELLER_CANCEL_CAPS = ['business.orders.cancel', 'business.distribution.manage'];

const notFound = () => new PurchaseOrderError('not_found', 'Commande introuvable', 404);
const units = (line) => line.packs * line.unitsPerPack;

async function assertAnyCapInTx(tx, userId, businessId, caps) {
  let last;
  for (const c of caps) {
    try {
      await assertBusinessAuthorityInTx(tx, userId, businessId, c);
      return c;
    } catch (e) {
      if (!(e instanceof OrgAccessError) || e.status === 404) throw e;
      last = e;
    }
  }
  throw last;
}

async function lockPo(tx, id) {
  await tx.$executeRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} FOR UPDATE`;
  const po = await tx.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw notFound();
  return po;
}

async function transition(tx, po, to, { actorUserId, actorBusinessId, note = null, data = {} }) {
  const r = await tx.purchaseOrder.updateMany({ where: { id: po.id, status: po.status }, data: { status: to, ...data } });
  if (r.count !== 1) throw new PurchaseOrderError('conflict', 'La commande a changé entre-temps');
  await tx.purchaseOrderEvent.create({ data: { purchaseOrderId: po.id, fromStatus: po.status, toStatus: to, actorUserId, actorBusinessId, note: note ? String(note).slice(0, 300) : null } });
  await emitCommerceEvent(tx, { type: `po.${to}`, businessId: po.sellerBusinessId, aggregateType: 'purchase_order', aggregateId: po.id, payload: { totalKori: po.totalKori, paymentTerm: po.paymentTerm, from: po.status } });
  return tx.purchaseOrder.findUnique({ where: { id: po.id } });
}

async function buyerOwnerId(tx, buyerBusinessId) {
  const b = await tx.business.findUnique({ where: { id: buyerBusinessId }, select: { ownerId: true } });
  return b.ownerId;
}

export function poView(po, lines = [], events = null) {
  return {
    id: po.id,
    reference: po.reference,
    buyerBusinessId: po.buyerBusinessId,
    sellerBusinessId: po.sellerBusinessId,
    status: po.status,
    paymentTerm: po.paymentTerm,
    paymentStatus: po.paymentStatus,
    totalKori: po.totalKori,
    creditReservedKori: po.creditReservedKori,
    invoiceId: po.invoiceId,
    fulfilmentMode: po.fulfilmentMode,
    deliveryRecordedBy: po.deliveredAt ? 'seller' : null,
    submittedAt: po.submittedAt.toISOString(),
    deliveredAt: po.deliveredAt?.toISOString() ?? null,
    receivedAt: po.receivedAt?.toISOString() ?? null,
    lines: lines.map((l) => ({ listingId: l.listingId, sku: l.sku, title: l.title, unit: l.unit, unitsPerPack: l.unitsPerPack, packs: l.packs, unitPriceKori: l.unitPriceKori, lineTotalKori: l.lineTotalKori, priceSource: l.priceSource })),
    ...(events ? { history: events.map((e) => ({ from: e.fromStatus, to: e.toStatus, at: e.createdAt.toISOString(), note: e.note })) } : {}),
  };
}

async function fullView(db, po, withHistory = false) {
  const lines = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id }, orderBy: { id: 'asc' } });
  const events = withHistory ? await db.purchaseOrderEvent.findMany({ where: { purchaseOrderId: po.id }, orderBy: { createdAt: 'asc' } }) : null;
  return poView(po, lines, events);
}

/** Server quote = the draft. Nothing is stored; prices come only from here. */
export async function quotePurchaseOrder(userId, buyerId, { sellerBusinessId, lines }) {
  await requireBusinessCapability(userId, buyerId, 'business.purchasing');
  const rel = await activeRelationship(prisma, { sellerId: sellerBusinessId, buyerId });
  if (!rel) throw new OrgAccessError('Fournisseur introuvable', 404);
  const q = await quoteInDb(prisma, { sellerId: sellerBusinessId, relationship: rel, lines });
  const { creditSummary } = await import('./credit.js');
  const credit = await creditSummary(prisma, { supplierBusinessId: sellerBusinessId, buyerUserId: await buyerOwnerId(prisma, buyerId) });
  return { lines: q.lines.map(({ depotLocationId, productId, ...l }) => l), totalKori: q.totalKori, terms: credit.terms, availableCreditKori: credit.availableKori };
}

export async function submitPurchaseOrder(userId, buyerId, { sellerBusinessId, lines, paymentTerm = 'due_now', expectedTotalKori, idempotencyKey, note }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 80) throw new PurchaseOrderError('idempotency_key_required', 'Clé d’idempotence requise', 400);
  if (!Number.isSafeInteger(expectedTotalKori)) throw new PurchaseOrderError('expected_total_required', 'Total attendu requis', 400);
  if (sellerBusinessId === buyerId) throw new PurchaseOrderError('invalid', 'Commande à soi-même impossible', 400);
  const replay = async () => {
    const existing = await prisma.purchaseOrder.findUnique({ where: { buyerBusinessId_idempotencyKey: { buyerBusinessId: buyerId, idempotencyKey } } });
    if (!existing) return null;
    await requireBusinessCapability(userId, buyerId, 'business.purchasing');
    if (existing.sellerBusinessId !== sellerBusinessId || existing.totalKori !== expectedTotalKori || existing.paymentTerm !== paymentTerm) {
      throw new PurchaseOrderError('idempotency_conflict', 'Cette clé a déjà servi pour une autre commande', 409);
    }
    return { ...(await fullView(prisma, existing)), replayed: true };
  };
  const prior = await replay();
  if (prior) return prior;
  try {
    return await runMoneyTransaction(prisma, async (tx) => {
      await assertBusinessAuthorityInTx(tx, userId, buyerId, 'business.purchasing');
      // Committing the business to supplier credit is a financial act: it also needs business.pay.
      if (paymentTerm !== 'due_now') await assertBusinessAuthorityInTx(tx, userId, buyerId, 'business.pay');
      await assertBusinessCanReceive(tx, sellerBusinessId, 'b2b_payment');
      const rel = await activeRelationship(tx, { sellerId: sellerBusinessId, buyerId, lock: true });
      if (!rel) throw new OrgAccessError('Fournisseur introuvable', 404);
      const q = await quoteInDb(tx, { sellerId: sellerBusinessId, relationship: rel, lines });
      if (q.totalKori !== expectedTotalKori) {
        const e = new PurchaseOrderError('price_changed', 'Le prix a changé — vérifie le nouveau total');
        e.totalKori = q.totalKori;
        throw e;
      }
      let account = null;
      if (paymentTerm !== 'due_now') {
        ({ account } = await assertCreditAvailableInTx(tx, { supplierBusinessId: sellerBusinessId, buyerUserId: await buyerOwnerId(tx, buyerId), term: paymentTerm, amountKori: q.totalKori }));
        if (account.buyerBusinessId && account.buyerBusinessId !== buyerId) throw new CreditError('no_credit', 'Aucun crédit fournisseur accordé à ce commerce');
      }
      const depots = [...new Set(q.lines.map((l) => l.depotLocationId).filter(Boolean))];
      const po = await tx.purchaseOrder.create({
        data: {
          reference: `PO-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
          buyerBusinessId: buyerId,
          sellerBusinessId,
          relationshipId: rel.id,
          tradeAccountId: account?.id ?? null,
          territoryId: rel.territoryId,
          status: 'submitted',
          paymentTerm,
          paymentStatus: paymentTerm === 'due_now' ? 'unpaid' : 'reserved',
          subtotalKori: q.subtotalKori,
          totalKori: q.totalKori,
          creditReservedKori: paymentTerm === 'due_now' ? 0 : q.totalKori,
          idempotencyKey,
          submittedBy: userId,
          depotLocationId: depots.length === 1 ? depots[0] : null,
        },
      });
      for (const l of q.lines) {
        await tx.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, listingId: l.listingId, productId: l.productId, sku: l.sku, title: l.title, unit: l.unit, unitsPerPack: l.unitsPerPack, packs: l.packs, unitPriceKori: l.unitPriceKori, lineTotalKori: l.lineTotalKori, priceSource: l.priceSource } });
      }
      await tx.purchaseOrderEvent.create({ data: { purchaseOrderId: po.id, fromStatus: null, toStatus: 'submitted', actorUserId: userId, actorBusinessId: buyerId, note: note ? String(note).slice(0, 300) : null } });
      await emitCommerceEvent(tx, { type: 'po.submitted', businessId: sellerBusinessId, aggregateType: 'purchase_order', aggregateId: po.id, payload: { totalKori: po.totalKori, paymentTerm, lines: q.lines.length } });
      return fullView(tx, po);
    });
  } catch (e) {
    if (e?.code === 'P2002') {
      const r = await replay();
      if (r) return r;
    }
    throw e;
  }
}

async function forSide(tx, po, businessId, side) {
  if (side === 'buyer' ? po.buyerBusinessId !== businessId : po.sellerBusinessId !== businessId) throw notFound();
}

export async function acceptPurchaseOrder(userId, sellerId, poId, { depotLocationId } = {}) {
  return runMoneyTransaction(prisma, async (tx) => {
    const po = await lockPo(tx, poId);
    await forSide(tx, po, sellerId, 'seller');
    await assertAnyCapInTx(tx, userId, sellerId, SELLER_CAPS);
    if (po.status !== 'submitted') throw new PurchaseOrderError('invalid_state', 'Commande déjà traitée');
    if (po.paymentTerm !== 'due_now') {
      // The reservation was made under the lock at submit; the account must STILL grant this term.
      const account = await lockTradeExposure(tx, { supplierBusinessId: sellerId, buyerUserId: await buyerOwnerId(tx, po.buyerBusinessId) });
      if (!accountGrantsCredit(account) || account.paymentTerm !== po.paymentTerm) throw new CreditError('term_revoked', 'Les conditions de crédit ont été retirées — l’acheteur doit annuler ou recommander');
    }
    const loc = depotLocationId ?? po.depotLocationId;
    if (loc) {
      const ok = await tx.inventoryLocation.findFirst({ where: { id: loc, operatorBusinessId: sellerId, status: 'active' } });
      if (!ok) throw new PurchaseOrderError('depot_not_found', 'Dépôt introuvable', 404);
      const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
      for (const l of lines.filter((x) => x.productId)) {
        await moveDepotStockInTx(tx, { locationId: loc, productId: l.productId, deltaReserved: units(l), reason: 'reserve', purchaseOrderId: po.id, actorUserId: userId });
      }
    }
    const net = po.paymentTerm !== 'due_now';
    const updated = await transition(tx, po, net ? 'confirmed' : 'accepted', {
      actorUserId: userId,
      actorBusinessId: sellerId,
      data: { acceptedBy: userId, acceptedAt: new Date(), depotLocationId: loc ?? null, ...(net ? { confirmedAt: new Date() } : {}) },
    });
    return fullView(tx, updated);
  });
}

async function releaseReservations(tx, po, userId) {
  if (po.depotLocationId && ['accepted', 'confirmed', 'preparing', 'ready'].includes(po.status)) {
    const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
    for (const l of lines.filter((x) => x.productId)) {
      await moveDepotStockInTx(tx, { locationId: po.depotLocationId, productId: l.productId, deltaReserved: -units(l), reason: 'release', purchaseOrderId: po.id, actorUserId: userId });
    }
  }
}

export async function rejectPurchaseOrder(userId, sellerId, poId, { reason }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const po = await lockPo(tx, poId);
    await forSide(tx, po, sellerId, 'seller');
    await assertAnyCapInTx(tx, userId, sellerId, SELLER_CAPS);
    if (po.status !== 'submitted') throw new PurchaseOrderError('invalid_state', 'Commande déjà traitée');
    const u = await transition(tx, po, 'rejected', { actorUserId: userId, actorBusinessId: sellerId, note: reason, data: { rejectedReason: String(reason ?? '').slice(0, 300), creditReservedKori: 0, paymentStatus: po.paymentStatus === 'reserved' ? 'released' : po.paymentStatus } });
    return fullView(tx, u);
  });
}

/** Due-now payment from the buyer business wallet (business.pay). Confirms; never delivers. */
export async function payPurchaseOrder(userId, buyerId, poId, { expectedAmountKori }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const po = await lockPo(tx, poId);
    await forSide(tx, po, buyerId, 'buyer');
    await assertBusinessAuthorityInTx(tx, userId, buyerId, 'business.pay');
    if (po.paymentStatus === 'paid' && po.paymentReference) return { ...(await fullView(tx, po)), replayed: true };
    if (po.paymentTerm !== 'due_now') throw new PurchaseOrderError('invalid_state', 'Commande à crédit : payez la facture après livraison');
    if (po.status !== 'accepted') throw new PurchaseOrderError('invalid_state', po.status === 'submitted' ? 'En attente d’acceptation par le fournisseur' : 'Commande non payable');
    if (expectedAmountKori !== po.totalKori) throw new PurchaseOrderError('amount_mismatch', 'Le montant ne correspond pas à la commande');
    const [bw, sw, buyer, seller] = await Promise.all([
      ensureBusinessWallet(po.buyerBusinessId, tx),
      ensureBusinessWallet(po.sellerBusinessId, tx),
      tx.business.findUnique({ where: { id: po.buyerBusinessId }, select: { name: true, kebuId: true } }),
      tx.business.findUnique({ where: { id: po.sellerBusinessId }, select: { name: true, kebuId: true } }),
    ]);
    const ref = `POP-${po.reference}`;
    await transferBusinessToBusiness(tx, {
      amount: po.totalKori,
      senderWalletId: bw.id,
      senderBusinessId: po.buyerBusinessId,
      recipientWalletId: sw.id,
      recipientBusinessId: po.sellerBusinessId,
      reference: ref,
      actingUserId: userId,
      capability: 'business.pay',
      purpose: 'b2b_payment',
      actor: { type: 'user', id: userId },
      senderLedger: { type: 'b2b_out', counterpartyName: seller.name, counterpartyKebuId: seller.kebuId ?? null, note: `Bon de commande ${po.reference}` },
      recipientLedger: { type: 'b2b_in', counterpartyName: buyer.name, counterpartyKebuId: buyer.kebuId ?? null, note: `Bon de commande ${po.reference}` },
    });
    await recordPayment(tx, { businessId: po.sellerBusinessId, method: 'wallet', sourceChannel: 'b2b_purchase_order', amountKori: po.totalKori, ledgerReference: `${ref}-J`, recordedBy: userId, note: po.reference });
    const u = await transition(tx, po, 'confirmed', { actorUserId: userId, actorBusinessId: buyerId, data: { paymentStatus: 'paid', paymentReference: ref, confirmedAt: new Date() } });
    return fullView(tx, u);
  });
}

export async function advancePurchaseOrder(userId, sellerId, poId, { to, fulfilmentMode, note }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const po = await lockPo(tx, poId);
    await forSide(tx, po, sellerId, 'seller');
    await assertAnyCapInTx(tx, userId, sellerId, SELLER_CAPS);
    if (SELLER_FLOW[po.status] !== to) throw new PurchaseOrderError('invalid_transition', `Transition impossible : ${po.status} → ${to}`);
    const data = {};
    if (to === 'fulfilment_requested') {
      const mode = FULFILMENT_MODES[fulfilmentMode];
      if (!mode) throw new PurchaseOrderError('invalid', 'Mode de livraison inconnu', 400);
      if (mode.status !== 'ACTIVE') throw new PurchaseOrderError('fulfilment_not_activated', `${mode.label} : pas encore activé`);
      data.fulfilmentMode = fulfilmentMode;
      data.fulfilmentRequestedAt = new Date();
      if (po.depotLocationId) {
        const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
        for (const l of lines.filter((x) => x.productId)) {
          await moveDepotStockInTx(tx, { locationId: po.depotLocationId, productId: l.productId, deltaOnHand: -units(l), deltaReserved: -units(l), reason: 'dispatch', purchaseOrderId: po.id, actorUserId: userId });
        }
      }
      await emitCommerceEvent(tx, { type: 'fulfillment.requested', businessId: sellerId, aggregateType: 'purchase_order', aggregateId: po.id, payload: { mode: fulfilmentMode, recordedBy: 'seller' } });
    }
    if (to === 'delivered') {
      data.deliveredAt = new Date();
      data.deliveryRecordedBy = userId;
      if (po.paymentTerm !== 'due_now') {
        await lockTradeExposure(tx, { supplierBusinessId: sellerId, buyerUserId: await buyerOwnerId(tx, po.buyerBusinessId) });
        const inv = await invoicePurchaseOrderInTx(tx, { ...po, deliveredAt: data.deliveredAt }, { buyerOwnerUserId: await buyerOwnerId(tx, po.buyerBusinessId) });
        // The reservation becomes the receivable: exposure is unchanged, never counted twice.
        data.invoiceId = inv.id;
        data.creditReservedKori = 0;
        data.paymentStatus = 'invoiced';
      }
    }
    const u = await transition(tx, po, to, { actorUserId: userId, actorBusinessId: sellerId, note, data });
    return fullView(tx, u);
  });
}

export async function buyerActOnPurchaseOrder(userId, buyerId, poId, { action, reason }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const po = await lockPo(tx, poId);
    await forSide(tx, po, buyerId, 'buyer');
    await assertBusinessAuthorityInTx(tx, userId, buyerId, 'business.purchasing');
    let to;
    let data = {};
    if (action === 'receive') {
      if (po.status !== 'delivered') throw new PurchaseOrderError('invalid_state', 'Pas encore livrée');
      to = 'received';
      data = { receivedAt: new Date(), receivedBy: userId };
    } else if (action === 'complete') {
      if (po.status !== 'received') throw new PurchaseOrderError('invalid_state', 'Réception non confirmée');
      to = 'completed';
      data = { completedAt: new Date() };
    } else if (action === 'dispute') {
      if (!['delivered', 'received'].includes(po.status)) throw new PurchaseOrderError('invalid_state', 'Litige impossible à ce stade');
      if (!(reason && String(reason).trim().length >= 5)) throw new PurchaseOrderError('reason_required', 'Explique le problème', 400);
      to = 'disputed';
      data = { disputedAt: new Date(), disputeReason: String(reason).slice(0, 300) };
    } else {
      throw new PurchaseOrderError('invalid', 'Action inconnue', 400);
    }
    const u = await transition(tx, po, to, { actorUserId: userId, actorBusinessId: buyerId, note: reason, data });
    return fullView(tx, u);
  });
}

export async function resolvePurchaseOrderDispute(userId, sellerId, poId, { note }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const po = await lockPo(tx, poId);
    await forSide(tx, po, sellerId, 'seller');
    await assertAnyCapInTx(tx, userId, sellerId, SELLER_CAPS);
    if (po.status !== 'disputed') throw new PurchaseOrderError('invalid_state', 'Aucun litige ouvert');
    if (!(note && String(note).trim().length >= 5)) throw new PurchaseOrderError('reason_required', 'Explique la résolution', 400);
    const u = await transition(tx, po, 'completed', { actorUserId: userId, actorBusinessId: sellerId, note, data: { completedAt: new Date() } });
    return fullView(tx, u);
  });
}

/**
 * Cancel. Buyer: before acceptance (or accepted but unpaid). Seller: before
 * preparing. Releases credit and stock reservations ONCE (same transaction as
 * the conditional status change) and refunds a paid order from the seller's
 * wallet (purpose `refund` — allowed even if the buyer is suspended).
 */
export async function cancelPurchaseOrder(userId, businessId, poId, { reason }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const po = await lockPo(tx, poId);
    const side = po.buyerBusinessId === businessId ? 'buyer' : po.sellerBusinessId === businessId ? 'seller' : null;
    if (!side) throw notFound();
    if (side === 'buyer') {
      await assertBusinessAuthorityInTx(tx, userId, businessId, 'business.purchasing');
      if (!(po.status === 'submitted' || (po.status === 'accepted' && po.paymentStatus !== 'paid'))) throw new PurchaseOrderError('invalid_state', 'Le fournisseur a déjà confirmé — demande-lui d’annuler');
    } else {
      await assertAnyCapInTx(tx, userId, businessId, SELLER_CANCEL_CAPS);
      if (!['submitted', 'accepted', 'confirmed'].includes(po.status)) throw new PurchaseOrderError('invalid_state', 'Préparation commencée — passez par un retour');
    }
    if (!(reason && String(reason).trim().length >= 3)) throw new PurchaseOrderError('reason_required', 'Motif requis', 400);
    await releaseReservations(tx, po, userId);
    const data = { cancelledAt: new Date(), cancelledBy: userId, cancelReason: String(reason).slice(0, 300), creditReservedKori: 0 };
    if (po.paymentStatus === 'paid') {
      await assertBusinessAuthorityInTx(tx, userId, po.sellerBusinessId, 'business.refund');
      const [bw, sw] = await Promise.all([ensureBusinessWallet(po.buyerBusinessId, tx), ensureBusinessWallet(po.sellerBusinessId, tx)]);
      const ref = `POR-${po.reference}`;
      await transferBusinessToBusiness(tx, {
        amount: po.totalKori,
        senderWalletId: sw.id,
        senderBusinessId: po.sellerBusinessId,
        recipientWalletId: bw.id,
        recipientBusinessId: po.buyerBusinessId,
        reference: ref,
        actingUserId: userId,
        capability: 'business.refund',
        purpose: 'refund',
        actor: { type: 'user', id: userId },
        senderLedger: { type: 'b2b_refund_out', note: `Annulation ${po.reference}` },
        recipientLedger: { type: 'b2b_refund_in', note: `Annulation ${po.reference}` },
      });
      data.paymentStatus = 'refunded';
      data.refundReference = ref;
    } else if (po.paymentStatus === 'reserved') {
      data.paymentStatus = 'released';
    }
    const u = await transition(tx, po, 'cancelled', { actorUserId: userId, actorBusinessId: businessId, note: reason, data });
    return fullView(tx, u);
  });
}

export async function getPurchaseOrder(userId, businessId, poId) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
  if (!po || (po.buyerBusinessId !== businessId && po.sellerBusinessId !== businessId)) throw notFound();
  const cap = po.buyerBusinessId === businessId ? 'business.purchasing' : 'business.orders.read';
  await requireBusinessCapability(userId, businessId, cap).catch(() => { throw notFound(); });
  return fullView(prisma, po, true);
}

export async function listPurchaseOrders(userId, businessId, { side = 'buyer', status, cursor, limit = 50 } = {}) {
  await requireBusinessCapability(userId, businessId, side === 'buyer' ? 'business.purchasing' : 'business.orders.read');
  const take = Math.min(Math.max(1, Number(limit) || 50), 200);
  const rows = await prisma.purchaseOrder.findMany({
    where: { [side === 'buyer' ? 'buyerBusinessId' : 'sellerBusinessId']: businessId, ...(status ? { status: String(status) } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
  });
  const page = rows.slice(0, take);
  return { items: page.map((po) => poView(po)), nextCursor: rows.length > take ? page[page.length - 1].id : null };
}

/* ── Invoices from the business side (J7.10) ─────────────────────────────── */

/** Buyer business pays (part of) an invoice from its wallet. Idempotent per (invoice, key). */
export async function payInvoiceFromBusiness(userId, buyerId, invoiceId, { amountKori, idempotencyKey }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 80) throw new PurchaseOrderError('idempotency_key_required', 'Clé d’idempotence requise', 400);
  if (!Number.isSafeInteger(amountKori) || amountKori <= 0) throw new InvoiceError('invalid_amount', 'Montant invalide', 400);
  const ref = `INVP-${crypto.createHash('sha256').update(`${invoiceId}:${idempotencyKey}`).digest('hex').slice(0, 24)}`;
  return runMoneyTransaction(prisma, async (tx) => {
    const inv0 = await tx.tradeInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv0 || inv0.buyerBusinessId !== buyerId) throw new InvoiceError('not_found', 'Facture introuvable', 404);
    await assertBusinessAuthorityInTx(tx, userId, buyerId, 'business.pay');
    const dup = await tx.tradeInvoicePayment.findUnique({ where: { ledgerReference: ref } });
    if (dup) {
      if (dup.amountKori !== amountKori) throw new PurchaseOrderError('idempotency_conflict', 'Cette clé a déjà servi pour un autre montant');
      return { invoice: invoiceView(await tx.tradeInvoice.findUnique({ where: { id: invoiceId } })), replayed: true };
    }
    await lockTradeExposure(tx, { supplierBusinessId: inv0.supplierBusinessId, buyerUserId: inv0.buyerUserId });
    await tx.$executeRaw`SELECT id FROM "TradeInvoice" WHERE id = ${invoiceId} FOR UPDATE`;
    const inv = await tx.tradeInvoice.findUnique({ where: { id: invoiceId } });
    if (amountKori > inv.amountKori - inv.amountPaid - inv.creditedKori) throw new InvoiceError('overpayment', 'Montant supérieur au reste dû', 409);
    const [bw, sw] = await Promise.all([ensureBusinessWallet(buyerId, tx), ensureBusinessWallet(inv.supplierBusinessId, tx)]);
    await transferBusinessToBusiness(tx, {
      amount: amountKori,
      senderWalletId: bw.id,
      senderBusinessId: buyerId,
      recipientWalletId: sw.id,
      recipientBusinessId: inv.supplierBusinessId,
      reference: ref,
      actingUserId: userId,
      capability: 'business.pay',
      purpose: 'invoice_payment',
      actor: { type: 'user', id: userId },
      senderLedger: { type: 'b2b_out', note: `Facture ${inv.reference}` },
      recipientLedger: { type: 'b2b_in', note: `Facture ${inv.reference}` },
    });
    const updated = await applyInvoicePaymentInTx(tx, { invoiceId, amountKori, ledgerReference: ref, paidByUserId: userId, paymentSource: 'kebu' });
    await recordPayment(tx, { businessId: inv.supplierBusinessId, method: 'wallet', sourceChannel: 'b2b_invoice', amountKori, ledgerReference: `${ref}-J`, recordedBy: userId, note: inv.reference });
    if (updated.status === 'paid' && updated.purchaseOrderId) await tx.purchaseOrder.update({ where: { id: updated.purchaseOrderId }, data: { paymentStatus: 'paid' } });
    await emitCommerceEvent(tx, { type: updated.status === 'paid' ? 'invoice.paid' : 'invoice.payment', businessId: inv.supplierBusinessId, aggregateType: 'trade_invoice', aggregateId: inv.id, payload: { amountKori } });
    return { invoice: invoiceView(updated) };
  });
}

/** Seller issues a correction credit memo (business.refund). Idempotent per client reference. */
export async function sellerCreditMemo(userId, sellerId, invoiceId, { amountKori, reason, reference }) {
  if (!(reason && String(reason).trim().length >= 5)) throw new InvoiceError('reason_required', 'Motif requis', 400);
  if (typeof reference !== 'string' || reference.length < 4 || reference.length > 60) throw new InvoiceError('reference_required', 'Référence requise', 400);
  return prisma.$transaction(async (tx) => {
    const inv = await tx.tradeInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv || inv.supplierBusinessId !== sellerId) throw new InvoiceError('not_found', 'Facture introuvable', 404);
    await assertBusinessAuthorityInTx(tx, userId, sellerId, 'business.refund');
    await lockTradeExposure(tx, { supplierBusinessId: sellerId, buyerUserId: inv.buyerUserId });
    const ref = `CRM-${invoiceId}-${reference}`;
    const prior = await tx.creditMemo.findUnique({ where: { reference: ref } });
    if (prior && prior.amountKori !== amountKori) throw new PurchaseOrderError('idempotency_conflict', 'Référence déjà utilisée pour un autre montant');
    const updated = await issueCreditMemoInTx(tx, { invoiceId, amountKori, kind: 'correction', reason, createdByUserId: userId, reference: ref });
    if (!prior) await emitCommerceEvent(tx, { type: 'invoice.credited', businessId: sellerId, aggregateType: 'trade_invoice', aggregateId: inv.id, payload: { amountKori } });
    if (updated.status === 'paid' && updated.purchaseOrderId) await tx.purchaseOrder.update({ where: { id: updated.purchaseOrderId }, data: { paymentStatus: 'paid' } });
    return { invoice: invoiceView(updated), replayed: Boolean(prior) };
  });
}

export async function getInvoiceForBusiness(userId, businessId, invoiceId) {
  const inv = await prisma.tradeInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv || (inv.buyerBusinessId !== businessId && inv.supplierBusinessId !== businessId)) throw new InvoiceError('not_found', 'Facture introuvable', 404);
  const cap = inv.supplierBusinessId === businessId ? 'business.orders.read' : 'business.purchasing';
  await requireBusinessCapability(userId, businessId, cap).catch(() => { throw new InvoiceError('not_found', 'Facture introuvable', 404); });
  const [memos, payments] = await Promise.all([
    prisma.creditMemo.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' } }),
    prisma.tradeInvoicePayment.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' } }),
  ]);
  return invoiceView(inv, { memos, payments });
}

export async function listInvoicesForBusiness(userId, businessId, { side = 'buyer', cursor, limit = 50, pastDueOnly = false } = {}) {
  await requireBusinessCapability(userId, businessId, side === 'seller' ? 'business.orders.read' : 'business.purchasing');
  const take = Math.min(Math.max(1, Number(limit) || 50), 200);
  const rows = await prisma.tradeInvoice.findMany({
    where: { [side === 'seller' ? 'supplierBusinessId' : 'buyerBusinessId']: businessId, ...(pastDueOnly ? { dueAt: { lt: new Date() }, status: { in: ['open', 'partial', 'overdue'] } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
  });
  const page = rows.slice(0, take);
  return { items: page.map((i) => invoiceView(i)), nextCursor: rows.length > take ? page[page.length - 1].id : null };
}
