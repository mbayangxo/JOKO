/**
 * J3 destruction suite — KYC (provider fail-closed, forged / replayed /
 * misdirected webhooks), tiers, privacy (PII enumeration), and regressions
 * found by the J3 mutation sweep. Real HTTP, NODE_ENV=production.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { establishedSessionToken, fundUser, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, signedIn, stepUp } from './helpers.js';

const KYC_SECRET = 'j3-kyc-webhook-secret-0123456789';
let api; // production, no KYC provider key
let kyc; // production, Sumsub webhook secret configured
before(async () => {
  api = await startApiServer();
  kyc = await startApiServer({ KYC_PROVIDER: 'sumsub', KYC_API_KEY: 'j3-test-key', KYC_WEBHOOK_SECRET: KYC_SECRET, CNI_HASH_SECRET: 'j3-cni-hash-secret-0123456789' });
});
after(async () => { await Promise.all([api?.stop(), kyc?.stop()]); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const sumsub = (server, body, { secret = KYC_SECRET } = {}) => {
  const raw = JSON.stringify(body);
  const digest = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return server.client('POST', 'webhooks/kyc/sumsub', { raw, headers: { 'x-payload-digest': digest, 'x-payload-digest-alg': 'HMAC_SHA256_HEX' } });
};

async function pendingJob(user) {
  const externalJobId = `appl-${crypto.randomBytes(5).toString('hex')}`;
  await prisma.user.update({ where: { id: user.id }, data: { verificationStatus: 'cni_pending' } });
  return prisma.cniVerificationJob.create({ data: { userId: user.id, provider: 'sumsub', externalJobId, status: 'pending', purgeImagesAt: new Date(Date.now() + 864e5) } });
}

test('KYC without a provider key fails closed in production; submitted is never verified', async () => {
  const c = await customer({ tier: 1 });
  const s = await signedIn(api, c);
  const img = `data:image/jpeg;base64,${Buffer.alloc(2048, 7).toString('base64')}`;
  const r = await s.call('POST', 'kyc/cni/submit', { frontImage: img, backImage: img });
  assert.equal(r.status, 503);
  const u = await prisma.user.findUnique({ where: { id: c.id } });
  assert.equal(u.cniVerifiedAt, null);
  assert.ok(u.verificationTier < 2 || !u.cniVerifiedAt, 'no tier without verification');
});

test('forged KYC webhook (bad / missing signature) is refused and changes nothing', async () => {
  const c = await customer({ tier: 1 });
  const job = await pendingJob(c);
  const body = { applicantId: job.externalJobId, reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' } };
  assert.equal((await sumsub(kyc, body, { secret: 'attacker-guess' })).status, 401);
  assert.equal((await kyc.client('POST', 'webhooks/kyc/sumsub', { raw: JSON.stringify(body) })).status, 401);
  assert.equal((await kyc.client('POST', 'webhooks/kyc/sumsub', { raw: '{not json', headers: { 'x-payload-digest': 'x' } })).status, 401);
  assert.equal((await prisma.user.findUnique({ where: { id: c.id } })).cniVerifiedAt, null);
});

test('KYC webhook replay is processed once; a callback naming another user is refused', async () => {
  const c = await customer({ tier: 1 });
  const job = await pendingJob(c);
  const body = { applicantId: job.externalJobId, externalUserId: c.id, reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' }, info: { idDocs: [{ number: `SN${crypto.randomBytes(4).toString('hex')}` }] } };
  const first = await sumsub(kyc, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  const replay = await sumsub(kyc, body);
  assert.equal(replay.body.duplicate, true, 'one-time receipt');
  const u = await prisma.user.findUnique({ where: { id: c.id } });
  assert.ok(u.cniVerifiedAt, 'verified by the provider outcome');
  assert.ok(await prisma.identityAuditEvent.findFirst({ where: { action: 'kyc_verified', subjectId: c.id } }));

  const victim = await customer({ tier: 1 });
  const vJob = await pendingJob(victim);
  const misdirected = await sumsub(kyc, { applicantId: vJob.externalJobId, externalUserId: c.id, reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' } });
  assert.equal(misdirected.body.ok, false);
  assert.equal(misdirected.body.reason, 'user_mismatch');
  assert.equal((await prisma.user.findUnique({ where: { id: victim.id } })).cniVerifiedAt, null);
});

test('Tier 0 (email-only account) can receive but cannot send', async () => {
  const c = await customer({ tier: 1 });
  await prisma.user.update({ where: { id: c.id }, data: { phone: `e:${c.id}@example.com` } });
  await fundUser(c.id, 1000);
  // Email-only accounts sign in by email OTP; an established session on their own device.
  const token = await establishedSessionToken(c.id, c.device, 'http-test-access-secret-0123456789');
  const r = await api.client('POST', 'transfers/send', { token, device: c.device, ip: freshIp(), headers: { 'x-vercel-ip-country': 'SN' }, body: { recipientHandle: (await customer()).handle, amount: 10 } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'tier_send_blocked');
});

test('PII enumeration: lookup and profiles return a minimal DTO (no phone, email, balance, DOB, ids of credentials)', async () => {
  const target = await customer({ koriBalance: 0 });
  await prisma.user.update({ where: { id: target.id }, data: { email: `t-${target.id}@leak.invalid`, emailVerifiedAt: new Date(), dateOfBirth: new Date('1901-02-03') } });
  await fundUser(target.id, 777);
  const s = await signedIn(api, await customer());
  for (const path of [`users/lookup?q=${target.handle}`, `profiles/${target.id}`]) {
    const r = await s.call('GET', path);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('@leak.invalid'), `${path}: email`);
    assert.ok(!text.includes('1901-02-03'), `${path}: dob`);
    assert.ok(!text.includes(target.phone), `${path}: full phone`);
    assert.ok(!/"(koriBalance|balance|pinHash|passwordHash|cniHash)"/.test(text), `${path}: balance or credential`);
  }
});

test('regressions found by the J3 mutation sweep: free-event tickets and Jekkal contributions no longer 500', async () => {
  const buyer = await customer({ koriBalance: 0 });
  await fundUser(buyer.id, 5000);
  const s = await signedIn(api, buyer);
  await stepUp(s);
  const promoter = await customer();
  const ev = await prisma.event.create({ data: { promoterId: promoter.id, title: 'Free concert', startsAt: new Date(Date.now() + 864e5), ticketPrice: 0 } });
  const t = await s.call('POST', `events/${ev.id}/tickets`, { quantity: 1 });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal((await prisma.wallet.findUnique({ where: { userId: buyer.id } })).koriBalance, 5000, 'a free ticket moves no money');
  const camp = await prisma.solidarityCampaign.create({ data: { creatorId: promoter.id, beneficiaryUserId: promoter.id, title: 'Help', goalAmount: 1000 } });
  const c = await s.call('POST', `jekkal/campaigns/${camp.id}/contribute`, { amount: 100 });
  assert.ok(c.status < 500, JSON.stringify(c.body));
});
