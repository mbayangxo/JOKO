import {
  KORI_EARN,
  koriToNationalAfterFee,
  nationalToKori,
  countryConfig,
} from './kori.js';
import { InsufficientFundsError } from './wallet-atomic.js';
import { cashInConfirmed, cashOutHold, customerByWallet, move, reward } from './money-kernel/flows.js';
import {
  applyCirculationDecrease,
  applyCirculationIncrease,
  assertConversionsAllowed,
  ensureReserve,
} from './kori-reserve.js';


export { ensureReserve } from './kori-reserve.js';

/**
 * Provider-confirmed collection → ₭ in the user's wallet (J2: a balanced
 * `cash_in_confirmed` entry against the provider clearing account through the
 * peg bridge — never a free mint). Callers must only invoke this once the
 * provider has CONFIRMED the funds (signed webhook / status lookup / attested
 * admin action). `reference` makes it exactly-once.
 */
export async function mintKoriFromNationalDeposit(db, params) {
  const { currency } = countryConfig(params.country);
  const { kori } = await cashInConfirmed(db, {
    provider: params.provider ?? 'julaya',
    currency,
    amountMinor: params.nationalAmount,
    userId: params.userId,
    reference: `${params.reference}-KORI`,
    externalOperationId: params.externalOperationId,
    metadata: params.metadata,
  });

  if (kori > 0) {
    const existing = await db.koriTransaction.findUnique({ where: { reference: `${params.reference}-KORI` } });
    if (!existing) {
      await db.koriTransaction.create({
        data: {
          recipientId: params.userId,
          amountKori: kori,
          transactionType: 'mint',
          reference: `${params.reference}-KORI`,
          note: params.note ?? 'Kori from confirmed deposit',
        },
      });
      await applyCirculationIncrease(db, kori);
    }
  }

  return { koriMinted: kori, reserveXof: kori * 10 };
}

/**
 * Rewards are paid from the FUNDED incentive budget (`incentives:funded`).
 * No budget → no reward (returns 0). Value is never created to pay them.
 */
export async function creditKoriEarn(db, userId, walletId, earnType, reference) {
  const amount = KORI_EARN[earnType];
  if (!amount) return 0;
  const paid = await reward(db, { userId, amount, reference, rewardType: earnType });
  if (paid > 0) {
    await db.koriTransaction.create({
      data: { recipientId: userId, amountKori: paid, transactionType: 'earn', reference, note: earnType },
    });
  }
  return paid;
}

export async function sendKoriTransfer(db, params) {
  const from = await customerByWallet(db, params.senderWalletId);
  const to = await customerByWallet(db, params.recipientWalletId);
  await move(db, {
    from,
    to,
    amount: params.amountKori,
    reference: params.reference,
    kind: params.kind ?? 'p2p_transfer',
    actor: params.actor ?? { type: 'user', id: params.senderId },
    authorization: params.authorization,
  });

  await db.koriTransaction.create({
    data: {
      senderId: params.senderId,
      recipientId: params.recipientId,
      amountKori: params.amountKori,
      transactionType: 'send',
      reference: params.reference,
      note: params.note,
      attachmentUrl: params.attachmentUrl ?? null,
      attachmentType: params.attachmentType ?? null,
      giftCardTheme: params.giftCardTheme ?? null,
    },
  });

  await db.ledgerEntry.create({
    data: {
      walletId: params.senderWalletId,
      userId: params.senderId,
      type: 'send',
      amount: -params.amountKori,
      counterpartyName: params.recipientName ?? null,
      counterpartyHandle: params.recipientHandle ?? null,
      note: params.note ?? null,
      attachmentUrl: params.attachmentUrl ?? null,
      attachmentType: params.attachmentType ?? null,
      giftCardTheme: params.giftCardTheme ?? null,
      reference: params.reference,
    },
  });
  await db.ledgerEntry.create({
    data: {
      walletId: params.recipientWalletId,
      userId: params.recipientId,
      type: 'receive',
      amount: params.amountKori,
      counterpartyName: params.senderName ?? null,
      counterpartyHandle: params.senderHandle ?? null,
      note: params.note ?? null,
      attachmentUrl: params.attachmentUrl ?? null,
      attachmentType: params.attachmentType ?? null,
      giftCardTheme: params.giftCardTheme ?? null,
      reference: `${params.reference}-R`,
    },
  });
}

/**
 * Burns ₭ "into national currency" — but no national balance or payout rail
 * receives the proceeds, so the user's value was destroyed while the API
 * reported a successful conversion (J0 audit, Phase 6). Refused until J2
 * defines where converted value goes; cash-out (rail-service) is the real exit.
 */
export class ConversionUnavailableError extends Error {
  constructor() {
    super('La conversion n’est pas disponible — utilise un retrait Mobile Money ou agent.');
    this.code = 'conversion_unavailable';
    this.status = 410;
  }
}

export async function convertKoriToNational() {
  throw new ConversionUnavailableError();
}

/**
 * Cash-out authorization (J2): ₭ move from the user's spendable balance into
 * their HELD account (not spendable, still theirs). The ₭ is retired only when
 * the provider confirms the payout (`cashOutConfirmed`); a failure releases it
 * once (`cashOutRelease`). Name kept for call-site compatibility.
 */
export async function burnKoriForCashOut(db, params) {
  await assertConversionsAllowed(db);

  const { grossNational } = koriToNationalAfterFee(params.koriAmount, params.country);
  const avail = await customerByWallet(db, params.walletId);
  await cashOutHold(db, {
    userId: params.userId,
    from: avail,
    amountKori: params.koriAmount,
    reference: `${params.reference}-HOLD`,
    actor: params.actor ?? { type: 'user', id: params.userId },
    authorization: params.authorization,
    externalOperationId: params.externalOperationId,
  });

  await db.koriTransaction.create({
    data: {
      senderId: params.userId,
      amountKori: params.koriAmount,
      transactionType: 'cash_out',
      reference: params.reference,
      note: params.note ?? `Cash-out ${grossNational} XOF`,
    },
  });

  await applyCirculationDecrease(db, params.koriAmount);

  const ledger = await db.ledgerEntry.create({
    data: {
      walletId: params.walletId,
      userId: params.userId,
      type: 'cash_out',
      amount: -params.koriAmount,
      note: params.note ?? `Retrait · ${grossNational.toLocaleString('fr-FR')} F`,
      reference: params.reference,
    },
  });

  return { koriBurned: params.koriAmount, grossNational, ledger };
}

export async function spendKoriAtMerchant(db, params) {
  // J7.0: owner-personal settlement of a business payment obeys the same eligibility policy.
  if (params.businessId) {
    const { assertBusinessCanReceive } = await import('./business/eligibility.js');
    await assertBusinessCanReceive(db, params.businessId, params.purpose ?? 'merchant_payment');
  }
  const from = await customerByWallet(db, params.payerWalletId);
  const to = await customerByWallet(db, params.merchantWalletId);
  await move(db, {
    from,
    to,
    amount: params.amountKori,
    reference: params.reference,
    kind: params.kind ?? 'merchant_payment',
    actor: params.actor ?? { type: 'user', id: params.payerId },
    authorization: params.authorization,
  });

  await db.koriTransaction.create({
    data: {
      senderId: params.payerId,
      recipientId: params.merchantUserId,
      amountKori: params.amountKori,
      transactionType: 'spend',
      reference: params.reference,
      note: params.merchantName,
    },
  });

  await db.ledgerEntry.create({
    data: {
      walletId: params.payerWalletId,
      userId: params.payerId,
      type: 'pay_merchant',
      amount: -params.amountKori,
      counterpartyName: params.merchantName ?? null,
      note: params.merchantName ?? null,
      reference: params.reference,
    },
  });
  await db.ledgerEntry.create({
    data: {
      walletId: params.merchantWalletId,
      userId: params.merchantUserId,
      type: 'marketplace_sale',
      amount: params.amountKori,
      counterpartyName: params.payerName ?? null,
      note: params.merchantName ?? null,
      reference: `${params.reference}-M`,
    },
  });
}
