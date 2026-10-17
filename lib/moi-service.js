import { prisma } from './prisma.js';
import { effectiveTier } from './tier-limits.js';
import { buildStudentPassUrl } from './k21-qr.js';

/** Ngor — honor score from verified money actions only (not social/music/culture). */
export const NGOR_POINTS = {
  send: 10,
  pay_merchant: 5,
  receive: 2,
  cash_in: 3,
  ticket_purchase: 4,
};

const NGOR_BAR_TARGET = 1000;

/** @deprecated use NGOR_POINTS */
export const KERSA_POINTS = NGOR_POINTS;
/** @deprecated use NGOR_POINTS */
export const WAKHNA_POINTS = NGOR_POINTS;

const HIGHLIGHT_RING_PALETTES = [
  ['#e85c1a', '#fad836'],
  ['#1af060', '#fad836'],
  ['#fad836', '#0fbc48'],
  ['#0fbc48', '#e85c1a'],
];

function eventHighlightIcon(title) {
  const t = String(title ?? '').toLowerCase();
  if (/concert|music|afro|rap|dj|rect/.test(t)) return '🎤';
  if (/foot|sport|match|can|lutte/.test(t)) return '⚽';
  if (/food|manger|resto|lekk|nu lekk/.test(t)) return '🍽️';
  if (/vacance|plage|travel|voyage/.test(t)) return '🌴';
  return '🎉';
}

function shortHighlightLabel(text, max = 10) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function computeHighlights(userId, user) {
  const [tickets, tontines] = await Promise.all([
    prisma.ticket.findMany({
      where: { buyerId: userId, status: 'paid' },
      include: { event: { select: { id: true, title: true } } },
      orderBy: { createdAt: 'desc' },
      take: 12,
    }),
    prisma.tontineMembership.findMany({
      where: { userId, group: { active: true } },
      include: { group: { select: { id: true, name: true } } },
      take: 6,
    }),
  ]);

  const highlights = [];
  let paletteIdx = 0;
  const nextRing = () => {
    const ring = HIGHLIGHT_RING_PALETTES[paletteIdx % HIGHLIGHT_RING_PALETTES.length];
    paletteIdx += 1;
    return ring;
  };

  const seenEvents = new Set();
  for (const ticket of tickets) {
    if (!ticket.event || seenEvents.has(ticket.event.id)) continue;
    seenEvents.add(ticket.event.id);
    highlights.push({
      key: `event-${ticket.event.id}`,
      type: 'event',
      icon: eventHighlightIcon(ticket.event.title),
      name: shortHighlightLabel(ticket.event.title),
      ring: nextRing(),
      targetId: ticket.event.id,
    });
  }

  for (const membership of tontines) {
    highlights.push({
      key: `tontine-${membership.groupId}`,
      type: 'tontine',
      icon: '🏆',
      name: shortHighlightLabel(membership.group.name),
      ring: nextRing(),
      targetId: membership.groupId,
    });
  }

  if (resolveStudentPassStatus(user) === 'active') {
    highlights.push({
      key: 'student-pass',
      type: 'student_pass',
      icon: '🎓',
      name: 'Pass',
      ring: ['#1af060', '#00853F'],
    });
  }

  return highlights.slice(0, 8);
}

function resolveStudentPassStatus(user) {
  if (!user.studentPassSchool && !user.studentPassStatus) return 'inactive';
  if (user.studentPassExpiresAt && user.studentPassExpiresAt < new Date()) return 'expired';
  if (user.studentPassStatus === 'active') return 'active';
  if (user.studentPassStatus === 'pending') return 'pending';
  return user.studentPassStatus ?? 'inactive';
}

export function studentPassShape(user) {
  const status = resolveStudentPassStatus(user);
  const handle = user.handle ?? '';
  return {
    status,
    schoolName: user.studentPassSchool ?? null,
    businessId: user.studentPassBusinessId ?? null,
    discountPercent: 15,
    verified: status === 'active',
    expiresAt: user.studentPassExpiresAt?.toISOString() ?? null,
    passQrUrl: status === 'active' && handle ? buildStudentPassUrl(handle) : null,
  };
}

/** Matches the freeform school name against a real school Business, if one exists on K21. */
async function findSchoolBusinessByName(db, name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return db.business.findFirst({
    where: { type: 'school', name: { equals: trimmed, mode: 'insensitive' } },
  });
}

export async function computeNgorScore(userId) {
  const grouped = await prisma.ledgerEntry.groupBy({
    by: ['type'],
    where: {
      userId,
      type: { in: Object.keys(NGOR_POINTS) },
    },
    _count: { _all: true },
  });

  let score = 0;
  for (const row of grouped) {
    const pts = NGOR_POINTS[row.type] ?? 0;
    score += pts * row._count._all;
  }
  return score;
}

/** @deprecated use computeNgorScore */
export const computeKersaScore = computeNgorScore;
/** @deprecated use computeNgorScore */
export const computeWakhnaScore = computeNgorScore;

export async function computeMoiSummary(userId) {
  const [ngor, mboolo, events, user] = await Promise.all([
    computeNgorScore(userId),
    prisma.mboloMember.count({ where: { userId } }),
    prisma.ticket.count({ where: { buyerId: userId } }),
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
  ]);

  const highlights = await computeHighlights(userId, user);

  return {
    stats: {
      ngor,
      mboolo,
      events,
      cauris: 0,
    },
    ngorBarPercent: Math.min(100, Math.round((ngor / NGOR_BAR_TARGET) * 100)),
    studentPass: studentPassShape(user),
    highlights,
  };
}

export async function enrollStudentPass(userId, schoolName) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const tier = effectiveTier(user);
  const now = new Date();
  const expires = new Date(now);
  expires.setFullYear(expires.getFullYear() + 1);

  const active = tier >= 2;
  const matchedBusiness = await findSchoolBusinessByName(prisma, schoolName);
  return prisma.user.update({
    where: { id: userId },
    data: {
      studentPassSchool: schoolName.trim(),
      studentPassBusinessId: matchedBusiness?.id ?? null,
      studentPassStatus: active ? 'active' : 'pending',
      studentPassRequestedAt: now,
      studentPassVerifiedAt: active ? now : null,
      studentPassExpiresAt: active ? expires : null,
    },
  });
}

/** Called after CNI verification — activates a pending student pass. */
export async function activatePendingStudentPass(db, userId) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.studentPassSchool || user.studentPassStatus === 'active') return null;
  const now = new Date();
  const expires = new Date(now);
  expires.setFullYear(expires.getFullYear() + 1);
  return db.user.update({
    where: { id: userId },
    data: {
      studentPassStatus: 'active',
      studentPassVerifiedAt: now,
      studentPassExpiresAt: expires,
    },
  });
}
