import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx } from '../business-access.js';
import { CommunityError } from './errors.js';

/**
 * J10-S5 safe merchant ↔ customer communication: a conversation exists only around a REAL order,
 * opened by its buyer or by that shop's staff (business.orders.fulfill). No cold outreach: a merchant
 * cannot message people who have not ordered. The thread carries the order's support reference; a
 * block in either direction (person or business) closes it. Messages never change the order — status,
 * refunds and cancellations stay in the order's own flow with its own authorization.
 */
const notFound = () => new CommunityError('not_found', 'Commande introuvable', 404);

export async function openOrderConversation(userId, orderId) {
  const order = await prisma.order.findUnique({ where: { id: String(orderId) }, select: { id: true, buyerId: true, businessId: true, orderReference: true, business: { select: { id: true, name: true, ownerId: true } } } });
  if (!order?.business) throw notFound();
  let role = null;
  if (order.buyerId === userId) role = 'buyer';
  else {
    try {
      await assertBusinessAuthorityInTx(prisma, userId, order.businessId, 'business.orders.fulfill');
      role = 'merchant';
    } catch (e) {
      if (e instanceof OrgAccessError) throw notFound();
      throw e;
    }
  }
  const blocked = await prisma.userBlock.findFirst({
    where: { OR: [
      { blockerId: order.buyerId, blockedBusinessId: order.businessId },
      { blockerId: order.buyerId, blockedUserId: order.business.ownerId },
      { blockerId: order.business.ownerId, blockedUserId: order.buyerId },
    ] },
  });
  if (blocked) throw new CommunityError('cannot_message', 'Conversation impossible avec ce compte', 403);
  if (role === 'merchant' || role === 'buyer') {
    const { activeRestriction } = await import('./groups.js');
    if (await activeRestriction(prisma, userId)) throw new CommunityError('messaging_restricted', 'Messagerie limitée suite à un signalement (tu peux faire appel)', 403);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-chat:${order.id}`}, 0))`;
    let thread = await tx.mboloThread.findFirst({ where: { commerceType: 'order', commerceRefId: order.id } });
    if (!thread) {
      thread = await tx.mboloThread.create({
        data: {
          creatorId: userId, name: `${order.business.name} · ${order.orderReference ?? 'commande'}`, type: 'order', commerceType: 'order', commerceRefId: order.id,
          members: { create: [...new Set([order.buyerId, order.business.ownerId, userId])].map((id) => ({ userId: id, role: 'member', status: 'active', respondedAt: new Date() })) },
        },
      });
      await tx.mboloMessage.create({ data: { threadId: thread.id, senderId: userId, kind: 'support_ref', body: `Référence de la commande : ${order.orderReference ?? order.id}. Pour annuler, rembourser ou suivre, utilise la commande elle-même.` } });
    } else {
      // A staff member who opens it joins it (still only for this order).
      await tx.mboloMember.upsert({ where: { threadId_userId: { threadId: thread.id, userId } }, create: { threadId: thread.id, userId, role: 'member', status: 'active', respondedAt: new Date() }, update: {} });
    }
    return { threadId: thread.id, supportReference: order.orderReference ?? order.id, role };
  });
}
