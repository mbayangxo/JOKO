import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { decryptAtRest, encryptAtRest } from './field-crypto.js';
import { prisma } from './prisma.js';
import { generateTotpSecret, verifyTotp } from './admin-totp.js';

const SESSION_MS = 8 * 60 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;

function requireEnv(name, min = 16) {
  const value = process.env[name];
  if (value && value.length >= min) return value;
  if (process.env.NODE_ENV === 'production') throw new Error(`Missing or invalid ${name}`);
  return 'dev-only-k21-admin-jwt-secret-min-32-chars!!';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function adminShape(admin) {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    totpEnabled: admin.totpEnabled,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
  };
}

export function signAdminChallenge(adminId, purpose) {
  return jwt.sign({ sub: adminId, type: 'admin_challenge', purpose }, requireEnv('ADMIN_JWT_SECRET'), {
    expiresIn: '5m',
  });
}

export function verifyAdminChallenge(token, purpose) {
  try {
    const payload = jwt.verify(token, requireEnv('ADMIN_JWT_SECRET'));
    if (payload.type !== 'admin_challenge' || payload.purpose !== purpose) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

async function createAdminSession(adminId, { ip, userAgent, totpVerified }) {
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_MS);
  await prisma.adminSession.create({
    data: {
      adminUserId: adminId,
      tokenHash: hashToken(raw),
      totpVerified,
      expiresAt,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    },
  });
  const accessToken = jwt.sign(
    { sub: adminId, type: 'admin_access', sid: hashToken(raw) },
    requireEnv('ADMIN_JWT_SECRET'),
    { expiresIn: '8h' },
  );
  return { accessToken, expiresAt };
}

export async function bootstrapAdmin({ email, password, name, bootstrapSecret }) {
  const count = await prisma.adminUser.count();
  if (count > 0) {
    const err = new Error('Admin already exists');
    err.code = 'admin_exists';
    throw err;
  }
  const expected = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!expected || bootstrapSecret !== expected) {
    const err = new Error('Invalid bootstrap secret');
    err.code = 'bootstrap_denied';
    throw err;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.$transaction(async (tx) => {
    const created = await tx.adminUser.create({
      data: { email: email.toLowerCase().trim(), passwordHash, name: name ?? null },
    });
    // J3: the very first operator is a sysadmin ONLY (role management, no
    // money or identity powers). Every other role needs a second sysadmin
    // (maker-checker) or the offline break-glass script.
    await tx.adminRoleGrant.create({
      data: { adminUserId: created.id, role: 'sysadmin', grantedBy: 'bootstrap', reason: 'first operator created with the bootstrap secret' },
    });
    await tx.identityAuditEvent.create({
      data: { actorType: 'break_glass', action: 'admin_role_granted', subjectType: 'admin', subjectId: created.id, reason: 'bootstrap', afterJson: JSON.stringify({ roles: ['sysadmin'] }) },
    });
    return created;
  });
  return adminShape(admin);
}

export async function loginAdmin({ email, password, ip, userAgent }) {
  const admin = await prisma.adminUser.findUnique({
    where: { email: email.toLowerCase().trim() },
  });
  if (!admin?.active) {
    const err = new Error('Invalid credentials');
    err.code = 'invalid_credentials';
    throw err;
  }
  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) {
    const err = new Error('Invalid credentials');
    err.code = 'invalid_credentials';
    throw err;
  }

  if (!admin.totpEnabled) {
    return {
      setupRequired: true,
      challengeToken: signAdminChallenge(admin.id, 'setup_2fa'),
      admin: adminShape(admin),
    };
  }

  return {
    totpRequired: true,
    challengeToken: signAdminChallenge(admin.id, 'verify_2fa'),
    admin: adminShape(admin),
  };
}

export async function beginTotpSetup(challengeToken) {
  const adminId = verifyAdminChallenge(challengeToken, 'setup_2fa');
  if (!adminId) {
    const err = new Error('Invalid or expired challenge');
    err.code = 'challenge_expired';
    throw err;
  }
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
  const secret = generateTotpSecret();
  await prisma.adminUser.update({
    where: { id: adminId },
    data: { totpSecretEnc: encryptAtRest(secret), totpEnabled: false },
  });
  return { secret, otpauthUri: `otpauth://totp/K21%20Admin:${encodeURIComponent(admin.email)}?secret=${secret}&issuer=K21%20Admin` };
}

export async function confirmTotpSetup(challengeToken, code, { ip, userAgent }) {
  const adminId = verifyAdminChallenge(challengeToken, 'setup_2fa');
  if (!adminId) {
    const err = new Error('Invalid or expired challenge');
    err.code = 'challenge_expired';
    throw err;
  }
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
  const secret = decryptAtRest(admin.totpSecretEnc);
  if (!secret || !verifyTotp(secret, code)) {
    const err = new Error('Invalid authenticator code');
    err.code = 'invalid_totp';
    throw err;
  }
  const now = new Date();
  await prisma.adminUser.update({
    where: { id: adminId },
    data: { totpEnabled: true, totpConfirmedAt: now, lastLoginAt: now },
  });
  return createAdminSession(adminId, { ip, userAgent, totpVerified: true });
}

export async function verifyAdminTotp(challengeToken, code, { ip, userAgent }) {
  const adminId = verifyAdminChallenge(challengeToken, 'verify_2fa');
  if (!adminId) {
    const err = new Error('Invalid or expired challenge');
    err.code = 'challenge_expired';
    throw err;
  }
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
  const secret = decryptAtRest(admin.totpSecretEnc);
  if (!secret || !verifyTotp(secret, code)) {
    const err = new Error('Invalid authenticator code');
    err.code = 'invalid_totp';
    throw err;
  }
  await prisma.adminUser.update({
    where: { id: adminId },
    data: { lastLoginAt: new Date() },
  });
  return createAdminSession(adminId, { ip, userAgent, totpVerified: true });
}

export async function revokeAdminSession(tokenHash) {
  await prisma.adminSession.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getAdminFromBearer(authorization) {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7);
  try {
    const payload = jwt.verify(token, requireEnv('ADMIN_JWT_SECRET'));
    if (payload.type !== 'admin_access' || !payload.sid) return null;
    const session = await prisma.adminSession.findFirst({
      where: {
        tokenHash: payload.sid,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        totpVerified: true,
      },
      include: { admin: true },
    });
    if (!session?.admin?.active) return null;
    return { adminId: session.admin.id, sessionId: session.id, admin: session.admin };
  } catch {
    return null;
  }
}

/** J3: the shared ADMIN_API_KEY is retired and authorizes nothing. */
export function legacyAdminKeyValid() {
  return false;
}
