import crypto from 'crypto';
import { prisma } from './prisma.js';
import { otpDisclosureAllowed } from './runtime-safety.js';
import { ThrottleError, assertNotThrottled, recordFailure } from './identity/throttle.js';

/** Wrong guesses allowed against one issued code before it is burned. */
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_TTL_MS = 10 * 60 * 1000;

export function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function codesEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Store a fresh code for `key`, replacing older ones (only the newest code is ever valid). */
export async function storeOtp(key, code) {
  await prisma.otpCode.deleteMany({ where: { phone: key } });
  return prisma.otpCode.create({
    data: { phone: key, code, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });
}

/**
 * Verify a code against the newest unexpired OTP for any of `keys`.
 * Every wrong guess is counted; after OTP_MAX_ATTEMPTS the code is burned, so
 * a 6-digit code cannot be brute-forced within its lifetime.
 * @returns {{ ok: true, row } | { ok: false, reason: 'invalid' | 'locked' }}
 */
export async function verifyOtp(keys, code) {
  const variants = [...new Set((keys ?? []).filter(Boolean))];
  if (!variants.length) return { ok: false, reason: 'invalid' };
  // J3: a rolling 24 h failure cap per identity that survives re-issuing codes.
  const throttleId = variants[0];
  try {
    await assertNotThrottled('otp', throttleId);
  } catch (error) {
    if (error instanceof ThrottleError) return { ok: false, reason: 'locked', throttled: true };
    throw error;
  }

  const latest = await prisma.otpCode.findFirst({
    where: { phone: { in: variants }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) return { ok: false, reason: 'invalid' };
  if (latest.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'locked' };

  if (codesEqual(latest.code, String(code ?? '').trim())) {
    // Single use: consume atomically so a replayed code can't be used twice.
    const consumed = await prisma.otpCode.deleteMany({ where: { id: latest.id } });
    if (consumed.count !== 1) return { ok: false, reason: 'invalid' };
    return { ok: true, row: latest };
  }

  const updated = await prisma.otpCode.update({
    where: { id: latest.id },
    data: { attempts: { increment: 1 } },
  });
  await recordFailure('otp', throttleId);
  return { ok: false, reason: updated.attempts >= OTP_MAX_ATTEMPTS ? 'locked' : 'invalid' };
}

/** Response for a failed verification (401 wrong code, 429 code burned). */
export function otpFailure(res, result, extra = {}) {
  if (result.reason === 'locked') {
    res.status(429).json({
      error: 'Trop de codes erronés — demande un nouveau code.',
      code: 'otp_locked',
    });
    return;
  }
  res.status(401).json({ error: 'Invalid or expired OTP', code: 'otp_invalid', ...extra });
}

/**
 * Send the OTP-issued response.
 * - Production: the code is NEVER returned. If no channel delivered it, the
 *   stored code is deleted and 503 is returned (fail closed, no fake success).
 * - Development/test: the code is echoed for local testing.
 */
export async function respondOtpIssued(res, { key, code, delivered, channel, extra = {} }) {
  if (otpDisclosureAllowed()) {
    res.json({ otp: code, [channel]: delivered ? 'sent' : 'mock', ...extra });
    return;
  }
  if (!delivered) {
    await prisma.otpCode.deleteMany({ where: { phone: key } }).catch(() => {});
    res.status(503).json({
      error: 'Envoi du code impossible pour le moment. Réessaie plus tard.',
      code: 'otp_delivery_unavailable',
    });
    return;
  }
  res.json({ sent: true, message: channel === 'email' ? 'Code envoyé par email' : 'Code envoyé par SMS', ...extra });
}
