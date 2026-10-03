import jwt from 'jsonwebtoken';
import { prisma } from './prisma.js';

export const SESSION_INACTIVITY_MS = 30 * 60 * 1000;
export const STEP_UP_VALID_MS = 5 * 60 * 1000;
export const HIGH_VALUE_XOF = 50_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.length < 16) throw new Error(`Missing or invalid ${name}`);
  return value;
}

export function isSessionInactive(lastActivityAt) {
  if (!lastActivityAt) return false;
  return Date.now() - lastActivityAt.getTime() > SESSION_INACTIVITY_MS;
}

export async function touchActivity(userId) {
  await prisma.user.update({
    where: { id: userId },
    data: { lastActivityAt: new Date() },
  });
}

/**
 * Step-up (PIN) verified. J3: bound to the session it happened in — a PIN
 * entered on one device never authorizes another device's session. The
 * user-level stepUpVerifiedAt is kept only for session-less legacy contexts.
 */
export async function markStepUpVerified(userId, sid = null) {
  const now = new Date();
  if (sid) {
    await prisma.authSession.updateMany({ where: { id: sid, userId, revokedAt: null }, data: { stepUpAt: now } });
  } else {
    await prisma.user.update({ where: { id: userId }, data: { stepUpVerifiedAt: now } });
  }
  return signStepUpToken(userId, now, sid);
}

export function signStepUpToken(userId, verifiedAt = new Date(), sid = null) {
  return jwt.sign(
    { sub: userId, type: 'step_up', verifiedAt: verifiedAt.toISOString(), ...(sid ? { sid } : {}) },
    requireEnv('JWT_ACCESS_SECRET'),
    { expiresIn: '5m' },
  );
}

/** A step-up token is valid only for its user AND (when sessions exist) its session. */
export function verifyStepUpToken(token, userId, sid = null) {
  try {
    const payload = jwt.verify(token, requireEnv('JWT_ACCESS_SECRET'));
    if (payload.sub !== userId || payload.type !== 'step_up') return false;
    if ((payload.sid ?? null) !== (sid ?? null)) return false;
    return true;
  } catch {
    return false;
  }
}

export function isStepUpFresh(stepUpVerifiedAt) {
  if (!stepUpVerifiedAt) return false;
  return Date.now() - stepUpVerifiedAt.getTime() <= STEP_UP_VALID_MS;
}

export async function assertAccountAccessible(user) {
  if (user.frozenByAdminAt) {
    const err = new Error('Account suspended by administrator');
    err.code = 'account_frozen';
    err.status = 423;
    throw err;
  }
  if (user.accountLockedAt) {
    const err = new Error('Account locked');
    err.code = 'account_locked';
    err.status = 423;
    throw err;
  }
  if (isSessionInactive(user.lastActivityAt)) {
    // Verify just wrote otpVerifiedAt + lastActivityAt; a read replica or
    // pooler lag can still serve the old idle timestamp on the very next call.
    if (user.otpVerifiedAt && Date.now() - user.otpVerifiedAt.getTime() < 120_000) {
      return;
    }
    const err = new Error('Session expired due to inactivity');
    err.code = 'session_inactive';
    err.status = 401;
    throw err;
  }
}
