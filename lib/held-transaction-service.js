import { reference } from '../api/_lib/auth.js';
import { prisma } from './prisma.js';
import { placeMarketplaceOrder } from './marketplace-service.js';
import { HELD_USER_MESSAGE_FR, REVIEW_SLA_MS } from './risk-constants.js';
import { assessTransactionRisk } from './risk-engine.js';
import {
  creditKoriEarn,
  convertKoriToNational,
  sendKoriTransfer,
  spendKoriAtMerchant,
} from './kori-service.js';
import {
  transferBusinessToBusiness,
  transferBusinessToPersonal,
  transferBusinessToPersonalPayroll,
  transferPersonalToBusiness,
} from './business-wallet-service.js';
import { acceptMoneyRequest } from './money-request-service.js';
import { startCashOut } from './rail-service.js';
import { runMoneyTransaction, transferNational } from './wallet-atomic.js';
import { formatKori } from './kori.js';
import { createInAppNotification } from './notify-service.js';

export class HeldTransactionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'HeldTransactionError';
  }
}

async function alertAdmins(userId, heldId, flags, message) {
  for (const code of flags) {
    await prisma.fraudAlert.create({
      data: {
        userId,
        heldTransactionId: heldId,
        code,
        message: message ?? `Risk flag: ${code}`,
        severity: 'high',
      },
    });
  }
}

export async function createHeldTransaction(db, params) {
  const {
    userId,
    operationType,
    amountNational,
    payload,
    flags,
    reasons,
    ref = reference('HOLD'),
  } = params;

  const expiresAt = new Date(Date.now() + REVIEW_SLA_MS);
  const held = await db.heldTransaction.create({
    data: {
      userId,
      operationType,
      amountNational,
      payloadJson: JSON.stringify({ ...payload, reference: ref }),
      flagsJson: JSON.stringify({ flags, reasons }),
      userMessage: HELD_USER_MESSAGE_FR,
      reference: ref,
      expiresAt,
      status: 'pending_review',
    },
  });

  await alertAdmins(userId, held.id, flags, reasons?.join('; '));
  await createInAppNotification(
    userId,
    'Vérification en cours',
    `${HELD_USER_MESSAGE_FR} Réf: ${ref}.`,
  );

  return held;
}

/**
 * Run risk checks; if flagged, hold and return { held: true, held }.
 * Otherwise run execute() and return { held: false, result }.
 */
export async function withRiskGate(db, ctx, execute) {
  const assessment = await assessTransactionRisk(db, ctx);
  if (!assessment.hold) {
    const result = await execute();
    return { held: false, result };
  }

  const ref = ctx.reference ?? reference('HOLD');
  const held = await createHeldTransaction(db, {
    userId: ctx.userId,
    operationType: ctx.operationType,
    amountNational: ctx.amountNational,
    payload: { ...ctx.payload, reference: ref },
    flags: assessment.flags,
    reasons: assessment.reasons,
    ref,
  });

  return { held: true, held, assessment };
}

export function heldResponseShape(held) {
  return {
    held: true,
    status: 'pending_review',
    heldTransactionId: held.id,
    reference: held.reference,
    message: held.userMessage,
    expiresAt: held.expiresAt.toISOString(),
  };
}

async function executeHeldPayload(payload, requesterId = null) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const type = p.operationType ?? p.type;

  switch (type) {
    case 'send_national': {
      return runMoneyTransaction(prisma, async (db) => {
        const outgoing = await transferNational(db, {
          amount: p.amount,
          senderWalletId: p.senderWalletId,
          recipientWalletId: p.recipientWalletId,
          senderUserId: p.senderUserId,
          recipientUserId: p.recipientUserId,
          reference: p.reference,
          senderLedger: p.senderLedger,
          recipientLedger: p.recipientLedger,
        });
        await creditKoriEarn(db, p.senderUserId, p.senderWalletId, 'send', `${p.reference}-EARN`);
        return { ledger: outgoing };
      });
    }
    case 'send_kori': {
      return runMoneyTransaction(prisma, async (db) => {
        await sendKoriTransfer(db, {
          senderId: p.senderId,
          senderWalletId: p.senderWalletId,
          recipientId: p.recipientId,
          recipientWalletId: p.recipientWalletId,
          amountKori: p.amountKori,
          reference: p.reference,
          note: p.note,
        });
        await creditKoriEarn(db, p.senderId, p.senderWalletId, 'send', `${p.reference}-EARN`);
        return { currency: 'kori', amount: p.amountKori };
      });
    }
    case 'kori_convert': {
      return runMoneyTransaction(prisma, async (db) => {
        const conversion = await convertKoriToNational(db, {
          userId: p.userId,
          walletId: p.walletId,
          country: p.country,
          koriAmount: p.amountKori,
          reference: p.reference,
        });
        const ledger = await db.ledgerEntry.create({
          data: {
            walletId: p.walletId,
            userId: p.userId,
            type: 'cash_out',
            amount: -p.amountKori,
            note: p.ledgerNote,
            reference: `${p.reference}-NAT`,
          },
        });
        const wallet = await db.wallet.findUniqueOrThrow({ where: { id: p.walletId } });
        return { conversion, ledger, wallet };
      });
    }
    case 'cash_out': {
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: p.userId },
        include: { wallet: true },
      });
      return startCashOut(prisma, {
        userId: p.userId,
        wallet: user.wallet,
        country: user.country,
        amount: p.amount,
        phone: p.phone,
        operator: p.operator,
        reference: p.reference,
        callbackUrl: p.callbackUrl,
      });
    }
    case 'merchant_pay_national': {
      return runMoneyTransaction(prisma, async (db) => {
        const tx = await transferNational(db, {
          amount: p.amount,
          senderWalletId: p.senderWalletId,
          recipientWalletId: p.recipientWalletId,
          senderUserId: p.senderUserId,
          recipientUserId: p.recipientUserId,
          reference: p.reference,
          senderLedger: p.senderLedger,
          recipientLedger: p.recipientLedger,
        });
        await creditKoriEarn(db, p.senderUserId, p.senderWalletId, 'pay_merchant', `${p.reference}-EARN`);
        return { ledger: tx };
      });
    }
    case 'merchant_pay_kori': {
      return runMoneyTransaction(prisma, async (db) => {
        await spendKoriAtMerchant(db, {
          payerId: p.payerId,
          payerWalletId: p.payerWalletId,
          merchantUserId: p.merchantUserId,
          merchantWalletId: p.merchantWalletId,
          amountKori: p.amountKori,
          merchantName: p.merchantName,
          reference: p.reference,
        });
        await creditKoriEarn(db, p.payerId, p.payerWalletId, 'pay_merchant', `${p.reference}-EARN`);
        return { currency: 'kori', amount: p.amountKori };
      });
    }
    case 'money_request_accept': {
      const updated = await acceptMoneyRequest(prisma, {
        requestId: p.requestId,
        payerUserId: p.payerUserId,
      });
      return { request: updated };
    }
    case 'payroll': {
      return runMoneyTransaction(prisma, async (db) => {
        const biz = await db.business.findUniqueOrThrow({ where: { id: p.businessId } });
        const employee = await db.payrollEmployee.findFirstOrThrow({
          where: { businessId: p.businessId, userId: p.recipientUserId, status: 'active' },
          include: { user: { include: { wallet: true } } },
        });
        const entry = await transferBusinessToPersonalPayroll(db, {
          actingUserId: requesterId,
          amount: p.amount,
          businessWalletId: p.businessWalletId,
          businessId: p.businessId,
          userWalletId: p.recipientWalletId,
          userId: p.recipientUserId,
          reference: p.reference,
          businessName: biz.name,
          employeeName: employee.user.name,
          employeeHandle: employee.user.handle,
          note: p.note,
        });
        await db.payrollRun.create({
          data: {
            businessId: p.businessId,
            employeeId: employee.id,
            amount: p.amount,
            reference: p.reference,
            note: p.note,
            status: 'completed',
            completedAt: new Date(),
          },
        });
        return { ledger: entry };
      });
    }
    case 'school_fee': {
      return runMoneyTransaction(prisma, async (db) => {
        await transferNational(db, {
          amount: p.amount,
          senderWalletId: p.senderWalletId,
          recipientWalletId: p.recipientWalletId,
          senderUserId: p.senderUserId,
          recipientUserId: p.recipientUserId,
          reference: p.reference,
          senderLedger: {
            type: 'pay_merchant',
            counterpartyName: p.counterpartyName ?? 'École',
            note: p.note,
          },
          recipientLedger: {
            type: 'marketplace_sale',
            counterpartyName: p.counterpartyName ?? 'Parent',
            note: p.note,
            reference: `${p.reference}-E`,
          },
        });
        if (p.paymentId) {
          await db.schoolFeePayment.update({
            where: { id: p.paymentId },
            data: { status: 'paid', paidAt: new Date(), ledgerReference: p.reference },
          });
        }
        return { ok: true };
      });
    }
    case 'kebu_capital_in': {
      return runMoneyTransaction(prisma, (db) =>
        transferPersonalToBusiness(db, {
          amount: p.amount,
          userWalletId: p.userWalletId,
          userId: p.userId,
          businessWalletId: p.businessWalletId,
          businessId: p.businessId,
          reference: p.reference,
          businessName: p.businessName,
          note: p.note,
        }),
      );
    }
    case 'kebu_owner_draw': {
      return runMoneyTransaction(prisma, (db) =>
        transferBusinessToPersonal(db, {
          actingUserId: requesterId,
          amount: p.amount,
          businessWalletId: p.businessWalletId,
          businessId: p.businessId,
          userWalletId: p.userWalletId,
          userId: p.userId,
          reference: p.reference,
          businessName: p.businessName,
          note: p.note,
        }),
      );
    }
    case 'b2b_pay': {
      return runMoneyTransaction(prisma, async (db) => {
        const [sender, recipient] = await Promise.all([
          db.business.findUniqueOrThrow({ where: { id: p.fromBusinessId } }),
          db.business.findUniqueOrThrow({ where: { id: p.toBusinessId } }),
        ]);
        const senderWallet = await db.businessWallet.findUniqueOrThrow({ where: { businessId: p.fromBusinessId } });
        const recipientWallet = await db.businessWallet.findUniqueOrThrow({ where: { businessId: p.toBusinessId } });
        return transferBusinessToBusiness(db, {
          actingUserId: requesterId,
          amount: p.amount,
          senderWalletId: senderWallet.id,
          senderBusinessId: sender.id,
          recipientWalletId: recipientWallet.id,
          recipientBusinessId: recipient.id,
          reference: p.reference,
          senderLedger: {
            type: 'b2b_out',
            counterpartyName: recipient.name,
            counterpartyKebuId: recipient.kebuId,
            note: p.note,
          },
          recipientLedger: {
            type: 'b2b_in',
            counterpartyName: sender.name,
            counterpartyKebuId: sender.kebuId,
            note: p.note,
          },
        });
      });
    }
    case 'ticket_purchase': {
      return runMoneyTransaction(prisma, async (db) => {
        await transferNational(db, {
          amount: p.amount,
          senderWalletId: p.senderWalletId,
          recipientWalletId: p.recipientWalletId,
          senderUserId: p.senderUserId,
          recipientUserId: p.recipientUserId,
          reference: p.reference,
          senderLedger: p.senderLedger,
          recipientLedger: p.recipientLedger,
        });
        const ticket = await db.ticket.create({
          data: {
            eventId: p.eventId,
            buyerId: p.buyerId,
            quantity: p.quantity,
            amount: p.amount,
          },
        });
        return { ticket };
      });
    }
    case 'marketplace_order': {
      const result = await placeMarketplaceOrder(prisma, {
        buyerId: p.buyerId,
        businessId: p.businessId,
        items: p.items,
        fulfillmentType: p.fulfillmentType,
        dropoff: p.dropoff,
        reference: p.reference,
        affiliateLinkCode: p.affiliateLinkCode,
        mboloThreadId: p.mboloThreadId,
        channel: p.channel,
        paymentTerm: p.paymentTerm,
        buyerBusinessId: p.buyerBusinessId,
        preferredDeliveryDate: p.preferredDeliveryDate,
        paymentSource: p.paymentSource,
      });
      return {
        orderId: result.order.id,
        status: result.order.status,
        fulfillmentType: result.order.fulfillmentType,
        totalKori: result.totalKori,
        deliveryId: result.delivery?.id ?? null,
      };
    }
    default:
      throw new HeldTransactionError('unknown_operation', `Unknown held operation: ${type}`);
  }
}

export async function approveHeldTransaction(heldId, adminId, note) {
  const held = await prisma.heldTransaction.findUnique({ where: { id: heldId } });
  if (!held) throw new HeldTransactionError('not_found', 'Held transaction not found');
  if (held.status !== 'pending_review') {
    throw new HeldTransactionError('invalid_state', `Cannot approve status ${held.status}`);
  }

  const payload = JSON.parse(held.payloadJson);
  payload.operationType = held.operationType;

  const result = await executeHeldPayload(payload, held.userId);

  const updated = await prisma.heldTransaction.update({
    where: { id: heldId },
    data: {
      status: 'approved',
      reviewedBy: adminId,
      reviewedAt: new Date(),
      reviewNote: note ?? 'Approved',
    },
  });

  await createInAppNotification(
    held.userId,
    'Transaction approuvée',
    `Votre transaction ${held.reference} a été vérifiée et traitée.`,
  );

  return { held: updated, result };
}

export async function rejectHeldTransaction(heldId, adminId, reason) {
  const held = await prisma.heldTransaction.findUnique({ where: { id: heldId } });
  if (!held) throw new HeldTransactionError('not_found', 'Held transaction not found');
  if (held.status !== 'pending_review') {
    throw new HeldTransactionError('invalid_state', `Cannot reject status ${held.status}`);
  }

  const updated = await prisma.heldTransaction.update({
    where: { id: heldId },
    data: {
      status: 'rejected',
      reviewedBy: adminId,
      reviewedAt: new Date(),
      reviewNote: reason ?? 'Rejected',
    },
  });

  await createInAppNotification(
    held.userId,
    'Transaction refusée',
    reason
      ? `${reason} (réf. ${held.reference})`
      : `Votre transaction ${held.reference} n’a pas pu être traitée. Aucun débit effectué.`,
  );

  return updated;
}

export async function listHeldTransactions({ status = 'pending_review', limit = 50 } = {}) {
  return prisma.heldTransaction.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { fraudAlerts: true },
  });
}

export async function listFraudAlerts({ unacknowledgedOnly = true, limit = 50 } = {}) {
  return prisma.fraudAlert.findMany({
    where: unacknowledgedOnly ? { acknowledgedAt: null } : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { heldTransaction: true },
  });
}

export { HELD_USER_MESSAGE_FR, formatKori };
