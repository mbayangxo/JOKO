import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx } from '../business-access.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { recordIdentityEvent } from '../identity/audit.js';
import {
  CLASSIFICATION, EVIDENCE_KINDS, OFFER_TTL_HOURS, SETTLEMENT, TYPES, WorkError, assertAgeEligible, assertClassification,
  parseJson, ref, reviewFlags, sha, verifiedAge,
} from './contract.js';
import { acceptMilestoneInTx, escrowBalance, fundOfferInTx, maybeCompleteInTx, refundAssignmentInTx, refundOfferInTx } from './money.js';

/**
 * J9 core lifecycle (docs/JOKKO-J9-WORK.md):
 *   opportunity (verified business; flagged postings held for review) → apply | invite
 *   → screening (structured: skills / qualifications / availability; never protected attributes)
 *   → offer with explicit, immutable terms (prepaid offers FUNDED when sent)
 *   → worker acceptance (age / minor rules; explicit grant of any business role)
 *   → work: attendance by counterpart code, milestone evidence
 *   → business acceptance | dispute (auto-accept when the agreed window lapses)
 *   → funded earning (hold) → worker payout. Employment: wages through payroll (J5), never here.
 */
const notFound = (what = 'Introuvable') => new WorkError('not_found', what, 404);
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 30 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const newCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const hashCode = (assignmentId, purpose, code) => sha(`${assignmentId}:${purpose}:${String(code).toUpperCase().trim()}`);
const s = (v, n) => (v == null ? null : String(v).trim().slice(0, n));
const list = (v, n = 20, len = 60) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().toLowerCase().slice(0, len)).filter(Boolean))].slice(0, n) : []);

export async function bizAuth(tx, userId, businessId, cap) {
  try {
    await assertBusinessAuthorityInTx(tx, userId, businessId, cap);
  } catch (e) {
    if (e instanceof OrgAccessError) throw new WorkError(e.status === 404 ? 'not_found' : 'not_authorized', e.status === 404 ? 'Entreprise introuvable' : 'Action non autorisée pour cette entreprise', e.status === 404 ? 404 : 403);
    throw e;
  }
  const b = await tx.business.findUnique({ where: { id: businessId }, select: { id: true, name: true, ownerId: true, status: true, verificationStatus: true, type: true } });
  if (b.status !== 'active') throw new WorkError('business_not_active', 'Entreprise suspendue ou fermée', 403);
  return b;
}

/** People who can create / approve / fund work for a business can never be hired by it (self-dealing). */
async function hasBusinessAuthority(tx, userId, businessId) {
  const b = await tx.business.findUnique({ where: { id: businessId }, select: { ownerId: true } });
  if (b?.ownerId === userId) return true;
  const ms = await tx.businessMember.findMany({ where: { businessId, userId, status: 'active' }, select: { role: true } });
  const { BUSINESS_CAPABILITIES } = await import('../authz/catalog.js');
  return ms.some((m) => ['business.staffing.manage', 'business.pay', 'business.treasury'].some((c) => BUSINESS_CAPABILITIES[c]?.includes(m.role)));
}

/* ── views (privacy: a business sees what the work needs, nothing more) ───────────────── */

export function opportunityView(o, business) {
  return {
    id: o.id, reference: o.reference, type: o.type, typeLabel: TYPES[o.type]?.label ?? o.type, arrangement: o.arrangement,
    business: business ? { id: business.id, name: business.name, verified: business.verificationStatus === 'verified' } : undefined,
    title: o.title, description: o.description, area: o.area, skills: parseJson(o.skillsJson, []), headcount: o.headcount,
    payKind: o.payKind, rateKori: o.rateKori, units: o.units, funding: o.funding, hazardous: o.hazardous, minAge: o.minAge,
    nightWork: o.nightWork, hoursPerWeek: o.hoursPerWeek, durationWeeks: o.durationWeeks, status: o.status,
    closesAt: o.closesAt?.toISOString() ?? null, createdAt: o.createdAt.toISOString(),
  };
}

async function workerCard(db, userId) {
  const [u, p, quals, done, fb] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { handle: true, name: true } }),
    db.workProfile.findUnique({ where: { userId } }),
    db.workQualification.findMany({ where: { userId, status: 'verified' }, select: { kind: true, title: true } }),
    db.workAssignment.count({ where: { workerUserId: userId, status: 'completed' } }),
    db.workFeedback.aggregate({ where: { subjectUserId: userId, status: { in: ['published', 'upheld'] } }, _avg: { rating: true }, _count: { rating: true } }),
  ]);
  return {
    handle: u?.handle ?? null, name: u?.name ?? null, headline: p?.headline ?? null, skills: parseJson(p?.skillsJson ?? '[]', []),
    areas: parseJson(p?.areasJson ?? '[]', []), availability: p?.availability ?? null, verifiedQualifications: quals,
    completedAssignments: done,
    // Shown only with enough independent feedback; contested feedback is excluded until ruled.
    rating: fb._count.rating >= 3 ? Math.round(fb._avg.rating * 10) / 10 : null, ratingCount: fb._count.rating,
  };
}

function offerView(o) {
  return { id: o.id, reference: o.reference, opportunityId: o.opportunityId, applicationId: o.applicationId, arrangement: o.arrangement, terms: parseJson(o.termsJson, {}), termsHash: o.termsHash, totalKori: o.totalKori, funding: o.funding, fundingStatus: o.fundingStatus, status: o.status, expiresAt: o.expiresAt.toISOString(), createdAt: o.createdAt.toISOString() };
}

async function assignmentView(db, a, { role }) {
  const [ms, offer, earnings, disputes, biz] = await Promise.all([
    db.workMilestone.findMany({ where: { assignmentId: a.id }, orderBy: { seq: 'asc' } }),
    db.workOffer.findUnique({ where: { id: a.offerId } }),
    db.workEarning.findMany({ where: { assignmentId: a.id }, orderBy: { createdAt: 'asc' } }),
    db.workDispute.findMany({ where: { assignmentId: a.id }, orderBy: { createdAt: 'asc' } }),
    db.business.findUnique({ where: { id: a.businessId }, select: { id: true, name: true } }),
  ]);
  return {
    id: a.id, reference: a.reference, type: a.type, arrangement: a.arrangement, status: a.status, totalKori: a.totalKori, funding: a.funding,
    refundedKori: a.refundedKori, escrowKori: a.funding === 'prepaid' ? await escrowBalance(db, a.offerId) : 0,
    business: biz, terms: parseJson(offer.termsJson, {}), termsHash: offer.termsHash,
    worker: role === 'business' ? await workerCard(db, a.workerUserId) : undefined,
    checkedInAt: a.checkedInAt?.toISOString() ?? null, checkedOutAt: a.checkedOutAt?.toISOString() ?? null,
    milestones: ms.map((m) => ({ id: m.id, seq: m.seq, title: m.title, amountKori: m.amountKori, kind: m.kind, status: m.status, submittedAt: m.submittedAt?.toISOString() ?? null, acceptDeadline: m.acceptDeadline?.toISOString() ?? null, acceptedBy: m.acceptedBy === 'auto' || m.acceptedBy === 'ruling' ? m.acceptedBy : m.acceptedBy ? 'business' : null })),
    earnings: earnings.map((e) => ({ id: e.id, milestoneId: e.milestoneId, amountKori: e.amountKori, classification: e.classification, status: e.status, contestableUntil: e.contestableUntil?.toISOString() ?? null, releasableAt: e.releasableAt.toISOString() })),
    disputes: disputes.map((d) => ({ id: d.id, kind: d.kind, openedByRole: d.openedByRole, status: d.status, resolution: d.resolution, appealable: ['awaiting_settlement', 'resolved'].includes(d.status) && !d.appealedAt && !d.settledAt && d.resolvedAt && d.resolvedAt.getTime() + SETTLEMENT.appealHours * 3600_000 > Date.now(), executableAfter: d.executableAfter?.toISOString() ?? null, createdAt: d.createdAt.toISOString() })),
    createdAt: a.createdAt.toISOString(), completedAt: a.completedAt?.toISOString() ?? null,
  };
}

/* ── worker profile, qualifications, blocks ─────────────────────────────────────────── */

export async function getMyProfile(userId) {
  const p = await prisma.workProfile.findUnique({ where: { userId } });
  const quals = await prisma.workQualification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  return {
    profile: p ? { headline: p.headline, skills: parseJson(p.skillsJson, []), areas: parseJson(p.areasJson, []), availability: p.availability, visibility: p.visibility, portfolio: parseJson(p.portfolioJson, []) } : null,
    qualifications: quals.map((q) => ({ id: q.id, kind: q.kind, title: q.title, issuer: q.issuer, status: q.status })),
    card: await workerCard(prisma, userId),
  };
}

export async function upsertMyProfile(userId, body) {
  const data = {
    headline: s(body.headline, 120), skillsJson: JSON.stringify(list(body.skills)), areasJson: JSON.stringify(list(body.areas, 10)),
    availability: s(body.availability, 200), visibility: ['private', 'applications_only', 'discoverable'].includes(body.visibility) ? body.visibility : 'applications_only',
    portfolioJson: JSON.stringify((Array.isArray(body.portfolio) ? body.portfolio : []).slice(0, 10).map((x) => ({ title: s(x?.title, 80), ref: s(x?.ref, 200) })).filter((x) => x.title)),
  };
  await prisma.workProfile.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  return getMyProfile(userId);
}

export async function addQualification(userId, { kind, title, issuer, evidenceRef }) {
  if (!['skill', 'certificate', 'licence', 'training', 'experience'].includes(kind)) throw new WorkError('invalid', 'Type inconnu', 400);
  if ((await prisma.workQualification.count({ where: { userId } })) >= 30) throw new WorkError('limit', 'Trop de qualifications', 409);
  const q = await prisma.workQualification.create({ data: { userId, kind, title: s(title, 120), issuer: s(issuer, 120), evidenceRef: s(evidenceRef, 200) } });
  return { id: q.id, kind: q.kind, title: q.title, status: q.status };
}

export async function blockBusiness(userId, businessId) {
  if (!(await prisma.business.findUnique({ where: { id: businessId }, select: { id: true } }))) throw notFound('Entreprise introuvable');
  await prisma.workBlock.upsert({ where: { userId_businessId: { userId, businessId } }, update: {}, create: { userId, businessId } });
  // Pending invitations / offers from a blocked business are withdrawn (offer escrow refunded).
  const offers = await prisma.workOffer.findMany({ where: { workerUserId: userId, businessId, status: 'sent' }, select: { id: true } });
  for (const o of offers) await closeOffer(o.id, 'declined', { actorUserId: userId });
  await prisma.workApplication.updateMany({ where: { workerUserId: userId, status: 'invited', opportunityId: { in: (await prisma.workOpportunity.findMany({ where: { businessId }, select: { id: true } })).map((x) => x.id) } }, data: { status: 'declined' } });
  return { blocked: true };
}

const isBlocked = (db, userId, businessId) => db.workBlock.findUnique({ where: { userId_businessId: { userId, businessId } } });

/* ── opportunities ─────────────────────────────────────────────────────────────────── */

export async function createOpportunity(userId, businessId, body) {
  const t = TYPES[body.type];
  if (!t) throw new WorkError('invalid', 'Type de travail inconnu', 400);
  const funding = t.arrangements[body.arrangement];
  if (!funding) throw new WorkError('invalid_arrangement', `${t.label} : forme de travail non proposée`, 400);
  if (body.payKind === 'wage' && body.arrangement !== 'employment') throw new WorkError('invalid_arrangement', 'Un salaire relève d’un emploi', 400);
  assertClassification(body);
  const rateKori = body.rateKori ?? 0;
  if (!Number.isSafeInteger(rateKori) || rateKori < 0) throw new WorkError('invalid', 'Rémunération invalide', 400);
  if (body.arrangement === 'apprenticeship' && !(body.durationWeeks >= 1 && body.durationWeeks <= 52)) throw new WorkError('invalid', 'Apprentissage : durée de 1 à 52 semaines', 400);
  const minAge = body.hazardous ? Math.max(18, body.minAge ?? 18) : Math.max(16, body.minAge ?? 18);
  return prisma.$transaction(async (tx) => {
    const b = await bizAuth(tx, userId, businessId, 'business.staffing.manage');
    if (b.verificationStatus !== 'verified') throw new WorkError('business_not_verified', 'Seules les entreprises vérifiées publient du travail', 403);
    if (body.type === 'coop_work' && b.type !== 'cooperative') throw new WorkError('invalid', 'Travail coopératif : réservé aux coopératives', 400);
    const flags = reviewFlags(body);
    const o = await tx.workOpportunity.create({
      data: {
        reference: ref('OPP'), businessId, type: body.type, arrangement: body.arrangement, title: s(body.title, 120), description: s(body.description, 2000),
        area: s(body.area, 60)?.toLowerCase() ?? null, skillsJson: JSON.stringify(list(body.skills)), headcount: Math.min(Math.max(1, body.headcount ?? 1), 500),
        payKind: body.payKind, rateKori, units: Math.max(1, body.units ?? 1), funding, hazardous: Boolean(body.hazardous), minAge, nightWork: Boolean(body.nightWork),
        hoursPerWeek: body.hoursPerWeek ?? null, durationWeeks: body.durationWeeks ?? null, closesAt: body.closesAt ? new Date(body.closesAt) : null,
        status: flags.length ? 'under_review' : 'open', reviewFlags: flags.length ? flags.join(',') : null, createdBy: userId,
      },
    });
    return opportunityView(o, b);
  });
}

export async function setOpportunityStatus(userId, businessId, oppId, { status }) {
  if (!['open', 'paused', 'closed'].includes(status)) throw new WorkError('invalid', 'Statut inconnu', 400);
  return prisma.$transaction(async (tx) => {
    const b = await bizAuth(tx, userId, businessId, 'business.staffing.manage');
    const o = await tx.workOpportunity.findUnique({ where: { id: oppId } });
    if (!o || o.businessId !== businessId) throw notFound();
    if (['under_review', 'rejected', 'closed'].includes(o.status)) throw new WorkError('invalid_state', 'Opportunité non modifiable');
    return opportunityView(await tx.workOpportunity.update({ where: { id: o.id }, data: { status } }), b);
  });
}

export async function listBusinessOpportunities(userId, businessId) {
  const b = await prisma.$transaction((tx) => bizAuth(tx, userId, businessId, 'business.staffing.manage'));
  const rows = await prisma.workOpportunity.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 100 });
  const counts = await prisma.workApplication.groupBy({ by: ['opportunityId', 'status'], where: { opportunityId: { in: rows.map((r) => r.id) } }, _count: true });
  return rows.map((o) => ({ ...opportunityView(o, b), applications: counts.filter((c) => c.opportunityId === o.id).reduce((acc, c) => ({ ...acc, [c.status]: c._count }), {}) }));
}

/** Fair discovery: open work only, filtered by what the WORKER chose; newest first; no paid ranking, no profiling. */
export async function discoverOpportunities(userId, { type, area, skill, cursor, limit = 30 } = {}) {
  const take = Math.min(Math.max(1, Number(limit) || 30), 100);
  const blocked = (await prisma.workBlock.findMany({ where: { userId }, select: { businessId: true } })).map((x) => x.businessId);
  const rows = await prisma.workOpportunity.findMany({
    where: {
      status: 'open', OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }], businessId: { notIn: blocked },
      ...(type && TYPES[type] ? { type } : {}), ...(area ? { area: String(area).toLowerCase() } : {}), ...(skill ? { skillsJson: { contains: `"${String(skill).toLowerCase()}"` } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1, ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
  });
  const page = rows.slice(0, take);
  const bizs = await prisma.business.findMany({ where: { id: { in: [...new Set(page.map((o) => o.businessId))] } }, select: { id: true, name: true, verificationStatus: true } });
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { dateOfBirth: true, verificationTier: true } });
  const mine = await prisma.workApplication.findMany({ where: { workerUserId: userId, opportunityId: { in: page.map((o) => o.id) } }, select: { opportunityId: true, status: true } });
  return {
    items: page.map((o) => {
      let eligible = true;
      let reason = null;
      try {
        assertAgeEligible(o, me);
      } catch (e) {
        eligible = false;
        reason = e.code;
      }
      return { ...opportunityView(o, bizs.find((b) => b.id === o.businessId)), eligible, ineligibleReason: reason, myApplication: mine.find((m) => m.opportunityId === o.id)?.status ?? null };
    }),
    nextCursor: rows.length > take ? page[page.length - 1].id : null,
  };
}

export async function getOpportunity(userId, oppId) {
  const o = await prisma.workOpportunity.findUnique({ where: { id: oppId } });
  if (!o || o.status !== 'open' || (await isBlocked(prisma, userId, o.businessId))) throw notFound();
  const b = await prisma.business.findUnique({ where: { id: o.businessId }, select: { id: true, name: true, verificationStatus: true } });
  return opportunityView(o, b);
}

/* ── applications, invitations, screening ──────────────────────────────────────────── */

export async function applyToOpportunity(userId, oppId, { note } = {}) {
  return prisma.$transaction(async (tx) => {
    const o = await tx.workOpportunity.findUnique({ where: { id: oppId } });
    if (!o || (await isBlocked(tx, userId, o.businessId))) throw notFound();
    const existing = await tx.workApplication.findUnique({ where: { opportunityId_workerUserId: { opportunityId: oppId, workerUserId: userId } } });
    if (existing?.status === 'invited') {
      // Responding to an invitation.
      const u = await tx.workApplication.update({ where: { id: existing.id }, data: { status: 'submitted', note: s(note, 500) ?? existing.note } });
      return { id: u.id, status: u.status };
    }
    if (existing) return { id: existing.id, status: existing.status, replayed: true };
    if (o.status !== 'open') throw new WorkError('invalid_state', 'Opportunité fermée');
    if (await hasBusinessAuthority(tx, userId, o.businessId)) throw new WorkError('conflict_of_interest', 'Tu gères cette entreprise : tu ne peux pas y être recruté·e', 403);
    const me = await tx.user.findUnique({ where: { id: userId }, select: { dateOfBirth: true, verificationTier: true } });
    assertAgeEligible(o, me);
    const a = await tx.workApplication.create({ data: { opportunityId: oppId, workerUserId: userId, source: 'applied', status: 'submitted', note: s(note, 500) } });
    return { id: a.id, status: a.status };
  });
}

export async function withdrawApplication(userId, appId) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.workApplication.findUnique({ where: { id: appId } });
    if (!a || a.workerUserId !== userId) throw notFound();
    if (!['submitted', 'shortlisted', 'invited'].includes(a.status)) throw new WorkError('invalid_state', 'Candidature non retirable');
    await tx.workApplication.update({ where: { id: a.id }, data: { status: 'withdrawn' } });
    return { id: a.id, status: 'withdrawn' };
  });
}

export async function myApplications(userId) {
  const rows = await prisma.workApplication.findMany({ where: { workerUserId: userId }, orderBy: { updatedAt: 'desc' }, take: 100 });
  const opps = await prisma.workOpportunity.findMany({ where: { id: { in: rows.map((r) => r.opportunityId) } } });
  const bizs = await prisma.business.findMany({ where: { id: { in: opps.map((o) => o.businessId) } }, select: { id: true, name: true, verificationStatus: true } });
  return rows.map((r) => {
    const o = opps.find((x) => x.id === r.opportunityId);
    return { id: r.id, status: r.status, source: r.source, opportunity: o ? opportunityView(o, bizs.find((b) => b.id === o.businessId)) : null, updatedAt: r.updatedAt.toISOString() };
  });
}

export async function listApplicants(userId, businessId, oppId) {
  await prisma.$transaction((tx) => bizAuth(tx, userId, businessId, 'business.staffing.manage'));
  const o = await prisma.workOpportunity.findUnique({ where: { id: oppId } });
  if (!o || o.businessId !== businessId) throw notFound();
  const apps = await prisma.workApplication.findMany({ where: { opportunityId: oppId, status: { not: 'withdrawn' } }, orderBy: { createdAt: 'asc' } });
  const out = [];
  for (const a of apps) out.push({ id: a.id, status: a.status, source: a.source, note: a.note, worker: await workerCard(prisma, a.workerUserId), createdAt: a.createdAt.toISOString() });
  return out;
}

export async function decideApplication(userId, businessId, appId, { decision }) {
  if (!['shortlist', 'decline'].includes(decision)) throw new WorkError('invalid', 'Décision inconnue', 400);
  return prisma.$transaction(async (tx) => {
    await bizAuth(tx, userId, businessId, 'business.staffing.manage');
    const a = await tx.workApplication.findUnique({ where: { id: appId } });
    const o = a && (await tx.workOpportunity.findUnique({ where: { id: a.opportunityId } }));
    if (!o || o.businessId !== businessId) throw notFound();
    if (!['submitted', 'shortlisted'].includes(a.status)) throw new WorkError('invalid_state', 'Candidature déjà traitée');
    const u = await tx.workApplication.update({ where: { id: a.id }, data: { status: decision === 'shortlist' ? 'shortlisted' : 'declined' } });
    return { id: u.id, status: u.status };
  });
}

/** Search discoverable workers only, by what they declared (skill / area). */
export async function searchWorkers(userId, businessId, { skill, area, limit = 30 } = {}) {
  await prisma.$transaction((tx) => bizAuth(tx, userId, businessId, 'business.staffing.manage'));
  const blockedBy = (await prisma.workBlock.findMany({ where: { businessId }, select: { userId: true } })).map((x) => x.userId);
  const rows = await prisma.workProfile.findMany({
    where: { visibility: 'discoverable', userId: { notIn: blockedBy }, ...(skill ? { skillsJson: { contains: `"${String(skill).toLowerCase()}"` } } : {}), ...(area ? { areasJson: { contains: `"${String(area).toLowerCase()}"` } } : {}) },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: Math.min(Number(limit) || 30, 100),
  });
  const out = [];
  for (const p of rows) out.push(await workerCard(prisma, p.userId));
  return out;
}

export async function inviteWorker(userId, businessId, oppId, { workerHandle, note }) {
  return prisma.$transaction(async (tx) => {
    await bizAuth(tx, userId, businessId, 'business.staffing.manage');
    const o = await tx.workOpportunity.findUnique({ where: { id: oppId } });
    if (!o || o.businessId !== businessId) throw notFound();
    if (o.status !== 'open') throw new WorkError('invalid_state', 'Opportunité fermée');
    const w = await tx.user.findFirst({ where: { handle: String(workerHandle ?? '').replace(/^@/, '') }, select: { id: true } });
    const p = w && (await tx.workProfile.findUnique({ where: { userId: w.id } }));
    // Private / non-discoverable profiles and workers who blocked this business look identical: not found.
    if (!p || p.visibility !== 'discoverable' || (await isBlocked(tx, w.id, businessId))) throw notFound('Travailleur introuvable');
    if (await hasBusinessAuthority(tx, w.id, businessId)) throw new WorkError('conflict_of_interest', 'Cette personne gère l’entreprise', 403);
    const existing = await tx.workApplication.findUnique({ where: { opportunityId_workerUserId: { opportunityId: oppId, workerUserId: w.id } } });
    if (existing) return { id: existing.id, status: existing.status, replayed: true };
    const a = await tx.workApplication.create({ data: { opportunityId: oppId, workerUserId: w.id, source: 'invited', status: 'invited', note: s(note, 500) } });
    return { id: a.id, status: a.status };
  });
}

/* ── offers ────────────────────────────────────────────────────────────────────────── */

function buildTerms(o, body) {
  const t = {
    startDate: body.startDate ? new Date(body.startDate).toISOString().slice(0, 10) : null,
    endDate: body.endDate ? new Date(body.endDate).toISOString().slice(0, 10) : null,
    duties: s(body.duties, 1000), area: o.area, schedule: s(body.schedule, 200),
    evidenceRequired: EVIDENCE_KINDS.includes(body.evidenceRequired) ? body.evidenceRequired : 'note',
    acceptanceWindowHours: Math.min(Math.max(Number(body.acceptanceWindowHours) || 72, 24), 168),
    hoursPerWeek: body.hoursPerWeek ?? o.hoursPerWeek ?? null, durationWeeks: body.durationWeeks ?? o.durationWeeks ?? null,
    hazardous: o.hazardous, nightWork: o.nightWork, minAge: o.minAge, payKind: o.payKind,
  };
  if (!t.startDate) throw new WorkError('invalid', 'Date de début requise', 400);
  if (!(t.duties && t.duties.length >= 10)) throw new WorkError('invalid', 'Décris les tâches (10 caractères min.)', 400);
  assertClassification({ arrangement: o.arrangement, hoursPerWeek: t.hoursPerWeek, durationWeeks: t.durationWeeks });
  let total = 0;
  let milestones = [];
  if (o.funding === 'prepaid' && o.type === 'courier') {
    const rate = body.rateKori ?? o.rateKori;
    const units = body.units ?? o.units;
    if (!Number.isSafeInteger(rate) || rate < o.rateKori) throw new WorkError('below_posted_rate', 'Tarif inférieur à celui publié', 422);
    if (!Number.isSafeInteger(units) || units < 1 || units > 1000) throw new WorkError('invalid', 'Nombre de livraisons invalide', 400);
    Object.assign(t, { ratePerDeliveryKori: rate, deliveriesBudget: units, earnsOn: 'verified_j8_delivery' });
    total = rate * units;
  } else if (o.funding === 'prepaid') {
    milestones = (Array.isArray(body.milestones) && body.milestones.length ? body.milestones : [{ title: 'Travail terminé', amountKori: o.rateKori * o.units }]).map((m, i) => ({
      seq: i + 1, title: s(m.title, 120) || `Étape ${i + 1}`, amountKori: m.amountKori, kind: m.kind === 'reimbursement' ? 'reimbursement' : 'work',
    }));
    if (milestones.length > 20 || milestones.some((m) => !Number.isSafeInteger(m.amountKori) || m.amountKori < 0)) throw new WorkError('invalid', 'Étapes invalides', 400);
    total = milestones.reduce((a, m) => a + m.amountKori, 0);
    const work = milestones.filter((m) => m.kind === 'work').reduce((a, m) => a + m.amountKori, 0);
    if (work < o.rateKori * o.units) throw new WorkError('below_posted_rate', 'Rémunération inférieure à celle publiée', 422);
    if (o.arrangement === 'apprenticeship') {
      t.learningPlan = s(body.learningPlan, 1000);
      if (!(t.learningPlan && t.learningPlan.length >= 20)) throw new WorkError('invalid', 'Apprentissage : programme d’apprentissage requis', 400);
    }
    t.milestones = milestones;
  } else if (o.funding === 'payroll') {
    const wage = body.rateKori ?? o.rateKori;
    if (!Number.isSafeInteger(wage) || wage < o.rateKori || wage <= 0) throw new WorkError('below_posted_rate', 'Salaire inférieur à celui publié', 422);
    t.wageKori = wage;
    t.wagePeriod = ['month', 'week', 'day'].includes(body.wagePeriod) ? body.wagePeriod : 'month';
    t.paidThrough = 'payroll';
  } else {
    t.earnsOn = o.type === 'rep' ? 'verified_received_first_order (approved, prefunded rule; subject to budget)' : 'verified_pickup_point_release (approved, prefunded rule; subject to budget)';
  }
  t.classification = o.funding === 'payroll' ? 'payroll_wage' : o.funding === 'outcome' ? (o.type === 'rep' ? 'commission' : 'service_fee') : CLASSIFICATION[o.arrangement];
  return { terms: t, total, milestones };
}

export async function createOffer(userId, businessId, body) {
  return runMoneyTransaction(prisma, async (tx) => {
    await bizAuth(tx, userId, businessId, 'business.staffing.manage');
    await tx.$executeRaw`SELECT id FROM "WorkApplication" WHERE id = ${body.applicationId} FOR UPDATE`;
    const app = await tx.workApplication.findUnique({ where: { id: body.applicationId } });
    const o = app && (await tx.workOpportunity.findUnique({ where: { id: app.opportunityId } }));
    if (!o || o.businessId !== businessId) throw notFound('Candidature introuvable');
    if (o.status !== 'open') throw new WorkError('invalid_state', 'Opportunité fermée');
    if (!['submitted', 'shortlisted'].includes(app.status)) throw new WorkError('invalid_state', 'Candidature non éligible à une offre');
    if (await isBlocked(tx, app.workerUserId, businessId)) throw notFound('Candidature introuvable');
    if (await hasBusinessAuthority(tx, app.workerUserId, businessId)) throw new WorkError('conflict_of_interest', 'Cette personne gère l’entreprise', 403);
    const filled = await tx.workAssignment.count({ where: { opportunityId: o.id, status: { in: ['active', 'completed'] } } }) + await tx.workOffer.count({ where: { opportunityId: o.id, status: 'sent' } });
    if (filled >= o.headcount) throw new WorkError('headcount_reached', 'Nombre de postes atteint', 409);
    const { terms, total } = buildTerms(o, body);
    if (total > 0) await bizAuth(tx, userId, businessId, 'business.pay');
    const termsJson = JSON.stringify(terms);
    let offer = await tx.workOffer.create({
      data: {
        reference: ref('OFR'), opportunityId: o.id, applicationId: app.id, businessId, workerUserId: app.workerUserId, arrangement: o.arrangement,
        termsJson, termsHash: sha(termsJson), totalKori: total, funding: o.funding, expiresAt: new Date(Date.now() + Math.min(Math.max(Number(body.expiresInHours) || OFFER_TTL_HOURS, 1), 168) * 3600_000), createdBy: userId,
      },
    });
    // Prepaid work is funded BEFORE the worker can accept: no binding unfunded paid assignment.
    if (o.funding === 'prepaid' && total > 0) offer = await fundOfferInTx(tx, offer, { actorUserId: userId });
    await tx.workApplication.update({ where: { id: app.id }, data: { status: 'offered' } });
    return offerView(offer);
  });
}

async function closeOffer(offerId, status, { actorUserId, businessId = null }) {
  return runMoneyTransaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "WorkOffer" WHERE id = ${offerId} FOR UPDATE`;
    const o = await tx.workOffer.findUnique({ where: { id: offerId } });
    if (!o || (businessId && o.businessId !== businessId) || (!businessId && o.workerUserId !== actorUserId)) throw notFound('Offre introuvable');
    if (o.status === status) return { ...offerView(o), replayed: true };
    if (o.status !== 'sent') throw new WorkError('invalid_state', 'Offre déjà traitée');
    const u = await tx.workOffer.update({ where: { id: o.id }, data: { status, decidedAt: new Date() } });
    await refundOfferInTx(tx, u, { reason: status });
    await tx.workApplication.update({ where: { id: o.applicationId }, data: { status: status === 'declined' ? 'declined' : 'shortlisted' } });
    return offerView(await tx.workOffer.findUnique({ where: { id: o.id } }));
  });
}

export const declineOffer = (userId, offerId) => closeOffer(offerId, 'declined', { actorUserId: userId });
export async function withdrawOffer(userId, businessId, offerId) {
  await prisma.$transaction((tx) => bizAuth(tx, userId, businessId, 'business.staffing.manage'));
  return closeOffer(offerId, 'withdrawn', { actorUserId: userId, businessId });
}

export async function myOffers(userId) {
  const rows = await prisma.workOffer.findMany({ where: { workerUserId: userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  const bizs = await prisma.business.findMany({ where: { id: { in: rows.map((r) => r.businessId) } }, select: { id: true, name: true } });
  const opps = await prisma.workOpportunity.findMany({ where: { id: { in: rows.map((r) => r.opportunityId) } }, select: { id: true, title: true, type: true } });
  return rows.map((o) => ({ ...offerView(o), business: bizs.find((b) => b.id === o.businessId), opportunity: opps.find((x) => x.id === o.opportunityId) }));
}

/** The worker accepts the exact terms they saw (termsHash). Creates the assignment once. */
export async function acceptOffer(userId, offerId, { termsHash, ageAttested = false }) {
  return runMoneyTransaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "WorkOffer" WHERE id = ${offerId} FOR UPDATE`;
    const o = await tx.workOffer.findUnique({ where: { id: offerId } });
    if (!o || o.workerUserId !== userId) throw notFound('Offre introuvable');
    if (o.status === 'accepted') {
      const a = await tx.workAssignment.findUnique({ where: { offerId: o.id } });
      return { ...(await assignmentView(tx, a, { role: 'worker' })), replayed: true };
    }
    if (o.status !== 'sent') throw new WorkError('invalid_state', 'Offre plus disponible');
    if (o.expiresAt <= new Date()) throw new WorkError('offer_expired', 'Offre expirée', 409);
    if (termsHash !== o.termsHash) throw new WorkError('terms_changed', 'Les conditions affichées ne correspondent pas — recharge l’offre', 409);
    const opp = await tx.workOpportunity.findUnique({ where: { id: o.opportunityId } });
    const me = await tx.user.findUnique({ where: { id: userId }, select: { dateOfBirth: true, verificationTier: true } });
    assertAgeEligible(opp, me, { ageAttested, atAcceptance: true });
    if (o.funding === 'prepaid' && o.totalKori > 0 && o.fundingStatus !== 'held') throw new WorkError('not_funded', 'Offre non financée', 409);
    if (await hasBusinessAuthority(tx, userId, o.businessId)) throw new WorkError('conflict_of_interest', 'Tu gères cette entreprise', 403);
    await tx.workOffer.update({ where: { id: o.id }, data: { status: 'accepted', decidedAt: new Date(), ...(o.fundingStatus === 'held' ? { fundingStatus: 'transferred' } : {}) } });
    const a = await tx.workAssignment.create({
      data: { reference: ref('ASG'), offerId: o.id, opportunityId: o.opportunityId, businessId: o.businessId, workerUserId: userId, type: opp.type, arrangement: o.arrangement, totalKori: o.totalKori, funding: o.funding },
    });
    const terms = parseJson(o.termsJson, {});
    for (const m of terms.milestones ?? []) await tx.workMilestone.create({ data: { assignmentId: a.id, seq: m.seq, title: m.title, amountKori: m.amountKori, kind: m.kind } });
    await tx.workApplication.update({ where: { id: o.applicationId }, data: { status: 'hired' } });
    // An explicit, revocable business role only where the work needs it (D25) — never inferred.
    const role = TYPES[opp.type]?.grantsRole;
    if (role) {
      await tx.businessMember.upsert({
        where: { businessId_userId_role: { businessId: o.businessId, userId, role } },
        update: { status: 'active', removedAt: null, removedBy: null, removedReason: null, acceptedAt: new Date() },
        create: { businessId: o.businessId, userId, role, status: 'active', invitedBy: o.createdBy, invitedAt: o.createdAt, acceptedAt: new Date() },
      });
    }
    // Employment: the employer's payroll (J5) carries the wage obligation — created, never paid, here.
    if (o.funding === 'payroll') {
      const existing = await tx.payrollEmployee.findUnique({ where: { businessId_userId: { businessId: o.businessId, userId } } });
      if (!existing) await tx.payrollEmployee.create({ data: { businessId: o.businessId, userId, jobTitle: opp.title.slice(0, 60), payAmount: terms.wageKori, paySchedule: 'manual' } });
    }
    if (age(me) !== null && age(me) < 18) await recordIdentityEvent(tx, { actorType: 'user', actorId: userId, action: 'work_minor_assignment', subjectType: 'work_assignment', subjectId: a.id, after: { type: opp.type, hazardous: opp.hazardous } });
    return assignmentView(tx, a, { role: 'worker' });
  });
}
const age = (u) => verifiedAge(u);

/* ── assignments: reads, attendance, milestones, cancel ────────────────────────────── */

async function lockAssignment(tx, id) {
  await tx.$executeRaw`SELECT id FROM "WorkAssignment" WHERE id = ${id} FOR UPDATE`;
  const a = await tx.workAssignment.findUnique({ where: { id } });
  if (!a) throw notFound('Mission introuvable');
  return a;
}

export async function myAssignments(userId) {
  const rows = await prisma.workAssignment.findMany({ where: { workerUserId: userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  const out = [];
  for (const a of rows) out.push(await assignmentView(prisma, a, { role: 'worker' }));
  return out;
}

export async function getAssignment(userId, assignmentId, { businessId = null } = {}) {
  const a = await prisma.workAssignment.findUnique({ where: { id: assignmentId } });
  if (!a) throw notFound('Mission introuvable');
  if (businessId) {
    if (a.businessId !== businessId) throw notFound('Mission introuvable');
    await prisma.$transaction((tx) => bizAuth(tx, userId, businessId, 'business.staffing.manage'));
    return assignmentView(prisma, a, { role: 'business' });
  }
  if (a.workerUserId !== userId) throw notFound('Mission introuvable');
  return assignmentView(prisma, a, { role: 'worker' });
}

export async function businessAssignments(userId, businessId, { status } = {}) {
  await prisma.$transaction((tx) => bizAuth(tx, userId, businessId, 'business.staffing.manage'));
  const rows = await prisma.workAssignment.findMany({ where: { businessId, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
  const out = [];
  for (const a of rows) out.push(await assignmentView(prisma, a, { role: 'business' }));
  return out;
}

/** The business issues an attendance code at the work site; the worker submits it — neither can fabricate attendance alone. */
export async function issueAttendanceCode(userId, businessId, assignmentId, { purpose }) {
  if (!['checkin', 'checkout'].includes(purpose)) throw new WorkError('invalid', 'Usage de code inconnu', 400);
  return prisma.$transaction(async (tx) => {
    await bizAuth(tx, userId, businessId, 'business.staffing.manage');
    const a = await lockAssignment(tx, assignmentId);
    if (a.businessId !== businessId) throw notFound('Mission introuvable');
    if (a.status !== 'active') throw new WorkError('invalid_state', 'Mission terminée');
    if (purpose === 'checkout' && !a.checkedInAt) throw new WorkError('invalid_state', 'Arrivée non enregistrée');
    if ((purpose === 'checkin' && a.checkedInAt) || (purpose === 'checkout' && a.checkedOutAt)) throw new WorkError('invalid_state', 'Déjà enregistré');
    const code = newCode();
    await tx.workChallenge.create({ data: { assignmentId: a.id, purpose, codeHash: hashCode(a.id, purpose, code), issuedBy: userId, expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
    return { code, expiresInSeconds: CODE_TTL_MS / 1000 };
  });
}

export async function submitAttendance(userId, assignmentId, { purpose, code }) {
  if (!['checkin', 'checkout'].includes(purpose)) throw new WorkError('invalid', 'Usage de code inconnu', 400);
  return prisma.$transaction(async (tx) => {
    const a = await lockAssignment(tx, assignmentId);
    if (a.workerUserId !== userId) throw notFound('Mission introuvable');
    const field = purpose === 'checkin' ? 'checkedInAt' : 'checkedOutAt';
    if (a[field]) {
      const used = await tx.workChallenge.findFirst({ where: { assignmentId: a.id, purpose, usedAt: { not: null }, codeHash: hashCode(a.id, purpose, code ?? '') } });
      if (used) return { ...(await assignmentView(tx, a, { role: 'worker' })), replayed: true };
      throw new WorkError('invalid_state', 'Déjà enregistré');
    }
    if (a.status !== 'active') throw new WorkError('invalid_state', 'Mission terminée');
    if (purpose === 'checkout' && !a.checkedInAt) throw new WorkError('invalid_state', 'Arrivée non enregistrée');
    const c = await tx.workChallenge.findFirst({ where: { assignmentId: a.id, purpose, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (!c) throw new WorkError('code_invalid', 'Code invalide ou expiré', 409);
    if (c.attempts >= MAX_CODE_ATTEMPTS) throw new WorkError('code_locked', 'Trop d’essais — demande un nouveau code', 423);
    if (!crypto.timingSafeEqual(Buffer.from(c.codeHash), Buffer.from(hashCode(a.id, purpose, code ?? '')))) {
      await prisma.workChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } }); // outside the tx: survives the rollback
      throw new WorkError('code_invalid', 'Code invalide ou expiré', 409);
    }
    const u = await tx.workChallenge.updateMany({ where: { id: c.id, usedAt: null }, data: { usedAt: new Date() } });
    if (u.count !== 1) throw new WorkError('code_invalid', 'Code déjà utilisé', 409);
    const now = new Date();
    const updated = await tx.workAssignment.update({ where: { id: a.id }, data: { [field]: now } });
    await tx.workEvidence.create({ data: { assignmentId: a.id, byUserId: userId, role: 'worker', kind: 'attendance', content: `${purpose}:counterpart_code:${now.toISOString()}` } });
    return assignmentView(tx, updated, { role: 'worker' });
  });
}

export async function submitMilestone(userId, assignmentId, seq, { kind = 'note', content }) {
  return prisma.$transaction(async (tx) => {
    const a = await lockAssignment(tx, assignmentId);
    if (a.workerUserId !== userId) throw notFound('Mission introuvable');
    const m = await tx.workMilestone.findUnique({ where: { assignmentId_seq: { assignmentId: a.id, seq: Number(seq) } } });
    if (!m) throw notFound('Étape introuvable');
    if (m.status !== 'pending') {
      if (m.status === 'submitted') return { ...(await assignmentView(tx, a, { role: 'worker' })), replayed: true };
      throw new WorkError('invalid_state', 'Étape déjà traitée');
    }
    if (a.status !== 'active') throw new WorkError('invalid_state', 'Mission terminée');
    const terms = parseJson((await tx.workOffer.findUnique({ where: { id: a.offerId } })).termsJson, {});
    if (terms.evidenceRequired === 'attendance' && !(a.checkedInAt && a.checkedOutAt)) throw new WorkError('attendance_required', 'Arrivée et départ confirmés par l’entreprise requis', 409);
    if (m.kind === 'reimbursement' && kind !== 'receipt_ref') throw new WorkError('receipt_required', 'Remboursement : justificatif requis', 422);
    if (!EVIDENCE_KINDS.includes(kind) || !(content && String(content).trim().length >= 5)) throw new WorkError('evidence_required', 'Preuve requise', 422);
    await tx.workEvidence.create({ data: { assignmentId: a.id, milestoneId: m.id, byUserId: userId, role: 'worker', kind, content: String(content).slice(0, 1000) } });
    const now = new Date();
    await tx.workMilestone.update({ where: { id: m.id }, data: { status: 'submitted', submittedAt: now, acceptDeadline: new Date(now.getTime() + (terms.acceptanceWindowHours ?? 72) * 3600_000) } });
    return assignmentView(tx, a, { role: 'worker' });
  });
}

export async function acceptMilestone(userId, businessId, assignmentId, seq) {
  return runMoneyTransaction(prisma, async (tx) => {
    await bizAuth(tx, userId, businessId, 'business.staffing.manage');
    const a = await lockAssignment(tx, assignmentId);
    if (a.businessId !== businessId) throw notFound('Mission introuvable');
    if (a.workerUserId === userId) throw new WorkError('conflict_of_interest', 'On ne valide pas son propre travail', 403);
    const m = await tx.workMilestone.findUnique({ where: { assignmentId_seq: { assignmentId: a.id, seq: Number(seq) } } });
    if (!m) throw notFound('Étape introuvable');
    if (m.status === 'accepted') return { ...(await assignmentView(tx, a, { role: 'business' })), replayed: true };
    if (m.status !== 'submitted') throw new WorkError('invalid_state', m.status === 'disputed' ? 'Étape en litige' : 'Étape non soumise');
    await acceptMilestoneInTx(tx, a, m, { by: userId });
    return assignmentView(tx, await tx.workAssignment.findUnique({ where: { id: a.id } }), { role: 'business' });
  });
}

/**
 * End an assignment. Before any work is submitted / attended: either party; unearned escrow back to
 * the business. Per-delivery courier, outcome and employment engagements can be ended any time;
 * earned money stays earned. A granted business role is revoked.
 */
export async function endAssignment(actor, assignmentId, { reason }) {
  if (!(reason && String(reason).trim().length >= 3)) throw new WorkError('reason_required', 'Motif requis', 400);
  return runMoneyTransaction(prisma, async (tx) => {
    if (actor.businessId) await bizAuth(tx, actor.userId, actor.businessId, 'business.staffing.manage');
    const a = await lockAssignment(tx, assignmentId);
    if (actor.businessId ? a.businessId !== actor.businessId : a.workerUserId !== actor.userId) throw notFound('Mission introuvable');
    if (a.status === 'cancelled') return { ...(await assignmentView(tx, a, { role: actor.businessId ? 'business' : 'worker' })), replayed: true };
    if (a.status !== 'active') throw new WorkError('invalid_state', 'Mission terminée');
    const ms = await tx.workMilestone.findMany({ where: { assignmentId: a.id } });
    const milestoneWork = ms.length > 0;
    if (milestoneWork && (ms.some((m) => ['submitted', 'disputed'].includes(m.status)) || (actor.businessId && a.checkedInAt))) {
      throw new WorkError('work_in_progress', 'Travail déjà fourni : valide-le ou ouvre un litige', 409);
    }
    for (const m of ms.filter((x) => x.status === 'pending')) {
      await tx.workMilestone.update({ where: { id: m.id }, data: { status: 'refunded' } });
      await refundAssignmentInTx(tx, a, m.amountKori, `M-${m.id}`, 'assignment_ended_unearned');
    }
    if (a.funding === 'prepaid' && !milestoneWork) {
      const rest = await escrowBalance(tx, a.offerId);
      if (rest > 0) await refundAssignmentInTx(tx, a, rest, `${a.id}-END`, 'assignment_ended_unused_budget');
    }
    const role = TYPES[a.type]?.grantsRole;
    if (role) await tx.businessMember.updateMany({ where: { businessId: a.businessId, userId: a.workerUserId, role, status: 'active' }, data: { status: 'removed', removedAt: new Date(), removedBy: actor.userId, removedReason: 'work_assignment_ended' } });
    const done = await maybeCompleteInTx(tx, a.id);
    const earned = (await tx.workEarning.count({ where: { assignmentId: a.id } })) > 0;
    const final = done.status === 'active'
      ? await tx.workAssignment.update({ where: { id: a.id }, data: { status: earned ? 'completed' : 'cancelled', cancelledAt: new Date(), cancelReason: String(reason).slice(0, 300), ...(earned ? { completedAt: new Date() } : {}) } })
      : done;
    return assignmentView(tx, final, { role: actor.businessId ? 'business' : 'worker' });
  });
}

/* ── worker earnings & history ─────────────────────────────────────────────────────── */

export async function myEarnings(userId) {
  const rows = await prisma.workEarning.findMany({ where: { workerUserId: userId }, orderBy: { createdAt: 'desc' }, take: 200 });
  const sum = (st) => rows.filter((e) => st.includes(e.status)).reduce((a, e) => a + e.amountKori, 0);
  // J8 courier earnings are shown, never duplicated: they stay J8's (read-only link).
  const courier = await prisma.courierEarning.findMany({ where: { courierUserId: userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  return {
    totals: { onHoldKori: sum(['accrued']), releasableKori: sum(['releasable']), paidKori: sum(['paid']), reversedKori: sum(['reversed']) },
    items: rows.map((e) => ({ id: e.id, amountKori: e.amountKori, classification: e.classification, status: e.status, releasableAt: e.releasableAt.toISOString(), paidAt: e.paidAt?.toISOString() ?? null, assignmentId: e.assignmentId, createdAt: e.createdAt.toISOString() })),
    j8CourierEarnings: courier.map((e) => ({ amountKori: e.amountKori, status: e.status, createdAt: e.createdAt.toISOString() })),
  };
}
