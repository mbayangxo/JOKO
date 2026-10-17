import { prisma } from '../prisma.js';
import { requestGeo } from '../geo-ip.js';
import { LIMITS } from '../authz/catalog.js';
import { recordIdentityEventSafe } from './audit.js';

/**
 * J3 sessions (docs/JOKKO-J3-DESIGN.md §5).
 *
 * One AuthSession per login on one device. Access tokens carry its id (`sid`);
 * refresh tokens are bound to it. The session has an ABSOLUTE expiry that
 * refresh rotation never extends, so a stolen refresh token cannot become
 * permanent access, and revoking the session ends both token kinds at once.
 *
 * trust:
 *  - 'trusted'  the device was already verified for this account
 *  - 'new'      first time this device is seen (or it was never verified)
 *  - 'recovery' the session was created by account recovery; it never
 *               becomes trusted (a fresh normal login after the cool-off does)
 */
export const SESSION_TRUST = ['trusted', 'new', 'recovery'];

export function sessionExpiry(from = new Date()) {
  return new Date(from.getTime() + LIMITS.sessionMaxDays() * 24 * 60 * 60 * 1000);
}

async function deviceRow(db, userId, deviceId) {
  if (!deviceId) return null;
  return db.userDevice.findUnique({ where: { userId_deviceId: { userId, deviceId } } });
}

export function deviceIsTrusted(device) {
  return Boolean(device?.verifiedAt && !device.revokedAt);
}

/** Create the session for a successful authentication (after registerDeviceLogin). */
export async function createAuthSession(db, { userId, req, authMethod }) {
  const geo = requestGeo(req);
  const device = await deviceRow(db, userId, geo.deviceId);
  const trust = authMethod === 'recovery' ? 'recovery' : deviceIsTrusted(device) ? 'trusted' : 'new';
  const now = new Date();
  const session = await db.authSession.create({
    data: {
      userId,
      deviceId: geo.deviceId ?? null,
      authMethod,
      trust,
      trustedAt: trust === 'trusted' ? now : null,
      ip: geo.ip ?? null,
      userAgent: String(req?.headers?.['user-agent'] ?? '').slice(0, 160) || null,
      expiresAt: sessionExpiry(now),
    },
  });
  await recordIdentityEventSafe(db, {
    actorType: 'user',
    actorId: userId,
    action: 'session_created',
    subjectType: 'session',
    subjectId: session.id,
    after: { authMethod, trust, deviceKnown: Boolean(device), deviceTrusted: deviceIsTrusted(device) },
    sessionId: session.id,
    ip: geo.ip ?? null,
  });
  return session;
}

/** Load a live session (not revoked, not past its absolute expiry). */
export async function loadLiveSession(sid, db = prisma) {
  if (!sid) return null;
  const s = await db.authSession.findUnique({ where: { id: sid } });
  if (!s || s.revokedAt || s.expiresAt <= new Date()) return null;
  return s;
}

export async function touchSession(sid, db = prisma) {
  if (!sid) return;
  await db.authSession.updateMany({ where: { id: sid, revokedAt: null }, data: { lastUsedAt: new Date() } });
}

/** Revoke one session and every refresh token bound to it. */
export async function revokeSession(db, sessionId, { reason, actorType = 'user', actorId = null } = {}) {
  const now = new Date();
  const r = await db.authSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: now, revokeReason: reason ?? 'revoked' },
  });
  await db.refreshToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: now } });
  if (r.count) {
    await recordIdentityEventSafe(db, { actorType, actorId, action: 'session_revoked', subjectType: 'session', subjectId: sessionId, reason });
  }
  return r.count;
}

/**
 * Revoke every session of a user (optionally keeping one), every refresh
 * token, and every access token issued before now (sessionsRevokedAt).
 */
export async function revokeAllSessions(db, userId, { reason, exceptSessionId = null, actorType = 'user', actorId = null } = {}) {
  const now = new Date();
  const where = { userId, revokedAt: null, ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}) };
  const r = await db.authSession.updateMany({ where, data: { revokedAt: now, revokeReason: reason ?? 'revoke_all' } });
  await db.refreshToken.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { NOT: { sessionId: exceptSessionId } } : {}) },
    data: { revokedAt: now },
  });
  if (!exceptSessionId) {
    await db.user.update({ where: { id: userId }, data: { sessionsRevokedAt: now } });
  }
  await recordIdentityEventSafe(db, {
    actorType,
    actorId,
    action: 'sessions_revoked_all',
    subjectType: 'user',
    subjectId: userId,
    reason,
    after: { revoked: r.count, keptCurrent: Boolean(exceptSessionId) },
  });
  return r.count;
}

/** Device verified with OTP: its normal sessions become trusted (recovery sessions do not). */
export async function trustSessionsOnDevice(db, userId, deviceId) {
  if (!deviceId) return 0;
  const r = await db.authSession.updateMany({
    where: { userId, deviceId, revokedAt: null, trust: 'new' },
    data: { trust: 'trusted', trustedAt: new Date() },
  });
  return r.count;
}

export async function markSessionStepUp(db, sid) {
  if (!sid) return;
  await db.authSession.updateMany({ where: { id: sid, revokedAt: null }, data: { stepUpAt: new Date() } });
}

/** Revoke a device's trust and every session on it. */
export async function revokeDevice(db, userId, deviceRowId, { reason, actorType = 'user', actorId = null } = {}) {
  const device = await db.userDevice.findFirst({ where: { id: deviceRowId, userId } });
  if (!device) return null;
  const now = new Date();
  await db.userDevice.update({ where: { id: device.id }, data: { revokedAt: now, revokedReason: reason ?? 'revoked', verifiedAt: null } });
  const sessions = await db.authSession.findMany({ where: { userId, deviceId: device.deviceId, revokedAt: null }, select: { id: true } });
  for (const s of sessions) await revokeSession(db, s.id, { reason: 'device_revoked', actorType, actorId });
  await recordIdentityEventSafe(db, { actorType, actorId, action: 'device_revoked', subjectType: 'device', subjectId: device.id, reason });
  return device;
}

export function sessionShape(s, currentSid) {
  return {
    id: s.id,
    current: s.id === currentSid,
    authMethod: s.authMethod,
    trust: s.trust,
    deviceId: s.deviceId ? `${s.deviceId.slice(0, 4)}…` : null,
    userAgent: s.userAgent,
    createdAt: s.createdAt.toISOString(),
    lastUsedAt: s.lastUsedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  };
}

export function deviceShape(d) {
  return {
    id: d.id,
    name: d.deviceName ?? null,
    trusted: deviceIsTrusted(d),
    revoked: Boolean(d.revokedAt),
    countryCode: d.countryCode ?? null,
    firstSeenAt: d.firstSeenAt.toISOString(),
    lastSeenAt: d.lastSeenAt.toISOString(),
  };
}

/**
 * The trust context of a request, used by step-up and the cash-out guard.
 * Requests that did not come through the dispatcher (direct handler calls in
 * unit tests) have no session: outside production they are treated as a
 * trusted legacy context; in production a token without a session is never
 * trusted.
 */
export function requestTrust(req) {
  const s = req?.authSession;
  if (s) {
    return {
      sessionId: s.id,
      trust: s.trust,
      deviceId: s.deviceId,
      stepUpAt: s.stepUpAt ?? null,
      createdAt: s.createdAt,
      legacy: false,
    };
  }
  const legacyTrusted = process.env.NODE_ENV !== 'production';
  return { sessionId: null, trust: legacyTrusted ? 'trusted' : 'new', deviceId: null, stepUpAt: null, createdAt: null, legacy: true };
}
