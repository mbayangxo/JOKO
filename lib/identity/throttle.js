import { prisma } from '../prisma.js';

/**
 * Rolling failure counters that survive code re-issue (AuthThrottle).
 * A 6-digit OTP is burned after 5 wrong guesses, but an attacker can request
 * a new code (5/h). Without a persistent counter that is ~120 guesses/day per
 * number forever; with it, a key is blocked for 24 h after MAX_FAILURES.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000;
export const THROTTLE_MAX_FAILURES = { otp: 15, cni_unlock: 5, pin: 10 };

export class ThrottleError extends Error {
  constructor(retryAfterSeconds) {
    super('Trop de tentatives — réessaie plus tard.');
    this.name = 'ThrottleError';
    this.code = 'auth_throttled';
    this.status = 429;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function assertNotThrottled(kind, id, db = prisma) {
  const row = await db.authThrottle.findUnique({ where: { key: `${kind}:${id}` } });
  if (row?.blockedUntil && row.blockedUntil > new Date()) {
    throw new ThrottleError(Math.ceil((row.blockedUntil.getTime() - Date.now()) / 1000));
  }
}

export async function recordFailure(kind, id, db = prisma) {
  const key = `${kind}:${id}`;
  const now = new Date();
  const max = THROTTLE_MAX_FAILURES[kind] ?? 10;
  const row = await db.authThrottle.findUnique({ where: { key } });
  const fresh = !row || now.getTime() - row.windowStart.getTime() > WINDOW_MS;
  const failures = fresh ? 1 : row.failures + 1;
  const blockedUntil = failures >= max ? new Date(now.getTime() + WINDOW_MS) : (fresh ? null : row.blockedUntil);
  await db.authThrottle.upsert({
    where: { key },
    create: { key, failures, windowStart: now, blockedUntil },
    update: { failures, windowStart: fresh ? now : row.windowStart, blockedUntil },
  });
  return { failures, blocked: Boolean(blockedUntil && blockedUntil > now) };
}

/** A success does not erase the window (an attacker cannot reset it by succeeding once elsewhere). */
export async function failureCount(kind, id, db = prisma) {
  const row = await db.authThrottle.findUnique({ where: { key: `${kind}:${id}` } });
  if (!row || Date.now() - row.windowStart.getTime() > WINDOW_MS) return 0;
  return row.failures;
}
