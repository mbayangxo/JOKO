/**
 * User notifications — in-app + optional email.
 * SMS is ONLY sent when the user texts SOLDE (inbound balance query).
 * Payment alerts never trigger outbound SMS.
 */

import { prisma } from './prisma.js';
import { formatKori } from './kori.js';
import { sendAlertEmail } from './email-service.js';
import { safeError } from './log-redact.js';

/** Create in-app notification. Pass `db` (e.g. transaction client) inside money flows. */
export async function createInAppNotification(userId, title, body, extras = {}, db = prisma) {
  return db.notification.create({
    data: {
      userId,
      title,
      body,
      kind: extras.kind ?? null,
      refId: extras.refId ?? null,
      actionLabel: extras.actionLabel ?? null,
    },
  });
}

/**
 * Notify user in-app and optionally by email.
 * SMS is not used for proactive payment alerts — users text SOLDE for balance.
 */
export async function notifyUser(userId, { title, body }) {
  await createInAppNotification(userId, title, body);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) return;

  try {
    await sendAlertEmail(user.email, title, body);
  } catch (error) {
    console.error('[notify] Email failed (money already settled)', { userId, error: safeError(error) });
  }
}

/** Alert recipient when money lands — app + email only. */
export async function notifyMoneyReceived(recipientId, { amount, currency, senderLabel, giftCardTheme, reference }) {
  const user = await prisma.user.findUnique({
    where: { id: recipientId },
    include: { wallet: true },
  });
  if (!user?.wallet) return;

  const amountLabel =
    currency === 'kori'
      ? formatKori(amount)
      : `${amount.toLocaleString('fr-FR')} ${user.wallet.currency}`;

  const title = giftCardTheme ? 'Carte cadeau reçue 🎁' : 'Argent reçu';
  const body = giftCardTheme
    ? `${senderLabel ?? 'Quelqu\'un'} t'a envoyé ${amountLabel} avec une carte`
    : `${senderLabel ?? 'Quelqu\'un'} t'a envoyé ${amountLabel}`;

  await createInAppNotification(user.id, title, body, {
    kind: giftCardTheme ? 'gift_receive' : 'money_receive',
    refId: reference ?? null,
    actionLabel: giftCardTheme ? 'Ouvrir' : null,
  });

  if (user.email) {
    try {
      await sendAlertEmail(user.email, title, body);
    } catch (error) {
      console.error('[notify] Email failed (money already settled)', { recipientId, error: safeError(error) });
    }
  }
}

/** Alert user when a deposit / cash-in completes. */
export async function notifyDepositReceived(userId, { amount }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { wallet: true },
  });
  if (!user?.wallet) return;

  const amountLabel = `${amount.toLocaleString('fr-FR')} ${user.wallet.currency}`;

  await notifyUser(user.id, {
    title: 'Dépôt confirmé',
    body: `${amountLabel} ajoutés à ton compte`,
  });
}
