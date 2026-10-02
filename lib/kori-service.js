import {
  KORI_EARN,
  koriToNationalAfterFee,
  nationalToKori,
  countryConfig,
} from './kori.js';
import { InsufficientFundsError, lockWallets } from './wallet-atomic.js';
import {
  applyCirculationDecrease,
  applyCirculationIncrease,
  assertConversionsAllowed,
  ensureReserve,
} from './kori-reserve.js';

import { unfundedIncentivesAllowed } from './runtime-safety.js';

export { ensureReserve } from './kori-reserve.js';

export async function mintKoriFromNationalDeposit(db, params) {
  const koriMinted = nationalToKori(params.nationalAmount, params.country);

  await lockWallets(db, [params.walletId]);
  await db.wallet.update({
    where: { id: params.walletId },
    data: {
      koriBalance: { increment: koriMinted },
    },
  });

  if (koriMinted > 0) {
    await db.koriTransaction.create({
      data: {
        recipientId: params.userId,
        amountKori: koriMinted,
        transactionType: 'mint',
        reference: `${params.reference}-KORI`,
        note: params.note ?? 'Kori minted from national deposit',
      },
    });
    await applyCirculationIncrease(db, koriMinted);
  }

  return { koriMinted, reserveXof: koriMinted * 10 };
}

/**
 * Platform "earn" rewards mint ₭ with no funding source (value from nothing),
 * and P2P/merchant rewards are farmable with 1 ₭ round trips. Until J2 adds a
 * funded incentive pool they are disabled in production (see runtime-safety).
 * Returns the amount credited (0 when disabled).
 */
export async function creditKoriEarn(db, userId, walletId, earnType, reference) {
  if (!unfundedIncentivesAllowed()) return 0;
  const amount = KORI_EARN[earnType];
  if (!amount) return 0;

  await lockWallets(db, [walletId]);
  await db.wallet.update({
    where: { id: walletId },
    data: { koriBalance: { increment: amount } },
  });

  await db.koriTransaction.create({
    data: {
      recipientId: userId,
      amountKori: amount,
      transactionType: 'earn',
      reference,
      note: earnType,
    },
  });

  await applyCirculationIncrease(db, amount);
  return amount;
}

export async function sendKoriTransfer(db, params) {
  await lockWallets(db, [params.senderWalletId, params.recipientWalletId]);

  const sender = await db.wallet.findUnique({ where: { id: params.senderWalletId } });
  if (!sender || sender.koriBalance < params.amountKori) {
    throw new InsufficientFundsError('Insufficient Kori balance');
  }

  await db.wallet.update({
    where: { id: params.senderWalletId },
    data: { koriBalance: { decrement: params.amountKori } },
  });
  await db.wallet.update({
    where: { id: params.recipientWalletId },
    data: { koriBalance: { increment: params.amountKori } },
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

/** Burn ₭ for cash-out rail — national currency leaves via licensed partner. */
export async function burnKoriForCashOut(db, params) {
  await assertConversionsAllowed(db);

  const { grossNational } = koriToNationalAfterFee(params.koriAmount, params.country);

  await lockWallets(db, [params.walletId]);

  const wallet = await db.wallet.findUnique({ where: { id: params.walletId } });
  if (!wallet || wallet.koriBalance < params.koriAmount) {
    throw new InsufficientFundsError('Insufficient Kori balance');
  }

  await db.wallet.update({
    where: { id: params.walletId },
    data: { koriBalance: { decrement: params.koriAmount } },
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
  await lockWallets(db, [params.payerWalletId, params.merchantWalletId]);

  const payer = await db.wallet.findUnique({ where: { id: params.payerWalletId } });
  if (!payer || payer.koriBalance < params.amountKori) {
    throw new InsufficientFundsError('Insufficient Kori balance');
  }

  await db.wallet.update({
    where: { id: params.payerWalletId },
    data: { koriBalance: { decrement: params.amountKori } },
  });
  await db.wallet.update({
    where: { id: params.merchantWalletId },
    data: { koriBalance: { increment: params.amountKori } },
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
