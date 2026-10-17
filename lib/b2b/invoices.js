import { reference as makeRef } from '../../api/_lib/auth.js';
import { computeDueDate } from '../trade-service.js';

/**
 * J7.10 — invoices & receivables.
 *
 * An invoice is a real commercial obligation (a delivered purchase order on
 * terms, or a legacy B2B order). Its principal (`amountKori`) and parties are
 * immutable (DB trigger); it is never deleted. Money applied to it is a
 * `TradeInvoicePayment` row (unique ledger reference); a correction is a
 * `CreditMemo` row. `amountPaid` / `creditedKori` are the locked running sums
 * of those rows (reconciled in the tests):
 *
 *   outstanding = principal − Σ payments − Σ credit memos   (never < 0, DB check)
 */
export class InvoiceError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'InvoiceError';
    this.code = code;
    this.status = status;
  }
}

export const OUTSTANDING = ['open', 'partial', 'overdue', 'disputed'];
export const outstandingOf = (inv) => inv.amountKori - inv.amountPaid - (inv.creditedKori ?? 0);

export function statusAfter(inv) {
  const out = outstandingOf(inv);
  if (out <= 0) return 'paid';
  if (inv.status === 'disputed') return 'disputed';
  if (inv.amountPaid > 0 || (inv.creditedKori ?? 0) > 0) return 'partial';
  return inv.dueAt < new Date() ? 'overdue' : 'open';
}

async function lockInvoice(tx, invoiceId) {
  await tx.$executeRaw`SELECT id FROM "TradeInvoice" WHERE id = ${invoiceId} FOR UPDATE`;
  const inv = await tx.tradeInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new InvoiceError('not_found', 'Facture introuvable', 404);
  return inv;
}

/** Issue a credit memo inside a transaction (caller authorizes). Returns the updated invoice. */
export async function issueCreditMemoInTx(tx, { invoiceId, amountKori, kind, reason, createdByUserId, reference }) {
  if (!Number.isSafeInteger(amountKori) || amountKori <= 0) throw new InvoiceError('invalid_amount', 'Montant invalide', 400);
  const ref = reference ?? makeRef('CRM');
  const existing = await tx.creditMemo.findUnique({ where: { reference: ref } });
  if (existing) return tx.tradeInvoice.findUnique({ where: { id: existing.invoiceId } }); // replay
  const inv = await lockInvoice(tx, invoiceId);
  if (amountKori > outstandingOf(inv)) throw new InvoiceError('credit_exceeds_outstanding', 'Avoir supérieur au reste dû', 409);
  await tx.creditMemo.create({ data: { invoiceId, reference: ref, amountKori, kind, reason: String(reason).slice(0, 300), createdByUserId } });
  const credited = (inv.creditedKori ?? 0) + amountKori;
  const next = { ...inv, creditedKori: credited };
  return tx.tradeInvoice.update({ where: { id: invoiceId }, data: { creditedKori: credited, status: statusAfter(next), paidAt: statusAfter(next) === 'paid' ? inv.paidAt ?? new Date() : inv.paidAt } });
}

/** Invoice a delivered purchase order on terms (idempotent per PO). */
export async function invoicePurchaseOrderInTx(tx, po, { buyerOwnerUserId }) {
  const existing = await tx.tradeInvoice.findUnique({ where: { purchaseOrderId: po.id } });
  if (existing) return existing;
  const from = po.deliveredAt ?? new Date();
  return tx.tradeInvoice.create({
    data: {
      supplierBusinessId: po.sellerBusinessId,
      buyerUserId: buyerOwnerUserId,
      buyerBusinessId: po.buyerBusinessId,
      tradeAccountId: po.tradeAccountId,
      purchaseOrderId: po.id,
      reference: `INV-${po.reference}`,
      amountKori: po.totalKori,
      amountPaid: 0,
      status: 'open',
      dueAt: computeDueDate(po.paymentTerm === 'due_now' ? 'immediate' : po.paymentTerm, from),
      notes: `Bon de commande ${po.reference}`,
    },
  });
}

/**
 * Apply a payment that has ALREADY been posted on the ledger in this
 * transaction (reference = its J2 reference). Partial payments allowed.
 */
export async function applyInvoicePaymentInTx(tx, { invoiceId, amountKori, ledgerReference, paidByUserId, paymentSource }) {
  const dup = await tx.tradeInvoicePayment.findUnique({ where: { ledgerReference } });
  if (dup) return tx.tradeInvoice.findUnique({ where: { id: dup.invoiceId } });
  const inv = await lockInvoice(tx, invoiceId);
  if (amountKori <= 0 || amountKori > outstandingOf(inv)) throw new InvoiceError('overpayment', 'Montant supérieur au reste dû', 409);
  await tx.tradeInvoicePayment.create({ data: { invoiceId, amountKori, ledgerReference, paidByUserId, paymentSource } });
  const next = { ...inv, amountPaid: inv.amountPaid + amountKori };
  const status = statusAfter(next);
  return tx.tradeInvoice.update({ where: { id: invoiceId }, data: { amountPaid: next.amountPaid, status, paidAt: status === 'paid' ? new Date() : inv.paidAt } });
}

export function invoiceView(inv, { memos = [], payments = [] } = {}) {
  return {
    id: inv.id,
    reference: inv.reference,
    sellerBusinessId: inv.supplierBusinessId,
    buyerBusinessId: inv.buyerBusinessId,
    purchaseOrderId: inv.purchaseOrderId,
    principalKori: inv.amountKori,
    paidKori: inv.amountPaid,
    creditedKori: inv.creditedKori ?? 0,
    outstandingKori: outstandingOf(inv),
    status: inv.status,
    dueAt: inv.dueAt.toISOString(),
    pastDue: OUTSTANDING.includes(inv.status) && outstandingOf(inv) > 0 && inv.dueAt < new Date(),
    payments: payments.map((p) => ({ amountKori: p.amountKori, reference: p.ledgerReference, at: p.createdAt.toISOString() })),
    creditMemos: memos.map((m) => ({ reference: m.reference, amountKori: m.amountKori, kind: m.kind, reason: m.reason, at: m.createdAt.toISOString() })),
  };
}
