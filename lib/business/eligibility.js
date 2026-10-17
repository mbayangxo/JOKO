/**
 * J7.0 — the ONE business eligibility policy for money directed AT a business.
 *
 * A business whose `status` is not `active` (suspended | closed, set by
 * compliance / risk — `POST admin/businesses/:id/status`) must not keep
 * receiving money through any Jokko route: direct merchant pay (wallet or
 * owner-personal settlement), vouchers, QR charges / payment links, order
 * payments (consumer, marketplace, B2B), invoice payments, B2B transfers,
 * owner capital-in, Kabu mapped settlement and future channel adapters.
 *
 * The check runs INSIDE the money transaction and share-locks the Business
 * row, so a concurrent status change (row-locked UPDATE) either commits first
 * (the payment is refused) or waits until the payment commits. Money is
 * never redirected to another business or the platform: a refused payment
 * simply does not happen (a provider-pending Kabu collection is held for
 * review — lib/partner-payments-service.js).
 *
 * NOT blocked (money leaving the business, or returning to its rightful owner):
 *   refunds / reversals / returns to a business that was the BUYER,
 *   operator-authorized remediation, owner withdrawal, payroll, outgoing B2B.
 * Freezing outflows is a different control (account freeze), not suspension.
 */
export const ACCEPTANCE_PURPOSES = new Set([
  'merchant_payment', 'voucher_redemption', 'charge', 'order_payment', 'marketplace_payment',
  'b2b_payment', 'invoice_payment', 'capital_in', 'partner_settlement', 'channel_adapter',
]);
export const RESTITUTION_PURPOSES = new Set(['refund', 'reversal', 'return_credit', 'remediation']);

export class BusinessIneligibleError extends Error {
  constructor(status, purpose) {
    super('Ce commerce ne peut pas recevoir de paiement pour le moment');
    this.name = 'BusinessIneligibleError';
    this.code = 'business_inactive';
    this.status = 409;
    this.businessStatus = status;
    this.purpose = purpose;
  }
}

/** Pure rule: may this business receive money for `purpose`? */
export function businessMayReceive(business, purpose) {
  if (RESTITUTION_PURPOSES.has(purpose)) return true;
  if (!ACCEPTANCE_PURPOSES.has(purpose)) throw new Error(`Unknown business money purpose: ${purpose}`);
  return Boolean(business) && (business.status ?? 'active') === 'active';
}

/**
 * Inside a money transaction: share-lock the business and refuse acceptance
 * when it is not active. Returns the business row (id, status).
 */
export async function assertBusinessCanReceive(tx, businessId, purpose) {
  if (RESTITUTION_PURPOSES.has(purpose)) return null;
  if (!ACCEPTANCE_PURPOSES.has(purpose)) throw new Error(`Unknown business money purpose: ${purpose}`);
  await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${businessId} FOR SHARE`;
  const b = await tx.business.findUnique({ where: { id: businessId }, select: { id: true, status: true } });
  if (!businessMayReceive(b, purpose)) throw new BusinessIneligibleError(b?.status ?? 'missing', purpose);
  return b;
}

/** Outside a transaction (early UX check, never the authority). */
export async function businessAcceptanceState(db, businessId) {
  const b = await db.business.findUnique({ where: { id: businessId }, select: { status: true } });
  return { accepting: (b?.status ?? 'missing') === 'active', status: b?.status ?? 'missing' };
}
