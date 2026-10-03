/**
 * J3 adversarial-test helpers: real OTP logins (stored code + POST auth/verify
 * against a NODE_ENV=production API process), operators with explicit
 * AdminRoleGrant rows, businesses with members. No lib/ module is mocked.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createUserWithWallet, createVerifiedDevice, prisma } from '../helpers/db.js';
import { freshIp } from '../helpers/http-harness.js';

export const ACCESS_SECRET = 'http-test-access-secret-0123456789';
export const ADMIN_SECRET = 'http-test-admin-secret-0123456789abcd';

export const newDevice = () => `dev-${crypto.randomBytes(6).toString('hex')}`;
const H = { 'x-vercel-ip-country': 'SN' };

/** Store an OTP for the phone and verify it through the real endpoint. */
export async function otpLogin(api, phone, { device, intent = 'login', ip = freshIp() } = {}) {
  const code = String(crypto.randomInt(100000, 1000000));
  await prisma.otpCode.deleteMany({ where: { phone } });
  await prisma.otpCode.create({ data: { phone, code, expiresAt: new Date(Date.now() + 600_000) } });
  const r = await api.client('POST', 'auth/verify', { device, ip, headers: H, body: { phone, otp: code, intent } });
  return { ...r, device, ip };
}

/** A customer with a phone, wallet, tier and a device first seen long ago (their own phone). */
export async function customer({ koriBalance = 0, tier = 2, deviceAgeHours = 72 } = {}) {
  const user = await createUserWithWallet({ koriBalance, tier });
  const device = await createVerifiedDevice(user.id);
  const past = new Date(Date.now() - deviceAgeHours * 3600_000);
  await prisma.userDevice.updateMany({ where: { userId: user.id, deviceId: device }, data: { firstSeenAt: past, verifiedAt: past } });
  return { user, id: user.id, phone: user.phone, handle: user.handle, device };
}

/** Log a customer in on their own (trusted) device; returns tokens + call helper. */
export async function signedIn(api, c, { device = c.device, intent = 'login' } = {}) {
  const r = await otpLogin(api, c.phone, { device, intent });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
  const ip = freshIp();
  const s = { ...c, device, ip, token: r.body.accessToken, refresh: r.body.refreshToken, session: r.body.session };
  s.call = (method, path, body, extra = {}) =>
    api.client(method, path, { token: s.token, device, ip, headers: { ...H, ...(extra.headers ?? {}) }, body });
  return s;
}

/** PIN step-up inside the session (sets a PIN first if none). */
export async function stepUp(s, pin = '482913') {
  const bcrypt = (await import('bcryptjs')).default;
  const u = await prisma.user.findUnique({ where: { id: s.id }, select: { pinHash: true } });
  if (!u.pinHash) await prisma.user.update({ where: { id: s.id }, data: { pinHash: await bcrypt.hash(pin, 4) } });
  const r = await s.call('POST', 'auth/pin/verify', { pin });
  if (r.status !== 200) throw new Error(`step-up failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.stepUpToken;
}

/** An operator holding exactly `roles`, with a live TOTP-verified admin session. */
export async function operator(api, roles = []) {
  const admin = await prisma.adminUser.create({
    data: { email: `op-${crypto.randomBytes(5).toString('hex')}@test.local`, passwordHash: 'x', totpEnabled: true },
  });
  for (const role of roles) {
    await prisma.adminRoleGrant.create({ data: { adminUserId: admin.id, role, grantedBy: 'test-fixture', reason: 'test fixture grant' } });
  }
  const tokenHash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');
  await prisma.adminSession.create({ data: { adminUserId: admin.id, tokenHash, totpVerified: true, expiresAt: new Date(Date.now() + 3600_000) } });
  const token = jwt.sign({ sub: admin.id, type: 'admin_access', sid: tokenHash }, ADMIN_SECRET, { expiresIn: '1h' });
  const ip = freshIp();
  return {
    id: admin.id,
    token,
    call: (method, path, body, headers = {}) => api.client(method, path, { token, ip, headers, body }),
  };
}

/** A business owned by `owner`, with optional ACTIVE members [{ user, role }]. */
export async function business(owner, members = []) {
  const b = await prisma.business.create({ data: { ownerId: owner.id, name: `Biz ${crypto.randomBytes(3).toString('hex')}`, type: 'merchant' } });
  for (const m of members) {
    await prisma.businessMember.create({ data: { businessId: b.id, userId: m.user.id, role: m.role, status: 'active', acceptedAt: new Date() } });
  }
  return b;
}
