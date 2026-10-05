import { creditKoriEarn, sendKoriTransfer } from './kori-service.js';
import { legacyNationalToKori } from './kori-primary.js';
import { creditMerchantVoucher, PURPOSE_LABELS } from './merchant-voucher-service.js';
import { createInAppNotification, notifyMoneyReceived } from './notify-service.js';
import { formatKori } from './kori.js';
import {
  InsufficientFundsError,
  runMoneyTransaction,
  transferNational,
} from './wallet-atomic.js';

export function moneyRequestShape(request) {
  return {
    id: request.id,
    reference: request.reference,
    amount: request.amount,
    currency: request.currency,
    purposeCategory: request.purposeCategory ?? 'general',
    purposeLabel: PURPOSE_LABELS[request.purposeCategory ?? 'general'] ?? PURPOSE_LABELS.general,
    note: request.note,
    voiceNoteUrl: request.voiceNoteUrl,
    photoUrl: request.photoUrl,
    videoUrl: request.videoUrl,
    lockToBusinessId: request.lockToBusinessId ?? null,
    lockedBusiness: request.lockToBusiness
      ? {
          id: request.lockToBusiness.id,
          name: request.lockToBusiness.name,
          category: request.lockToBusiness.category,
        }
      : null,
    // J4: a pending request past its expiry is shown as expired (never payable).
    status: request.status === 'pending' && request.expiresAt && request.expiresAt <= new Date() ? 'expired' : request.status,
    expiresAt: request.expiresAt?.toISOString() ?? null,
    respondedAt: request.respondedAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    requester: {
      id: request.requester.id,
      name: request.requester.name ?? '',
      handle: request.requester.handle ?? '',
      avatarEmoji: request.requester.avatarEmoji ?? '👤',
    },
    payer: {
      id: request.payer.id,
      name: request.payer.name ?? '',
      handle: request.payer.handle ?? '',
      avatarEmoji: request.payer.avatarEmoji ?? '👤',
    },
  };
}

const requestInclude = {
  requester: { select: { id: true, name: true, handle: true, avatarEmoji: true } },
  payer: { select: { id: true, name: true, handle: true, avatarEmoji: true } },
  lockToBusiness: { select: { id: true, name: true, category: true } },
};

async function lockMoneyRequestRow(tx, requestId) {
  await tx.$executeRaw`SELECT id FROM "MoneyRequest" WHERE id = ${requestId} FOR UPDATE`;
  return tx.moneyRequest.findUnique({ where: { id: requestId } });
}

export async function acceptMoneyRequest(db, params) {
  const request = await db.moneyRequest.findUnique({
    where: { id: params.requestId },
    include: {
      requester: { include: { wallet: true } },
      payer: { include: { wallet: true } },
      lockToBusiness: { select: { id: true, name: true, category: true } },
    },
  });
  if (!request) throw new RequestError('not_found', 'Money request not found');
  if (request.payerId !== params.payerUserId) {
    throw new RequestError('forbidden', 'Only the payer can accept');
  }
  if (request.status !== 'pending') {
    throw new RequestError('invalid_state', `Request is already ${request.status}`);
  }
  if (request.expiresAt && request.expiresAt <= new Date()) {
    await db.moneyRequest.updateMany({ where: { id: request.id, status: 'pending' }, data: { status: 'expired' } });
    throw new RequestError('expired', 'Cette demande a expiré');
  }
  if (!request.payer.wallet || !request.requester.wallet) {
    throw new RequestError('wallet_missing', 'Wallet not found');
  }

  const ref = request.reference;
  const now = new Date();
  const payerWallet = request.payer.wallet;
  const requesterWallet = request.requester.wallet;
  const lockBusinessName = request.lockToBusiness?.name ?? 'marchand';

  await runMoneyTransaction(db, async (tx) => {
    const locked = await lockMoneyRequestRow(tx, request.id);
    if (!locked || locked.status !== 'pending') {
      throw new RequestError('invalid_state', `Request is already ${locked?.status ?? 'missing'}`);
    }
    // J4: an expired request is not payable (and is marked expired).
    if (request.expiresAt && request.expiresAt <= new Date()) {
      throw new RequestError('expired', 'Cette demande a expiré');
    }

    if (request.lockToBusinessId) {
      try {
        await creditMerchantVoucher(tx, {
          userId: request.requesterId,
          businessId: request.lockToBusinessId,
          amountKori: request.amount,
          reference: `${ref}-V`,
          counterpartyName: request.payer.name ?? request.payer.handle,
          purposeNote: request.note ?? request.purposeCategory,
          fromWalletId: payerWallet.id,
          fromUserId: request.payerId,
        });
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          throw new RequestError('insufficient', 'Solde C insuffisant');
        }
        throw error;
      }
      await tx.ledgerEntry.create({
        data: {
          walletId: payerWallet.id,
          userId: request.payerId,
          type: 'send',
          amount: -request.amount,
          counterpartyName: request.requester.name,
          counterpartyHandle: request.requester.handle,
          note: request.note ?? `Bon verrouillé · ${lockBusinessName}`,
          reference: ref,
        },
      });
      await creditKoriEarn(tx, request.payerId, payerWallet.id, 'send', `${ref}-EARN`);
    } else if (request.currency === 'kori') {
      try {
        await sendKoriTransfer(tx, {
          senderId: request.payerId,
          senderWalletId: payerWallet.id,
          recipientId: request.requesterId,
          recipientWalletId: requesterWallet.id,
          amountKori: request.amount,
          reference: ref,
          note: request.note ?? undefined,
        });
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          throw new RequestError('insufficient', error.message);
        }
        throw error;
      }
    } else {
      const amountKori = legacyNationalToKori(request.amount, request.payer.country ?? 'SN');
      try {
        await transferNational(tx, {
          amount: amountKori,
          senderWalletId: payerWallet.id,
          recipientWalletId: requesterWallet.id,
          senderUserId: request.payerId,
          recipientUserId: request.requesterId,
          reference: ref,
          senderLedger: {
            type: 'send',
            counterpartyName: request.requester.name,
            counterpartyHandle: request.requester.handle,
            note: request.note ?? "Demande d'argent acceptée",
          },
          recipientLedger: {
            type: 'receive',
            counterpartyName: request.payer.name,
            counterpartyHandle: request.payer.handle,
            note: request.note ?? "Demande d'argent acceptée",
          },
        });
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          throw new RequestError('insufficient', error.message);
        }
        throw error;
      }
      await creditKoriEarn(tx, request.payerId, payerWallet.id, 'send', `${ref}-EARN`);
    }

    const updated = await tx.moneyRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: 'accepted', respondedAt: now },
    });
    if (updated.count !== 1) {
      throw new RequestError('invalid_state', 'Request already processed');
    }
  });

  if (request.lockToBusinessId) {
    await createInAppNotification(
      request.requesterId,
      'Bon marchand reçu 🔒',
      `${formatKori(request.amount)} · ${lockBusinessName}`,
      { kind: 'merchant_voucher', refId: request.lockToBusinessId },
    );
  } else {
    await notifyMoneyReceived(request.requesterId, {
      amount: request.amount,
      currency: request.currency === 'kori' ? 'kori' : 'national',
      senderLabel: request.payer.name ?? request.payer.handle,
    });
  }

  return db.moneyRequest.findUniqueOrThrow({ where: { id: request.id }, include: requestInclude });
}

export async function denyMoneyRequest(db, params) {
  const request = await db.moneyRequest.findUnique({ where: { id: params.requestId }, include: requestInclude });
  if (!request) throw new RequestError('not_found', 'Money request not found');
  if (request.payerId !== params.payerUserId) throw new RequestError('forbidden', 'Only the payer can deny');
  if (request.status !== 'pending') {
    throw new RequestError('invalid_state', `Request is already ${request.status}`);
  }
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.moneyRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: 'denied', respondedAt: now },
    });
    await tx.notification.create({
      data: {
        userId: request.requesterId,
        title: 'Demande refusée',
        body: `${request.payer.name ?? request.payer.handle} a refusé ta demande de ${request.amount.toLocaleString('fr-FR')} F`,
      },
    });
  });
  return db.moneyRequest.findUniqueOrThrow({ where: { id: request.id }, include: requestInclude });
}

export async function cancelMoneyRequest(db, params) {
  const request = await db.moneyRequest.findUnique({ where: { id: params.requestId }, include: requestInclude });
  if (!request) throw new RequestError('not_found', 'Money request not found');
  if (request.requesterId !== params.requesterUserId) {
    throw new RequestError('forbidden', 'Only the requester can cancel');
  }
  if (request.status !== 'pending') {
    throw new RequestError('invalid_state', `Request is already ${request.status}`);
  }
  const now = new Date();
  await db.moneyRequest.updateMany({
    where: { id: request.id, status: 'pending' },
    data: { status: 'cancelled', respondedAt: now },
  });
  return db.moneyRequest.findUniqueOrThrow({ where: { id: request.id }, include: requestInclude });
}

export class RequestError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'RequestError';
  }
}

export function requestErrorStatus(code) {
  switch (code) {
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'expired':
      return 410;
    case 'insufficient':
    case 'invalid_state':
    case 'wallet_missing':
      return 400;
    default:
      return 400;
  }
}
