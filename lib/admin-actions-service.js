import { reference } from '../api/_lib/auth.js';
import { logAdminAction } from './admin-audit.js';
import { prisma } from './prisma.js';
import { approveHeldTransaction, HeldTransactionError, rejectHeldTransaction } from './held-transaction-service.js';
import { getRailStatus } from './julaya.js';
import { settleRailFromWebhook } from './rail-service.js';
import { InsufficientFundsError, runMoneyTransaction } from './wallet-atomic.js';
import { account as ledgerAccount, customer, move } from './money-kernel/flows.js';
import { createInAppNotification } from './notify-service.js';

export class AdminActionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function freezeUserAccount(adminId, userId, reason) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AdminActionError('user_not_found', 'User not found', 404);

  await prisma.user.update({
    where: { id: userId },
    data: {
      frozenByAdminAt: new Date(),
      adminFreezeReason: reason,
    },
  });

  await createInAppNotification(
    userId,
    'Compte suspendu',
    'Votre compte a été temporairement suspendu. Contactez le support K21.',
  );

  await logAdminAction(adminId, 'freeze_user', {
    targetType: 'user',
    targetId: userId,
    detail: { reason },
  });

  return { userId, frozen: true, reason };
}

export async function unfreezeUserAccount(adminId, userId) {
  await prisma.user.update({
    where: { id: userId },
    data: { frozenByAdminAt: null, adminFreezeReason: null },
  });
  await logAdminAction(adminId, 'unfreeze_user', { targetType: 'user', targetId: userId });
  return { userId, frozen: false };
}

export async function releaseStuckRail(adminId, railId, { action, note }) {
  const rail = await prisma.railTransaction.findUnique({ where: { id: railId } });
  if (!rail) throw new AdminActionError('rail_not_found', 'Rail transaction not found', 404);
  if (rail.status !== 'pending' && rail.status !== 'review') {
    throw new AdminActionError('not_pending', `Rail is already ${rail.status}`);
  }

  let status = action;
  let failureReason = note;
  let providerAmount;

  if (action === 'poll') {
    if (!rail.externalId) {
      throw new AdminActionError('no_external_id', 'Cannot poll partner without externalId');
    }
    const partner = await getRailStatus(rail.externalId);
    status = partner.status;
    providerAmount = partner.amount ?? undefined;
    failureReason = partner.status === 'failed' ? partner.message : note;
  }

  const settled = await settleRailFromWebhook(prisma, {
    reference: rail.reference,
    status,
    amount: providerAmount,
    externalId: rail.externalId ?? undefined,
    failureReason,
  });

  await logAdminAction(adminId, 'release_rail', {
    targetType: 'rail',
    targetId: railId,
    detail: { action, status: settled?.status, note },
  });

  return settled;
}

export async function issueAdminRefund(adminId, { recipientUserId, amount, reason, originalRef }) {
  // J2: support refunds are paid from the FUNDED `platform:refunds` budget
  // (a ledger account credited only by real treasury funding) — never from a
  // personal "float user" wallet and never minted. `amount` is in ₭ (the
  // pre-J2 code moved `amount` ₭ while labelling it XOF).
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AdminActionError('invalid_amount', 'Amount must be a positive integer (₭)');
  }
  const recipient = await prisma.user.findUnique({ where: { id: recipientUserId }, include: { wallet: true } });
  if (!recipient?.wallet) throw new AdminActionError('recipient_not_found', 'Recipient wallet not found', 404);

  const ref = reference('AREF');

  let result;
  try {
    result = await runMoneyTransaction(prisma, async (tx) => {
      await move(tx, {
        from: await ledgerAccount(tx, 'refundsBudget'),
        to: await customer(tx, recipient.id),
        amount,
        reference: ref,
        kind: 'support_refund',
        actor: { type: 'admin', id: adminId },
        authorization: 'admin_totp_refund',
        reason,
        metadata: originalRef ? { originalReference: originalRef } : undefined,
      });
      await tx.ledgerEntry.create({
        data: {
          walletId: recipient.wallet.id,
          userId: recipient.id,
          type: 'admin_refund',
          amount,
          counterpartyName: 'K21 Support',
          note: reason,
          reference: `${ref}-R`,
        },
      });
      return tx.adminRefund.create({
        data: {
          adminUserId: adminId,
          recipientUserId,
          amount,
          reason,
          ledgerReference: ref,
          originalRef: originalRef ?? null,
        },
      });
    });
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      throw new AdminActionError('refund_budget_insufficient', 'Le budget remboursements n’est pas approvisionné', 409);
    }
    throw error;
  }

  await createInAppNotification(
    recipientUserId,
    'Remboursement K21',
    `${amount.toLocaleString('fr-FR')} ₭ crédités. ${reason}`,
  );

  await logAdminAction(adminId, 'issue_refund', {
    targetType: 'user',
    targetId: recipientUserId,
    detail: { amount, reason, reference: ref, originalRef },
  });

  return result;
}

export async function adminApproveHeld(adminId, heldId, note) {
  try {
    const result = await approveHeldTransaction(heldId, adminId, note);
    await logAdminAction(adminId, 'approve_held', {
      targetType: 'held',
      targetId: heldId,
      detail: { note },
    });
    return result;
  } catch (error) {
    if (error instanceof HeldTransactionError) {
      throw new AdminActionError(error.code, error.message);
    }
    throw error;
  }
}

export async function adminRejectHeld(adminId, heldId, reason) {
  try {
    const result = await rejectHeldTransaction(heldId, adminId, reason);
    await logAdminAction(adminId, 'reject_held', {
      targetType: 'held',
      targetId: heldId,
      detail: { reason },
    });
    return result;
  } catch (error) {
    if (error instanceof HeldTransactionError) {
      throw new AdminActionError(error.code, error.message);
    }
    throw error;
  }
}

export async function acknowledgeFraudAlert(adminId, alertId) {
  const alert = await prisma.fraudAlert.update({
    where: { id: alertId },
    data: { acknowledgedAt: new Date() },
  });
  await logAdminAction(adminId, 'ack_fraud_alert', { targetType: 'fraud_alert', targetId: alertId });
  return alert;
}

export async function respondSupportTicket(adminId, ticketId, body) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new AdminActionError('ticket_not_found', 'Ticket not found', 404);

  const [message] = await prisma.$transaction([
    prisma.supportTicketMessage.create({
      data: {
        ticketId,
        authorType: 'admin',
        authorAdminId: adminId,
        body,
      },
    }),
    prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: 'pending', assignedAdminId: adminId, updatedAt: new Date() },
    }),
  ]);

  await createInAppNotification(ticket.userId, 'Réponse support K21', body.slice(0, 120));

  await logAdminAction(adminId, 'support_reply', {
    targetType: 'support_ticket',
    targetId: ticketId,
    detail: { messageId: message.id },
  });

  return message;
}

export async function updateSupportTicketStatus(adminId, ticketId, status) {
  const ticket = await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      status,
      assignedAdminId: adminId,
      resolvedAt: ['resolved', 'closed'].includes(status) ? new Date() : null,
    },
  });
  await logAdminAction(adminId, 'support_status', {
    targetType: 'support_ticket',
    targetId: ticketId,
    detail: { status },
  });
  return ticket;
}

export async function getSupportTicketDetail(ticketId) {
  return prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      user: { select: { id: true, phone: true, name: true, handle: true } },
      assignee: { select: { id: true, email: true, name: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
}
