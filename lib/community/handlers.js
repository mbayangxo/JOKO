import { z } from 'zod';
import { validationError } from '../validation.js';
import * as N from './notify.js';
import { CommunityError } from './errors.js';

/** J10 community / daily-life handlers. Errors carry their own status; nothing here moves money. */
export const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof CommunityError) return res.status(error.status).json({ error: error.message, code: error.code });
    throw error;
  }
};
export const parse = (schema, req, res) => {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) { validationError(res, r.error); return null; }
  return r.data;
};
const category = z.enum(N.CATEGORIES);

/* ── S4 notifications ─────────────────────────────────────────────────────────────── */
export const notificationsFeed = wrap(async (req, res) => {
  const c = req.query.category ? category.safeParse(req.query.category) : { success: true, data: null };
  if (!c.success) return res.status(400).json({ error: 'Catégorie inconnue', code: 'invalid' });
  res.json(await N.listNotifications(req.userId, { category: c.data, before: req.query.before ?? null, limit: req.query.limit }));
});
export const notificationsUnread = wrap(async (req, res) => res.json(await N.unreadSummary(req.userId)));
export const notificationsReadAll = wrap(async (req, res) => {
  const b = parse(z.object({ category: category.optional() }).strict(), req, res);
  if (b) res.json(await N.markAllRead(req.userId, b));
});

/* ── settings (S4 mutes + S7 privacy) ─────────────────────────────────────────────── */
export const communitySettings = wrap(async (req, res) => {
  const { prisma } = await import('../prisma.js');
  if (req.method === 'PUT') {
    const b = parse(z.object({
      mutedCategories: z.array(z.string()).max(10).optional(),
      discoverableByPhone: z.enum(['everyone', 'connections', 'nobody']).optional(),
      neighbourhoodVisible: z.boolean().optional(),
    }).strict(), req, res);
    if (!b) return;
    if (b.mutedCategories) await N.setMutedCategories(req.userId, b.mutedCategories);
    const rest = { ...(b.discoverableByPhone ? { discoverableByPhone: b.discoverableByPhone } : {}), ...(b.neighbourhoodVisible !== undefined ? { neighbourhoodVisible: b.neighbourhoodVisible } : {}) };
    if (Object.keys(rest).length) await prisma.communitySettings.upsert({ where: { userId: req.userId }, create: { userId: req.userId, ...rest }, update: rest });
  }
  const s = await prisma.communitySettings.findUnique({ where: { userId: req.userId } });
  res.json({
    discoverableByPhone: s?.discoverableByPhone ?? 'everyone',
    neighbourhoodVisible: s?.neighbourhoodVisible ?? false,
    mutedCategories: (s?.mutedCategories ?? []).filter((c) => !N.UNMUTABLE.has(c)),
    categories: N.CATEGORIES,
    unmutable: [...N.UNMUTABLE],
  });
});

/* ── S1 Aujourd'hui ───────────────────────────────────────────────────────────────── */
export const today = wrap(async (req, res) => {
  const { todayFor } = await import('./today.js');
  const { body, etag } = await todayFor(req.userId);
  res.setHeader?.('ETag', etag);
  res.setHeader?.('Cache-Control', 'private, no-cache');
  if (req.headers?.['if-none-match'] === etag) return res.status(304).end();
  res.json(body);
});

/* ── S3 groups ────────────────────────────────────────────────────────────────────── */
const G = () => import('./groups.js');
const tid = (req) => String(req.query.id ?? '');
const uid = z.string().min(1).max(64);
export const groupRoster = wrap(async (req, res) => res.json(await (await G()).roster(req.userId, tid(req))));
export const groupRole = wrap(async (req, res) => {
  const b = parse(z.object({ userId: uid, role: z.enum(['admin', 'member', 'owner']) }).strict(), req, res);
  if (b) res.json(await (await G()).setRole(req.userId, tid(req), { targetUserId: b.userId, role: b.role }));
});
export const groupRemove = wrap(async (req, res) => {
  const b = parse(z.object({ userId: uid }).strict(), req, res);
  if (b) res.json(await (await G()).removeMember(req.userId, tid(req), { targetUserId: b.userId }));
});
export const groupMute = wrap(async (req, res) => {
  const b = parse(z.object({ userId: uid, hours: z.number().int().min(0).max(24 * 30) }).strict(), req, res);
  if (b) res.json(await (await G()).muteMember(req.userId, tid(req), { targetUserId: b.userId, hours: b.hours }));
});
export const groupSettings = wrap(async (req, res) => {
  const b = parse(z.object({ postingPolicy: z.enum(['all', 'admins']) }).strict(), req, res);
  if (b) res.json(await (await G()).setPostingPolicy(req.userId, tid(req), b));
});
export const groupInviteRevoke = wrap(async (req, res) => res.json(await (await G()).revokeInvite(req.userId, tid(req))));
export const groupLeave = wrap(async (req, res) => res.json(await (await G()).leaveGroup(req.userId, tid(req))));

/* ── S8 reports, moderation, appeals ─────────────────────────────────────────────── */
const M = () => import('./moderation.js');
export const messageReport = wrap(async (req, res) => {
  const { REPORT_CATEGORIES } = await M();
  const b = parse(z.object({ category: z.enum(REPORT_CATEGORIES), reason: z.string().trim().min(3).max(500) }).strict(), req, res);
  if (b) res.status(201).json(await (await M()).reportMessage(req.userId, tid(req), b));
});
export const myReports = wrap(async (req, res) => res.json(await (await M()).myReports(req.userId)));
export const myModeration = wrap(async (req, res) => res.json(await (await M()).myModeration(req.userId)));
export const moderationAppeal = wrap(async (req, res) => {
  const b = parse(z.object({ note: z.string().trim().min(10).max(1000) }).strict(), req, res);
  if (b) res.json(await (await M()).appealAction(req.userId, tid(req), b));
});
export const adminModerationQueue = wrap(async (req, res) => res.json(await (await M()).moderationQueue({ status: req.query.status === 'resolved' ? 'resolved' : 'open', limit: req.query.limit })));
export const adminModerationResolve = wrap(async (req, res) => {
  const b = parse(z.object({ outcome: z.enum(['no_violation', 'warn', 'restrict_messaging']), days: z.number().int().min(1).max(30).optional(), note: z.string().trim().min(10).max(500) }).strict(), req, res);
  if (!b) return;
  if (b.outcome === 'restrict_messaging' && !b.days) return res.status(400).json({ error: 'Durée requise (1–30 jours)', code: 'invalid' });
  res.json(await (await M()).resolveReport(req.adminId, tid(req), b));
});
export const adminModerationAppeals = wrap(async (_req, res) => res.json(await (await M()).appealQueue()));
export const adminModerationAppealResolve = wrap(async (req, res) => {
  const b = parse(z.object({ outcome: z.enum(['upheld', 'lifted']), note: z.string().trim().min(10).max(500) }).strict(), req, res);
  if (b) res.json(await (await M()).resolveAppeal(req.adminId, tid(req), b));
});

/* ── S7 discovery / S6 neighbourhood ─────────────────────────────────────────────── */
export const contactsMatch = wrap(async (req, res) => {
  const b = parse(z.object({ hashes: z.array(z.string().length(64)).max(200) }).strict(), req, res);
  if (b) res.json(await (await import('./discovery.js')).matchContacts(req.userId, b.hashes));
});
export const neighbourhood = wrap(async (req, res) => res.json(await (await import('./discovery.js')).neighbourhood(req.userId)));

/* ── S5 order conversations ──────────────────────────────────────────────────────── */
export const orderConversation = wrap(async (req, res) => res.json(await (await import('./order-chat.js')).openOrderConversation(req.userId, tid(req))));
