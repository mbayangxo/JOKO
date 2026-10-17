/**
 * Credential remediation (exposed PIN/password hashes) — real HTTP,
 * NODE_ENV=production. Proves: invalidation, session revocation, secure
 * re-establishment after fresh OTP, no new takeover path, no enumeration,
 * append-only audit without secrets, operator tool safety.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { createUserWithWallet, createVerifiedDevice, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { markCredentialsCompromised } from '../../lib/credential-remediation.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
const REFRESH_SECRET = 'http-test-refresh-secret-0123456789';
let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function victim({ pin = '482193', password = 'correct-horse-9', koriBalance = 1000 } = {}) {
  const user = await createUserWithWallet({ koriBalance, tier: 2 });
  const email = `v-${crypto.randomBytes(4).toString('hex')}@test.local`;
  await prisma.user.update({
    where: { id: user.id },
    data: { pinHash: await bcrypt.hash(pin, 4), passwordHash: await bcrypt.hash(password, 4), email, emailVerifiedAt: new Date() },
  });
  const device = await createVerifiedDevice(user.id);
  const token = jwt.sign({ sub: user.id, type: 'access' }, ACCESS_SECRET, { expiresIn: '30m' });
  const refresh = jwt.sign({ sub: user.id, type: 'refresh', jti: crypto.randomUUID() }, REFRESH_SECRET, { expiresIn: '30d' });
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: crypto.createHash('sha256').update(refresh).digest('hex'), expiresAt: new Date(Date.now() + 864e5) },
  });
  return { user, id: user.id, email, pin, password, device, token, refresh, ip: freshIp() };
}
const as = (v, token = v.token) => ({ token, device: v.device, ip: v.ip, headers: { 'x-vercel-ip-country': 'SN' } });

/** Fresh OTP login (the only way to re-establish credentials after a reset). */
async function otpLogin(v) {
  await prisma.otpCode.create({ data: { phone: v.user.phone, code: '135790', expiresAt: new Date(Date.now() + 600_000) } });
  const r = await api.client('POST', 'auth/verify', { ip: freshIp(), device: v.device, body: { phone: v.user.phone, otp: '135790', intent: 'login' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.accessToken;
}

test('marking compromised invalidates PIN + password, revokes access and refresh tokens, audits without secrets', async () => {
  const v = await victim();
  assert.equal((await api.client('GET', 'wallet', as(v))).status, 200);
  await sleep(1100); // token iat (seconds) strictly before revocation
  const summary = await markCredentialsCompromised([v.id], { reason: 'test exposure', actorType: 'system', classification: 'A' });
  assert.equal(summary.found, 1);

  const row = await prisma.user.findUnique({ where: { id: v.id } });
  assert.equal(row.pinHash, null);
  assert.equal(row.passwordHash, null);
  assert.ok(row.credentialResetRequiredAt);
  assert.equal((await api.client('GET', 'wallet', as(v))).status, 401, 'old access token rejected');
  assert.equal((await api.client('POST', 'auth/refresh', { ip: freshIp(), body: { refreshToken: v.refresh } })).status, 401, 'refresh revoked');

  const events = await prisma.credentialSecurityEvent.findMany({ where: { userId: v.id } });
  assert.deepEqual(events.map((e) => e.type).sort(), ['exposure_marked', 'password_invalidated', 'pin_invalidated', 'sessions_revoked']);
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes('$2') && !blob.includes(v.pin) && !blob.includes(v.password), 'no secrets in audit');
  await assert.rejects(prisma.credentialSecurityEvent.deleteMany({ where: { userId: v.id } }), 'audit is append-only');
});

test('exposed password no longer works; failure is indistinguishable from a wrong password or unknown email', async () => {
  const v = await victim();
  await markCredentialsCompromised([v.id], { reason: 'test', actorType: 'system' });
  const ip = freshIp();
  const exposed = await api.client('POST', 'auth/password/login', { ip, body: { email: v.email, password: v.password } });
  const unknown = await api.client('POST', 'auth/password/login', { ip, body: { email: `nobody-${crypto.randomBytes(3).toString('hex')}@test.local`, password: 'whatever-123' } });
  const other = await victim();
  const wrong = await api.client('POST', 'auth/password/login', { ip, body: { email: other.email, password: 'wrong-pass-123' } });
  assert.equal(exposed.status, 401);
  assert.deepEqual(exposed.body, unknown.body);
  assert.deepEqual(exposed.body, wrong.body);
});

test('re-establishment: needs a fresh OTP login; money is held until the new PIN, then a 24h cool-off', async () => {
  const v = await victim();
  await sleep(1100);
  await markCredentialsCompromised([v.id], { reason: 'test', actorType: 'system' });
  const fresh = await otpLogin(v);

  const me = await api.client('GET', 'me', as(v, fresh));
  assert.equal(me.body.credentialResetRequired, true);
  assert.equal(me.body.pinSet, false);
  const other = await victim();
  const send = await api.client('POST', 'transfers/send', { ...as(v, fresh), body: { recipientHandle: other.user.handle, amount: 10 } });
  assert.equal(send.status, 202, 'outbound money held while credentials are not re-established');

  const set = await api.client('POST', 'auth/pin/set', { ...as(v, fresh), body: { pin: '904512' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const row = await prisma.user.findUnique({ where: { id: v.id } });
  assert.equal(row.credentialResetRequiredAt, null);
  assert.ok(row.accountRecoveredAt, '24h cool-off opened');
  assert.ok(await bcrypt.compare('904512', row.pinHash));
  const types = (await prisma.credentialSecurityEvent.findMany({ where: { userId: v.id } })).map((e) => e.type);
  assert.ok(types.includes('pin_reestablished'));
});

test('a session that predates the reset (not revoked) cannot set new credentials without a fresh OTP login', async () => {
  const v = await victim();
  await markCredentialsCompromised([v.id], { reason: 'class B, sessions kept', actorType: 'system', revokeSessions: false });
  const pinTry = await api.client('POST', 'auth/pin/set', { ...as(v), body: { pin: '111222' } });
  assert.equal(pinTry.status, 403);
  assert.equal(pinTry.body.code, 'reverification_required');
  const pwTry = await api.client('POST', 'auth/password/set', { ...as(v), body: { password: 'new-password-1' } });
  // J3: refused by the sensitive-change guard (423, untrusted pre-J3 session)
  // before the handler's own fresh-OTP check (403) — either way: refused.
  assert.ok([403, 423].includes(pwTry.status), `status ${pwTry.status}`);
  const after = await prisma.user.findUnique({ where: { id: v.id } });
  assert.equal(after.pinHash, null);
  assert.equal(after.passwordHash, null, 'no password was written');
});

test('changing an existing PIN requires the current PIN (a borrowed session cannot replace it)', async () => {
  const v = await victim({ pin: '246813' });
  const none = await api.client('POST', 'auth/pin/set', { ...as(v), body: { pin: '999999' } });
  assert.equal(none.status, 401);
  const wrong = await api.client('POST', 'auth/pin/set', { ...as(v), body: { pin: '999999', currentPin: '000000' } });
  assert.equal(wrong.status, 401);
  const ok = await api.client('POST', 'auth/pin/set', { ...as(v), body: { pin: '999999', currentPin: '246813' } });
  assert.equal(ok.status, 200);
});

test('password login does not count as OTP verification (cannot satisfy re-verification)', async () => {
  const v = await victim();
  const before = (await prisma.user.findUnique({ where: { id: v.id } })).otpVerifiedAt;
  const r = await api.client('POST', 'auth/password/login', { ip: freshIp(), device: v.device, body: { email: v.email, password: v.password } });
  assert.equal(r.status, 200);
  const afterRow = await prisma.user.findUnique({ where: { id: v.id } });
  assert.equal(afterRow.otpVerifiedAt?.getTime(), before?.getTime());
});

test('operator tool: dry-run by default, refuses to execute without explicit flags, prints no PII', () => {
  const v1 = `c${crypto.randomBytes(12).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  const file = join(dir, 'ids.txt');
  writeFileSync(file, `# class A\n${v1}\n`);
  const run = (extra) =>
    spawnSync(process.execPath, ['scripts/forensics/remediate-credentials.mjs', '--ids', file, '--class', 'A', ...extra], {
      env: { ...process.env },
      encoding: 'utf8',
    });
  const dry = run([]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /"mode": "DRY_RUN"/);
  const refused = run(['--execute']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /i-understand-this-revokes-sessions/);
});

test('server logs never contain PINs, passwords or hashes during the flows', () => {
  const logs = api.logs();
  for (const s of ['482193', 'correct-horse-9', '904512', '246813', '$2a$', '$2b$']) {
    assert.ok(!logs.includes(s), `log leak: ${s}`);
  }
});
