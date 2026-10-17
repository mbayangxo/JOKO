import { prisma } from '../prisma.js';
import { requireBusinessCapability } from '../business-access.js';
import { assertCanPost } from '../mbolo-access.js';
import { postCommerceCard } from '../mbolo-receipt-service.js';
import { businessAcceptanceState } from '../business/eligibility.js';

/**
 * J7.19 — Mbolo conversational commerce: the seller's charge card.
 *
 * A seller (staff with business.charges.create, active member of the thread)
 * shares an OPEN charge (J4 `money/charges`) into a conversation. The card
 * payload carries only the opaque charge code and the card type; the buyer's
 * app resolves amount, label and merchant from the server
 * (`GET money/charges/:code`) and pays with `expectedAmountKori` (J4). Text in
 * the conversation — including this card's caption — is never financial
 * authority: changing it changes nothing about what is owed or paid.
 *
 * Users still cannot post `commerce` / `payment` kinds through the message
 * API; this is the only seller-initiated card, and it is server-built.
 */
export class ChargeCardError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ChargeCardError';
    this.code = code;
    this.status = status;
  }
}

export async function postChargeCard(userId, threadId, { code }) {
  const charge = await prisma.merchantCharge.findUnique({ where: { code: String(code ?? '') } });
  if (!charge) throw new ChargeCardError('not_found', 'Référence de paiement introuvable', 404);
  // Only someone who may issue charges for that business can share its charge.
  await requireBusinessCapability(userId, charge.businessId, 'business.charges.create').catch(() => {
    throw new ChargeCardError('not_found', 'Référence de paiement introuvable', 404);
  });
  if (charge.status !== 'open' || charge.expiresAt <= new Date()) throw new ChargeCardError('charge_not_open', 'Ce paiement n’est plus ouvert');
  if (!(await businessAcceptanceState(prisma, charge.businessId)).accepting) throw new ChargeCardError('business_inactive', 'Ce commerce ne peut pas recevoir de paiement pour le moment');
  await assertCanPost(prisma, threadId, userId, { kind: 'commerce' });
  const business = await prisma.business.findUnique({ where: { id: charge.businessId }, select: { name: true } });
  const msg = await postCommerceCard(prisma, {
    threadId: String(threadId),
    senderId: userId,
    body: `${business.name} · demande de paiement`,
    payload: { type: 'charge_card', code: charge.code, version: '2026-10-j7' },
  });
  return { messageId: msg.id, code: charge.code };
}
