import { reference } from '../api/_lib/auth.js';
import { prisma } from './prisma.js';
import { TRANSFER_UNDO_WINDOW_MS } from './transfer-constants.js';
import { createInAppNotification } from './notify-service.js';
import {
  InsufficientFundsError,
  isMoneyError,
  moneyErrorStatus,
  runMoneyTransaction,
  transferNational,
} from './wallet-atomic.js';

export class TransferUndoError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Create undo record in the same DB transaction as the transfer. */
export async function createTransferUndoInTx(tx, params) {
  const {
    senderUserId,
    recipientUserId,
    amount,
    originalReference,
    recipientReference,
    operationType = 'send',
    currency = 'kori',
    windowMs = TRANSFER_UNDO_WINDOW_MS,
  } = params;

  return tx.transferUndo.create({
    data: {
      senderUserId,
      recipientUserId,
      amount,
      currency,
      operationType,
      originalReference,
      recipientReference,
      reversibleUntil: new Date(Date.now() + windowMs),
      status: 'active',
    },
  });
}

export function undoShape(row) {
  if (!row) return null;
  return {
    reference: row.originalReference,
    reversibleUntil: row.reversibleUntil.toISOString(),
    secondsRemaining: Math.max(0, Math.ceil((row.reversibleUntil.getTime() - Date.now()) / 1000)),
    canUndo: row.status === 'active' && Date.now() < row.reversibleUntil.getTime(),
  };
}

/**
 * Atomically reverse a transfer within the undo window.
 * Debit recipient and credit sender in one transaction — all or nothing.
 */
export async function undoTransfer(db, { reference, userId }) {
  const undo = await db.transferUndo.findUnique({ where: { originalReference: reference } });
  if (!undo) throw new TransferUndoError('not_found', 'Transfer not found', 404);
  if (undo.senderUserId !== userId) {
    throw new TransferUndoError('forbidden', 'Only the sender can undo this payment', 403);
  }
  if (undo.status === 'reversed') {
    throw new TransferUndoError('already_reversed', 'Payment already undone');
  }
  if (undo.status !== 'active') {
    throw new TransferUndoError('not_reversible', 'This payment cannot be undone');
  }
  if (Date.now() > undo.reversibleUntil.getTime()) {
    await db.transferUndo.update({ where: { id: undo.id }, data: { status: 'expired' } });
    throw new TransferUndoError('window_expired', 'Undo window has closed (60 seconds)');
  }

  try {
    const result = await runMoneyTransaction(db, async (tx) => {
      // Row lock: two concurrent undo requests must not both reverse the transfer.
      await tx.$executeRaw`SELECT id FROM "TransferUndo" WHERE "originalReference" = ${reference} FOR UPDATE`;
      const row = await tx.transferUndo.findUnique({ where: { originalReference: reference } });
      if (!row || row.status !== 'active') {
        throw new TransferUndoError('not_reversible', 'Payment is no longer reversible');
      }
      if (Date.now() > row.reversibleUntil.getTime()) {
        await tx.transferUndo.update({ where: { id: row.id }, data: { status: 'expired' } });
        throw new TransferUndoError('window_expired', 'Undo window has closed (60 seconds)');
      }

      const [payer, payee] = await Promise.all([
        tx.user.findUniqueOrThrow({
          where: { id: row.recipientUserId },
          include: { wallet: true },
        }),
        tx.user.findUniqueOrThrow({
          where: { id: row.senderUserId },
          include: { wallet: true },
        }),
      ]);

      if (!payer.wallet || !payee.wallet) {
        throw new TransferUndoError('wallet_missing', 'Wallet not found', 400);
      }

      const reverseRef = reference('UNDO');
      await transferNational(tx, {
        amount: row.amount,
        senderWalletId: payer.wallet.id,
        recipientWalletId: payee.wallet.id,
        senderUserId: payer.id,
        recipientUserId: payee.id,
        reference: reverseRef,
        senderLedger: {
          type: 'send_undo',
          counterpartyName: payee.name ?? payee.handle,
          note: `Annulation ${row.originalReference}`,
        },
        recipientLedger: {
          type: 'receive_undo',
          counterpartyName: payer.name ?? payer.handle,
          note: `Remboursement annulation`,
          reference: `${reverseRef}-R`,
        },
      });

      await tx.transferUndo.update({
        where: { id: row.id },
        data: {
          status: 'reversed',
          reversedAt: new Date(),
          reversedReference: reverseRef,
        },
      });

      return { reversedReference: reverseRef, amount: row.amount, originalReference: reference };
    });

    await createInAppNotification(
      undo.recipientUserId,
      'Paiement annulé',
      `L'expéditeur a annulé un paiement de ${undo.amount.toLocaleString('fr-FR')} F.`,
    );

    return result;
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      throw new TransferUndoError(
        'recipient_spent',
        'Impossible d\'annuler — le destinataire a déjà utilisé cet argent',
      );
    }
    if (error instanceof TransferUndoError) throw error;
    throw error;
  }
}

export function handleTransferUndoError(res, error) {
  if (error instanceof TransferUndoError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  if (isMoneyError(error)) {
    res.status(moneyErrorStatus(error)).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

export async function getTransferUndoStatus(reference, userId) {
  const undo = await prisma.transferUndo.findUnique({ where: { originalReference: reference } });
  if (!undo || undo.senderUserId !== userId) return null;
  return undoShape(undo);
}
