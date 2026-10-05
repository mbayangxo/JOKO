import { sendKoriTransfer } from './kori-service.js';
import {
  creditNational,
  debitNational,
  InsufficientFundsError,
  lockProjections,
  lockWallets,
  runMoneyTransaction,
} from './wallet-atomic.js';
import { formatKori } from './kori.js';
import { createInAppNotification } from './notify-service.js';
import { reference } from '../api/_lib/auth.js';
import { account as ledgerAccount } from './money-kernel/flows.js';

export class ScheduledPaymentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ScheduledPaymentError';
  }
}

function fundShape(fund) {
  const targetKori = fund.targetKori;
  const balanceKori = fund.balanceKori;
  const progressPct =
    targetKori != null && targetKori > 0
      ? Math.min(100, Math.round((balanceKori / targetKori) * 100))
      : null;
  return {
    id: fund.id,
    name: fund.name,
    category: fund.category ?? null,
    balanceKori,
    balanceFormatted: formatKori(balanceKori),
    targetKori,
    targetFormatted: targetKori != null ? formatKori(targetKori) : null,
    progressPct,
    remainingKori: targetKori != null ? Math.max(0, targetKori - balanceKori) : null,
    remainingFormatted:
      targetKori != null ? formatKori(Math.max(0, targetKori - balanceKori)) : null,
    createdAt: fund.createdAt.toISOString(),
  };
}

function scheduleShape(row) {
  return {
    id: row.id,
    kind: row.kind ?? 'send',
    recipientHandle: row.recipientHandle,
    amountKori: row.amountKori,
    amountFormatted: formatKori(row.amountKori),
    note: row.note,
    scheduleType: row.scheduleType,
    scheduleDay: row.scheduleDay,
    nextRunAt: row.nextRunAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    active: row.active,
    fundId: row.fundId,
    fund: row.fund ? fundShape(row.fund) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function computeNextRun(from, scheduleType, scheduleDay) {
  const d = new Date(from);
  d.setHours(9, 0, 0, 0);
  if (scheduleType === 'weekly') {
    const target = scheduleDay % 7;
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return d;
  }
  const day = Math.min(28, Math.max(1, scheduleDay));
  d.setDate(day);
  if (d <= from) {
    d.setMonth(d.getMonth() + 1);
    d.setDate(day);
  }
  return d;
}

function runReference(kind, scheduleId, nextRunAt) {
  const prefix = kind === 'save' ? 'SAV' : 'SCH';
  return `${prefix}-${scheduleId}-${nextRunAt.getTime()}`;
}

async function lockPaymentFund(tx, fundId, userId) {
  await lockProjections(tx, { PaymentFund: [fundId] });
  const fund = await tx.paymentFund.findFirst({ where: { id: fundId, userId } });
  if (!fund) throw new ScheduledPaymentError('not_found', 'Fonds introuvable');
  return fund;
}

async function lockScheduledPaymentRow(tx, scheduleId) {
  await tx.$executeRaw`SELECT id FROM "ScheduledPayment" WHERE id = ${scheduleId} FOR UPDATE`;
  return tx.scheduledPayment.findUnique({
    where: { id: scheduleId },
    include: {
      fund: true,
      user: { include: { wallet: true } },
    },
  });
}

export async function listPaymentFunds(db, userId) {
  const funds = await db.paymentFund.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return funds.map(fundShape);
}

export async function createPaymentFund(db, { userId, name, targetKori, category }) {
  const fund = await db.paymentFund.create({
    data: {
      userId,
      name: name.trim(),
      targetKori: targetKori ?? null,
      category: category ?? null,
    },
  });
  return fundShape(fund);
}

export async function fundPaymentPot(db, { userId, fundId, amountKori }) {
  if (amountKori <= 0) throw new ScheduledPaymentError('invalid', 'Montant invalide');

  const ref = reference('SAV');
  return runMoneyTransaction(db, async (tx) => {
    const fund = await lockPaymentFund(tx, fundId, userId);

    await debitNational(tx, {
      walletId: (await tx.wallet.findUniqueOrThrow({ where: { userId } })).id,
      userId,
      amount: amountKori,
      reference: ref,
      ledger: {
        type: 'save',
        counterpartyName: fund.name,
        note: 'Épargne objectif',
      },
      to: await ledgerAccount(tx, 'paymentFund', fundId),
      kind: 'fund_deposit',
    });

    const updated = await tx.paymentFund.findUniqueOrThrow({ where: { id: fundId } });
    return fundShape(updated);
  });
}

export async function withdrawPaymentFund(db, { userId, fundId, amountKori }) {
  if (amountKori <= 0) throw new ScheduledPaymentError('invalid', 'Montant invalide');

  const ref = reference('SWR');
  return runMoneyTransaction(db, async (tx) => {
    const fund = await lockPaymentFund(tx, fundId, userId);
    if (fund.balanceKori < amountKori) {
      throw new InsufficientFundsError('Solde objectif insuffisant');
    }

    await creditNational(tx, {
      walletId: (await tx.wallet.findUniqueOrThrow({ where: { userId } })).id,
      userId,
      amount: amountKori,
      reference: ref,
      from: await ledgerAccount(tx, 'paymentFund', fundId),
      kind: 'fund_withdraw',
      actor: { type: 'user', id: userId },
      authorization: 'fund_owner',
      ledger: {
        type: 'save_release',
        counterpartyName: fund.name,
        note: 'Retrait objectif',
      },
    });

    const updated = await tx.paymentFund.findUniqueOrThrow({ where: { id: fundId } });
    return fundShape(updated);
  });
}

export async function listScheduledPayments(db, userId) {
  const rows = await db.scheduledPayment.findMany({
    where: { userId },
    include: { fund: true },
    orderBy: { nextRunAt: 'asc' },
  });
  return rows.map(scheduleShape);
}

export async function createScheduledPayment(db, params) {
  const {
    userId,
    kind = 'send',
    recipientHandle,
    amountKori,
    note,
    scheduleType,
    scheduleDay,
    fundId,
  } = params;

  if (kind === 'save') {
    if (!fundId) throw new ScheduledPaymentError('invalid', 'Fonds requis pour épargne auto');
    const fund = await db.paymentFund.findFirst({ where: { id: fundId, userId } });
    if (!fund) throw new ScheduledPaymentError('not_found', 'Fonds introuvable');
  } else {
    if (!recipientHandle) throw new ScheduledPaymentError('invalid', 'Destinataire requis');
    const recipient = await db.user.findUnique({ where: { handle: recipientHandle } });
    if (!recipient) throw new ScheduledPaymentError('not_found', 'Destinataire introuvable');
    if (fundId) {
      const fund = await db.paymentFund.findFirst({ where: { id: fundId, userId } });
      if (!fund) throw new ScheduledPaymentError('not_found', 'Fonds introuvable');
    }
    const nextRunAt = computeNextRun(new Date(), scheduleType, scheduleDay);
    const row = await db.scheduledPayment.create({
      data: {
        userId,
        kind: 'send',
        fundId: fundId ?? null,
        recipientHandle,
        recipientId: recipient.id,
        amountKori,
        note: note ?? null,
        scheduleType,
        scheduleDay,
        nextRunAt,
      },
      include: { fund: true },
    });
    return scheduleShape(row);
  }

  const nextRunAt = computeNextRun(new Date(), scheduleType, scheduleDay);
  const row = await db.scheduledPayment.create({
    data: {
      userId,
      kind: 'save',
      fundId,
      recipientHandle: null,
      recipientId: null,
      amountKori,
      note: note ?? null,
      scheduleType,
      scheduleDay,
      nextRunAt,
    },
    include: { fund: true },
  });
  return scheduleShape(row);
}

export async function toggleScheduledPayment(db, { userId, scheduleId, active }) {
  const row = await db.scheduledPayment.findFirst({ where: { id: scheduleId, userId } });
  if (!row) throw new ScheduledPaymentError('not_found', 'Paiement planifié introuvable');
  const updated = await db.scheduledPayment.update({
    where: { id: scheduleId },
    data: { active },
    include: { fund: true },
  });
  return scheduleShape(updated);
}

export async function runDueScheduledPayments(db, { limit = 50 } = {}) {
  const now = new Date();
  const due = await db.scheduledPayment.findMany({
    where: { active: true, nextRunAt: { lte: now } },
    take: limit,
    include: {
      fund: true,
      user: { include: { wallet: true } },
    },
  });

  const results = [];
  for (const row of due) {
    try {
      if (row.kind === 'save') {
        let goalReached = false;
        let fundName = row.fund?.name ?? 'Objectif';
        const ref = runReference('save', row.id, row.nextRunAt);

        await runMoneyTransaction(db, async (tx) => {
          const locked = await lockScheduledPaymentRow(tx, row.id);
          if (!locked?.active || locked.nextRunAt > now) return;

          const existing = await tx.ledgerEntry.findUnique({ where: { reference: ref } });
          if (existing) {
            await tx.scheduledPayment.update({
              where: { id: row.id },
              data: {
                lastRunAt: now,
                nextRunAt: computeNextRun(now, locked.scheduleType, locked.scheduleDay),
              },
            });
            return;
          }

          if (!locked.fundId || !locked.fund) {
            throw new ScheduledPaymentError('not_found', 'Fonds introuvable');
          }

          const fund = await lockPaymentFund(tx, locked.fundId, locked.userId);
          fundName = fund.name;

          await debitNational(tx, {
            walletId: locked.user.wallet.id,
            userId: locked.userId,
            amount: locked.amountKori,
            reference: ref,
            ledger: {
              type: 'save',
              counterpartyName: fund.name,
              note: locked.note ?? 'Épargne automatique',
            },
            to: await ledgerAccount(tx, 'paymentFund', fund.id),
            kind: 'fund_deposit',
            authorization: 'scheduled_by_owner',
          });

          const updatedFund = await tx.paymentFund.findUniqueOrThrow({ where: { id: fund.id } });

          goalReached =
            updatedFund.targetKori != null && updatedFund.balanceKori >= updatedFund.targetKori;

          await tx.scheduledPayment.update({
            where: { id: row.id },
            data: {
              lastRunAt: now,
              nextRunAt: computeNextRun(now, locked.scheduleType, locked.scheduleDay),
            },
          });
        });

        await createInAppNotification(
          row.userId,
          'Épargne automatique',
          `${formatKori(row.amountKori)} → ${fundName}`,
          { kind: 'scheduled_save', refId: row.id },
        );

        if (goalReached) {
          const fund = await db.paymentFund.findUnique({ where: { id: row.fundId } });
          await createInAppNotification(
            row.userId,
            'Objectif atteint 🎉',
            `${fundName} — ${formatKori(fund?.balanceKori ?? row.amountKori)} épargnés`,
            { kind: 'savings_goal_reached', refId: row.fundId },
          );
        }

        results.push({ id: row.id, status: 'ok', reference: ref, kind: 'save' });
        continue;
      }

      const ref = runReference('send', row.id, row.nextRunAt);

      await runMoneyTransaction(db, async (tx) => {
        const locked = await lockScheduledPaymentRow(tx, row.id);
        if (!locked?.active || locked.nextRunAt > now) return;

        const existing = await tx.koriTransaction.findUnique({ where: { reference: ref } });
        if (existing) {
          await tx.scheduledPayment.update({
            where: { id: row.id },
            data: {
              lastRunAt: now,
              nextRunAt: computeNextRun(now, locked.scheduleType, locked.scheduleDay),
            },
          });
          return;
        }

        const recipient = await tx.user.findUnique({
          where: { id: locked.recipientId ?? undefined },
          include: { wallet: true },
        });
        if (!recipient?.wallet || !locked.user?.wallet) {
          throw new ScheduledPaymentError('not_found', 'Portefeuille introuvable');
        }

        if (locked.fundId && locked.fund) {
          const fund = await lockPaymentFund(tx, locked.fundId, locked.userId);
          if (fund.balanceKori < locked.amountKori) {
            throw new InsufficientFundsError('Fonds dédié insuffisant');
          }
          await creditNational(tx, {
            walletId: recipient.wallet.id,
            userId: recipient.id,
            amount: locked.amountKori,
            reference: `${ref}-R`,
            from: await ledgerAccount(tx, 'paymentFund', fund.id),
            kind: 'scheduled_payment',
            actor: { type: 'user', id: locked.userId },
            authorization: 'scheduled_by_owner',
            ledger: {
              type: 'receive',
              counterpartyName: locked.user.name,
              counterpartyHandle: locked.user.handle,
              note: locked.note ?? fund.name,
            },
          });
          await tx.koriTransaction.create({
            data: {
              senderId: locked.userId,
              recipientId: recipient.id,
              amountKori: locked.amountKori,
              transactionType: 'scheduled',
              reference: ref,
              note: locked.note ?? `Depuis ${fund.name}`,
            },
          });
        } else {
          await sendKoriTransfer(tx, {
            senderId: locked.userId,
            senderWalletId: locked.user.wallet.id,
            recipientId: recipient.id,
            recipientWalletId: recipient.wallet.id,
            amountKori: locked.amountKori,
            reference: ref,
            note: locked.note ?? 'Paiement planifié',
            senderName: locked.user.name,
            senderHandle: locked.user.handle,
            recipientName: recipient.name,
            recipientHandle: recipient.handle,
          });
        }

        await tx.scheduledPayment.update({
          where: { id: row.id },
          data: {
            lastRunAt: now,
            nextRunAt: computeNextRun(now, locked.scheduleType, locked.scheduleDay),
          },
        });
      });

      const recipient = await db.user.findUnique({ where: { id: row.recipientId ?? undefined } });
      if (recipient) {
        await createInAppNotification(
          recipient.id,
          'Paiement planifié reçu',
          `${formatKori(row.amountKori)} de ${row.user.name ?? row.user.handle}`,
          { kind: 'scheduled_payment', refId: row.id },
        );
      }

      results.push({ id: row.id, status: 'ok', reference: ref });
    } catch (err) {
      results.push({ id: row.id, status: 'failed', error: err.message });
    }
  }
  return results;
}
