import { prisma } from '../prisma.js';

/**
 * J10 notifications: one place to create a categorized, deduplicated, preference-aware in-app
 * notification, and to read them (by category, unread count, mark all).
 *  - Categories: money, security, orders, deliveries, work, community, school.
 *  - money and security can never be muted (a person must always see money movement and account
 *    security events); the others can be muted per person.
 *  - dedupeKey identifies the real event ("shipment:<id>:delivered"): a retry or a double emit
 *    never creates a second notification.
 *  - Notifications only describe real objects (refId) — they never carry an action that moves money,
 *    assigns work or changes permissions by itself; the app opens the object's own screen.
 */
export const CATEGORIES = ['money', 'security', 'orders', 'deliveries', 'work', 'community', 'school'];
export const UNMUTABLE = new Set(['money', 'security']);

/** Legacy rows have no category: derive it from `kind`. */
export function categoryOf(n) {
  if (n.category) return n.category;
  const k = String(n.kind ?? '');
  if (/^(money|gift|pay|cash|deposit|withdraw|refund|transfer|agent_payout|affiliate|jekkal|kori|scheduled)/.test(k)) return 'money';
  if (/^(security|login|device|credential|pin|kyc|agent_approved)/.test(k)) return 'security';
  if (/^(marketplace_order|order|low_stock|trade_|business_invitation|distribution_invitation)/.test(k)) return 'orders';
  if (/^(shipment|delivery|hub_parcel|pickup)/.test(k)) return 'deliveries';
  if (/^work/.test(k)) return 'work';
  if (/^(school|student)/.test(k)) return 'school';
  if (/^(mbolo|friend|group|community|moderation|tontine)/.test(k)) return 'community';
  return 'money'; // unknown legacy kinds were money alerts: never hide them behind a mute
}

export async function mutedCategories(db, userId) {
  const s = await db.communitySettings.findUnique({ where: { userId }, select: { mutedCategories: true } });
  return (s?.mutedCategories ?? []).filter((c) => !UNMUTABLE.has(c));
}

/**
 * Create a notification (inside the caller's transaction when `db` is a tx). Returns the row,
 * or null when the category is muted or the event was already notified.
 */
export async function notifyEvent(db, userId, { category, title, body, kind = null, refId = null, dedupeKey = null, actionLabel = null }) {
  if (!userId || !CATEGORIES.includes(category)) return null;
  if (!UNMUTABLE.has(category) && (await mutedCategories(db, userId)).includes(category)) return null;
  const data = { userId, title: String(title).slice(0, 120), body: String(body).slice(0, 400), kind, refId, category, dedupeKey, actionLabel };
  if (!dedupeKey) return db.notification.create({ data });
  // ON CONFLICT DO NOTHING keeps an enclosing transaction usable (a unique violation would abort it).
  const rows = await db.$queryRaw`
    INSERT INTO "Notification" ("id", "userId", "title", "body", "kind", "refId", "category", "dedupeKey", "actionLabel", "read", "createdAt", "updatedAt")
    VALUES (${`ntf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}, ${userId}, ${data.title}, ${data.body}, ${kind}, ${refId}, ${category}, ${dedupeKey}, ${actionLabel}, false, now(), now())
    ON CONFLICT ("userId", "dedupeKey") DO NOTHING RETURNING "id"`;
  return rows[0] ?? null;
}

const shape = (n) => ({ id: n.id, title: n.title, body: n.body, kind: n.kind, refId: n.refId, category: categoryOf(n), actionLabel: n.actionLabel, read: n.read, createdAt: n.createdAt.toISOString() });

/** List (cursor = createdAt of the last item), optionally one category. Compact by design (low data). */
export async function listNotifications(userId, { category = null, before = null, limit = 30 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const where = { userId, ...(before ? { createdAt: { lt: new Date(before) } } : {}) };
  // Category is derived for legacy rows, so filter after reading a bounded window.
  const rows = await prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: category ? take * 4 : take });
  const items = rows.map(shape).filter((n) => !category || n.category === category).slice(0, take);
  return { items, nextBefore: items.length === take ? items.at(-1).createdAt : null };
}

/** Unread counts per category; muted categories are not counted (the badge is honest and quiet). */
export async function unreadSummary(userId) {
  const [rows, muted] = await Promise.all([
    prisma.notification.findMany({ where: { userId, read: false }, select: { kind: true, category: true }, take: 1000 }),
    mutedCategories(prisma, userId),
  ]);
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const r of rows) byCategory[categoryOf(r)] += 1;
  const total = Object.entries(byCategory).filter(([c]) => !muted.includes(c)).reduce((s, [, n]) => s + n, 0);
  return { total, byCategory, muted };
}

export async function markAllRead(userId, { category = null } = {}) {
  if (!category) return { updated: (await prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } })).count };
  const ids = (await prisma.notification.findMany({ where: { userId, read: false }, select: { id: true, kind: true, category: true }, take: 1000 }))
    .filter((n) => categoryOf(n) === category).map((n) => n.id);
  return { updated: (await prisma.notification.updateMany({ where: { id: { in: ids }, userId }, data: { read: true } })).count };
}

export async function setMutedCategories(userId, categories) {
  const clean = [...new Set(categories)].filter((c) => CATEGORIES.includes(c) && !UNMUTABLE.has(c));
  const s = await prisma.communitySettings.upsert({ where: { userId }, create: { userId, mutedCategories: clean }, update: { mutedCategories: clean } });
  return { mutedCategories: s.mutedCategories, unmutable: [...UNMUTABLE] };
}
