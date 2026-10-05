/**
 * J3 destruction suite — sessions, devices, OTP, PIN, recovery.
 * Real HTTP against api/index.js with NODE_ENV=production. Logins are real
 * (stored OTP → POST auth/verify). J2 money invariants are checked after
 * every scenario.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fundUser, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, newDevice, otpLogin, signedIn, stepUp } from './helpers.js';
import { verifyOtp } from '../../lib/otp-service.js';
import { otpKeysForPhone } from '../../lib/auth-otp.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const refresh = (t) => api.client('POST', 'auth/refresh', { ip: freshIp(), body: { refreshToken: t } });

test('every login is a device-bound session; the access token dies with the session (logout)', async () => {
  const c = await customer();
  const s = await signedIn(api, c);
  assert.equal(s.session.trust, 'trusted', 'own, previously verified device');
  assert.equal((await s.call('GET', 'wallet')).status, 200);
  assert.equal((await s.call('POST', 'auth/logout', { refreshToken: s.refresh })).status, 200);
  assert.equal((await s.call('GET', 'wallet')).status, 401, 'access token revoked immediately, not at expiry');
  assert.equal((await refresh(s.refresh)).status, 401);
});

test('stolen refresh token: replay after rotation kills the whole session (thief and victim)', async () => {
  const c = await customer();
  const victim = await signedIn(api, c);
  const thief = await refresh(victim.refresh); // the thief rotates first
  assert.equal(thief.status, 200);
  await prisma.refreshToken.updateMany({ where: { sessionId: victim.session.id, rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 120_000) } });
  assert.equal((await refresh(victim.refresh)).status, 401, 'victim replays the old token → reuse detected');
  assert.equal((await refresh(thief.body.refreshToken)).status, 401, 'thief chain dead');
  const thiefCall = await api.client('GET', 'wallet', { token: thief.body.accessToken, device: c.device, ip: freshIp() });
  assert.equal(thiefCall.status, 401, 'thief access token dead too');
  const s = await prisma.authSession.findUnique({ where: { id: victim.session.id } });
  assert.equal(s.revokeReason, 'refresh_reuse_detected');
});

test('refresh replay under concurrency: exactly one rotation', async () => {
  const s = await signedIn(api, await customer());
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => refresh(s.refresh)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(','));
});

test('a stolen refresh token never becomes permanent access: absolute session expiry', async () => {
  const s = await signedIn(api, await customer());
  await prisma.authSession.update({ where: { id: s.session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await refresh(s.refresh)).status, 401);
  assert.equal((await s.call('GET', 'wallet')).status, 401);
});

test('sessions/devices: users see and revoke their own — never someone else’s', async () => {
  const c = await customer();
  const phone1 = await signedIn(api, c);
  const phone2 = await signedIn(api, c, { device: newDevice() });
  const list = await phone1.call('GET', 'auth/sessions');
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 2);
  assert.ok(!JSON.stringify(list.body).match(/token|hash/i), 'no token material');
  const other = list.body.find((x) => !x.current);
  const stranger = await signedIn(api, await customer());
  assert.equal((await stranger.call('POST', `auth/sessions/${other.id}/revoke`)).status, 404, 'IDOR refused');
  assert.equal((await phone1.call('POST', `auth/sessions/${phone2.session.id}/revoke`)).status, 200);
  assert.equal((await phone2.call('GET', 'wallet')).status, 401);
  assert.equal((await phone1.call('GET', 'wallet')).status, 200);
  const devices = await phone1.call('GET', 'auth/devices');
  assert.equal((await stranger.call('POST', `auth/devices/${devices.body[0].id}/revoke`)).status, 404);
});

test('logout-all ends every session of the account', async () => {
  const c = await customer();
  const a = await signedIn(api, c);
  const b = await signedIn(api, c, { device: newDevice() });
  assert.equal((await a.call('POST', 'auth/logout-all', {})).status, 200);
  assert.equal((await a.call('GET', 'wallet')).status, 401);
  assert.equal((await b.call('GET', 'wallet')).status, 401);
});

test('OTP brute force: codes burn after 5 guesses and a rolling 24 h cap survives re-issuing codes', async () => {
  const c = await customer();
  const keys = otpKeysForPhone(c.phone);
  // In-process (no HTTP rate limiter in the way): 3 fresh codes × 5 wrong guesses.
  for (let round = 0; round < 3; round += 1) {
    await prisma.otpCode.create({ data: { phone: c.phone, code: '999999', expiresAt: new Date(Date.now() + 600_000) } });
    for (let i = 0; i < 5; i += 1) await verifyOtp(keys, String(100000 + i));
  }
  // A brand-new code, guessed correctly, is still refused: the identity is throttled for 24 h.
  await prisma.otpCode.create({ data: { phone: c.phone, code: '555555', expiresAt: new Date(Date.now() + 600_000) } });
  const r = await verifyOtp(keys, '555555');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'locked');
  assert.ok(await prisma.authThrottle.findFirst({ where: { key: `otp:${keys[0]}`, blockedUntil: { gt: new Date() } } }));
  // And over HTTP the correct code is refused too.
  const http = await otpLogin(api, c.phone, { device: c.device });
  assert.equal(http.status, 429);
});

test('recovery takeover (SIM swap): old sessions die, PIN is reset, cash-out and credential changes are held', async () => {
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, 50_000);
  const owner = await signedIn(api, c);
  const attackerDevice = newDevice();
  const takeover = await signedIn(api, c, { device: attackerDevice, intent: 'recover' });
  assert.equal(takeover.session.trust, 'recovery');
  assert.equal((await owner.call('GET', 'wallet')).status, 401, 'the previous session is revoked');
  const u = await prisma.user.findUnique({ where: { id: c.id } });
  assert.equal(u.pinHash, null);
  assert.ok(u.accountRecoveredAt);
  // The attacker sets a fresh PIN (allowed: it is how the real owner gets back in) …
  await stepUp(takeover);
  // … but money cannot leave, and the account's contact points cannot be changed.
  const out = await takeover.call('POST', 'cash/out', { amount: 20_000, operator: 'wave' });
  assert.equal(out.status, 423);
  assert.ok(out.body.reasonCodes.includes('recent_recovery'));
  const before = (await prisma.wallet.findUnique({ where: { userId: c.id } })).koriBalance;
  assert.equal(before, 50_000, 'nothing moved');
  const email = await takeover.call('POST', 'me/email', { email: 'attacker@example.com' });
  assert.equal(email.status, 423);
  const phone = await takeover.call('POST', 'me/phone', { phone: '+221771234567' });
  assert.equal(phone.status, 423);
  const send = await takeover.call('POST', 'transfers/send', { recipientHandle: (await customer()).handle, amount: 100 });
  assert.notEqual(send.status, 201, 'P2P out of a recovered account is held for review, not executed');
});

test('PIN brute-force loop is closed: an OTP login that clears a PIN lock is a recovery', async () => {
  const c = await customer();
  const s = await signedIn(api, c);
  await stepUp(s, '135790');
  for (let i = 0; i < 5; i += 1) await s.call('POST', 'auth/pin/verify', { pin: '000000' });
  assert.ok((await prisma.user.findUnique({ where: { id: c.id } })).accountLockedAt, 'locked after 5');
  const again = await signedIn(api, c);
  assert.equal(again.session.trust, 'recovery', 'unlocking via OTP opens a recovery session');
  const u = await prisma.user.findUnique({ where: { id: c.id } });
  assert.equal(u.pinHash, null, 'the PIN being guessed is gone — guessing cannot continue');
  assert.ok(u.accountRecoveredAt);
});

test('new-device cash-out: an OTP login on an unknown phone is untrusted; verifying it does not skip the cool-off', async () => {
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, 30_000);
  const fresh = await signedIn(api, c, { device: newDevice() });
  assert.equal(fresh.session.trust, 'new');
  await stepUp(fresh);
  const r1 = await fresh.call('POST', 'cash/out', { amount: 10_000, operator: 'wave' });
  assert.equal(r1.status, 423);
  assert.ok(r1.body.reasonCodes.includes('untrusted_session'));
  // The attacker holds the SIM, so verifies the device by OTP …
  const code = '424242';
  await prisma.otpCode.create({ data: { phone: c.phone, code, expiresAt: new Date(Date.now() + 600_000) } });
  assert.equal((await fresh.call('POST', 'auth/device/verify', { phone: c.phone, otp: code })).status, 200);
  const r2 = await fresh.call('POST', 'cash/out', { amount: 10_000, operator: 'wave' });
  assert.equal(r2.status, 423, 'device first seen < 24 h ago');
  assert.ok(r2.body.reasonCodes.includes('new_device'));
  // P2P from the untrusted session needs step-up for ANY amount.
  const s2 = await signedIn(api, c, { device: newDevice() });
  const p2p = await s2.call('POST', 'transfers/send', { recipientHandle: (await customer()).handle, amount: 10 });
  assert.equal(p2p.status, 403);
  assert.equal(p2p.body.code, 'step_up_required');
});

test('step-up is bound to its session: a PIN entered on one phone does not authorize another', async () => {
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, 20_000);
  const phoneA = await signedIn(api, c);
  const token = await stepUp(phoneA);
  const phoneB = await signedIn(api, c);
  const r = await phoneB.call('POST', 'transfers/send', { recipientHandle: (await customer()).handle, amount: 6_000 }, { headers: { 'x-step-up-token': token } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'step_up_required');
});

test('established owner on own phone with PIN step-up passes the guard (reaches the cash-out handler)', async () => {
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, 30_000);
  const s = await signedIn(api, c);
  const noPin = await s.call('POST', 'cash/out', { amount: 10_000, operator: 'wave' });
  assert.equal(noPin.status, 403);
  assert.equal(noPin.body.code, 'step_up_required');
  await stepUp(s);
  const r = await s.call('POST', 'cash/out', { amount: 10_000, operator: 'wave' });
  assert.ok(!['cash_out_hold', 'cash_out_denied', 'step_up_required'].includes(r.body?.code), JSON.stringify(r.body));
  const d = await prisma.riskDecision.findFirst({ where: { userId: c.id, action: 'cash_out' }, orderBy: { createdAt: 'desc' } });
  assert.equal(d.decision, 'allow', 'every decision is recorded with its reasons');
});

test('contact change opens a cool-off: phone changed → cash-out held 24 h', async () => {
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, 30_000);
  const s = await signedIn(api, c);
  await stepUp(s);
  const newPhone = `+22178${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  // Passes the sensitive-change guard; production cannot deliver SMS here (503, fail closed).
  const asked = await s.call('POST', 'me/phone', { phone: newPhone });
  assert.ok([200, 503].includes(asked.status), JSON.stringify(asked.body));
  await prisma.otpCode.create({ data: { phone: `change:${c.id}:${newPhone}`, code: '737373', expiresAt: new Date(Date.now() + 600_000) } });
  const done = await s.call('POST', 'me/phone/confirm', { phone: newPhone, otp: '737373' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const r = await s.call('POST', 'cash/out', { amount: 10_000, operator: 'wave' });
  assert.equal(r.status, 423);
  assert.ok(r.body.reasonCodes.includes('recent_contact_change'));
});

test('email can never be attached by a profile update; the verified flow proves the inbox', async () => {
  const c = await customer();
  const s = await signedIn(api, c);
  const direct = await s.call('PATCH', 'me', { email: 'squat@example.com' });
  assert.equal(direct.status, 400);
  assert.equal(direct.body.code, 'email_change_requires_verification');
  assert.equal((await prisma.user.findUnique({ where: { id: c.id } })).email, null);
  // Through the guarded flow (trusted session + step-up + code to the new inbox).
  // With a PIN on the account, a fresh login alone is not enough: step-up is required.
  const bcrypt = (await import('bcryptjs')).default;
  await prisma.user.update({ where: { id: c.id }, data: { pinHash: await bcrypt.hash('482913', 4) } });
  const noStep = await s.call('POST', 'me/email', { email: 'me@example.com' });
  assert.equal(noStep.status, 403);
  assert.equal(noStep.body.code, 'step_up_required');
  await stepUp(s);
  const req = await s.call('POST', 'me/email', { email: `me-${c.id}@example.com` });
  assert.ok([200, 503].includes(req.status), 'in production a code is only issued when it can be delivered');
});
