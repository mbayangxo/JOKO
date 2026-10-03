import { hitBucket } from './request-limits.js';

/**
 * Mboolo message requests. A public handle makes someone discoverable; it
 * does NOT grant a conversation. Per-member state on MboloMember.status:
 *
 *   active     accepted (or deliberate relationship: friends, invite link, creator)
 *   requested  invited by a stranger; may only see the request card
 *   declined   said no; the requester can never re-request into a new thread
 *   blocked    said no + blocked the requester (UserBlock)
 *
 * While any other member of a DIRECT thread is not active, the requester may
 * send exactly ONE short text intro. No media, no commerce/payment cards, no
 * calls, no presence/read state in either direction. Only active members can
 * read, post, see presence, ring a call or receive receipts.
 *
 * Trust is never inferred from a marketplace or payment transaction — only
 * an accepted friendship, an explicit accept, or a voluntary invite-link join.
 */

export const MEMBER_ACTIVE = 'active';
export const MEMBER_REQUESTED = 'requested';
export const MEMBER_DECLINED = 'declined';
export const MEMBER_BLOCKED = 'blocked';

export const INTRO_MAX_CHARS = 500;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export class MboloAccessError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Same answer for "no such thread" and "not yours" — no thread enumeration. */
export const notFound = () => new MboloAccessError('not_found', 'Conversation introuvable', 403);
const cannotMessage = () =>
  new MboloAccessError('cannot_message', 'Impossible d’envoyer une demande de message à ce compte.', 403);

export async function areFriends(db, aId, bId) {
  const row = await db.userFriend.findFirst({ where: { userId: aId, friendId: bId }, select: { id: true } });
  return Boolean(row);
}

/** Either side blocked the other (UserBlock). */
export async function blockedEitherWay(db, aId, bId) {
  const row = await db.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: aId, blockedUserId: bId },
        { blockerId: bId, blockedUserId: aId },
      ],
    },
    select: { id: true },
  });
  return Boolean(row);
}

/** The recipient has ever declined or blocked a request from this requester. */
async function previouslyRefused(db, requesterId, recipientId) {
  const row = await db.mboloMember.findFirst({
    where: {
      userId: recipientId,
      status: { in: [MEMBER_DECLINED, MEMBER_BLOCKED] },
      OR: [{ invitedById: requesterId }, { thread: { creatorId: requesterId } }],
    },
    select: { id: true },
  });
  return Boolean(row);
}

/** Rate limit for opening requests to strangers (per requester). */
export async function chargeMessageRequests(userId, count = 1) {
  if (count <= 0) return;
  const perHour = envInt('RL_MSG_REQUEST_HOUR', 10);
  const perDay = envInt('RL_MSG_REQUEST_DAY', 30);
  let hour = 0;
  let day = 0;
  for (let i = 0; i < count; i += 1) {
    hour = await hitBucket(`msgreq-h:${userId}`, REQUEST_WINDOW_MS);
    day = await hitBucket(`msgreq-d:${userId}`, DAY_MS);
  }
  if (hour > perHour || day > perDay) {
    throw new MboloAccessError('rate_limited', 'Trop de demandes de message. Réessaie plus tard.', 429);
  }
}

/**
 * Status a new member should get when `inviterId` puts `targetId` in a thread.
 * Throws cannot_message when the target blocked/declined the inviter.
 */
export async function initialStatusFor(db, inviterId, targetId) {
  if (await blockedEitherWay(db, inviterId, targetId)) throw cannotMessage();
  if (await previouslyRefused(db, inviterId, targetId)) throw cannotMessage();
  return (await areFriends(db, targetId, inviterId)) ? MEMBER_ACTIVE : MEMBER_REQUESTED;
}

/** Membership of any status, or 404 (no enumeration of other people's threads). */
export async function getMembership(db, threadId, userId) {
  if (!threadId) throw notFound();
  const member = await db.mboloMember.findUnique({
    where: { threadId_userId: { threadId: String(threadId), userId } },
  });
  if (!member) throw notFound();
  return member;
}

/** Active membership required for reading, presence, typing, read receipts, invites. */
export async function requireActiveMember(db, threadId, userId) {
  const member = await getMembership(db, threadId, userId);
  if (member.status === MEMBER_REQUESTED) {
    throw new MboloAccessError('request_pending', 'Accepte la demande pour voir cette conversation.', 403);
  }
  if (member.status !== MEMBER_ACTIVE) throw notFound();
  return member;
}

/**
 * Can `userId` post a message of `kind` in `threadId`? Returns { intro } where
 * intro=true means this is the single allowed request message.
 *
 * kind: 'text' | media kinds | 'share' | 'commerce' | 'payment' | 'call' | 'affiliate_product'
 */
export async function assertCanPost(db, threadId, userId, { kind = 'text', body = '' } = {}) {
  await requireActiveMember(db, threadId, userId);
  const thread = await db.mboloThread.findUnique({
    where: { id: String(threadId) },
    select: { id: true, type: true, members: { select: { userId: true, status: true } } },
  });
  if (!thread) throw notFound();
  const others = thread.members.filter((m) => m.userId !== userId);

  if (thread.type === 'direct') {
    const other = others[0];
    if (other && (await blockedEitherWay(db, userId, other.userId))) throw cannotMessage();
    if (other && other.status !== MEMBER_ACTIVE) {
      // Pending direct request: one short text intro, nothing else. A declined
      // or blocked recipient looks exactly like a pending one to the requester.
      if (kind !== 'text') {
        throw new MboloAccessError('request_pending', 'Seul un court message texte est possible avant acceptation.', 403);
      }
      if (String(body ?? '').trim().length > INTRO_MAX_CHARS) {
        throw new MboloAccessError('intro_too_long', `Message de demande limité à ${INTRO_MAX_CHARS} caractères.`, 400);
      }
      const already = await db.mboloMessage.count({ where: { threadId: thread.id, senderId: userId } });
      if (already > 0 || other.status !== MEMBER_REQUESTED) {
        throw new MboloAccessError('request_pending', 'Ta demande est envoyée. Attends qu’elle soit acceptée.', 403);
      }
      return { intro: true };
    }
  }
  return { intro: false };
}

/** Thread is a direct thread whose members are all active (used for receipts / calls). */
export async function allActive(db, threadId, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const n = await db.mboloMember.count({ where: { threadId: String(threadId), userId: { in: ids }, status: MEMBER_ACTIVE } });
  return n === ids.length;
}

/** Find the direct thread between two users (any status). */
export async function findDirectThread(db, aId, bId) {
  return db.mboloThread.findFirst({
    where: {
      type: 'direct',
      AND: [{ members: { some: { userId: aId } } }, { members: { some: { userId: bId } } }],
    },
    include: { members: { select: { userId: true, status: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Accept / decline / block a request. Conditional on the member still being
 * 'requested', so concurrent responses resolve to exactly one outcome.
 */
export async function respondToRequest(db, threadId, userId, action) {
  const member = await getMembership(db, threadId, userId);
  const next = { accept: MEMBER_ACTIVE, decline: MEMBER_DECLINED, block: MEMBER_BLOCKED }[action];
  if (!next) throw new MboloAccessError('bad_action', 'Action invalide', 400);

  // Blocking is always allowed (also from an active or declined conversation).
  const allowedFrom = action === 'block' ? [MEMBER_REQUESTED, MEMBER_ACTIVE, MEMBER_DECLINED] : [MEMBER_REQUESTED];
  const updated = await db.mboloMember.updateMany({
    where: { id: member.id, status: { in: allowedFrom } },
    data: { status: next, respondedAt: new Date(), lastReadAt: null, lastTypingAt: null },
  });
  if (updated.count === 0) {
    const current = await db.mboloMember.findUnique({ where: { id: member.id }, select: { status: true } });
    if (current?.status === next) return { status: next, changed: false };
    throw new MboloAccessError('already_responded', 'Cette demande a déjà reçu une réponse.', 409);
  }
  if (action === 'accept') {
    await db.mboloMember.update({ where: { id: member.id }, data: { lastReadAt: new Date() } });
  }

  let blockedUserId = null;
  if (action === 'block') {
    const thread = await db.mboloThread.findUnique({
      where: { id: member.threadId },
      select: { type: true, creatorId: true, members: { select: { userId: true } } },
    });
    blockedUserId =
      member.invitedById ??
      (thread?.type === 'direct' ? thread.members.find((m) => m.userId !== userId)?.userId : thread?.creatorId) ??
      null;
    if (blockedUserId && blockedUserId !== userId) {
      await db.userBlock.upsert({
        where: { blockerId_blockedUserId: { blockerId: userId, blockedUserId } },
        update: {},
        create: { blockerId: userId, blockedUserId },
      });
    }
  }
  return { status: next, changed: true, blockedUserId };
}

/** Who should be blamed for a request (for report): inviter, else the direct counterpart / creator. */
export async function requestCounterpart(db, threadId, userId) {
  const member = await getMembership(db, threadId, userId);
  if (member.invitedById) return member.invitedById;
  const thread = await db.mboloThread.findUnique({
    where: { id: member.threadId },
    select: { type: true, creatorId: true, members: { select: { userId: true } } },
  });
  if (thread?.type === 'direct') return thread.members.find((m) => m.userId !== userId)?.userId ?? null;
  return thread?.creatorId !== userId ? thread?.creatorId : null;
}

/** Public card for a person inside Mboolo (no phone/email/ids beyond the user id). */
export const MBOLO_PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  handle: true,
  avatarEmoji: true,
  avatarUrl: true,
  statusText: true,
};

/**
 * Explicit DTO for a thread as seen by `viewerId`. Non-active members never
 * expose read/typing state, and a requester can't tell pending from declined
 * or blocked (all shown as 'pending').
 */
export function threadDto(thread, viewerId) {
  const me = thread.members?.find((m) => m.userId === viewerId);
  const members = (thread.members ?? []).map((m) => {
    const self = m.userId === viewerId;
    const active = m.status === MEMBER_ACTIVE;
    return {
      userId: m.userId,
      role: m.role,
      status: self ? m.status : active ? MEMBER_ACTIVE : 'pending',
      lastReadAt: active && me?.status === MEMBER_ACTIVE ? (m.lastReadAt ?? null) : null,
      user: m.user
        ? {
            id: m.user.id,
            name: m.user.name ?? null,
            handle: m.user.handle ?? null,
            avatarEmoji: m.user.avatarEmoji ?? null,
            avatarUrl: m.user.avatarUrl ?? null,
            statusText: m.user.statusText ?? null,
          }
        : undefined,
    };
  });
  const pending = members.some((m) => m.userId !== viewerId && m.status !== MEMBER_ACTIVE);
  return {
    id: thread.id,
    name: thread.name ?? null,
    type: thread.type,
    creatorId: thread.creatorId,
    commerceType: thread.commerceType ?? null,
    commerceRefId: thread.commerceRefId ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    myStatus: me?.status ?? null,
    requestPending: thread.type === 'direct' ? pending : false,
    members,
    ...(thread.messages ? { messages: thread.messages } : {}),
  };
}


/**
 * One-time migration of conversations created before message requests
 * existed. A legacy member (no invitedById, never responded) who is not the
 * creator, never posted in the thread and is not a friend of the creator was
 * put there without consent: they become 'requested' (invited by the creator).
 * Anyone who has posted keeps the conversation (previously accepted).
 * Partner/system and commerce (tontine) threads are out of scope.
 *
 * Idempotent; dryRun returns the count only.
 */
export async function migrateLegacyThreadsToRequests(db, { dryRun = true } = {}) {
  const where = `
    FROM "MboloMember" m
    JOIN "MboloThread" t ON t."id" = m."threadId"
    WHERE m."status" = 'active'
      AND m."invitedById" IS NULL
      AND m."respondedAt" IS NULL
      AND m."userId" <> t."creatorId"
      AND t."type" IN ('direct', 'group')
      AND t."commerceType" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "MboloMessage" x WHERE x."threadId" = m."threadId" AND x."senderId" = m."userId")
      AND NOT EXISTS (SELECT 1 FROM "UserFriend" f WHERE f."userId" = m."userId" AND f."friendId" = t."creatorId")`;
  const [{ n }] = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n ${where}`);
  const [{ kept }] = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS kept FROM "MboloMember" m JOIN "MboloThread" t ON t."id" = m."threadId"
     WHERE m."status" = 'active' AND m."userId" <> t."creatorId" AND t."type" IN ('direct','group')`,
  );
  if (dryRun) return { mode: 'DRY_RUN', toRequested: n, activeNonCreatorMembers: kept };
  const updated = await db.$executeRawUnsafe(`
    UPDATE "MboloMember" SET "status" = 'requested', "invitedById" = sub."creatorId", "lastReadAt" = NULL, "lastTypingAt" = NULL
    FROM (SELECT m."id", t."creatorId" ${where}) sub
    WHERE "MboloMember"."id" = sub."id"`);
  return { mode: 'EXECUTED', toRequested: updated, activeNonCreatorMembers: kept };
}
