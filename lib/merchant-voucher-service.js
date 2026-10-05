import { formatKori } from './kori.js';
import { InsufficientFundsError, lockProjections, runMoneyTransaction } from './wallet-atomic.js';
import { account as ledgerAccount, customerByWallet, move } from './money-kernel/flows.js';

export const PURPOSE_LABELS = {
  general: 'Usage libre',
  food: 'Nourriture',
  grocery: 'Courses',
  school: 'École',
  transport: 'Transport',
  rent: 'Loyer',
  health: 'Santé',
  other: 'Autre',
};

export function merchantVoucherShape(row) {
  return {
    id: row.id,
    businessId: row.businessId,
    balanceKori: row.balanceKori,
    balanceFormatted: formatKori(row.balanceKori),
    business: row.business
      ? {
          id: row.business.id,
          name: row.business.name,
          category: row.business.category,
          arrondissement: row.business.arrondissement,
        }
      : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listMerchantVouchers(db, userId) {
  const rows = await db.merchantVoucher.findMany({
    where: { userId, balanceKori: { gt: 0 } },
    include: { business: { select: { id: true, name: true, category: true, arrondissement: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(merchantVoucherShape);
}

export async function getMerchantVoucherBalance(db, userId, businessId) {
  const row = await db.merchantVoucher.findUnique({
    where: { userId_businessId: { userId, businessId } },
  });
  return row?.balanceKori ?? 0;
}

export async function creditMerchantVoucher(
  db,
  { userId, businessId, amountKori, reference, counterpartyName, purposeNote, fromWalletId, fromUserId },
) {
  if (amountKori <= 0) throw new Error('Invalid voucher amount');
  if (!fromWalletId || !fromUserId) throw new Error('A voucher is funded from a payer wallet (fromWalletId)');

  const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true, name: true } });
  if (!business) throw new Error('Marchand introuvable');

  const existing = await db.merchantVoucher.findUnique({
    where: { userId_businessId: { userId, businessId } },
  });
  if (existing) {
    await lockProjections(db, { MerchantVoucher: [existing.id] });
  }

  const row = await db.merchantVoucher.upsert({
    where: { userId_businessId: { userId, businessId } },
    create: { userId, businessId, balanceKori: 0 },
    update: {},
  });
  // J2: payer wallet → voucher account, one balanced entry.
  await move(db, {
    from: await customerByWallet(db, fromWalletId),
    to: await ledgerAccount(db, 'voucher', row.id),
    amount: amountKori,
    reference: `${reference}-J`,
    kind: 'voucher_fund',
    actor: { type: 'user', id: fromUserId },
  });
  const voucher = await db.merchantVoucher.findUniqueOrThrow({
    where: { id: row.id },
    include: { business: { select: { id: true, name: true, category: true, arrondissement: true } } },
  });

  const wallet = await db.wallet.findUnique({ where: { userId } });
  if (wallet) {
    const prior = await db.ledgerEntry.findUnique({ where: { reference } });
    if (!prior) {
      await db.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          userId,
          type: 'voucher_receive',
          amount: amountKori,
          counterpartyName: counterpartyName ?? business.name,
          note: purposeNote ?? `Bon verrouillé · ${business.name}`,
          reference,
        },
      });
    }
  }

  return merchantVoucherShape(voucher);
}

export async function spendMerchantVoucher(db, params) {
  const {
    userId,
    businessId,
    amountKori,
    merchantUserId,
    merchantWalletId,
    merchantName,
    payerName,
    reference,
  } = params;

  return runMoneyTransaction(db, async (tx) => {
    const voucher = await tx.merchantVoucher.findUnique({
      where: { userId_businessId: { userId, businessId } },
    });
    if (!voucher) throw new InsufficientFundsError('Bon marchand insuffisant');

    await lockProjections(tx, { MerchantVoucher: [voucher.id] });
    const lockedVoucher = await tx.merchantVoucher.findUniqueOrThrow({ where: { id: voucher.id } });
    if (lockedVoucher.balanceKori < amountKori) {
      throw new InsufficientFundsError('Bon marchand insuffisant');
    }

    await move(tx, {
      from: await ledgerAccount(tx, 'voucher', voucher.id),
      to: await customerByWallet(tx, merchantWalletId),
      amount: amountKori,
      reference: `${reference}-J`,
      kind: 'voucher_spend',
      actor: { type: 'user', id: userId },
      authorization: 'voucher_holder_payment',
    });

    await tx.koriTransaction.create({
      data: {
        senderId: userId,
        recipientId: merchantUserId,
        amountKori,
        transactionType: 'voucher_spend',
        reference,
        note: merchantName,
      },
    });

    const payerWallet = await tx.wallet.findUnique({ where: { userId } });
    if (payerWallet) {
      await tx.ledgerEntry.create({
        data: {
          walletId: payerWallet.id,
          userId,
          type: 'voucher_spend',
          amount: -amountKori,
          counterpartyName: merchantName,
          note: `Bon · ${merchantName}`,
          reference,
        },
      });
    }

    await tx.ledgerEntry.create({
      data: {
        walletId: merchantWalletId,
        userId: merchantUserId,
        type: 'marketplace_sale',
        amount: amountKori,
        counterpartyName: payerName ?? null,
        note: `${merchantName} · bon verrouillé`,
        reference: `${reference}-M`,
      },
    });

    return { amountKori, merchantName, reference };
  });
}
