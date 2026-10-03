/**
 * Sharing a business or marketplace product as a rich card inside a Mboolo
 * thread. Unlike the affiliate share flow (affiliate-service.js), this is
 * plain informational sharing — no affiliate link/commission attached. The
 * server looks up the canonical title/price/image itself rather than
 * trusting client-supplied display fields, so a message can't be forged to
 * look like a real listing with a different price.
 *
 * Event sharing is intentionally not included: event creation/tickets moved
 * out of the main K21 app into a dedicated K21 Events app (see
 * docs/K21-EVENTS-APP.md) — the main app must not surface event/ticket UI.
 */
import { assertCanPost, MboloAccessError } from './mbolo-access.js';

export class MboloShareError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'MboloShareError';
  }
}

function shareFallbackBody(payload) {
  if (payload.refType === 'business') return `🏪 ${payload.title}`;
  return `🛍️ ${payload.title}`;
}

export async function shareToMbolo(db, userId, { threadId, refType, refId }) {
  try {
    await assertCanPost(db, threadId, userId, { kind: 'share' });
  } catch (error) {
    if (error instanceof MboloAccessError) throw new MboloShareError('not_a_member', 'Conversation introuvable');
    throw error;
  }

  let payload;
  if (refType === 'business') {
    const business = await db.business.findUnique({ where: { id: refId } });
    if (!business) throw new MboloShareError('not_found', 'Commerce introuvable');
    payload = {
      refType: 'business',
      refId: business.id,
      title: business.name,
      subtitle: business.category ?? null,
      imageUrl: business.imageUrl ?? null,
    };
  } else if (refType === 'product') {
    const product = await db.product.findUnique({ where: { id: refId }, include: { business: true } });
    if (!product?.active || !product.businessId) throw new MboloShareError('not_found', 'Produit introuvable');
    payload = {
      refType: 'product',
      refId: product.id,
      businessId: product.businessId,
      title: product.title,
      subtitle: product.business?.name ?? null,
      price: product.price,
      imageUrl: product.imageUrl ?? null,
    };
  } else {
    throw new MboloShareError('bad_ref_type', 'Type de partage invalide');
  }

  const message = await db.mboloMessage.create({
    data: {
      threadId,
      senderId: userId,
      kind: 'share',
      body: shareFallbackBody(payload),
      mediaUrl: JSON.stringify(payload),
    },
    include: { sender: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
  });
  await db.mboloThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });
  return message;
}
