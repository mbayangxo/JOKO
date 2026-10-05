import crypto from 'crypto';
import { prisma } from '../prisma.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { ensureBusinessWallet, spendKoriToBusinessWallet } from '../business-wallet-service.js';
import { requireBusinessCapability } from '../business-access.js';
import { FLOW_LIMITS } from './policy.js';
import { buildChargeUrl } from '../k21-qr.js';

/**
 * J4 — merchant charges: the safe QR / payment-reference primitive.
 *
 * The QR carries ONLY an opaque, unguessable code (k21://charge/<code>).
 * Merchant, amount, label and expiry are server state: a forged QR cannot
 * change the merchant or price, a changed amount is refused, a paid charge
 * cannot be paid again (screenshot / replay), and an expired one cannot be
 * paid at all. Static merchant QRs (k21://merchant/<id>) only identify the
 * merchant; the payer types and confirms the amount.
 */
export class ChargeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ChargeError';
    this.code = code;
    this.status = status;
  }
}

const newCode = () => crypto.randomBytes(15).toString('base64url');

export function chargeShape(c, business) {
  const expired = c.status === 'open' && c.expiresAt <= new Date();
  return {
    code: c.code,
    qrUrl: buildChargeUrl(c.code),
    merchant: business ? { name: business.name, kebuId: business.kebuId ?? null } : undefined,
    amountKori: c.amountKori,
    label: c.label,
    status: expired ? 'expired' : c.status,
    expiresAt: c.expiresAt.toISOString(),
    paidAt: c.paidAt?.toISOString() ?? null,
    receiptReference: c.paymentRef ? `${c.paymentRef}-J` : null,
  };
}

/** A merchant (owner or staff with catalog rights) issues a charge. */
export async function createCharge(userId, { businessId, amountKori, label }) {
  if (!Number.isSafeInteger(amountKori) || amountKori < FLOW_LIMITS.charge.minKori || amountKori > FLOW_LIMITS.charge.maxKori) {
    throw new ChargeError('invalid_amount', 'Montant invalide');
  }
  const business = await requireBusinessCapability(userId, businessId, 'business.catalog.manage');
  const charge = await prisma.merchantCharge.create({
    data: {
      code: newCode(),
      businessId,
      createdBy: userId,
      amountKori,
      label: label ? String(label).slice(0, 80) : null,
      expiresAt: new Date(Date.now() + FLOW_LIMITS.charge.expiresAfterMinutes * 60_000),
    },
  });
  return chargeShape(charge, business);
}

/** What the payer sees after scanning: server-provided merchant + amount. */
export async function viewCharge(code) {
  const charge = await prisma.merchantCharge.findUnique({ where: { code: String(code ?? '') } });
  if (!charge) throw new ChargeError('not_found', 'Référence de paiement introuvable', 404);
  const business = await prisma.business.findUnique({ where: { id: charge.businessId }, select: { name: true, kebuId: true } });
  return chargeShape(charge, business);
}

/**
 * Pay a charge exactly once. `expectedAmountKori` is what the payer was shown
 * and confirmed: if it differs from the server amount (tampered display or a
 * changed charge), nothing is paid.
 */
export async function payCharge(payerId, code, { expectedAmountKori }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const rows = await tx.$queryRaw`SELECT id FROM "MerchantCharge" WHERE code = ${String(code ?? '')} FOR UPDATE`;
    if (!rows.length) throw new ChargeError('not_found', 'Référence de paiement introuvable', 404);
    const charge = await tx.merchantCharge.findUnique({ where: { id: rows[0].id } });
    const business = await tx.business.findUnique({ where: { id: charge.businessId } });
    if (charge.status === 'paid') {
      if (charge.paidBy === payerId) return { charge: chargeShape(charge, business), replayed: true };
      throw new ChargeError('already_paid', 'Cette référence a déjà été payée', 409);
    }
    if (charge.status !== 'open') throw new ChargeError('not_payable', 'Cette référence n’est plus payable', 409);
    if (charge.expiresAt <= new Date()) throw new ChargeError('expired', 'Cette référence a expiré — demande un nouveau QR au marchand', 410);
    if (expectedAmountKori !== charge.amountKori) {
      throw new ChargeError('amount_mismatch', 'Le montant ne correspond pas à la référence du marchand — paiement annulé', 409);
    }
    const member = business.ownerId === payerId || (await tx.businessMember.findFirst({ where: { businessId: business.id, userId: payerId, status: 'active' } }));
    if (member) throw new ChargeError('self_payment', 'Un commerce ne peut pas se payer lui-même', 400);

    const payer = await tx.user.findUniqueOrThrow({ where: { id: payerId }, include: { wallet: true } });
    const bizWallet = await ensureBusinessWallet(business.id, tx);
    const paymentRef = `charge:${charge.code}`;
    await spendKoriToBusinessWallet(tx, {
      payerWalletId: payer.wallet.id,
      payerId,
      businessWalletId: bizWallet.id,
      businessId: business.id,
      amountKori: charge.amountKori,
      reference: paymentRef,
      businessName: business.name,
      payerName: payer.name,
      note: charge.label,
      merchantUserId: business.ownerId,
      kind: 'charge_payment',
    });
    const paid = await tx.merchantCharge.update({
      where: { id: charge.id },
      data: { status: 'paid', paidBy: payerId, paidAt: new Date(), paymentRef },
    });
    return { charge: chargeShape(paid, business), replayed: false };
  });
}

export async function cancelCharge(userId, code) {
  const charge = await prisma.merchantCharge.findUnique({ where: { code: String(code ?? '') } });
  if (!charge) throw new ChargeError('not_found', 'Référence introuvable', 404);
  await requireBusinessCapability(userId, charge.businessId, 'business.catalog.manage');
  const r = await prisma.merchantCharge.updateMany({ where: { id: charge.id, status: 'open' }, data: { status: 'cancelled' } });
  if (!r.count) throw new ChargeError('not_payable', 'Référence déjà payée ou annulée', 409);
  return { code: charge.code, status: 'cancelled' };
}
