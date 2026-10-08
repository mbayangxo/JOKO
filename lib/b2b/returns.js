import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx, requireBusinessCapability } from '../business-access.js';
import { ensureBusinessWallet, transferBusinessToBusiness } from '../business-wallet-service.js';
import { emitCommerceEvent } from '../commerce/events.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { moveDepotStockInTx } from './depot.js';
import { issueCreditMemoInTx, outstandingOf } from './invoices.js';
import { lockTradeExposure } from './credit.js';
import { InventoryError, quarantineForReturnInTx, releaseFromReturnInTx, tracksStock } from '../commerce/inventory.js';

/**
 * J7.16 — commercial returns, separate from refunds.
 *
 *   requested (buyer) → approved | rejected (seller) → goods_returned (buyer ships)
 *   → received (seller confirms the goods; optional restock — ONLY here)
 *   → resolved (seller): credit memo on the PO invoice | refund of money actually paid | none
 *
 * A return never moves money by itself and never restocks without the seller
 * confirming receipt. Amounts come from the PO line snapshots (server), never
 * from the request. Returned quantities per line never exceed what was
 * ordered minus earlier non-rejected returns (checked under the PO lock).
 *
 * D44 — buyer-side stock. A request changes no stock. When the buyer SHIPS the
 * return, a ReturnStockHold per product takes the sellable units out of the
 * buyer's own (mapped, D40) product into quarantine — never below zero.
 * Damaged units (`fromDamagedUnits`, bounded by what the PO's receiving
 * recorded as damaged and never credited) touch no stock. The hold is
 * handed_over on verified custody (the courier's pickup with the buyer's code)
 * or self-reported (untracked return); a cancelled / failed collection releases
 * it once and puts the return back to `approved` for another attempt.
 */
export class ReturnError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ReturnError';
    this.code = code;
    this.status = status;
  }
}

const RETURNABLE = ['delivered', 'received', 'completed', 'disputed'];
const SELLER_CAPS = ['business.orders.fulfill', 'business.distribution.manage'];

async function sellerAuth(tx, userId, sellerId) {
  let last;
  for (const c of SELLER_CAPS) {
    try {
      return await assertBusinessAuthorityInTx(tx, userId, sellerId, c);
    } catch (e) {
      if (!(e instanceof OrgAccessError) || e.status === 404) throw e;
      last = e;
    }
  }
  throw last;
}

function view(r) {
  return {
    id: r.id,
    reference: r.reference,
    purchaseOrderId: r.purchaseOrderId,
    status: r.status,
    reason: r.reason,
    lines: JSON.parse(r.linesJson),
    amountKori: r.amountKori,
    restocked: r.restocked,
    shipAttempts: r.shipAttempts,
    shipTracked: r.shipTracked,
    resolution: r.resolution,
    createdAt: r.createdAt.toISOString(),
  };
}

async function lockReturn(tx, id) {
  await tx.$executeRaw`SELECT id FROM "CommercialReturn" WHERE id = ${id} FOR UPDATE`;
  const r = await tx.commercialReturn.findUnique({ where: { id } });
  if (!r) throw new ReturnError('not_found', 'Retour introuvable', 404);
  return r;
}

async function step(tx, r, from, to, data) {
  const u = await tx.commercialReturn.updateMany({ where: { id: r.id, status: from }, data: { status: to, ...data } });
  if (u.count !== 1) throw new ReturnError('invalid_state', 'Le retour a changé entre-temps');
  await emitCommerceEvent(tx, { type: `return.${to}`, businessId: r.sellerBusinessId, aggregateType: 'commercial_return', aggregateId: r.id, payload: { amountKori: r.amountKori } });
  return tx.commercialReturn.findUnique({ where: { id: r.id } });
}

export async function requestReturn(userId, buyerId, poId, { lines, reason, idempotencyKey }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) throw new ReturnError('idempotency_key_required', 'Clé d’idempotence requise', 400);
  if (!(reason && String(reason).trim().length >= 5)) throw new ReturnError('reason_required', 'Explique le retour', 400);
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw new ReturnError('invalid', 'Lignes invalides', 400);
  const reference = `RET-${crypto.createHash('sha256').update(`${poId}:${idempotencyKey}`).digest('hex').slice(0, 16).toUpperCase()}`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${poId} FOR UPDATE`;
    const po = await tx.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po || po.buyerBusinessId !== buyerId) throw new ReturnError('not_found', 'Commande introuvable', 404);
    await assertBusinessAuthorityInTx(tx, userId, buyerId, 'business.purchasing');
    const prior = await tx.commercialReturn.findUnique({ where: { reference } });
    if (prior) return { ...view(prior), replayed: true };
    if (!RETURNABLE.includes(po.status)) throw new ReturnError('invalid_state', 'Retour possible après livraison seulement');
    const poLines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
    const earlier = await tx.commercialReturn.findMany({ where: { purchaseOrderId: po.id, status: { not: 'rejected' } } });
    const already = {};
    const damagedUsed = {};
    for (const e of earlier) {
      for (const l of JSON.parse(e.linesJson)) {
        already[l.listingId] = (already[l.listingId] ?? 0) + l.packs;
        if (l.fromDamagedUnits) damagedUsed[l.productId] = (damagedUsed[l.productId] ?? 0) + l.fromDamagedUnits;
      }
    }
    const damagedRecorded = lines.some((l) => l.fromDamagedUnits) ? await damagedOnReceiving(tx, po.id) : {};
    let amount = 0;
    const snap = [];
    for (const ln of lines) {
      const pl = poLines.find((x) => x.listingId === ln.listingId);
      if (!pl || !Number.isSafeInteger(ln.packs) || ln.packs < 1) throw new ReturnError('invalid', 'Ligne invalide', 400);
      if (snap.some((s) => s.listingId === ln.listingId)) throw new ReturnError('invalid', 'Ligne en double', 400);
      if (ln.packs + (already[ln.listingId] ?? 0) > pl.packs) throw new ReturnError('exceeds_ordered', `${pl.title} — quantité retournée supérieure à la commande`);
      const dmg = ln.fromDamagedUnits ?? 0;
      if (!Number.isSafeInteger(dmg) || dmg < 0 || dmg > ln.packs * pl.unitsPerPack) throw new ReturnError('invalid', 'Unités abîmées invalides', 400);
      if (dmg) {
        if (!pl.productId) throw new ReturnError('invalid', 'Unités abîmées invalides', 400);
        const avail = (damagedRecorded[pl.productId] ?? 0) - (damagedUsed[pl.productId] ?? 0);
        if (dmg > avail) throw new ReturnError('exceeds_damaged', `${pl.title} — plus d’unités abîmées que celles constatées à la réception (${Math.max(avail, 0)})`);
        damagedUsed[pl.productId] = (damagedUsed[pl.productId] ?? 0) + dmg;
      }
      amount += pl.unitPriceKori * ln.packs;
      snap.push({ listingId: pl.listingId, productId: pl.productId, sku: pl.sku, title: pl.title, packs: ln.packs, unitsPerPack: pl.unitsPerPack, unitPriceKori: pl.unitPriceKori, ...(dmg ? { fromDamagedUnits: dmg } : {}) });
    }
    const r = await tx.commercialReturn.create({
      data: { reference, purchaseOrderId: po.id, buyerBusinessId: buyerId, sellerBusinessId: po.sellerBusinessId, reason: String(reason).slice(0, 300), linesJson: JSON.stringify(snap), amountKori: amount, requestedBy: userId },
    });
    await emitCommerceEvent(tx, { type: 'return.requested', businessId: po.sellerBusinessId, aggregateType: 'commercial_return', aggregateId: r.id, payload: { amountKori: amount } });
    return view(r);
  });
}

export async function decideReturn(userId, sellerId, returnId, { approve, note }) {
  return prisma.$transaction(async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (r.sellerBusinessId !== sellerId) throw new ReturnError('not_found', 'Retour introuvable', 404);
    await sellerAuth(tx, userId, sellerId);
    if (r.status !== 'requested') throw new ReturnError('invalid_state', 'Retour déjà traité');
    return view(await step(tx, r, 'requested', approve ? 'approved' : 'rejected', { decidedBy: userId, decidedAt: new Date(), decisionNote: note ? String(note).slice(0, 300) : null }));
  });
}

export async function shipReturn(userId, buyerId, returnId, { tracked = false } = {}) {
  return prisma.$transaction(async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (r.buyerBusinessId !== buyerId) throw new ReturnError('not_found', 'Retour introuvable', 404);
    await assertBusinessAuthorityInTx(tx, userId, buyerId, 'business.purchasing');
    if (r.status !== 'approved') throw new ReturnError('invalid_state', 'Retour non approuvé');
    const attempt = r.shipAttempts + 1;
    const u = await step(tx, r, 'approved', 'goods_returned', { shippedAt: new Date(), shipAttempts: attempt, shipTracked: Boolean(tracked) });
    await createHoldsInTx(tx, r, { attempt, tracked: Boolean(tracked), actorUserId: userId });
    // J8.18: a tracked return is collected by the seller's fleet; J8 consumes this event.
    if (tracked) await emitCommerceEvent(tx, { type: 'return.collection_requested', businessId: r.sellerBusinessId, aggregateType: 'commercial_return', aggregateId: r.id, payload: { tracked: true, requestedBy: userId, attempt } });
    return view(u);
  });
}

/** J8 intake key of a return's collection request (attempt 1 keeps the pre-D44 key). */
export function returnCollectionKey(returnId, attempt) {
  return `j7_return:${returnId}:return${attempt > 1 ? `:a${attempt}` : ''}`;
}

/** Damaged units per (seller) product recorded on this PO's J8 receiving records — never credited to the buyer. */
async function damagedOnReceiving(tx, poId) {
  const reqs = await tx.fulfilmentRequest.findMany({ where: { sourceSystem: 'jokko_po', sourceId: poId }, select: { id: true } });
  if (!reqs.length) return {};
  const shs = await tx.shipment.findMany({ where: { requestId: { in: reqs.map((q) => q.id) } }, select: { id: true } });
  const recs = await tx.receivingRecord.findMany({ where: { shipmentId: { in: shs.map((x) => x.id) } } });
  const out = {};
  for (const rec of recs) for (const l of JSON.parse(rec.linesJson)) if (l.damaged > 0) out[l.productId] = (out[l.productId] ?? 0) + l.damaged;
  return out;
}

async function createHoldsInTx(tx, r, { attempt, tracked, actorUserId }) {
  const per = new Map();
  for (const l of JSON.parse(r.linesJson).filter((x) => x.productId)) {
    const p = per.get(l.productId) ?? { units: 0, damaged: 0 };
    p.units += l.packs * l.unitsPerPack;
    p.damaged += l.fromDamagedUnits ?? 0;
    per.set(l.productId, p);
  }
  for (const [sellerProductId, { units, damaged }] of per) {
    const m = await tx.buyerProductMapping.findUnique({ where: { buyerBusinessId_sellerProductId: { buyerBusinessId: r.buyerBusinessId, sellerProductId } } });
    const product = m ? await tx.product.findFirst({ where: { id: m.buyerProductId, businessId: r.buyerBusinessId } }) : null;
    const stocked = product && tracksStock(product) ? product : null;
    const sellable = units - damaged;
    const hold = await tx.returnStockHold.create({
      data: {
        returnId: r.id, attempt, buyerBusinessId: r.buyerBusinessId, sellerProductId, buyerProductId: stocked?.id ?? null,
        sellableUnits: sellable, damagedUnits: damaged,
        state: tracked ? 'quarantined' : 'handed_over', handoverEvidence: tracked ? null : 'self_reported',
      },
    });
    if (stocked && sellable > 0) {
      try {
        await quarantineForReturnInTx(tx, { product: stocked, quantity: sellable, holdId: hold.id, actorUserId });
      } catch (e) {
        if (e instanceof InventoryError) throw new ReturnError(e.code, e.message, e.status);
        throw e;
      }
    }
  }
}

/** J8 contract: the seller's courier collected the return with the buyer's pickup code — verified custody handoff. */
export async function applyReturnPickedUpInTx(tx, returnId) {
  await tx.returnStockHold.updateMany({ where: { returnId, state: 'quarantined' }, data: { state: 'handed_over', handoverEvidence: 'courier_code' } });
}

/**
 * J8 contract: the return's collection was cancelled before pickup, or the goods came
 * back to the buyer (verified with the buyer's code). Holds of the current attempt are
 * released once (sellable units back into the buyer's stock) and the return goes back
 * to `approved` so the buyer can ship it again.
 */
export async function applyReturnShipmentAbortedInTx(tx, returnId, { actorUserId, reason }) {
  const r = await lockReturn(tx, returnId);
  if (r.status !== 'goods_returned') return r;
  const holds = await tx.returnStockHold.findMany({ where: { returnId, attempt: r.shipAttempts, state: { in: ['quarantined', 'handed_over'] } } });
  for (const h of holds) {
    const u = await tx.returnStockHold.updateMany({ where: { id: h.id, state: h.state }, data: { state: 'released' } });
    if (u.count !== 1) continue;
    if (h.buyerProductId && h.sellableUnits > 0) {
      const product = await tx.product.findUnique({ where: { id: h.buyerProductId } });
      await releaseFromReturnInTx(tx, { product, quantity: h.sellableUnits, holdId: h.id, actorUserId });
    }
  }
  const u = await tx.commercialReturn.updateMany({ where: { id: r.id, status: 'goods_returned' }, data: { status: 'approved', shippedAt: null, shipTracked: false } });
  if (u.count !== 1) throw new ReturnError('invalid_state', 'Le retour a changé entre-temps');
  await emitCommerceEvent(tx, { type: 'return.collection_failed', businessId: r.sellerBusinessId, aggregateType: 'commercial_return', aggregateId: r.id, payload: { attempt: r.shipAttempts, reason } });
  return tx.commercialReturn.findUnique({ where: { id: r.id } });
}

async function carriedReturn(tx, r) {
  if (!r.shipTracked) return false;
  const req = await tx.fulfilmentRequest.findUnique({ where: { sourceKey: returnCollectionKey(r.id, r.shipAttempts) } });
  return !req || !['cancelled', 'failed'].includes(req.status);
}

/**
 * J8 contract: the seller recorded per-line receiving of a tracked return shipment.
 * Received units are restocked into the PO depot (once — one receiving record per
 * shipment); damaged / missing units are on the receiving record, not restocked.
 */
export async function applyReturnReceivingInTx(tx, returnId, { receiverUserId, lines, shipmentReference }) {
  const r = await lockReturn(tx, returnId);
  if (r.status !== 'goods_returned') return r;
  const po = await tx.purchaseOrder.findUnique({ where: { id: r.purchaseOrderId } });
  const received = lines.filter((l) => l.received > 0);
  const doRestock = Boolean(po.depotLocationId && received.length);
  const u = await step(tx, r, 'goods_returned', 'received', { receivedAt: new Date(), receivedBy: receiverUserId, restocked: doRestock });
  if (doRestock) {
    for (const l of received) {
      await moveDepotStockInTx(tx, { locationId: po.depotLocationId, productId: l.productId, deltaOnHand: l.received, reason: 'return_restock', purchaseOrderId: po.id, returnId: r.id, actorUserId: receiverUserId, note: shipmentReference });
    }
  }
  return u;
}

/** Seller confirms the goods are back. Restock happens here and only here, once. */
export async function receiveReturn(userId, sellerId, returnId, { restock = false } = {}) {
  return prisma.$transaction(async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (r.sellerBusinessId !== sellerId) throw new ReturnError('not_found', 'Retour introuvable', 404);
    await sellerAuth(tx, userId, sellerId);
    if (r.status !== 'goods_returned') throw new ReturnError('invalid_state', r.status === 'approved' ? 'Marchandise pas encore renvoyée' : 'Retour non réceptionnable');
    if (await carriedReturn(tx, r)) throw new ReturnError('received_by_shipment', 'Retour suivi : déclare la réception article par article sur l’expédition', 409);
    const po = await tx.purchaseOrder.findUnique({ where: { id: r.purchaseOrderId } });
    const doRestock = Boolean(restock && po.depotLocationId);
    const updated = await step(tx, r, 'goods_returned', 'received', { receivedAt: new Date(), receivedBy: userId, restocked: doRestock });
    if (doRestock) {
      for (const l of JSON.parse(r.linesJson).filter((x) => x.productId)) {
        await moveDepotStockInTx(tx, { locationId: po.depotLocationId, productId: l.productId, deltaOnHand: l.packs * l.unitsPerPack, reason: 'return_restock', purchaseOrderId: po.id, returnId: r.id, actorUserId: userId });
      }
    }
    return view(updated);
  });
}

/**
 * Resolve a received return: a credit memo against the PO invoice's
 * outstanding balance, or a refund of money actually paid (never more than
 * was paid net of earlier return refunds), or none (e.g. goods replaced).
 */
export async function resolveReturn(userId, sellerId, returnId, { resolution, note }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (r.sellerBusinessId !== sellerId) throw new ReturnError('not_found', 'Retour introuvable', 404);
    // Authority before any state is revealed (a money resolution also needs business.refund, below).
    await sellerAuth(tx, userId, sellerId);
    if (r.status !== 'received') throw new ReturnError('invalid_state', 'Réception de la marchandise requise avant résolution');
    await tx.$executeRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${r.purchaseOrderId} FOR UPDATE`;
    const po = await tx.purchaseOrder.findUnique({ where: { id: r.purchaseOrderId } });
    const data = { resolution, decisionNote: note ? String(note).slice(0, 300) : r.decisionNote };
    if (resolution === 'credit_memo') {
      await assertBusinessAuthorityInTx(tx, userId, sellerId, 'business.refund');
      if (!po.invoiceId) throw new ReturnError('no_invoice', 'Pas de facture pour cette commande — utilisez un remboursement');
      const inv = await tx.tradeInvoice.findUnique({ where: { id: po.invoiceId } });
      await lockTradeExposure(tx, { supplierBusinessId: sellerId, buyerUserId: inv.buyerUserId });
      if (outstandingOf(inv) < r.amountKori) throw new ReturnError('credit_exceeds_outstanding', 'Avoir supérieur au reste dû — remboursez la partie payée');
      const memoRef = `RCM-${r.reference}`;
      await issueCreditMemoInTx(tx, { invoiceId: inv.id, amountKori: r.amountKori, kind: 'return_credit', reason: `Retour ${r.reference}`, createdByUserId: userId, reference: memoRef });
      const memo = await tx.creditMemo.findUnique({ where: { reference: memoRef } });
      data.creditMemoId = memo.id;
    } else if (resolution === 'refund') {
      await assertBusinessAuthorityInTx(tx, userId, sellerId, 'business.refund');
      const inv = po.invoiceId ? await tx.tradeInvoice.findUnique({ where: { id: po.invoiceId } }) : null;
      const paid = po.paymentStatus === 'paid' && !inv ? po.totalKori : (inv?.amountPaid ?? 0);
      const refunded = (await tx.commercialReturn.aggregate({ where: { purchaseOrderId: po.id, resolution: 'refund', status: 'resolved' }, _sum: { amountKori: true } }))._sum.amountKori ?? 0;
      if (paid - refunded < r.amountKori) throw new ReturnError('refund_exceeds_paid', 'Remboursement supérieur aux paiements reçus');
      const [bw, sw] = await Promise.all([ensureBusinessWallet(po.buyerBusinessId, tx), ensureBusinessWallet(sellerId, tx)]);
      const ref = `RRF-${r.reference}`;
      await transferBusinessToBusiness(tx, {
        amount: r.amountKori,
        senderWalletId: sw.id,
        senderBusinessId: sellerId,
        recipientWalletId: bw.id,
        recipientBusinessId: po.buyerBusinessId,
        reference: ref,
        actingUserId: userId,
        capability: 'business.refund',
        purpose: 'return_credit',
        actor: { type: 'user', id: userId },
        senderLedger: { type: 'b2b_refund_out', note: `Retour ${r.reference}` },
        recipientLedger: { type: 'b2b_refund_in', note: `Retour ${r.reference}` },
      });
      data.refundReference = ref;
    } else if (resolution === 'none') {
      await sellerAuth(tx, userId, sellerId);
      if (!(note && String(note).trim().length >= 5)) throw new ReturnError('reason_required', 'Explique la résolution', 400);
    } else {
      throw new ReturnError('invalid', 'Résolution inconnue', 400);
    }
    return view(await step(tx, r, 'received', 'resolved', data));
  });
}

export async function listReturns(userId, businessId, { side = 'buyer', limit = 50 } = {}) {
  await requireBusinessCapability(userId, businessId, side === 'seller' ? 'business.orders.read' : 'business.purchasing');
  const rows = await prisma.commercialReturn.findMany({ where: { [side === 'seller' ? 'sellerBusinessId' : 'buyerBusinessId']: businessId }, orderBy: { createdAt: 'desc' }, take: Math.min(Number(limit) || 50, 200) });
  return rows.map(view);
}
