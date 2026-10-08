import { receiveSupplierLinesInTx } from '../b2b/product-mapping.js';
import { DISTRIBUTION_MODES } from '../business/distribution.js';
import { moveDepotStockInTx } from '../b2b/depot.js';
import { applyShipmentDeliveredInTx, applyShipmentNotDeliveredInTx, applyShipmentReceivingInTx } from '../b2b/purchase-orders.js';
import { applyReturnReceivingInTx } from '../b2b/returns.js';
import { LogisticsError } from './contract.js';

/**
 * The ONLY place J8 touches commerce (J7 purchase orders / returns) and stock
 * positions. Logistics never edits an order directly; it reports physical
 * facts and the commercial module decides what they mean.
 */

/** Map a J7 PO fulfilment mode to a J8 owner (third_party = outside Jokko: no shipment). */
export async function ownerForPoMode(tx, po, mode) {
  if (mode === 'buyer_pickup') return 'CUSTOMER_PICKUP';
  if (mode === 'jokko_logistics') return 'JOKKO_LOGISTICS';
  if (mode === 'seller_delivery') {
    const seller = await tx.business.findUnique({ where: { id: po.sellerBusinessId }, select: { operatingMode: true } });
    return DISTRIBUTION_MODES.has(seller?.operatingMode) ? 'DISTRIBUTOR_FULFILLED' : 'MERCHANT_FULFILLED';
  }
  return null;
}

/** What a PO shipment carries and where it goes (contents by reference; destination snapshot for the courier). */
export async function poShipmentSource(tx, poId) {
  const po = await tx.purchaseOrder.findUnique({ where: { id: poId } });
  if (!po) throw new LogisticsError('not_found', 'Commande introuvable', 404);
  const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
  const buyer = await tx.business.findUnique({ where: { id: po.buyerBusinessId }, select: { arrondissement: true, address: true, lat: true, lng: true } });
  return {
    po,
    originBusinessId: po.sellerBusinessId,
    destinationBusinessId: po.buyerBusinessId,
    originLocationId: po.depotLocationId,
    lines: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, sku: l.sku, units: l.packs * l.unitsPerPack })),
    dest: { area: buyer?.arrondissement ?? null, precise: buyer?.address ?? null, lat: buyer?.lat ?? null, lng: buyer?.lng ?? null },
  };
}

/** A tracked J7 return: from the buyer back to the seller (contents = the return snapshot). */
export async function returnShipmentSource(tx, returnId) {
  const ret = await tx.commercialReturn.findUnique({ where: { id: returnId } });
  if (!ret) throw new LogisticsError('not_found', 'Retour introuvable', 404);
  const po = await tx.purchaseOrder.findUnique({ where: { id: ret.purchaseOrderId } });
  const seller = await tx.business.findUnique({ where: { id: ret.sellerBusinessId }, select: { arrondissement: true, address: true, lat: true, lng: true } });
  return {
    ret,
    po,
    lines: JSON.parse(ret.linesJson).filter((l) => l.productId).map((l) => ({ productId: l.productId, sku: l.sku, units: l.packs * l.unitsPerPack })),
    dest: { area: seller?.arrondissement ?? null, precise: seller?.address ?? null, lat: seller?.lat ?? null, lng: seller?.lng ?? null },
  };
}

export async function onVerifiedDelivery(tx, request, shipment, proof) {
  if (request.sourceSystem === 'jokko_po' && request.purpose === 'outbound') {
    await applyShipmentDeliveredInTx(tx, request.sourceId, { shipmentId: shipment.id, proof });
  }
}

/**
 * Receiving consequences. Stock moves ONLY here (never from a "delivered" tap):
 * received units are credited to the receiver's location, once (one receiving
 * record per shipment). Damaged / missing / refused units are recorded, not credited.
 */
export async function onReceiving(tx, request, shipment, record, lines) {
  const receiverBusinessId = record.receiverBusinessId;
  if (request.sourceSystem === 'stock_transfer') {
    const t = await tx.stockTransfer.findUnique({ where: { id: request.sourceId } });
    for (const l of lines.filter((x) => x.received > 0)) {
      await moveDepotStockInTx(tx, { locationId: t.toLocationId, productId: l.productId, deltaOnHand: l.received, reason: 'transfer_in', actorUserId: record.receiverUserId, note: `${t.reference} / ${shipment.reference}` });
    }
    await tx.stockTransfer.update({ where: { id: t.id }, data: { status: 'received', receivedAt: new Date() } });
    return;
  }
  if (request.sourceSystem === 'j7_return') {
    await applyReturnReceivingInTx(tx, request.sourceId, { receiverUserId: record.receiverUserId, lines, shipmentReference: shipment.reference });
    return;
  }
  if (request.sourceSystem === 'refusal') {
    // Refused-at-the-door units back at the original source: into the original origin depot, once.
    const orig = await tx.shipment.findUnique({ where: { id: request.sourceId } });
    const origReq = await tx.fulfilmentRequest.findUnique({ where: { id: orig.requestId } });
    if (origReq.originLocationId) {
      for (const l of lines.filter((x) => x.received > 0)) {
        await moveDepotStockInTx(tx, { locationId: origReq.originLocationId, productId: l.productId, deltaOnHand: l.received, reason: 'refusal_return', purchaseOrderId: origReq.sourceSystem === 'jokko_po' ? origReq.sourceId : null, actorUserId: record.receiverUserId, note: shipment.reference });
      }
    }
    return;
  }
  if (request.sourceSystem === 'jokko_po' && receiverBusinessId) {
    // D40: never the supplier's product id in the buyer's stock — mapped lines go to the
    // buyer's own product, unmapped lines wait in UnmatchedReceipt (no stock position).
    await receiveSupplierLinesInTx(tx, { buyerBusinessId: receiverBusinessId, sellerBusinessId: request.originBusinessId, shipmentId: shipment.id, shipmentRef: shipment.reference, lines, actorUserId: record.receiverUserId });
    const summary = record.outcome === 'full' ? 'Réception complète' : `Réception ${record.outcome} : ${lines.filter((l) => l.received !== l.expected).map((l) => `${l.sku} ${l.received}/${l.expected} (abîmé ${l.damaged}, manquant ${l.missing}, refusé ${l.refused})`).join('; ')}`;
    await applyShipmentReceivingInTx(tx, request.sourceId, { outcome: record.outcome, summary, receiverUserId: record.receiverUserId });
  }
}

/** Goods returned to the source after a failed delivery: back into the origin depot, once. */
export async function onReturnedToSource(tx, request, shipment, { actorUserId }) {
  // A PO's depot accounting belongs to J7: it re-credits (and re-reserves) its own dispatch.
  if (request.sourceSystem === 'jokko_po') return applyShipmentNotDeliveredInTx(tx, request.sourceId, { shipmentId: shipment.id, reason: 'shipment_return' });
  if (request.sourceSystem === 'stock_transfer') await tx.stockTransfer.update({ where: { id: request.sourceId }, data: { status: 'returned' } });
  if (!request.originLocationId) return;
  const pkgs = await tx.shipmentPackage.findMany({ where: { shipmentId: shipment.id } });
  for (const p of pkgs) {
    for (const l of JSON.parse(p.linesJson)) {
      if (l.units > 0) await moveDepotStockInTx(tx, { locationId: request.originLocationId, productId: l.productId, deltaOnHand: l.units, reason: 'shipment_return', actorUserId, note: shipment.reference });
    }
  }
}

/**
 * Cancelled before pickup: the goods never left. A transfer re-credits its
 * from-location (the dispatch decrement is undone, once — a cancelled shipment is
 * final). A PO goes back to J7, which undoes its own dispatch and returns the
 * order to `ready` so the seller can request fulfilment again.
 */
export async function onCancelled(tx, request, shipment, { actorUserId }) {
  if (request.sourceSystem === 'jokko_po') return applyShipmentNotDeliveredInTx(tx, request.sourceId, { shipmentId: shipment.id, reason: 'dispatch_cancel' });
  if (request.sourceSystem !== 'stock_transfer') return;
  const t = await tx.stockTransfer.findUnique({ where: { id: request.sourceId } });
  for (const l of JSON.parse(t.linesJson)) {
    await moveDepotStockInTx(tx, { locationId: t.fromLocationId, productId: l.productId, deltaOnHand: l.units, reason: 'transfer_cancel', actorUserId, note: `${t.reference} / ${shipment.reference}` });
  }
  await tx.stockTransfer.update({ where: { id: t.id }, data: { status: 'cancelled' } });
}
