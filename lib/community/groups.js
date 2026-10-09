import { prisma } from '../prisma.js';
import { CommunityError } from './errors.js';
import { notifyEvent } from './notify.js';

/**
 * J10-S3 Mbolo groups with roles and moderation.
 *  - Roles: owner (the creator, or whoever the owner handed it to) > admin > member.
 *  - Owner/admins add and remove members, mute a member for a while, switch announcement mode
 *    (only owner/admins post), and revoke the invite link. Only the owner promotes/demotes admins.
 *  - An admin cannot remove or mute the owner or another admin; nobody acts on themselves this way.
 *  - Removed members never rejoin with the invite code; a member can leave at any time (the owner
 *    hands ownership over first unless they are the last member).
 *  - Chat membership is ONLY chat membership: removing someone from a tontine's group chat never
 *    changes the tontine membership or any money (J11 owns that, with its own consent rules).
 */
const MANAGERS = new Set(['owner', 'admin']);
const notFound = () => new CommunityError('not_found', 'Groupe introuvable', 404);

export function roleOf(_thread, member) {
  if (!member) return null;
  return member.role === 'owner' ? 'owner' : member.role === 'admin' ? 'admin' : 'member';
}

/** Legacy groups have no explicit owner row: the creator (if still active) becomes the owner, once. */
async function ensureOwner(db, thread) {
  if (await db.mboloMember.count({ where: { threadId: thread.id, role: 'owner' } })) return;
  await db.mboloMember.updateMany({ where: { threadId: thread.id, userId: thread.creatorId, status: 'active', role: { in: ['member', 'admin'] } }, data: { role: 'owner' } });
}

async function load(db, threadId, userId) {
  const thread = await db.mboloThread.findUnique({ where: { id: String(threadId) } });
  if (!thread || thread.type === 'direct') throw notFound();
  await ensureOwner(db, thread);
  const me = await db.mboloMember.findUnique({ where: { threadId_userId: { threadId: thread.id, userId } } });
  if (!me || me.status !== 'active') throw notFound();
  return { thread, me, myRole: roleOf(thread, me) };
}

export async function assertGroupManager(db, threadId, userId, { ownerOnly = false } = {}) {
  const ctx = await load(db, threadId, userId);
  if (ownerOnly ? ctx.myRole !== 'owner' : !MANAGERS.has(ctx.myRole)) throw new CommunityError('not_group_admin', ownerOnly ? 'Réservé au créateur du groupe' : 'Réservé aux administrateurs du groupe', 403);
  return ctx;
}

async function target(db, thread, userId) {
  const m = await db.mboloMember.findUnique({ where: { threadId_userId: { threadId: thread.id, userId } } });
  if (!m || !['active', 'requested'].includes(m.status)) throw new CommunityError('not_member', 'Cette personne n’est pas dans le groupe', 404);
  return m;
}

/** Owner/admin rank check: admins act only on members; nobody acts on the owner. */
function assertOutranks(thread, actorRole, targetMember) {
  const tr = roleOf(thread, targetMember);
  if (tr === 'owner' || (tr === 'admin' && actorRole !== 'owner')) throw new CommunityError('insufficient_rank', 'Impossible sur un administrateur ou le créateur', 403);
}

export async function roster(userId, threadId) {
  const { thread, myRole } = await load(prisma, threadId, userId);
  const members = await prisma.mboloMember.findMany({
    where: { threadId: thread.id, status: { in: ['active', 'requested'] } },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, role: true, status: true, mutedUntil: true, user: { select: { name: true, handle: true, avatarEmoji: true } } },
  });
  const now = new Date();
  return {
    threadId: thread.id, name: thread.name, postingPolicy: thread.postingPolicy, myRole, inviteActive: Boolean(thread.inviteCode),
    members: members.map((m) => ({ userId: m.userId, name: m.user?.name ?? null, handle: m.user?.handle ?? null, avatarEmoji: m.user?.avatarEmoji ?? null, role: roleOf(thread, m), status: m.status, muted: Boolean(m.mutedUntil && m.mutedUntil > now) })),
  };
}

export async function setRole(userId, threadId, { targetUserId, role }) {
  const { thread } = await assertGroupManager(prisma, threadId, userId, { ownerOnly: true });
  if (targetUserId === userId) throw new CommunityError('invalid', 'Choisis un autre membre', 400);
  const m = await target(prisma, thread, targetUserId);
  if (m.status !== 'active') throw new CommunityError('not_member', 'La personne doit d’abord accepter l’invitation', 409);
  if (role === 'owner') {
    // Hand ownership over: the previous owner becomes an admin.
    await prisma.$transaction([
      prisma.mboloMember.update({ where: { id: m.id }, data: { role: 'owner' } }),
      prisma.mboloMember.update({ where: { threadId_userId: { threadId: thread.id, userId } }, data: { role: 'admin' } }),
    ]);
  } else {
    await prisma.mboloMember.update({ where: { id: m.id }, data: { role } });
  }
  return roster(role === 'owner' ? targetUserId : userId, threadId);
}

export async function removeMember(userId, threadId, { targetUserId }) {
  const { thread, myRole } = await assertGroupManager(prisma, threadId, userId);
  if (targetUserId === userId) throw new CommunityError('invalid', 'Utilise « Quitter le groupe »', 400);
  const m = await target(prisma, thread, targetUserId);
  assertOutranks(thread, myRole, m);
  await prisma.mboloMember.update({ where: { id: m.id }, data: { status: 'removed', removedById: userId, removedAt: new Date(), mutedUntil: null } });
  await notifyEvent(prisma, targetUserId, { category: 'community', kind: 'group_removed', refId: thread.id, title: 'Retiré d’un groupe', body: `Tu ne fais plus partie de « ${thread.name ?? 'groupe'} »`, dedupeKey: `group:${thread.id}:removed:${m.id}:${Date.now()}` });
  return { removed: true };
}

export async function muteMember(userId, threadId, { targetUserId, hours }) {
  const { thread, myRole } = await assertGroupManager(prisma, threadId, userId);
  if (targetUserId === userId) throw new CommunityError('invalid', 'Choisis un autre membre', 400);
  const m = await target(prisma, thread, targetUserId);
  assertOutranks(thread, myRole, m);
  const until = hours > 0 ? new Date(Date.now() + hours * 3600_000) : null;
  await prisma.mboloMember.update({ where: { id: m.id }, data: { mutedUntil: until } });
  return { mutedUntil: until?.toISOString() ?? null };
}

export async function setPostingPolicy(userId, threadId, { postingPolicy }) {
  await assertGroupManager(prisma, threadId, userId);
  await prisma.mboloThread.update({ where: { id: String(threadId) }, data: { postingPolicy } });
  return roster(userId, threadId);
}

export async function revokeInvite(userId, threadId) {
  await assertGroupManager(prisma, threadId, userId);
  await prisma.mboloThread.update({ where: { id: String(threadId) }, data: { inviteCode: null } });
  return { inviteActive: false };
}

export async function leaveGroup(userId, threadId) {
  const { thread, me, myRole } = await load(prisma, threadId, userId);
  const others = await prisma.mboloMember.count({ where: { threadId: thread.id, status: 'active', userId: { not: userId } } });
  if (myRole === 'owner' && others > 0) throw new CommunityError('owner_must_transfer', 'Confie d’abord le groupe à un autre membre', 409);
  await prisma.mboloMember.update({ where: { id: me.id }, data: { status: 'left', removedAt: new Date() } });
  return { left: true };
}

/** Posting rules for groups (called from assertCanPost). Payment receipts never pass through here. */
export async function assertGroupPosting(db, thread, member) {
  if (thread.type === 'direct') return;
  const now = new Date();
  if (member.mutedUntil && member.mutedUntil > now) throw new CommunityError('muted', `Un administrateur t’a mis en sourdine jusqu’au ${member.mutedUntil.toLocaleString('fr-SN')}`, 403);
  if (thread.postingPolicy === 'admins' && !MANAGERS.has(roleOf(thread, member))) throw new CommunityError('announcement_only', 'Seuls les administrateurs publient dans ce groupe', 403);
}

/** Active moderation restriction on messaging (J10-S8), or null. */
export async function activeRestriction(db, userId) {
  return db.moderationAction.findFirst({ where: { userId, kind: 'restrict_messaging', liftedAt: null, until: { gt: new Date() } }, orderBy: { until: 'desc' } });
}
