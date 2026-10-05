import { prisma } from '../prisma.js';
import { post } from '../money-kernel/ledger.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { assertBusinessAuthorityInTx } from '../business-access.js';

/**
 * J4 — refund primitive for a RECEIVED customer payment (merchant pay,
 * merchant charge). A J2 compensating transaction:
 *  - a NEW entry (kind 'merchant_refund') debits the payee's own account and
 *    credits the original payer; the original entry is never edited/deleted;
 *  - linked by metadata.originalReference (history shows "refunded" /
 *    "partially refunded" on the original and "Remboursement de …" on the refund);
 *  - cumulative refunds can never exceed the original amount (serialized
 *    per original reference).
 * The payee can only give back its own money; it can never pull money from
 * the customer (that is the sender's 60 s undo, or support).
 *
 * NOT a commerce return/cancellation workflow (orders, stock, disputes) —
 * that product area is still PARTIAL and is not pretended here.
 */
export class RefundError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RefundError';
    this.code = code;
    this.status = status;
  }
}

const REFUNDABLE = new Set(['pay_merchant', 'merchant_payment', 'charge_payment', 'business_payment']);

export async function refundReceivedPayment(actorUserId, originalReference, { amountKori, reason }) {
  if (!Number.isSafeInteger(amountKori) || amountKori <= 0) throw new RefundError('invalid_amount', 'Montant invalide');
  if (!reason || String(reason).trim().length < 3) throw new RefundError('reason_required', 'Motif requis');
  return runMoneyTransaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`refund:${originalReference}`}, 0))`;
    const original = await tx.journalEntry.findUnique({
      where: { reference: String(originalReference) },
      include: { postings: { include: { account: true } } },
    });
    if (!original || !REFUNDABLE.has(original.kind)) throw new RefundError('not_refundable', 'Paiement introuvable ou non remboursable', 404);
    const payerLine = original.postings.find((p) => p.side === 'debit' && p.account.type === 'customer_available');
    const payeeLine = original.postings.find((p) => p.side === 'credit' && ['customer_available', 'business_wallet'].includes(p.account.type));
    if (!payerLine || !payeeLine) throw new RefundError('not_refundable', 'Paiement non remboursable', 404);

    // Only the payee (or a treasury member of the payee business) may refund.
    if (payeeLine.account.type === 'customer_available') {
      if (payeeLine.account.ownerId !== actorUserId) throw new RefundError('not_payee', 'Seul le bénéficiaire peut rembourser ce paiement', 403);
    } else {
      await assertBusinessAuthorityInTx(tx, actorUserId, payeeLine.account.ownerId, 'business.treasury').catch(() => {
        throw new RefundError('not_payee', 'Seul le commerce bénéficiaire peut rembourser ce paiement', 403);
      });
    }
    if (payerLine.account.ownerId === actorUserId) throw new RefundError('not_payee', 'Remboursement impossible', 403);

    const prior = await tx.journalEntry.findMany({
      where: { kind: 'merchant_refund', metadata: { path: ['originalReference'], equals: original.reference } },
      include: { postings: true },
    });
    const refunded = prior.reduce((s, e) => s + e.postings.filter((p) => p.side === 'debit').reduce((a, p) => a + Number(p.amount), 0), 0);
    const originalAmount = Number(payerLine.amount);
    if (refunded + amountKori > originalAmount) {
      throw new RefundError('exceeds_original', `Remboursement au-delà du paiement initial (reste ${originalAmount - refunded} ₭)`, 409);
    }

    const { entry } = await post(tx, {
      reference: `refund:${original.reference}:${prior.length + 1}`,
      kind: 'merchant_refund',
      actor: { type: 'user', id: actorUserId },
      authorization: 'payee_refund_of_received_payment',
      reason: String(reason).slice(0, 300),
      metadata: { originalReference: original.reference },
      lines: [
        { account: payeeLine.account, side: 'debit', amount: amountKori },
        { account: payerLine.account, side: 'credit', amount: amountKori },
      ],
    });
    return {
      reference: entry.reference,
      originalReference: original.reference,
      amountKori,
      refundedTotalKori: refunded + amountKori,
      remainingRefundableKori: originalAmount - refunded - amountKori,
    };
  });
}
