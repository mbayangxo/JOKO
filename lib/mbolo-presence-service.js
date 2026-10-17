/** Typing indicators + read receipts (Postgres-backed for serverless). */

import { prisma } from './prisma.js';

const TYPING_TTL_MS = 8000;

// Only ACTIVE members have read/typing state (message requests: a pending
// recipient's activity is never visible to the requester, and vice versa).
async function touchActive(userId, threadId, data) {
  const r = await prisma.mboloMember.updateMany({
    where: { threadId: String(threadId), userId, status: 'active' },
    data,
  });
  if (r.count === 0) throw new Error('not_a_member');
  return { ok: true };
}

export async function markThreadRead(userId, threadId) {
  return touchActive(userId, threadId, { lastReadAt: new Date() });
}

export async function markThreadTyping(userId, threadId) {
  return touchActive(userId, threadId, { lastTypingAt: new Date() });
}

export async function getThreadPresence(threadId, viewerUserId) {
  const members = await prisma.mboloMember.findMany({
    where: { threadId, status: 'active' },
    include: { user: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
  });
  const now = Date.now();
  const typing = members
    .filter((m) => m.userId !== viewerUserId && m.lastTypingAt && now - m.lastTypingAt.getTime() < TYPING_TTL_MS)
    .map((m) => ({
      userId: m.userId,
      name: m.user.name ?? m.user.handle,
      avatarEmoji: m.user.avatarEmoji,
    }));

  const readBy = members
    .filter((m) => m.userId !== viewerUserId && m.lastReadAt)
    .map((m) => ({ userId: m.userId, lastReadAt: m.lastReadAt.toISOString() }));

  return { typing, readBy };
}
