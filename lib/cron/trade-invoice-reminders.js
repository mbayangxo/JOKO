/**
 * B2B trade invoice overdue detection + reminders — mirrors the school-fee
 * reminder shape (lib/cron/school-reminders.js): first pass flips anything
 * past its due date to 'overdue' and tells the supplier once; every run
 * after that nudges the buyer again on a cooldown so a net30 invoice
 * doesn't just sit there silently forever.
 */

import { prisma } from '../prisma.js';
import { createInAppNotification } from '../notify-service.js';
import { formatKori } from '../kori.js';

const REMINDER_COOLDOWN_MS = 3 * 24 * 3600 * 1000;

export async function runTradeInvoiceReminders(db = prisma) {
  const now = new Date();

  const newlyOverdue = await db.tradeInvoice.findMany({
    where: { status: { in: ['open', 'partial'] }, dueAt: { lt: now } },
    include: { supplier: true },
  });

  for (const invoice of newlyOverdue) {
    await db.tradeInvoice.update({
      where: { id: invoice.id },
      data: { status: 'overdue' },
    });
    await createInAppNotification(
      invoice.supplier.ownerId,
      'Facture en retard',
      `${invoice.reference} · ${formatKori(invoice.amountKori - (invoice.creditedKori ?? 0) - invoice.amountPaid)} n'a pas été payée à temps`,
      { kind: 'trade_invoice_overdue', refId: invoice.id },
    );
  }

  const dueForReminder = await db.tradeInvoice.findMany({
    where: {
      status: 'overdue',
      OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: new Date(now.getTime() - REMINDER_COOLDOWN_MS) } }],
    },
    include: { supplier: true },
  });

  let reminded = 0;
  for (const invoice of dueForReminder) {
    const due = invoice.amountKori - (invoice.creditedKori ?? 0) - invoice.amountPaid;
    await createInAppNotification(
      invoice.buyerUserId,
      'Facture en retard',
      `${formatKori(due)} dû à ${invoice.supplier.name} · ${invoice.reference} — paie dès que possible`,
      { kind: 'trade_invoice_reminder', refId: invoice.id },
    );
    await db.tradeInvoice.update({
      where: { id: invoice.id },
      data: { reminderSentAt: now },
    });
    reminded += 1;
  }

  return { newlyOverdue: newlyOverdue.length, remindersSent: reminded };
}
