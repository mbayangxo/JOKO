import { prisma } from '../prisma.js';
import { distanceKm, formatDistanceKm } from '../geo.js';
import { cashLimits } from './limits.js';

/**
 * J6.14 — public agent discovery.
 *
 * Lists SERVICE POINTS (public places), only when the point, its
 * organization and at least one assigned agent are all active. Never: the
 * agent's phone, user id, home, precise coordinates, float, cash on hand or
 * any "available now" claim. `openNow` is computed ONLY from the hours the
 * point declared (source: declared_hours) and is null when none are declared.
 * The old agents/nearby leak (float-based ordering, ~100 m coordinates,
 * float-derived "open now") is gone.
 */
const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function openNowFromHours(hoursJson, now = new Date()) {
  if (!hoursJson) return null;
  let hours;
  try {
    hours = JSON.parse(hoursJson);
  } catch {
    return null;
  }
  const day = DAY[now.getUTCDay()]; // Africa/Dakar = UTC, no DST
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return (hours[day] ?? []).some(([a, b]) => hhmm >= a && hhmm < b);
}

export function servicePointPublicShape(sp, { lat, lng, hasBusinessAgent }) {
  const d = lat != null && lng != null && sp.approxLat != null ? distanceKm(lat, lng, sp.approxLat, sp.approxLng) : null;
  return {
    id: sp.id,
    name: sp.name,
    publicAddress: sp.publicAddress,
    area: sp.area,
    services: { cashIn: sp.cashIn, cashOut: sp.cashOut, merchantAssist: sp.merchantAssist && sp.merchantAssistPermitted },
    largeCashOut: hasBusinessAgent,
    hours: sp.hoursJson ? JSON.parse(sp.hoursJson) : null,
    openNow: openNowFromHours(sp.hoursJson),
    openNowSource: sp.hoursJson ? 'declared_hours' : null,
    distanceKm: d == null ? null : Math.round(d * 10) / 10,
    distanceLabel: formatDistanceKm(d),
  };
}

export async function listServicePoints(db = prisma, { lat, lng, service, amountXof, limit = 30 } = {}) {
  const where = { status: 'active' };
  if (service === 'cash_in') where.cashIn = true;
  if (service === 'cash_out') where.cashOut = true;
  const points = await db.agentServicePoint.findMany({ where, take: 300 });
  if (!points.length) return [];
  const ids = points.map((p) => p.id);
  const candidates = await db.agentProfile.findMany({ where: { servicePointId: { in: ids }, status: 'active' }, select: { userId: true, servicePointId: true, tier: true, organizationId: true } });
  const active = new Set((await db.accountRole.findMany({ where: { role: 'agent', status: 'active', userId: { in: candidates.map((a) => a.userId) } }, select: { userId: true } })).map((r) => r.userId));
  const agents = candidates.filter((a) => active.has(a.userId));
  const orgIds = [...new Set(points.map((p) => p.organizationId))];
  const orgs = new Set((await db.agentOrganization.findMany({ where: { id: { in: orgIds }, status: 'active' }, select: { id: true } })).map((o) => o.id));
  const large = amountXof != null && service === 'cash_out' && amountXof > cashLimits().largeCashOutXof;
  const shaped = points
    .filter((p) => orgs.has(p.organizationId))
    .map((p) => {
      const here = agents.filter((a) => a.servicePointId === p.id && a.organizationId === p.organizationId);
      return { p, here };
    })
    .filter(({ here }) => here.length > 0)
    .filter(({ here }) => !large || here.some((a) => a.tier === 'business'))
    .map(({ p, here }) => servicePointPublicShape(p, { lat, lng, hasBusinessAgent: here.some((a) => a.tier === 'business') }));
  shaped.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.name.localeCompare(b.name));
  return shaped.slice(0, limit);
}
