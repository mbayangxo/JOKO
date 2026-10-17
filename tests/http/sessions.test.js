/**
 * Sessions (Phase 22: reload / second session) — real HTTP, NODE_ENV=production.
 * Refresh rotation is single-use under concurrency, a copied (rotated) token
 * kills the whole family, and users can sign out of one or all devices.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { createUserWithWallet, createVerifiedDevice, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
const REFRESH_SECRET = 'http-test-refresh-secret-0123456789';
let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session() {
  const user = await createUserWithWallet({ tier: 2 });
  const device = await createVerifiedDevice(user.id);
  const refresh = jwt.sign({ sub: user.id, type: 'refresh', jti: crypto.randomUUID() }, REFRESH_SECRET, { expiresIn: '30d' });
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: crypto.createHash('sha256').update(refresh).digest('hex'), expiresAt: new Date(Date.now() + 864e5) },
  });
  return { user, device, refresh, token: jwt.sign({ sub: user.id, type: 'access' }, ACCESS_SECRET, { expiresIn: '30m' }) };
}
const refresh = (t) => api.client('POST', 'auth/refresh', { ip: freshIp(), body: { refreshToken: t } });
const as = (s, token = s.token) => ({ token, device: s.device, ip: freshIp(), headers: { 'x-vercel-ip-country': 'SN' } });

test('two concurrent refreshes with one token: exactly one new session', async () => {
  const s = await session();
  const rs = await Promise.all([refresh(s.refresh), refresh(s.refresh), refresh(s.refresh)]);
  assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(','));
  assert.equal(await prisma.refreshToken.count({ where: { userId: s.user.id, revokedAt: null } }), 1);
});

test('a rotated token presented later (copied) revokes every refresh token of the user', async () => {
  const s = await session();
  const r1 = await refresh(s.refresh);
  assert.equal(r1.status, 200);
  // Within the grace window (a client retry), just 401 — the new chain survives.
  assert.equal((await refresh(s.refresh)).status, 401);
  assert.equal((await refresh(r1.body.refreshToken)).status, 200, 'legit chain still works');
  // Pretend the rotation happened 2 minutes ago, then the copy is replayed.
  await prisma.refreshToken.updateMany({ where: { userId: s.user.id, rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 120_000) } });
  assert.equal((await refresh(s.refresh)).status, 401);
  assert.equal(await prisma.refreshToken.count({ where: { userId: s.user.id, revokedAt: null } }), 0, 'family revoked');
  assert.ok(await prisma.credentialSecurityEvent.findFirst({ where: { userId: s.user.id, type: 'refresh_reuse_detected' } }));
});

test('logout revokes this device’s refresh token only; logout-all kills access tokens too', async () => {
  const s = await session();
  const other = await refresh((await session()).refresh); // unrelated user, unaffected
  assert.equal((await api.client('POST', 'auth/logout', { ...as(s), body: { refreshToken: s.refresh } })).status, 200);
  assert.equal((await refresh(s.refresh)).status, 401);
  assert.equal(other.status, 200);

  const s2 = await session();
  await sleep(1100);
  assert.equal((await api.client('GET', 'wallet', as(s2))).status, 200);
  assert.equal((await api.client('POST', 'auth/logout-all', { ...as(s2), body: {} })).status, 200);
  assert.equal((await api.client('GET', 'wallet', as(s2))).status, 401, 'old access token rejected');
  assert.equal((await refresh(s2.refresh)).status, 401);

  // Another user's refresh token can't be revoked through my logout.
  const victim = await session();
  const me = await session();
  await api.client('POST', 'auth/logout', { ...as(me), body: { refreshToken: victim.refresh } });
  assert.equal((await refresh(victim.refresh)).status, 200);
});
