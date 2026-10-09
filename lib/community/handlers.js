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
