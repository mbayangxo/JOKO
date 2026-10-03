/**
 * KYC in production without a provider key — real HTTP, NODE_ENV=production.
 * The sandbox auto-approval (any two "images" → Tier 2, any address → Tier 3)
 * must never run in production: it bypasses KYC and lifts money limits.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { createUserWithWallet, createVerifiedDevice, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
let api;
before(async () => { api = await startApiServer({ DATA_ENCRYPTION_KEY: 'a'.repeat(64) }); }); // as in production
after(async () => { await api?.stop(); await prisma.$disconnect(); });

async function actor(tier) {
  const user = await createUserWithWallet({ tier });
  const device = await createVerifiedDevice(user.id);
  return { user, device, token: jwt.sign({ sub: user.id, type: 'access' }, ACCESS_SECRET), ip: freshIp() };
}
const call = (p, a, body) => api.client('POST', p, { token: a.token, device: a.device, ip: a.ip, headers: { 'x-vercel-ip-country': 'SN' }, body });
const fakeImage = 'data:image/jpeg;base64,' + 'A'.repeat(200);

test('CNI submission never auto-approves in production when no KYC provider is configured', async () => {
  const a = await actor(1);
  const r = await call('kyc/cni/submit', a, { frontImage: fakeImage, backImage: fakeImage });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, 'kyc_unavailable');
  const row = await prisma.user.findUnique({ where: { id: a.user.id } });
  assert.equal(row.verificationTier, 1, 'tier unchanged');
  assert.equal(row.cniVerifiedAt, null);
  assert.equal(await prisma.cniVerificationJob.count({ where: { userId: a.user.id } }), 0);
});

test('address submission never auto-approves Tier 3 in production', async () => {
  const a = await actor(2);
  const r = await call('kyc/address/submit', a, { addressLine: 'Rue 10 x 11', city: 'Dakar' });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  const row = await prisma.user.findUnique({ where: { id: a.user.id } });
  assert.equal(row.verificationTier, 2);
  assert.equal(row.addressVerifiedAt, null);
});
