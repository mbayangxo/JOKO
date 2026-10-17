import { prisma } from './prisma.js';
import { reference } from '../api/_lib/auth.js';
import { requireBusinessAdmin, requireBusinessMember } from './business-access.js';
import { legacyNationalToKori } from './kori-primary.js';
import { koriToNational } from './kori.js';
import {
  isMoneyError,
  moneyErrorStatus,
  runMoneyTransaction,
  transferNational,
} from './wallet-atomic.js';
import { gateOrExecute } from './risk-gate.js';
import { assertStepUpForAmount } from './step-up.js';
import { notifyMoneyReceived } from './notify-service.js';
import { createInAppNotification } from './notify-service.js';

export async function enrollStudent(businessId, data) {
  const parent = await prisma.user.findFirst({
    where: {
      OR: [
        { handle: data.parentHandle?.replace(/^@/, '').toLowerCase() },
        ...(data.parentUserId ? [{ id: data.parentUserId }] : []),
      ],
    },
  });
  if (!parent) throw new Error('Parent account not found');

  return prisma.schoolStudent.create({
    data: {
      businessId,
      studentName: data.studentName,
      parentUserId: parent.id,
      gradeLabel: data.gradeLabel ?? null,
      externalId: data.externalId ?? null,
    },
    include: { parent: { select: { id: true, name: true, handle: true, phone: true } } },
  });
}

export async function listStudents(businessId) {
  return prisma.schoolStudent.findMany({
    where: { businessId, status: 'active' },
    orderBy: { studentName: 'asc' },
    include: { parent: { select: { id: true, name: true, handle: true, phone: true } } },
  });
}

export async function createFeePeriod(businessId, { label, amount, dueDate }) {
  const period = await prisma.schoolFeePeriod.create({
    data: { businessId, label, amount, dueDate: new Date(dueDate) },
  });

  const students = await prisma.schoolStudent.findMany({ where: { businessId, status: 'active' } });
  if (students.length) {
    await prisma.schoolFeePayment.createMany({
      data: students.map((s) => ({
        periodId: period.id,
        studentId: s.id,
        parentUserId: s.parentUserId,
        amount,
        status: 'pending',
      })),
      skipDuplicates: true,
    });
  }

  return period;
}

export async function listFeePeriods(businessId) {
  return prisma.schoolFeePeriod.findMany({
    where: { businessId },
    orderBy: { dueDate: 'desc' },
    include: { _count: { select: { payments: true } } },
  });
}

export async function feePeriodStatus(businessId, periodId) {
  const period = await prisma.schoolFeePeriod.findFirst({
    where: { id: periodId, businessId },
  });
  if (!period) throw new Error('Fee period not found');

  const payments = await prisma.schoolFeePayment.findMany({
    where: { periodId },
    include: {
      student: { select: { id: true, studentName: true, gradeLabel: true, externalId: true } },
    },
    orderBy: { student: { studentName: 'asc' } },
  });

  const paid = payments.filter((p) => p.status === 'paid');
  const unpaid = payments.filter((p) => p.status !== 'paid');

  return {
    period,
    paid,
    unpaid,
    summary: {
      total: payments.length,
      paidCount: paid.length,
      unpaidCount: unpaid.length,
      collectedXof: paid.reduce((sum, p) => sum + p.amount, 0),
    },
  };
}

export async function parentPayFee({ req, res, businessId, studentId, periodId }) {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { owner: { include: { wallet: true } } },
  });
  if (!business.owner?.wallet) throw new Error('School wallet unavailable');

  const payment = await prisma.schoolFeePayment.findFirst({
    where: { periodId, studentId, parentUserId: req.userId },
    include: { period: true, student: true },
  });
  if (!payment) throw new Error('Fee record not found');
  if (payment.status === 'paid') throw new Error('Already paid');

  const payerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: req.userId } });
  const payer = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
  const amountKori = legacyNationalToKori(payment.amount, payer.country ?? 'SN');
  const amountNational = koriToNational(amountKori, payer.country ?? 'SN');
  await assertStepUpForAmount(req, amountNational);

  const txRef = reference('SCH');
  const gate = await gateOrExecute(
    req,
    res,
    {
      operationType: 'school_fee',
      amountNational,
      recipientId: business.ownerId,
      payload: {
        amount: amountKori,
        paymentId: payment.id,
        counterpartyName: business.name,
        note: `${payment.student.studentName} · ${payment.period.label}`,
        senderUserId: req.userId,
        recipientUserId: business.ownerId,
        senderWalletId: payerWallet.id,
        recipientWalletId: business.owner.wallet.id,
        businessId: business.id,
      },
    },
    async (ref) => {
      await runMoneyTransaction(prisma, async (db) => {
        // J7.0: school fees settle to the owner wallet — same business eligibility policy.
        const { assertBusinessCanReceive } = await import('./business/eligibility.js');
        await assertBusinessCanReceive(db, business.id, 'merchant_payment');
        await transferNational(db, {
          amount: amountKori,
          senderWalletId: payerWallet.id,
          recipientWalletId: business.owner.wallet.id,
          senderUserId: req.userId,
          recipientUserId: business.ownerId,
          reference: ref,
          senderLedger: {
            type: 'pay_merchant',
            counterpartyName: business.name,
            note: `${payment.student.studentName} · ${payment.period.label}`,
          },
          recipientLedger: {
            type: 'marketplace_sale',
            counterpartyName: payment.student.studentName,
            note: payment.period.label,
            reference: `${ref}-E`,
          },
        });
        await db.schoolFeePayment.update({
          where: { id: payment.id },
          data: { status: 'paid', paidAt: new Date(), ledgerReference: ref },
        });
      });
      return { reference: ref, amount: amountKori, student: payment.student.studentName };
    },
  );

  if (!gate.held) {
    await notifyMoneyReceived(business.ownerId, {
      amount: payment.amount,
      currency: 'national',
      senderLabel: payment.student.studentName,
    });
  }

  return gate;
}

export async function sendFeeRemindersForAdmin(userId, businessId, periodId) {
  await requireBusinessAdmin(userId, businessId);
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });

  const unpaid = await prisma.schoolFeePayment.findMany({
    where: { periodId, status: { not: 'paid' }, student: { businessId } },
    include: { student: true, period: true },
  });

  const notified = [];
  for (const row of unpaid) {
    await createInAppNotification(
      row.parentUserId,
      'Frais scolaires en attente',
      `${row.student.studentName} · ${row.period.label} — ${row.amount.toLocaleString('fr-FR')} XOF pour ${business.name}`,
    );
    await prisma.schoolFeePayment.update({
      where: { id: row.id },
      data: { reminderSentAt: new Date() },
    });
    notified.push({ paymentId: row.id, parentUserId: row.parentUserId });
  }

  return { reminded: notified.length, parents: notified };
}

export { isMoneyError, moneyErrorStatus, requireBusinessMember };
