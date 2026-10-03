/**
 * Universal verifiable payment / receipt cards in Mboolo threads.
 */

import { allActive, MEMBER_ACTIVE } from './mbolo-access.js';
import { formatKori } from './kori.js';

export function buildReceiptPayload({
  type,
  reference,
  amountKori,
  note,
  attachmentUrl,
  attachmentType,
  giftCardTheme,
  merchantName,
  merchantId,
  requestId,
  paidWith,
  undoUntil,
}) {
  return {
    type: type ?? 'send',
    reference,
    amountKori,
    note: note ?? null,
    attachmentUrl: attachmentUrl ?? null,
    attachmentType: attachmentType ?? null,
    giftCardTheme: giftCardTheme ?? null,
    merchantName: merchantName ?? null,
    merchantId: merchantId ?? null,
    requestId: requestId ?? null,
    paidWith: paidWith ?? null,
    undoUntil: undoUntil ?? null,
    verified: true,
  };
}

export function receiptBodyForPayload(payload) {
  const amount = payload.amountKori ?? 0;
  switch (payload.type) {
    case 'merchant_pay':
      return `🏪 ${formatKori(amount)} · ${payload.merchantName ?? 'Marchand'}`;
    case 'request_accept':
      return `✅ Demande acceptée · ${formatKori(amount)}`;
    case 'marketplace':
      return `🛍️ Commande · ${formatKori(amount)}`;
    case 'tontine_escrow':
      return `🤝 Caisse tontine · ${formatKori(amount)}`;
    default:
      return `💸 ${formatKori(amount)} envoyé${payload.note ? ` — ${payload.note}` : ''}`;
  }
}

export async function postMboloReceipt(db, { threadId, senderId, body, payload }) {
  const mediaUrl = JSON.stringify(payload);
  const message = await db.mboloMessage.create({
    data: {
      threadId,
      senderId,
      body: body ?? receiptBodyForPayload(payload),
      kind: 'payment',
      mediaUrl,
    },
    include: { sender: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
  });
  await db.mboloThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });
  return message;
}

/**
 * Post a payment receipt into a conversation — ONLY one where both payer and
 * recipient are active (accepted) members. A payment never creates a
 * conversation, never lands in a pending message request, and never implies
 * trust between the parties.
 */
export async function postPaymentReceipt(db, { threadId, senderId, recipientId, payload, body }) {
  if (threadId) {
    if (!(await allActive(db, threadId, [senderId, recipientId]))) return null;
    return postMboloReceipt(db, { threadId, senderId, body, payload });
  }
  if (!recipientId || recipientId === senderId) return null;
  const thread = await db.mboloThread.findFirst({
    where: {
      type: 'direct',
      AND: [
        { members: { some: { userId: senderId, status: MEMBER_ACTIVE } } },
        { members: { some: { userId: recipientId, status: MEMBER_ACTIVE } } },
      ],
    },
  });
  if (!thread) return null;
  return postMboloReceipt(db, { threadId: thread.id, senderId, body, payload });
}

export async function postCommerceCard(db, { threadId, senderId, body, payload }) {
  const message = await db.mboloMessage.create({
    data: {
      threadId,
      senderId,
      body,
      kind: 'commerce',
      mediaUrl: JSON.stringify(payload),
    },
    include: { sender: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
  });
  await db.mboloThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });
  return message;
}
