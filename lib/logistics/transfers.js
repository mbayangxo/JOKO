import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx } from '../business-access.js';
import { moveDepotStockInTx } from '../b2b/depot.js';
import { DISTRIBUTION_MODES } from '../business/distribution.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { LogisticsError } from './contract.js';
import { createRequestInTx } from './intake.js';

/**
 * J8.17 — inventory transfer between two locations of the SAME business.
 *
 *   dispatch   from-location −units (reason transfer_out), one shipment created (own fleet)
 *   in transit the units are in nobody's position: they are in the shipment (custody = courier)
 *   receive    per-line receiving record at the destination → +received (transfer_in), once
 *   return     a failed transfer returns to the from-location (shipment_return), once
 * Damaged / missing units are recorded on the receiving record, never silently re-credited.
 */
const notFound = () => new LogisticsError('not_found', 'Transfert introuvable', 404);

export async function createTransfer(userId, businessId, { fromLocationId, toLocationId, lines, note }) {
  if (fromLocationId === toLocationId) throw new LogisticsError('invalid', 'Origine et destination identiques', 400);
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw new LogisticsError('invalid', '1 à 100 lignes', 400);
  const seen = new Set();
  for (const l of lines) {
    if (typeof l?.productId !== 'string' || !Number.isSafeInteger(l.units) || l.units <= 0 || l.units > 1_000_000 || seen.has(l.productId)) throw new LogisticsError('invalid', 'Ligne invalide', 400);
    seen.add(l.productId);
  }
  return runMoneyTransaction(prisma, async (tx) => {
    await assertBusinessAuthorityInTx(tx, userId, businessId, 'business.inventory.adjust').catch((e) => {
      if (e instanceof OrgAccessError) throw notFound();
      throw e;
    });
    const locs = await tx.inventoryLocation.findMany({ where: { id: { in: [fromLocationId, toLocationId] }, operatorBusinessId: businessId, status: 'active' } });
    if (locs.length !== 2) throw new LogisticsError('location_not_found', 'Emplacement introuvable', 404);
    const products = await tx.product.findMany({ where: { id: { in: [...seen] } }, select: { id: true, title: true } });
    if (products.length !== seen.size) throw new LogisticsError('product_not_found', 'Produit introuvable', 404);
    const reference = `TR-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const pkgLines = lines.map((l) => ({ productId: l.productId, sku: products.find((p) => p.id === l.productId).title.slice(0, 40), units: l.units }));
    const t = await tx.stockTransfer.create({ data: { reference, businessId, fromLocationId, toLocationId, linesJson: JSON.stringify(pkgLines), status: 'dispatched', createdBy: userId, dispatchedAt: new Date() } });
    for (const l of pkgLines) {
      await moveDepotStockInTx(tx, { locationId: fromLocationId, productId: l.productId, deltaOnHand: -l.units, reason: 'transfer_out', actorUserId: userId, note: reference });
    }
    const biz = await tx.business.findUnique({ where: { id: businessId }, select: { operatingMode: true } });
    const to = locs.find((x) => x.id === toLocationId);
    const { shipment } = await createRequestInTx(tx, {
      sourceSystem: 'stock_transfer', sourceId: t.id, fulfilmentOwner: DISTRIBUTION_MODES.has(biz?.operatingMode) ? 'DISTRIBUTOR_FULFILLED' : 'MERCHANT_FULFILLED',
      fulfillerBusinessId: businessId, originBusinessId: businessId, originLocationId: fromLocationId, destinationBusinessId: businessId,
      lines: pkgLines, dest: { area: to.name ?? null }, createdBy: userId,
    });
    return { transfer: transferView(t), shipmentId: shipment.id, note: note ?? null };
  });
}

export async function listTransfers(userId, businessId, { status } = {}) {
  await assertBusinessAuthorityInTx(prisma, userId, businessId, 'business.orders.read').catch(() => { throw notFound(); });
  const rows = await prisma.stockTransfer.findMany({ where: { businessId, ...(status ? { status: String(status) } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
  return rows.map(transferView);
}

export const transferView = (t) => ({ id: t.id, reference: t.reference, fromLocationId: t.fromLocationId, toLocationId: t.toLocationId, status: t.status, lines: JSON.parse(t.linesJson), dispatchedAt: t.dispatchedAt?.toISOString() ?? null, receivedAt: t.receivedAt?.toISOString() ?? null });
