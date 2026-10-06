/**
 * J7.8 / J7.9 — supplier-granted trade credit. Jokko never lends: the
 * SUPPLIER grants a term and a limit on a `TradeAccount`; Jokko only records
 * and enforces it.
 *
 *   exposure  = Σ outstanding invoices (principal − paid − credited)
 *             + Σ credit reserved by open purchase orders (not yet invoiced)
 *   available = creditLimit − exposure
 *
 * Every decision that adds or removes exposure (PO submit, legacy B2B net/COD
 * order, invoice issue / payment / credit memo, cancel, revoke, limit change)
 * runs inside a transaction holding `lockTradeExposure` for the
 * (supplier, buyer) pair: a transaction-scoped advisory lock (covers the pair
 * even with no account row yet, e.g. legacy COD) plus FOR UPDATE on the
 * account row (so revoke / limit edits — row UPDATEs — serialize with orders).
 * Two concurrent orders can therefore never both spend the same headroom.
 */
import { OUTSTANDING } from './invoices.js';

export const PO_TERMS = ['due_now', 'net7', 'net15', 'net30', 'net60', 'net90'];

export class CreditError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'CreditError';
    this.code = code;
    this.status = status;
  }
}

export async function lockTradeExposure(tx, { supplierBusinessId, buyerUserId }) {
  const key = `trade:${supplierBusinessId}:${buyerUserId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  await tx.$executeRaw`SELECT id FROM "TradeAccount" WHERE "supplierBusinessId" = ${supplierBusinessId} AND "buyerUserId" = ${buyerUserId} FOR UPDATE`;
  return tx.tradeAccount.findUnique({ where: { supplierBusinessId_buyerUserId: { supplierBusinessId, buyerUserId } } });
}

export async function creditExposure(db, { supplierBusinessId, buyerUserId, tradeAccountId }) {
  const [inv, po] = await Promise.all([
    db.tradeInvoice.aggregate({
      where: { supplierBusinessId, buyerUserId, status: { in: OUTSTANDING } },
      _sum: { amountKori: true, amountPaid: true, creditedKori: true },
    }),
    tradeAccountId
      ? db.purchaseOrder.aggregate({ where: { tradeAccountId, creditReservedKori: { gt: 0 } }, _sum: { creditReservedKori: true } })
      : { _sum: { creditReservedKori: 0 } },
  ]);
  const invoices = (inv._sum.amountKori ?? 0) - (inv._sum.amountPaid ?? 0) - (inv._sum.creditedKori ?? 0);
  const reserved = po._sum.creditReservedKori ?? 0;
  return { invoices, reserved, total: invoices + reserved };
}

/** Is this account usable for credit at all (granted, not revoked)? */
export function accountGrantsCredit(account) {
  return Boolean(account) && account.active && !account.revokedAt && account.creditLimitKori > 0;
}

/** Terms the supplier actually granted this buyer (due now is always allowed). */
export function grantedTerms(account) {
  const terms = ['due_now'];
  if (accountGrantsCredit(account) && PO_TERMS.includes(account.paymentTerm) && account.paymentTerm !== 'due_now') {
    terms.push(account.paymentTerm);
  }
  return terms;
}

/**
 * Under `lockTradeExposure`: verify `term` is granted and `amountKori` fits the
 * remaining headroom. Returns { account, available }.
 */
export async function assertCreditAvailableInTx(tx, { supplierBusinessId, buyerUserId, term, amountKori }) {
  const account = await lockTradeExposure(tx, { supplierBusinessId, buyerUserId });
  if (term === 'due_now') return { account, available: null };
  if (!PO_TERMS.includes(term)) throw new CreditError('invalid_term', 'Conditions de paiement inconnues', 400);
  if (!accountGrantsCredit(account)) throw new CreditError('no_credit', 'Aucun crédit fournisseur accordé — paiement immédiat requis');
  if (account.paymentTerm !== term) throw new CreditError('term_not_granted', `Conditions accordées : ${account.paymentTerm}`);
  const exposure = await creditExposure(tx, { supplierBusinessId, buyerUserId, tradeAccountId: account.id });
  const available = account.creditLimitKori - exposure.total;
  if (amountKori > available) throw new CreditError('credit_limit_exceeded', 'Limite de crédit fournisseur dépassée');
  return { account, available: available - amountKori };
}

export async function creditSummary(db, { supplierBusinessId, buyerUserId }) {
  const account = await db.tradeAccount.findUnique({ where: { supplierBusinessId_buyerUserId: { supplierBusinessId, buyerUserId } } });
  const exposure = await creditExposure(db, { supplierBusinessId, buyerUserId, tradeAccountId: account?.id });
  const limit = accountGrantsCredit(account) ? account.creditLimitKori : 0;
  return {
    granted: accountGrantsCredit(account),
    terms: grantedTerms(account),
    creditLimitKori: limit,
    outstandingKori: exposure.invoices,
    reservedKori: exposure.reserved,
    availableKori: Math.max(0, limit - exposure.total),
    revoked: Boolean(account?.revokedAt),
  };
}
