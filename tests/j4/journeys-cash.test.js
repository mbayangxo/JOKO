/**
 * J4 vertical slices — cash-in and cash-out, end to end over real HTTP
 * (NODE_ENV=production, real OTP logins, fake Julaya over HTTP):
 * client contract (home / preview / submit / intent / activity / receipt)
 * → J3 policy → J2 kernel → provider → ledger → history → reload.
 * J2 invariants after every scenario.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { startFakeJulaya } from '../helpers/fake-julaya.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, newDevice, signedIn, stepUp } from '../j3/helpers.js';

const WEBHOOK_SECRET = 'http-test-julaya-webhook-secret';
let live;
let noRail;
let julaya;
before(async () => {
  julaya = await startFakeJulaya();
  live = await startApiServer({ JULAYA_API_KEY: julaya.apiKey, JULAYA_API_URL_PRODUCTION: julaya.url, JULAYA_WEBHOOK_SECRET: WEBHOOK_SECRET });
  noRail = await startApiServer();
});
after(async () => { await Promise.all([live?.stop(), noRail?.stop(), julaya?.close()]); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const key = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const webhook = (payload) => {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return live.client('POST', 'webhooks/julaya', { raw, headers: { 'x-julaya-signature': sig } });
};
const INTERNAL = /velocity|rapid_cash|untrusted_session|recent_recovery|recent_contact|signal|risk|tier_insufficient|reasonCodes/i;

test('cash-in: amount → provider → PENDING (not spendable) → provider confirmation → available → receipt/history; duplicate callbacks; reload', async () => {
  const c = await customer();
  const s = await signedIn(live, c);
  const home0 = await s.call('GET', 'money/home');
  assert.equal(home0.status, 200);
  assert.deepEqual(home0.body.balance, { availableKori: 0, heldKori: 0, pendingInKori: 0 });
  assert.equal(home0.body.actions.cashIn.allowed, true);
  const pv = await s.call('POST', 'money/preview', { flow: 'cash_in', amountKori: 1000 });
  assert.equal(pv.body.feeKori, 0);
  assert.equal(pv.body.feeBasis, 'no_fee');

  julaya.setNext({ initiate: 'pending', status: 'pending' });
  const k = key();
  const r = await s.call('POST', 'cash/in', { amount: 10_000, operator: 'wave' }, { headers: { 'idempotency-key': k } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const ref = r.body.rail.reference;

  const pending = await s.call('GET', 'money/home');
  assert.equal(pending.body.balance.availableKori, 0, 'pending money is never spendable');
  assert.equal(pending.body.balance.pendingInKori, 1000);
  assert.ok(pending.body.explain.pendingIn);
  const rc = await s.call('GET', `money/activity/${ref}`);
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
  assert.equal(rc.body.status, 'pending');
  assert.equal(rc.body.statusLabel, 'En cours');
  const spend = await s.call('POST', 'transfers/send', { recipientHandle: (await customer()).handle, amount: 100 });
  assert.equal(spend.status, 400, 'cannot spend pending cash-in');
  assert.equal((await s.call('GET', `money/intents/${k}`)).body.state, 'accepted_pending');

  // Duplicate / out-of-order callbacks: credited once.
  for (let i = 0; i < 3; i++) assert.equal((await webhook({ reference: ref, status: 'completed', id: r.body.rail.externalId })).status, 200);
  await webhook({ reference: ref, status: 'pending' });
  const done = await s.call('GET', 'money/home');
  assert.equal(done.body.balance.availableKori, 1000);
  assert.equal(done.body.balance.pendingInKori, 0);
  const receipt = await s.call('GET', `money/activity/${ref}`);
  assert.equal(receipt.body.status, 'completed');
  assert.equal(receipt.body.amountKori, 1000);
  assert.equal(receipt.body.channel, 'Mobile money');
  assert.ok(!JSON.stringify(receipt.body).match(/customer:|accountCode|providerMode|apiKey/), 'no internal identifiers in receipts');

  // Retry with the same key replays — never a second cash-in.
  await s.call('POST', 'cash/in', { amount: 10_000, operator: 'wave' }, { headers: { 'idempotency-key': k } });
  assert.equal(await prisma.externalOperation.count({ where: { userId: c.id, direction: 'in' } }), 1);

  // Reload / reinstall: a fresh login on another phone sees the same history.
  const other = await signedIn(live, c, { device: newDevice() });
  const hist = await other.call('GET', 'money/activity');
  assert.ok(hist.body.items.some((i) => i.reference === ref && i.status === 'completed'));
});

test('cash-in: callback arrives before the client gets its response (provider timeout) → credited once; the app resolves via intent, not a second payment', async () => {
  const c = await customer();
  const s = await signedIn(live, c);
  julaya.setNext({ initiate: 'timeout', status: 'pending' });
  const k = key();
  const r = await s.call('POST', 'cash/in', { amount: 5_000, operator: 'wave' }, { headers: { 'idempotency-key': k } });
  assert.ok([202, 201].includes(r.status), JSON.stringify(r.body));
  const op = await prisma.externalOperation.findFirst({ where: { userId: c.id, direction: 'in' }, orderBy: { createdAt: 'desc' } });
  assert.equal((await s.call('GET', 'money/home')).body.balance.availableKori, 0, 'a timeout is not confirmation');
  await webhook({ reference: op.reference, status: 'completed' });
  const intent = await s.call('GET', `money/intents/${k}`);
  assert.ok(['accepted_pending', 'completed'].includes(intent.body.state));
  assert.equal(intent.body.safeToRetry, false, 'the app must not offer a second payment');
  assert.equal((await s.call('GET', 'money/home')).body.balance.availableKori, 500);
});

test('cash-in: rejected / failed payments never credit and read as "Échoué"; provider unavailable is explained, nothing written', async () => {
  const c = await customer();
  const s = await signedIn(live, c);
  julaya.setNext({ initiate: 'http400', status: 'pending' });
  const r = await s.call('POST', 'cash/in', { amount: 10_000, operator: 'wave' });
  assert.ok(r.status < 500);
  const op = await prisma.externalOperation.findFirst({ where: { userId: c.id }, orderBy: { createdAt: 'desc' } });
  const rc = await s.call('GET', `money/activity/${op.reference}`);
  assert.equal(rc.body.status, 'failed');
  assert.equal((await s.call('GET', 'money/home')).body.balance.availableKori, 0);

  const s2 = await signedIn(noRail, await customer());
  const home = await s2.call('GET', 'money/home');
  assert.equal(home.body.actions.cashIn.allowed, false);
  assert.equal(home.body.actions.cashIn.category, 'provider_unavailable');
  const down = await s2.call('POST', 'cash/in', { amount: 10_000, operator: 'wave' });
  assert.equal(down.status, 503);
  assert.equal(await prisma.externalOperation.count({ where: { userId: s2.id } }), 0, 'nothing written when the rail is down');
});

test('cash-out: eligibility → PIN → held funds (not spendable) → provider failure releases once → retry → success; receipts explain each state', async () => {
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, 3000);
  const s = await signedIn(live, c);
  const home = await s.call('GET', 'money/home');
  assert.equal(home.body.actions.cashOut.allowed, true);
  assert.equal(home.body.actions.cashOut.requiresPin, true);
  const pv = await s.call('POST', 'money/preview', { flow: 'cash_out', amountKori: 2000 });
  assert.equal(pv.body.payoutXof, 20_000);
  assert.equal(pv.body.requiresPin, true);
  assert.equal(pv.body.allowed, true);

  const noPin = await s.call('POST', 'cash/out', { amount: 20_000, operator: 'wave' });
  assert.equal(noPin.status, 403);
  assert.equal(noPin.body.code, 'step_up_required');
  await stepUp(s);

  julaya.setNext({ initiate: 'pending' });
  const co = await s.call('POST', 'cash/out', { amount: 20_000, operator: 'wave' }, { headers: { 'idempotency-key': key() } });
  assert.equal(co.status, 202, JSON.stringify(co.body));
  const ref = co.body.rail.reference;
  const h1 = await s.call('GET', 'money/home');
  assert.equal(h1.body.balance.availableKori, 1000);
  assert.equal(h1.body.balance.heldKori, 2000, 'held, shown, not spendable');
  const r1 = await s.call('GET', `money/activity/${ref}`);
  assert.equal(r1.body.status, 'pending');
  assert.match(r1.body.explanation, /réservé/);

  await webhook({ reference: ref, status: 'failed' });
  await webhook({ reference: ref, status: 'failed' }); // replay
  await webhook({ reference: ref, status: 'completed' }); // late success after final: no-op
  const h2 = await s.call('GET', 'money/home');
  assert.equal(h2.body.balance.availableKori, 3000, 'released exactly once');
  assert.equal(h2.body.balance.heldKori, 0);
  const r2 = await s.call('GET', `money/activity/${ref}`);
  assert.equal(r2.body.status, 'failed');
  assert.match(r2.body.explanation, /rendu/);

  julaya.setNext({ initiate: 'pending' });
  await stepUp(s);
  const co2 = await s.call('POST', 'cash/out', { amount: 20_000, operator: 'wave' }, { headers: { 'idempotency-key': key() } });
  await webhook({ reference: co2.body.rail.reference, status: 'completed' });
  const h3 = await s.call('GET', 'money/home');
  assert.equal(h3.body.balance.availableKori, 1000);
  assert.equal(h3.body.balance.heldKori, 0);
  assert.equal((await s.call('GET', `money/activity/${co2.body.rail.reference}`)).body.status, 'completed');
});

test('cash-out blocked: tier, new device, recent recovery, provider outage — explained in user terms, no detection logic leaked', async () => {
  // Tier 1
  const t1 = await signedIn(live, await customer({ tier: 1 }));
  const h = await t1.call('GET', 'money/home');
  assert.equal(h.body.actions.cashOut.allowed, false);
  assert.equal(h.body.actions.cashOut.category, 'verify_identity');
  await stepUp(t1);
  const r = await t1.call('POST', 'cash/out', { amount: 10_000, operator: 'wave' });
  assert.equal(r.status, 403);
  assert.equal(r.body.category, 'verify_identity');
  assert.ok(!INTERNAL.test(JSON.stringify(r.body)), JSON.stringify(r.body));

  // New device
  const c = await customer({ koriBalance: 0 });
  await fundUser(c.id, 2000);
  const nd = await signedIn(live, c, { device: newDevice() });
  const hn = await nd.call('GET', 'money/home');
  assert.equal(hn.body.actions.cashOut.category, 'new_device');
  assert.ok(hn.body.actions.cashOut.nextStep);
  assert.ok(!INTERNAL.test(JSON.stringify(hn.body)));

  // Recent recovery
  const rc = await customer({ koriBalance: 0 });
  await fundUser(rc.id, 2000);
  const recovered = await signedIn(live, rc, { intent: 'recover' });
  const hr = await recovered.call('GET', 'money/home');
  assert.equal(hr.body.actions.cashOut.category, 'security_change');

  // Provider outage
  const o = await customer({ koriBalance: 0 });
  await fundUser(o.id, 2000);
  const so = await signedIn(noRail, o);
  assert.equal((await so.call('GET', 'money/home')).body.actions.cashOut.category, 'provider_unavailable');
  await stepUp(so);
  const out = await so.call('POST', 'cash/out', { amount: 10_000, operator: 'wave' });
  assert.equal(out.status, 503);
  assert.equal((await prisma.wallet.findUnique({ where: { userId: o.id } })).koriBalance, 2000, 'nothing held when the rail is down');
});
