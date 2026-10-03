/**
 * Mass/broadcast messaging — one message sent to many contacts at once,
 * WhatsApp-broadcast style: each recipient gets it as an individual DM in
 * their own direct thread, recipients never see each other or that it was
 * a broadcast. Restricted to existing friends (already vetted through the
 * friend-request flow), so there's no per-recipient first-message KYC gate
 * to run like a fresh conversation would need.
 */

import { ensureDirectMboloThread } from './friends-service.js';
import { assertCanPost, MboloAccessError } from './mbolo-access.js';

export class BroadcastError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'BroadcastError';
  }
}

export const MAX_BROADCAST_RECIPIENTS = 50;

export async function broadcastMboloMessage(db, senderId, { recipientHandles, body, kind = 'text', mediaUrl }) {
  const handles = [
    ...new Set((recipientHandles ?? []).map((h) => String(h).replace(/^@+/, '').trim().toLowerCase()).filter(Boolean)),
  ];
  if (handles.length === 0) throw new BroadcastError('no_recipients', 'Choisis au moins un destinataire');
  if (handles.length > MAX_BROADCAST_RECIPIENTS) {
    throw new BroadcastError('too_many', `Maximum ${MAX_BROADCAST_RECIPIENTS} destinataires par diffusion`);
  }

  const friends = await db.userFriend.findMany({
    where: { userId: senderId, friend: { handle: { in: handles } } },
    include: { friend: { select: { id: true, handle: true, name: true } } },
  });
  const foundHandles = new Set(friends.map((f) => f.friend.handle.toLowerCase()));
  const missing = handles.filter((h) => !foundHandles.has(h));
  if (missing.length > 0) {
    throw new BroadcastError('not_friends', `Pas encore ami avec : ${missing.map((h) => `@${h}`).join(', ')}`);
  }

  const recipients = [];
  for (const f of friends) {
    const thread = await ensureDirectMboloThread(db, senderId, f.friend.id);
    try {
      await assertCanPost(db, thread.id, senderId, { kind, body });
    } catch (error) {
      if (error instanceof MboloAccessError) continue; // blocked: skip silently
      throw error;
    }
    const message = await db.mboloMessage.create({
      data: { threadId: thread.id, senderId, body: body ?? '', kind, mediaUrl: mediaUrl ?? null },
    });
    await db.mboloThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
    recipients.push({ handle: f.friend.handle, name: f.friend.name, threadId: thread.id, messageId: message.id });
  }

  return { sentCount: recipients.length, recipients };
}
