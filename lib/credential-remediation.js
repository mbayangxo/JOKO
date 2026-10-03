import bcrypt from 'bcryptjs';
import { prisma } from './prisma.js';

/**
 * Credential remediation for accounts whose PIN/password hashes may have been
 * exposed (J0 run 3: Mboolo returned raw User rows). A 6-digit PIN hash is
 * brute-forceable offline, so exposed credentials are treated as COMPROMISED:
 *
 *   markCredentialsCompromised()  — operator/admin action, per account:
 *     • invalidates the PIN (pinHash → null) and password (passwordHash → null)
 *     • flags credentialResetRequiredAt (outbound money held by the risk gate)
 *     • optionally revokes every session: refresh tokens revoked, and access
 *       tokens issued before sessionsRevokedAt are rejected by the API
 *     • writes CredentialSecurityEvent rows (append-only; never secrets)
 *
 *   The user re-establishes credentials only after a FRESH OTP login made
 *   after the reset was flagged (assertFreshVerificationForReset). The same
 *   OTP attempt limits / rate limits / generic responses apply, so the reset
 *   flow is no easier than normal recovery and reveals nothing extra.
 *
 * Nothing here sends notifications; see docs/JOKKO-CREDENTIAL-REMEDIATION.md.
 */

export class CredentialResetError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function recordCredentialEvent(db, { userId, type, actorType, actorId, reason, classification }) {
  return db.credentialSecurityEvent.create({
    data: { userId, type, actorType, actorId: actorId ?? null, reason: reason ?? null, classification: classification ?? null },
  });
}

/**
 * @param {string[]} userIds
 * @param {{ reason: string, actorType: 'admin'|'operator_script'|'system', actorId?: string,
 *           classification?: 'A'|'B', revokeSessions?: boolean, dryRun?: boolean }} opts
 */
export async function markCredentialsCompromised(userIds, opts) {
  const { reason, actorType, actorId = null, classification = null, revokeSessions = true, dryRun = false } = opts;
  if (!reason) throw new Error('reason required');
  const ids = [...new Set(userIds.filter(Boolean))];
  const summary = { requested: ids.length, found: 0, pinInvalidated: 0, passwordInvalidated: 0, sessionsRevoked: 0, alreadyFlagged: 0 };

  for (const userId of ids) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, pinHash: true, passwordHash: true, credentialResetRequiredAt: true },
    });
    if (!user) continue;
    summary.found += 1;
    if (user.credentialResetRequiredAt) summary.alreadyFlagged += 1;
    if (user.pinHash) summary.pinInvalidated += 1;
    if (user.passwordHash) summary.passwordInvalidated += 1;
    if (revokeSessions) summary.sessionsRevoked += 1;
    if (dryRun) continue;

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          pinHash: null,
          passwordHash: null,
          pinFailedAttempts: 0,
          credentialResetRequiredAt: now,
          credentialResetReason: reason.slice(0, 200),
          ...(revokeSessions ? { sessionsRevokedAt: now } : {}),
        },
      });
      const base = { userId, actorType, actorId, reason, classification };
      await recordCredentialEvent(tx, { ...base, type: 'exposure_marked' });
      if (user.pinHash) await recordCredentialEvent(tx, { ...base, type: 'pin_invalidated' });
      if (user.passwordHash) await recordCredentialEvent(tx, { ...base, type: 'password_invalidated' });
      if (revokeSessions) {
        await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
        await recordCredentialEvent(tx, { ...base, type: 'sessions_revoked' });
      }
    });
  }
  return summary;
}

/**
 * Before a new PIN/password may be set on an account under forced reset, the
 * caller must have completed an OTP login AFTER the reset was flagged.
 * (Password logins do not set otpVerifiedAt — only OTP verification does.)
 */
export function assertFreshVerificationForReset(user) {
  if (!user.credentialResetRequiredAt) return;
  const verifiedAt = user.otpVerifiedAt?.getTime() ?? 0;
  if (verifiedAt <= user.credentialResetRequiredAt.getTime()) {
    throw new CredentialResetError(
      'reverification_required',
      'Pour ta sécurité, reconnecte-toi avec un code reçu par SMS ou email avant de choisir un nouveau code.',
    );
  }
}

/** Called after a credential was re-established; clears the reset when nothing is left to set. */
export async function completeCredentialReset(db, userId, type) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { credentialResetRequiredAt: true, pinHash: true } });
  if (!user?.credentialResetRequiredAt) return;
  await recordCredentialEvent(db, { userId, type, actorType: 'user', actorId: userId });
  // The PIN is the transaction credential: once it is re-established the
  // forced reset is complete (password is optional on Jokko). A 24h cool-off
  // on outbound money follows, exactly like an access recovery.
  if (type === 'pin_reestablished' || user.pinHash) {
    await db.user.update({
      where: { id: userId },
      data: { credentialResetRequiredAt: null, credentialResetReason: null, accountRecoveredAt: new Date() },
    });
  }
}

/** Constant-time-ish PIN check used when changing an existing PIN. */
export async function pinMatches(pin, pinHash) {
  if (!pinHash) return false;
  return bcrypt.compare(String(pin ?? ''), pinHash);
}
