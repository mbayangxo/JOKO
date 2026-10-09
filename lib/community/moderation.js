import { prisma } from '../prisma.js';
import { CommunityError } from './errors.js';
import { notifyEvent } from './notify.js';

/**
 * J10-S8 reporting → review → action → appeal.
 *  - Reports: a person (trust/report, existing) or a specific message they can see (snapshot of the
 *    content at report time, so deletion cannot erase the evidence). ≤ 20 reports / reporter / day;
 *    one report per reporter per message.
 *  - Review: trust_safety operators see the queue (oldest first, with how often the target was
 *    reported in 30 days) and decide: no_violation | warn | restrict_messaging (1–30 days).
 *    No automatic punishment from report counts.
 *  - restrict_messaging stops new conversations and posts; it NEVER touches money (payments,
 *    refunds, payouts and receipts keep working) and never changes group, tontine or business roles.
 *  - The person acted on is told (security category: cannot be muted) and may appeal once within
 *    14 days; the appeal is decided by a DIFFERENT operator. The reporter is told the report was
 *    handled, never what happened to the other person.
 *  - Every decision is written to the admin audit log.
 */
const REPORTS_PER_DAY = 20;
const APPEAL_DAYS = 14;
const CATEGORIES = ['spam', 'harassment', 'scam', 'hate', 'violence', 'sexual', 'impersonation', 'other'];
export { CATEGORIES as REPORT_CATEGORIES };

async function audit(adminId, action, targetType, targetId, detail) {
  await prisma.adminAuditLog.create({ data: { adminUserId: adminId, action, targetType, targetId, detailJson: JSON.stringify(detail) } }).catch(() => {});
}

export async function reportMessage(userId, messageId, { category, reason }) {
  const msg = await prisma.mboloMessage.findUnique({ where: { id: String(messageId) }, select: { id: true, threadId: true, senderId: true, body: true, kind: true, createdAt: true } });
  const seen = msg && (await prisma.mboloMember.findUnique({ where: { threadId_userId: { threadId: msg.threadId, userId } } }));
  // Only a message the reporter can actually see; otherwise indistinguishable from "not found".
  if (!msg || !seen || !['active', 'requested'].includes(seen.status)) throw new CommunityError('not_found', 'Message introuvable', 404);
  if (msg.senderId === userId) throw new CommunityError('invalid', 'Tu ne peux pas signaler ton propre message', 400);
  const dup = await prisma.contentReport.findFirst({ where: { reporterId: userId, targetMessageId: msg.id } });
  if (dup) return { id: dup.id, status: dup.status, replayed: true };
  if ((await prisma.contentReport.count({ where: { reporterId: userId, createdAt: { gte: new Date(Date.now() - 86_400_000) } } })) >= REPORTS_PER_DAY) {
    throw new CommunityError('report_limit', 'Trop de signalements aujourd’hui — réessaie demain', 429);
  }
  const r = await prisma.contentReport.create({
    data: {
      reporterId: userId, targetUserId: msg.senderId, category, reason: String(reason).slice(0, 500), status: 'open',
      targetThreadId: msg.threadId, targetMessageId: msg.id,
      evidenceSnapshot: JSON.stringify({ kind: msg.kind, body: String(msg.body ?? '').slice(0, 1000), at: msg.createdAt.toISOString() }),
    },
  });
  return { id: r.id, status: r.status };
}

/** The reporter's own reports: handled or not — never what happened to the other person. */
export async function myReports(userId) {
  const rows = await prisma.contentReport.findMany({ where: { reporterId: userId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, category: true, status: true, createdAt: true, resolvedAt: true } });
  return { reports: rows.map((r) => ({ id: r.id, category: r.category, handled: r.status !== 'open', createdAt: r.createdAt.toISOString(), handledAt: r.resolvedAt?.toISOString() ?? null })) };
}

/* ── operators ───────────────────────────────────────────────────────────────────── */
export async function moderationQueue({ status = 'open', limit = 50 } = {}) {
  const rows = await prisma.contentReport.findMany({ where: { status }, orderBy: { createdAt: 'asc' }, take: Math.min(Number(limit) || 50, 200) });
  const since = new Date(Date.now() - 30 * 86_400_000);
  const out = [];
  for (const r of rows) {
    const [againstTarget, priorActions] = r.targetUserId
      ? await Promise.all([
        prisma.contentReport.count({ where: { targetUserId: r.targetUserId, createdAt: { gte: since } } }),
        prisma.moderationAction.count({ where: { userId: r.targetUserId } }),
      ])
      : [0, 0];
    out.push({
      id: r.id, category: r.category, reason: r.reason, status: r.status, createdAt: r.createdAt.toISOString(),
      targetUserId: r.targetUserId, targetBusinessId: r.targetBusinessId, targetMessageId: r.targetMessageId,
      evidence: r.evidenceSnapshot ? JSON.parse(r.evidenceSnapshot) : null, reportsAgainstTarget30d: againstTarget, priorActions,
    });
  }
  return { reports: out };
}

export async function resolveReport(adminId, reportId, { outcome, days, note }) {
  const r = await prisma.contentReport.findUnique({ where: { id: String(reportId) } });
  if (!r) throw new CommunityError('not_found', 'Signalement introuvable', 404);
  if (r.status !== 'open') return { id: r.id, status: r.status, resolution: r.resolution, replayed: true };
  if (outcome !== 'no_violation' && !r.targetUserId) throw new CommunityError('invalid', 'Action possible seulement sur une personne', 400);
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const u = await tx.contentReport.updateMany({ where: { id: r.id, status: 'open' }, data: { status: 'resolved', resolution: outcome, resolvedBy: adminId, resolvedAt: now, adminNotes: String(note).slice(0, 500) } });
    if (u.count !== 1) throw new CommunityError('conflict', 'Déjà traité', 409);
    let action = null;
    if (outcome !== 'no_violation') {
      action = await tx.moderationAction.create({ data: { userId: r.targetUserId, kind: outcome, until: outcome === 'restrict_messaging' ? new Date(now.getTime() + days * 86_400_000) : null, reportId: r.id, byAdminId: adminId, note: String(note).slice(0, 500) } });
      await notifyEvent(tx, r.targetUserId, {
        category: 'security', kind: 'moderation_action', refId: action.id,
        title: outcome === 'warn' ? 'Avertissement de la communauté' : 'Messagerie limitée',
        body: outcome === 'warn' ? 'Un de tes messages enfreint les règles de la communauté. Tu peux faire appel.' : `Tu ne peux plus écrire de nouveaux messages jusqu’au ${action.until.toLocaleDateString('fr-SN')}. Tes paiements ne sont pas touchés. Tu peux faire appel.`,
        dedupeKey: `moderation:${action.id}`,
      });
    }
    await notifyEvent(tx, r.reporterId, { category: 'community', kind: 'report_handled', refId: r.id, title: 'Signalement traité', body: 'Merci : ton signalement a été examiné par l’équipe K21.', dedupeKey: `report:${r.id}:handled` });
    return { id: r.id, status: 'resolved', resolution: outcome, actionId: action?.id ?? null, until: action?.until?.toISOString() ?? null };
  });
  await audit(adminId, 'community.report.resolve', 'content_report', r.id, { outcome, days: days ?? null, actionId: result.actionId });
  return result;
}

/* ── the person acted on ─────────────────────────────────────────────────────────── */
const actionView = (a, now = new Date()) => ({
  id: a.id, kind: a.kind, until: a.until?.toISOString() ?? null, active: a.kind === 'restrict_messaging' && !a.liftedAt && a.until > now,
  note: a.note, createdAt: a.createdAt.toISOString(), appealed: Boolean(a.appealedAt), appealOutcome: a.appealOutcome,
  appealable: !a.appealedAt && !a.liftedAt && a.createdAt.getTime() + APPEAL_DAYS * 86_400_000 > now.getTime(),
});

export async function myModeration(userId) {
  const rows = await prisma.moderationAction.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 });
  return { actions: rows.map((a) => actionView(a)) };
}

export async function appealAction(userId, actionId, { note }) {
  const a = await prisma.moderationAction.findUnique({ where: { id: String(actionId) } });
  if (!a || a.userId !== userId) throw new CommunityError('not_found', 'Décision introuvable', 404);
  if (a.appealedAt) return { ...actionView(a), replayed: true };
  if (!actionView(a).appealable) throw new CommunityError('appeal_closed', 'Le délai d’appel est dépassé', 409);
  const u = await prisma.moderationAction.updateMany({ where: { id: a.id, appealedAt: null }, data: { appealedAt: new Date(), appealNote: String(note).slice(0, 1000) } });
  if (u.count !== 1) return { ...actionView(await prisma.moderationAction.findUnique({ where: { id: a.id } })), replayed: true };
  return actionView(await prisma.moderationAction.findUnique({ where: { id: a.id } }));
}

export async function appealQueue() {
  const rows = await prisma.moderationAction.findMany({ where: { appealedAt: { not: null }, appealOutcome: null }, orderBy: { appealedAt: 'asc' }, take: 100 });
  return { appeals: rows.map((a) => ({ ...actionView(a), userId: a.userId, appealNote: a.appealNote, decidedBy: a.byAdminId, reportId: a.reportId })) };
}

export async function resolveAppeal(adminId, actionId, { outcome, note }) {
  const a = await prisma.moderationAction.findUnique({ where: { id: String(actionId) } });
  if (!a || !a.appealedAt) throw new CommunityError('not_found', 'Appel introuvable', 404);
  if (a.appealOutcome) return { id: a.id, appealOutcome: a.appealOutcome, replayed: true };
  if (a.byAdminId === adminId) throw new CommunityError('same_operator', 'Un autre opérateur doit trancher l’appel', 403);
  const now = new Date();
  const u = await prisma.moderationAction.updateMany({ where: { id: a.id, appealOutcome: null }, data: { appealOutcome: outcome, appealResolvedBy: adminId, appealResolvedAt: now, ...(outcome === 'lifted' ? { liftedAt: now } : {}) } });
  if (u.count !== 1) throw new CommunityError('conflict', 'Déjà tranché', 409);
  await notifyEvent(prisma, a.userId, { category: 'security', kind: 'moderation_appeal', refId: a.id, title: 'Décision sur ton appel', body: outcome === 'lifted' ? 'Ton appel est accepté : la mesure est levée.' : 'Ton appel est rejeté : la mesure est maintenue.', dedupeKey: `moderation:${a.id}:appeal` });
  await audit(adminId, 'community.appeal.resolve', 'moderation_action', a.id, { outcome, note: String(note).slice(0, 300) });
  return { id: a.id, appealOutcome: outcome, lifted: outcome === 'lifted' };
}
