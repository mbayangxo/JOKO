import { prisma } from '../prisma.js';
import { MoneyAdminError, approveAdjustment, requestAdjustment } from '../money-kernel/admin.js';
import { ensureBusinessWallet } from '../business-wallet-service.js';
import { recordPayment } from '../commerce/acceptance.js';

/**
 * J6.0: a partner collection held for review (mapping revoked / changed or
 * merchant inactive at confirmation) sits in `partner:<id>:unallocated`.
 * There is no "move it somewhere" button. The only release is a
 * maker/checker adjustment to the business the payment was BOUND TO AT
 * CREATION, and only while that mapping is active again and the business is
 * active. Anything else (e.g. a refund to the payer through the provider)
 * stays a reconciliation exception handled by finance.
 */
const releaseKey = (paymentId) => `constrained:partner-release:${paymentId}`;

async function heldPayment(db, paymentId) {
  const row = await db.partnerPayment.findUnique({ where: { id: String(paymentId) } });
  if (!row) throw new MoneyAdminError('not_found', 'Payment not found', 404);
  if (row.settlementTarget !== 'held_for_review' || row.status !== 'completed') throw new MoneyAdminError('not_held', 'Payment is not held for review', 409);
  if (!row.settlementBusinessId || !row.externalLinkId) throw new MoneyAdminError('no_bound_merchant', 'Payment has no bound merchant — resolve through finance adjustments', 409);
  return row;
}

async function assertReleasable(db, row) {
  const link = await db.externalLink.findUnique({ where: { id: row.externalLinkId } });
  if (!link || link.status !== 'active' || link.businessId !== row.settlementBusinessId || link.externalId !== row.externalBusinessId) {
    throw new MoneyAdminError('mapping_not_active', 'The merchant mapping is not active for the bound business', 409);
  }
  const b = await db.business.findUnique({ where: { id: row.settlementBusinessId }, select: { status: true } });
  if (!b || b.status !== 'active') throw new MoneyAdminError('merchant_inactive', 'The bound merchant is not active', 409);
}

export async function requestHeldPartnerRelease(adminId, paymentId, { reason }) {
  const row = await heldPayment(prisma, paymentId);
  await assertReleasable(prisma, row);
  const op = await prisma.externalOperation.findUnique({ where: { reference: `partner_${row.id}` } });
  if (!op) throw new MoneyAdminError('not_found', 'No collection operation', 404);
  await ensureBusinessWallet(row.settlementBusinessId, prisma);
  await prisma.$transaction(async (tx) => {
    const { business } = await import('../money-kernel/flows.js');
    await business(tx, row.settlementBusinessId); // open the ledger account
  });
  return requestAdjustment(prisma, adminId, {
    idempotencyKey: releaseKey(row.id),
    debitAccount: `partner:${row.partnerId}:unallocated`,
    creditAccount: `business:${row.settlementBusinessId}:wallet`,
    amount: Number(op.amountKori),
    reason,
    originalReference: `partner_${row.id}`,
  });
}

export async function approveHeldPartnerRelease(adminId, paymentId) {
  const row = await heldPayment(prisma, paymentId);
  const req = await prisma.moneyAdjustmentRequest.findUnique({ where: { idempotencyKey: releaseKey(row.id) } });
  if (!req) throw new MoneyAdminError('not_found', 'No release request', 404);
  return approveAdjustment(prisma, adminId, req.id, {
    afterPost: async (tx, posted) => {
      await tx.$executeRaw`SELECT id FROM "PartnerPayment" WHERE id = ${row.id} FOR UPDATE`;
      const fresh = await tx.partnerPayment.findUnique({ where: { id: row.id } });
      if (fresh.settlementTarget !== 'held_for_review') throw new MoneyAdminError('not_held', 'Payment is no longer held', 409);
      // Re-check under lock: the mapping / merchant may have changed since the request.
      await tx.$executeRaw`SELECT id FROM "ExternalLink" WHERE id = ${row.externalLinkId} FOR UPDATE`;
      await assertReleasable(tx, fresh);
      const ref = `adjustment:${posted.id}`;
      const bw = await tx.businessWallet.findUnique({ where: { businessId: row.settlementBusinessId } });
      const amount = Number(posted.amount);
      await tx.businessLedgerEntry.create({
        data: { businessWalletId: bw.id, businessId: row.settlementBusinessId, type: 'partner_collect', amount, note: `Paiement ${row.partnerId} · ${row.reference} (libéré après revue)`.slice(0, 200), reference: `partner_${row.id}` },
      });
      await recordPayment(tx, { businessId: row.settlementBusinessId, method: 'partner_checkout', sourceChannel: 'partner_online', sourceSystem: row.partnerId, amountKori: amount, ledgerReference: ref, externalRef: row.reference, note: 'released after review' });
      await tx.partnerPayment.update({ where: { id: row.id }, data: { settlementTarget: 'business_wallet', settlementReference: ref } });
      await tx.reconciliationException.updateMany({
        where: { kind: 'partner_settlement_held', providerReference: `partner_${row.id}`, status: 'open' },
        data: { status: 'resolved', resolvedAt: new Date(), resolvedBy: adminId },
      });
    },
  });
}

/** J6.0: compliance suspends / reactivates / closes a business (audited, reasoned). */
export async function setBusinessStatus(adminId, businessId, { status, reason }) {
  if (!['active', 'suspended', 'closed'].includes(status)) throw new MoneyAdminError('invalid_status', 'status must be active | suspended | closed');
  if (!reason || String(reason).trim().length < 10) throw new MoneyAdminError('reason_required', 'A reason (≥ 10 characters) is required');
  const { recordIdentityEvent } = await import('../identity/audit.js');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${businessId} FOR UPDATE`;
    const b = await tx.business.findUnique({ where: { id: businessId }, select: { id: true, status: true } });
    if (!b) throw new MoneyAdminError('not_found', 'Business not found', 404);
    if (b.status === 'closed' && status !== 'closed') throw new MoneyAdminError('closed_final', 'A closed business cannot be reopened', 409);
    if (b.status === status) return { id: b.id, status, changed: false };
    await tx.business.update({ where: { id: businessId }, data: { status, statusReason: String(reason).slice(0, 300), statusChangedAt: new Date(), statusChangedBy: adminId } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'business_status_changed', subjectType: 'business', subjectId: businessId, reason: String(reason).slice(0, 300), before: { status: b.status }, after: { status } });
    return { id: b.id, status, changed: true };
  });
}
