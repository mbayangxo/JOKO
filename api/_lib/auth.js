import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import { assertAccountAccessible, touchActivity } from '../../lib/session-security.js';
import { safeError } from '../../lib/log-redact.js';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.length < 16) {
    throw new Error(`Missing or invalid ${name}`);
  }
  return value;
}

export function signAccessToken(userId) {
  // iatMs: millisecond issue time so session revocation is exact (JWT iat is
  // whole seconds, which would reject a fresh login made in the same second).
  return jwt.sign({ sub: userId, type: 'access', iatMs: Date.now() }, requireEnv('JWT_ACCESS_SECRET'), {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '30m',
  });
}

export function signRefreshToken(userId) {
  // jti makes every token byte-distinct even when issued for the same user in
  // the same second (JWT `iat` is second-granularity) — without it, two logins
  // within the same second produce an identical token, and storing its hash
  // in the unique RefreshToken.tokenHash column throws on the second insert.
  return jwt.sign(
    { sub: userId, type: 'refresh', jti: crypto.randomBytes(16).toString('hex') },
    requireEnv('JWT_REFRESH_SECRET'),
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' },
  );
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshExpiry() {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

export function reference(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

export function otp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** JWT validation only — no session/lock checks. */
export function verifyAccessToken(token) {
  const payload = verifyAccessTokenPayload(token);
  return payload?.sub ?? null;
}

export function verifyAccessTokenPayload(token) {
  const payload = jwt.verify(token, requireEnv('JWT_ACCESS_SECRET'));
  if (!payload.sub || payload.type !== 'access') return null;
  return payload;
}

function authFail(req, code, message, debug) {
  req._authError = { code, message, debug };
  return null;
}

/**
 * Every exit path tags req._authError with a distinct code + a `debug`
 * string. This turns "session invalide" from an unexplained dead end into
 * something a screenshot can diagnose in one look — the router echoes
 * `debug` on the response while the app is in beta (see api-router.js).
 */
export async function getUserIdFromRequest(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return authFail(req, 'no_token', 'No Authorization header', 'missing_bearer_header');
  }

  let userId;
  let tokenIssuedAtMs = null;
  try {
    const payload = verifyAccessTokenPayload(header.slice('Bearer '.length).trim());
    userId = payload?.sub ?? null;
    tokenIssuedAtMs = Number.isFinite(payload?.iatMs) ? payload.iatMs : payload?.iat ? payload.iat * 1000 : null;
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'token_expired' : 'token_invalid';
    return authFail(req, code, err.message, `jwt:${err.name}`);
  }
  if (!userId) {
    return authFail(req, 'token_invalid', 'Token payload missing sub/type', 'jwt:bad_payload');
  }

  let user;
  try {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        frozenByAdminAt: true,
        accountLockedAt: true,
        lastActivityAt: true,
        otpVerifiedAt: true,
        sessionsRevokedAt: true,
      },
    });
  } catch (err) {
    if (err?.code === 'P2022') {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, frozenByAdminAt: true, accountLockedAt: true, lastActivityAt: true },
      });
    } else {
      throw err;
    }
  }
  if (!user) {
    return authFail(req, 'user_not_found', 'Valid token but no matching user row', `uid:${userId}`);
  }

  // Session revocation (credential remediation): tokens issued before the
  // revocation instant are dead, even though their signature is valid.
  if (user.sessionsRevokedAt && (!tokenIssuedAtMs || tokenIssuedAtMs < user.sessionsRevokedAt.getTime())) {
    return authFail(req, 'token_expired', 'Session revoked', 'session_revoked');
  }

  // Refresh activity before the idle check — returning users were getting
  // "session invalide" on the first call right after a successful OTP login.
  await touchActivity(userId).catch((err) => {
    console.error('[auth] touchActivity failed', safeError(err));
  });

  try {
    await assertAccountAccessible({ ...user, lastActivityAt: new Date() });
  } catch (error) {
    if (error.code === 'account_frozen' || error.code === 'account_locked') {
      return authFail(req, error.code, error.message, `account:${error.code}`);
    }
    // Ignore session_inactive — client PIN gate handles idle lock locally.
  }

  return userId;
}
