/**
 * J1 — P0 financial & account safety, proven over REAL HTTP against the real
 * Vercel entry (api/index.js) running with NODE_ENV=production in a child
 * process. Providers are absent or a real local HTTP fake (fake Julaya); no
 * lib/ module is mocked. Fixtures (users, devices, stored OTPs) are written to
 * the test database directly; every assertion about money reads the DB.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import {
  createUserWithWallet,
  createVerifiedDevice,
  establishedSessionToken,
  prisma,
  resetReserveToWallets,
  fundAgentFloat,
} from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { startFakeJulaya } from '../helpers/fake-julaya.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
const WEBHOOK_SECRET = 'http-test-julaya-webhook-secret';
const PARTNER_KEY = 'http-test-partner-key-0123456789';

let noRail; // production, no providers at all
let live; // production, Julaya pointed at the local fake provider
let julaya;

before(async () => {
  julaya = await startFakeJulaya();
  const settlement = await createUserWithWallet({ koriBalance: 0 });
  noRail = await startApiServer({
    ALLOW_BETA_OTP: 'true', // must NOT disclose OTPs in production
    ALLOW_BETA_DEPOSITS: 'true', // must NOT enable test credits in production
    JOKO_API_KEY: PARTNER_KEY,
    PARTNER_SETTLEMENT_USER_ID: settlement.id,
  });
  live = await startApiServer({
    JULAYA_API_KEY: julaya.apiKey,
    JULAYA_API_URL_PRODUCTION: julaya.url,
    JULAYA_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
});

after(async () => {
  await Promise.all([noRail?.stop(), live?.stop(), julaya?.close()]);
  await prisma.$disconnect();
});

async function actor({ koriBalance = 0, tier = 2 } = {}) {
  const user = await createUserWithWallet({ koriBalance, tier });
  const device = await createVerifiedDevice(user.id);
  return { user, device, token: await establishedSessionToken(user.id, device, ACCESS_SECRET), ip: freshIp() };
}

const as = (a) => ({ token: a.token, device: a.device, ip: a.ip, headers: { 'x-vercel-ip-country': 'SN' } });
const bal = async (u) => (await prisma.wallet.findUnique({ where: { userId: u.id } })).koriBalance;

function signedWebhook(server, payload, { secret = WEBHOOK_SECRET } = {}) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return server.client('POST', 'webhooks/julaya', { raw, headers: { 'x-julaya-signature': sig } });
}

// ─── P0-1 deposits/national ───────────────────────────────────────────────────

test('P0-1: deposits/national never mints in production, even with source "julaya" and ALLOW_BETA_DEPOSITS', async () => {
  const a = await actor();
  for (const source of ['julaya', 'julaya-webhook', undefined]) {
    const r = await noRail.client('POST', 'deposits/national', { ...as(a), body: { amount: 5000, ...(source ? { source } : {}) } });
    assert.equal(r.status, 403, `source=${source}`);
    assert.equal(r.body.code, 'deposits_disabled');
  }
  assert.equal(await bal(a.user), 0);
  assert.equal(await prisma.ledgerEntry.count({ where: { userId: a.user.id } }), 0);
});

// ─── P0-2 cash/in without a configured rail ───────────────────────────────────

test('P0-2: cash/in with no Julaya key fails closed (503), writes nothing, credits nothing', async () => {
  const a = await actor();
  const r = await noRail.client('POST', 'cash/in', { ...as(a), body: { amount: 10000, operator: 'wave' } });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'rail_unavailable');
  assert.equal(await bal(a.user), 0);
  assert.equal(await prisma.railTransaction.count({ where: { userId: a.user.id } }), 0);
});

test('P0-2: cash/out with no Julaya key fails closed and does not touch the balance', async () => {
  await resetReserveToWallets();
  const a = await actor({ koriBalance: 5000 });
  const r = await noRail.client('POST', 'cash/out', { ...as(a), body: { amount: 10000, operator: 'wave' } });
  assert.equal(r.status, 503);
  assert.equal(await bal(a.user), 5000);
});

test('P0-2: unsigned Julaya webhook is rejected in production', async () => {
  const r = await noRail.client('POST', 'webhooks/julaya', { body: { reference: 'CIN-X', status: 'completed' } });
  assert.equal(r.status, 401);
});

test('P0-2: partner sandbox-complete is forbidden in production (no mock settlement)', async () => {
  const reference = `ord_${crypto.randomBytes(4).toString('hex')}`;
  const headers = { 'x-api-key': PARTNER_KEY };
  const created = await noRail.client('POST', 'v1/checkout/sessions', {
    headers,
    body: { reference, amount_xof: 50000, currency: 'XOF', customer: { phone: '+221771234567' }, method: 'wave' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const done = await noRail.client('POST', `v1/payments/${reference}/sandbox-complete`, { headers });
  assert.equal(done.status, 403);
  const row = await prisma.partnerPayment.findFirst({ where: { reference } });
  assert.notEqual(row.status, 'completed');
});

// ─── Live rail (fake provider): settlement invariants ────────────────────────

test('cash-in: provider says "completed" at initiation but status query says pending → nothing credited', async () => {
  const a = await actor();
  julaya.setNext({ initiate: 'completed', status: 'pending' });
  const r = await live.client('POST', 'cash/in', { ...as(a), body: { amount: 10000, operator: 'wave' } });
  assert.equal(r.status, 202);
  assert.equal(r.body.rail.status, 'pending');
  assert.equal(await bal(a.user), 0, 'an initiation response is not settlement');
});

test('cash-in: confirmed by provider status query → credited exactly once; signed webhook replay is a no-op', async () => {
  const a = await actor();
  julaya.setNext({ initiate: 'completed', status: 'completed' });
  const r = await live.client('POST', 'cash/in', { ...as(a), body: { amount: 10000, operator: 'wave' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await bal(a.user), 1000);
  for (let i = 0; i < 3; i++) {
    const w = await signedWebhook(live, { reference: r.body.rail.reference, status: 'completed', id: r.body.rail.externalId });
    assert.equal(w.status, 200);
  }
  assert.equal(await bal(a.user), 1000, 'replayed settlement never credits twice');
});

test('cash-in: provider confirms a DIFFERENT amount → review, nothing credited', async () => {
  const a = await actor();
  julaya.setNext({ initiate: 'pending', status: 'pending' });
  const r = await live.client('POST', 'cash/in', { ...as(a), body: { amount: 10000, operator: 'wave' } });
  assert.equal(r.status, 202);
  const w = await signedWebhook(live, { reference: r.body.rail.reference, status: 'completed', amount: 100000, id: r.body.rail.externalId });
  assert.equal(w.status, 200);
  assert.equal(w.body.rail.status, 'review');
  assert.equal(await bal(a.user), 0);
});

test('cash-in: provider failure / timeout / 5xx never credit', async () => {
  for (const initiate of ['failed', 'http400', 'timeout', 'http500']) {
    const a = await actor();
    julaya.setNext({ initiate, status: 'pending' });
    const r = await live.client('POST', 'cash/in', { ...as(a), body: { amount: 10000, operator: 'wave' } });
    assert.ok([202, 201].includes(r.status) || r.status === 400, `${initiate}: ${r.status}`);
    assert.notEqual(r.body.rail?.status, 'completed', initiate);
    assert.equal(await bal(a.user), 0, `${initiate} must not credit`);
  }
});

test('cash-in: a failed-provider webhook can never credit', async () => {
  const a = await actor();
  julaya.setNext({ initiate: 'pending' });
  const r = await live.client('POST', 'cash/in', { ...as(a), body: { amount: 10000, operator: 'wave' } });
  await signedWebhook(live, { reference: r.body.rail.reference, status: 'failed' });
  await signedWebhook(live, { reference: r.body.rail.reference, status: 'completed' }); // out-of-order after final
  assert.equal(await bal(a.user), 0);
});

test('cash-out: pending payout HOLDS funds → cannot be double-spent; completion does not debit again', async () => {
  await resetReserveToWallets();
  const a = await actor({ koriBalance: 2000 });
  const b = await actor();
  julaya.setNext({ initiate: 'pending' });
  const co = await live.client('POST', 'cash/out', { ...as(a), body: { amount: 20000, operator: 'wave' } });
  assert.equal(co.status, 202, JSON.stringify(co.body));
  assert.equal(await bal(a.user), 0, 'funds held at initiation');

  const handle = (await prisma.user.findUnique({ where: { id: b.user.id } })).handle;
  const spend = await live.client('POST', 'transfers/send', { ...as(a), body: { recipientHandle: handle, amount: 1990 } });
  assert.equal(spend.status, 400, 'held funds are not spendable');

  const w = await signedWebhook(live, { reference: co.body.rail.reference, status: 'completed' });
  assert.equal(w.status, 200);
  assert.equal(w.body.rail.status, 'completed');
  assert.equal(await bal(a.user), 0);
  assert.equal(await bal(b.user), 0);
});

test('cash-out: explicit provider failure refunds exactly once (replays / late success are no-ops)', async () => {
  await resetReserveToWallets();
  const a = await actor({ koriBalance: 3000 });
  julaya.setNext({ initiate: 'pending' });
  const co = await live.client('POST', 'cash/out', { ...as(a), body: { amount: 20000, operator: 'wave' } });
  assert.equal(await bal(a.user), 1000);
  for (let i = 0; i < 3; i++) await signedWebhook(live, { reference: co.body.rail.reference, status: 'failed' });
  await signedWebhook(live, { reference: co.body.rail.reference, status: 'completed' });
  assert.equal(await bal(a.user), 3000, 'refunded once, never twice, never re-debited');
  assert.equal(await prisma.ledgerEntry.count({ where: { reference: `${co.body.rail.reference}-REFUND` } }), 1);
});

test('cash-out: provider 400 at initiation → refunded immediately; timeout → stays held (no blind refund)', async () => {
  await resetReserveToWallets();
  const a = await actor({ koriBalance: 3000 });
  julaya.setNext({ initiate: 'http400' });
  const rej = await live.client('POST', 'cash/out', { ...as(a), body: { amount: 10000, operator: 'wave' } });
  assert.equal(rej.status, 400);
  assert.equal(await bal(a.user), 3000);

  julaya.setNext({ initiate: 'timeout' });
  const amb = await live.client('POST', 'cash/out', { ...as(a), body: { amount: 10000, operator: 'wave' } });
  assert.equal(amb.status, 202);
  assert.equal(await bal(a.user), 2000, 'ambiguous outcome keeps the hold');
});

test('cash-out: same Idempotency-Key submitted 5× concurrently → one rail, one debit', async () => {
  await resetReserveToWallets();
  const a = await actor({ koriBalance: 5000 });
  julaya.setNext({ initiate: 'pending' });
  const key = `dup-${crypto.randomBytes(4).toString('hex')}`;
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      live.client('POST', 'cash/out', { ...as(a), headers: { 'x-vercel-ip-country': 'SN', 'idempotency-key': key }, body: { amount: 10000, operator: 'wave' } }),
    ),
  );
  // One executes; concurrent duplicates are told it's in progress (409) — none executes twice.
  assert.ok(results.every((r) => [201, 202, 409].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => [201, 202].includes(r.status)).length >= 1, true);
  assert.equal(await prisma.railTransaction.count({ where: { userId: a.user.id } }), 1);
  assert.equal(await bal(a.user), 4000);
});

// ─── P2P: value conservation, self-transfer, earn mint, concurrency ──────────

test('self-transfer is refused and creates no value', async () => {
  const a = await actor({ koriBalance: 100 });
  const handle = (await prisma.user.findUnique({ where: { id: a.user.id } })).handle;
  const r = await live.client('POST', 'transfers/send', { ...as(a), body: { recipientHandle: handle, amount: 1 } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'self_transfer');
  assert.equal(await bal(a.user), 100);
});

test('1 ₭ round trips create no value (no unfunded "earn" mint)', async () => {
  const a = await actor({ koriBalance: 100 });
  const b = await actor({ koriBalance: 100 });
  const ha = (await prisma.user.findUnique({ where: { id: a.user.id } })).handle;
  const hb = (await prisma.user.findUnique({ where: { id: b.user.id } })).handle;
  for (let i = 1; i <= 3; i++) {
    assert.equal((await live.client('POST', 'transfers/send', { ...as(a), body: { recipientHandle: hb, amount: i } })).status, 201);
    assert.equal((await live.client('POST', 'transfers/send', { ...as(b), body: { recipientHandle: ha, amount: i } })).status, 201);
  }
  assert.equal((await bal(a.user)) + (await bal(b.user)), 200, 'system total conserved');
  assert.equal(await prisma.koriTransaction.count({ where: { recipientId: { in: [a.user.id, b.user.id] }, transactionType: 'earn' } }), 0);
});

test('double-spend: two concurrent sends that together exceed the balance → exactly one succeeds', async () => {
  const a = await actor({ koriBalance: 1000 });
  const b = await actor();
  const c = await actor();
  const hb = (await prisma.user.findUnique({ where: { id: b.user.id } })).handle;
  const hc = (await prisma.user.findUnique({ where: { id: c.user.id } })).handle;
  const [r1, r2] = await Promise.all([
    live.client('POST', 'transfers/send', { ...as(a), body: { recipientHandle: hb, amount: 700 } }),
    live.client('POST', 'transfers/send', { ...as(a), body: { recipientHandle: hc, amount: 700 } }),
  ]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [201, 400], JSON.stringify([r1.body, r2.body]));
  assert.equal(await bal(a.user), 300);
  assert.equal((await bal(b.user)) + (await bal(c.user)), 700);
});

test('malformed / zero / negative / fractional / huge amounts are rejected without moving money', async () => {
  const a = await actor({ koriBalance: 1000 });
  const b = await actor();
  const hb = (await prisma.user.findUnique({ where: { id: b.user.id } })).handle;
  for (const amount of [0, -5, 1.5, '100', null, 1e15, Number.MAX_SAFE_INTEGER + 2]) {
    const r = await live.client('POST', 'transfers/send', { ...as(a), body: { recipientHandle: hb, amount } });
    assert.ok(r.status >= 400 && r.status < 500, `amount=${amount} → ${r.status}`);
  }
  assert.equal(await bal(a.user), 1000);
  assert.equal(await bal(b.user), 0);
});

test('unauthenticated and forged-token money calls are rejected', async () => {
  const r1 = await live.client('POST', 'transfers/send', { body: { recipientHandle: 'x', amount: 1 } });
  assert.equal(r1.status, 401);
  const forged = jwt.sign({ sub: 'someone', type: 'access' }, 'wrong-secret-0123456789abcdef');
  const r2 = await live.client('GET', 'wallet', { token: forged });
  assert.equal(r2.status, 401);
});

// ─── P0-3 OTP disclosure, brute force, recovery takeover ─────────────────────

test('P0-3: production never returns an OTP — even with ALLOW_BETA_OTP=true — and fails closed without SMS', async () => {
  const phone = `+22177${crypto.randomInt(1000000, 9999999)}`;
  const r = await noRail.client('POST', 'auth/phone', { ip: freshIp(), body: { phone, intent: 'signup' } });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'otp_delivery_unavailable');
  assert.equal(r.body.otp, undefined);
  assert.equal(await prisma.otpCode.count({ where: { phone } }), 0, 'undeliverable code is not left valid');
  assert.ok(!noRail.logs().includes('Ton code est'), 'OTP never written to server logs');
});

test('OTP brute force: 5 wrong guesses burn the code — the right code no longer works', async () => {
  const u = await createUserWithWallet();
  await prisma.otpCode.create({ data: { phone: u.phone, code: '424242', expiresAt: new Date(Date.now() + 600_000) } });
  const ip = freshIp();
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await noRail.client('POST', 'auth/verify', { ip, body: { phone: u.phone, otp: String(100000 + i), intent: 'login' } })).status);
  }
  const right = await noRail.client('POST', 'auth/verify', { ip, body: { phone: u.phone, otp: '424242', intent: 'login' } });
  assert.deepEqual(statuses.slice(0, 4), [401, 401, 401, 401]);
  assert.equal(right.status, 429);
  assert.equal(right.body.accessToken, undefined);
});

test('OTP verify is rate limited per phone even across many IPs', async () => {
  const u = await createUserWithWallet();
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    await prisma.otpCode.create({ data: { phone: u.phone, code: '999999', expiresAt: new Date(Date.now() + 600_000) } });
    statuses.push((await noRail.client('POST', 'auth/verify', { ip: freshIp(), body: { phone: u.phone, otp: '000000', intent: 'login' } })).status);
  }
  assert.ok(statuses.includes(429), JSON.stringify(statuses));
});

test('OTP send endpoint is rate limited per IP', async () => {
  const ip = freshIp();
  const statuses = [];
  for (let i = 0; i < 22; i++) {
    statuses.push((await noRail.client('POST', 'auth/phone', { ip, body: { phone: `+22176${crypto.randomInt(1000000, 9999999)}`, intent: 'signup' } })).status);
  }
  assert.equal(statuses.at(-1), 429, JSON.stringify(statuses));
});

test('authenticated API is rate limited (global per-user budget)', async () => {
  const a = await actor();
  let limited = false;
  for (let i = 0; i < 110 && !limited; i++) {
    const r = await live.client('GET', 'wallet', as(a));
    if (r.status === 429 || r.status === 403) limited = true;
  }
  assert.ok(limited, 'flooding is cut off');
});

test('money endpoints have a tighter per-user budget', async () => {
  const a = await actor({ koriBalance: 0 });
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    statuses.push((await live.client('POST', 'transfers/send', { ...as(a), body: { recipientHandle: 'nobody_here', amount: 1 } })).status);
  }
  assert.ok(statuses.includes(429), JSON.stringify(statuses));
});

test('recovery: an unauthenticated caller cannot attach their email to a victim account', async () => {
  const victim = await createUserWithWallet();
  const r = await noRail.client('POST', 'auth/recover', { ip: freshIp(), body: { phone: victim.phone, email: 'attacker@evil.test' } });
  // 200 (generic) or 503 (no SMS channel in this test env) — never a code, never an attach.
  assert.ok([200, 503].includes(r.status), String(r.status));
  assert.equal(r.body.otp, undefined);
  const after = await prisma.user.findUnique({ where: { id: victim.id } });
  assert.equal(after.email, null, 'victim email untouched');
  const login = await noRail.client('POST', 'auth/email', { ip: freshIp(), body: { email: 'attacker@evil.test', intent: 'login' } });
  assert.notEqual(login.body?.otp, true);
  assert.equal(login.body?.accountExists, undefined, 'no account enumeration in production');
});

test('recovery opens a 24h cool-off: outbound money is held for review', async () => {
  const a = await actor({ koriBalance: 1000 });
  const b = await actor();
  await prisma.user.update({ where: { id: a.user.id }, data: { accountRecoveredAt: new Date() } });
  const hb = (await prisma.user.findUnique({ where: { id: b.user.id } })).handle;
  const r = await live.client('POST', 'transfers/send', { ...as(a), body: { recipientHandle: hb, amount: 100 } });
  assert.equal(r.status, 202);
  assert.equal(r.body.held, true);
  assert.equal(await bal(a.user), 1000);
});

test('email typed at profile step is NOT marked verified and cannot be used to log into the account', async () => {
  const a = await actor();
  const email = `typed-${crypto.randomBytes(4).toString('hex')}@victim.test`;
  const r = await live.client('POST', 'auth/complete-profile', {
    ...as(a),
    body: { name: 'QA', handle: `qa_${crypto.randomBytes(4).toString('hex')}`, arrondissement: { key: 'plateau', name: 'Plateau' }, email },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await prisma.user.findUnique({ where: { id: a.user.id } });
  assert.equal(row.email, email);
  assert.equal(row.emailVerifiedAt, null);
  const { findUserByEmail } = await import('../../lib/auth-otp.js');
  assert.equal(await findUserByEmail(prisma, email), null);
});

// ─── P1 fixes ─────────────────────────────────────────────────────────────────

test('GET me/summary works (was a 500: ticket.userId vs buyerId)', async () => {
  const a = await actor();
  const r = await live.client('GET', 'me/summary', as(a));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('agents/nearby exposes no phone, user id, float or exact location', async () => {
  const owner = await createUserWithWallet({ tier: 2 });
  const ag = await prisma.agentProfile.create({
    data: {
      userId: owner.id,
      agentCode: `AGT-T${crypto.randomInt(100000, 999999)}`,
      displayName: 'Boutique QA',
      lat: 14.692812,
      lng: -17.446734,
      floatBalance: 0,
      floatLimit: 500000,
      status: 'active',
    },
  });
  await fundAgentFloat(ag.id, 250000);
  const a = await actor();
  const r = await live.client('GET', 'agents/nearby?lat=14.69&lng=-17.44', as(a));
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes(owner.phone), 'no agent phone');
  assert.ok(!text.includes(owner.id), 'no internal user id');
  assert.ok(!/floatBalance|floatLimit|commissionBps/.test(text), 'no cash-on-hand');
  assert.ok(!text.includes('14.692812'), 'location is rounded');
});

test('production serves no hardcoded "live" emergency alerts or seeded culture items', async () => {
  const a = await actor();
  const t = await live.client('GET', 'trending/feed', as(a));
  assert.equal(t.status, 200);
  assert.ok(!JSON.stringify(t.body).includes('Canicule'), 'no fabricated heat-wave alert');
  const c = await live.client('GET', 'culture/feed', as(a));
  assert.ok(!JSON.stringify(c.body).includes('Lions — match à venir'));
});

test('ledger history cannot be deleted or edited (DB-enforced)', async () => {
  const a = await actor({ koriBalance: 10 });
  const entry = await prisma.ledgerEntry.create({
    data: { walletId: a.user.wallet.id, userId: a.user.id, type: 'test', amount: 1, reference: `T-${crypto.randomBytes(6).toString('hex')}` },
  });
  await assert.rejects(prisma.ledgerEntry.delete({ where: { id: entry.id } }));
  await assert.rejects(prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amount: 999 } }));
  await assert.rejects(prisma.user.delete({ where: { id: a.user.id } }), 'a user with financial history cannot be deleted');
  await assert.rejects(prisma.wallet.update({ where: { id: a.user.wallet.id }, data: { koriBalance: -1 } }), 'negative balance refused');
});

// ─── Duplicate submission / retries (Idempotency-Key) ─────────────────────────

test('transfers/send: same Idempotency-Key — sequential retry replays, concurrent duplicates never double-send', async () => {
  const a = await actor({ koriBalance: 1000 });
  const b = await actor();
  const hb = (await prisma.user.findUnique({ where: { id: b.user.id } })).handle;
  const key = `tap-${crypto.randomBytes(6).toString('hex')}`;
  const opts = { ...as(a), headers: { 'x-vercel-ip-country': 'SN', 'idempotency-key': key }, body: { recipientHandle: hb, amount: 100 } };

  const burst = await Promise.all(Array.from({ length: 5 }, () => live.client('POST', 'transfers/send', opts)));
  const ok = burst.filter((r) => r.status === 201);
  assert.ok(ok.length >= 1, JSON.stringify(burst.map((r) => r.status)));
  assert.ok(burst.every((r) => [201, 409].includes(r.status)), JSON.stringify(burst.map((r) => r.status)));

  const retry = await live.client('POST', 'transfers/send', opts);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.reference, ok[0].body.reference, 'retry replays the original result');

  assert.equal(await bal(a.user), 900, 'exactly one debit');
  assert.equal(await bal(b.user), 100);

  const reuse = await live.client('POST', 'transfers/send', { ...opts, body: { recipientHandle: hb, amount: 999 } });
  assert.equal(reuse.status, 422, 'a key cannot be reused for a different payment');
});

test('transfers/send: different Idempotency-Keys are different payments (both execute, balance-checked)', async () => {
  const a = await actor({ koriBalance: 150 });
  const b = await actor();
  const hb = (await prisma.user.findUnique({ where: { id: b.user.id } })).handle;
  const send = (k) => live.client('POST', 'transfers/send', { ...as(a), headers: { 'x-vercel-ip-country': 'SN', 'idempotency-key': k }, body: { recipientHandle: hb, amount: 100 } });
  const r1 = await send(`k1-${crypto.randomBytes(5).toString('hex')}`);
  const r2 = await send(`k2-${crypto.randomBytes(5).toString('hex')}`);
  assert.deepEqual([r1.status, r2.status], [201, 400]);
  assert.equal(await bal(a.user), 50);
});

// ─── Partner (Kebu) payouts in production ─────────────────────────────────────

test('partner payout: provider rejection refunds the settlement wallet once; double execute never pays twice', async () => {
  await resetReserveToWallets();
  const settlement = await createUserWithWallet({ koriBalance: 10_000 });
  await resetReserveToWallets();
  const server = await startApiServer({
    JULAYA_API_KEY: julaya.apiKey,
    JULAYA_API_URL_PRODUCTION: julaya.url,
    JULAYA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    JOKO_API_KEY: PARTNER_KEY,
    PARTNER_SETTLEMENT_USER_ID: settlement.id,
  });
  try {
    const headers = { 'x-api-key': PARTNER_KEY };
    const body = (reference) => ({ reference, amount_xof: 20_000, phone: '+221771112233', method: 'wave', execute: true });

    julaya.setNext({ initiate: 'http400' });
    const rejected = await server.client('POST', 'v1/payouts', { headers, body: body(`po_rej_${crypto.randomBytes(4).toString('hex')}`) });
    assert.equal(rejected.body.status, 'failed', JSON.stringify(rejected.body));
    assert.equal(await bal(settlement), 10_000, 'held ₭ returned on explicit failure');

    julaya.setNext({ initiate: 'pending' });
    const ref = `po_ok_${crypto.randomBytes(4).toString('hex')}`;
    const runs = await Promise.all([1, 2, 3].map(() => server.client('POST', 'v1/payouts', { headers, body: body(ref) })));
    assert.ok(runs.every((r) => r.status < 500), JSON.stringify(runs.map((r) => r.body)));
    assert.equal(await bal(settlement), 8_000, 'debited exactly once for one payout');
    const sandbox = await server.client('POST', `v1/payouts/${ref}/sandbox-complete`, { headers });
    assert.equal(sandbox.status, 403, 'no sandbox completion in production');
  } finally {
    await server.stop();
  }
});

// ─── Tontine wallet drain (found in the resumed J0 audit, Phase 10) ───────────

test('tontine: a creator cannot pull money from members (collections paused in production)', async () => {
  const attacker = await actor({ koriBalance: 0 });
  const v1 = await actor({ koriBalance: 50_000 });
  const v2 = await actor({ koriBalance: 30_000 });
  const handles = await prisma.user.findMany({ where: { id: { in: [v1.user.id, v2.user.id] } }, select: { handle: true } });
  const created = await live.client('POST', 'tontine/groups', {
    ...as(attacker),
    body: { name: 'Famille', amountPerMember: 300_000, frequency: 'mensuel', memberHandles: handles.map((h) => h.handle) },
  });
  assert.equal(created.status, 201);
  const rel = await live.client('POST', `tontine/groups/${created.body.id}/release`, as(attacker));
  assert.equal(rel.status, 503);
  assert.equal(rel.body.code, 'tontine_collections_paused');
  assert.equal(await bal(attacker.user), 0);
  assert.equal(await bal(v1.user), 50_000);
  assert.equal(await bal(v2.user), 30_000);
});

test('kori/convert refuses honestly instead of burning ₭ with nowhere for the value to go', async () => {
  const a = await actor({ koriBalance: 1000 });
  const r = await live.client('POST', 'kori/convert', { ...as(a), body: { amountKori: 500 } });
  assert.equal(r.status, 410);
  assert.equal(r.body.code, 'conversion_unavailable');
  assert.equal(await bal(a.user), 1000);
});
