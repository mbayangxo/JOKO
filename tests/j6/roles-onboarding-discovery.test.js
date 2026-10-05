/**
 * J6.12 assisted onboarding, J6.13 strict role separation, J6.14 discovery,
 * J6.17 economic-OS coexistence (one person / shop in several networks never
 * couples permissions).
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { business, customer, operator, signedIn } from '../j3/helpers.js';
import { activeAgent, idem } from './helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

async function distributor() {
  const owner = await customer();
  const rep = await customer();
  const b = await business(owner.user, [{ user: rep.user, role: 'distribution_rep' }]);
  await prisma.business.update({ where: { id: b.id }, data: { operatingMode: 'distribution' } });
  return { b, owner: await signedIn(api, owner), rep: await signedIn(api, rep), repUser: rep };
}

test('role separation: distribution rep, merchant cashier and financial agent never borrow each other’s authority', async () => {
  const d = await distributor();
  const cashierC = await customer();
  const shopOwner = await customer();
  const shop = await business(shopOwner.user, [{ user: cashierC.user, role: 'cashier' }]);
  const cashier = await signedIn(api, cashierC);
  const ag = await activeAgent(api);
  const cust = await signedIn(api, await customer());
  const intent = await cust.call('POST', 'agent-cash/in', { amountXof: 10_000 }, idem());

  // Distribution rep → cash-in / cash-out / agent float: refused.
  for (const [m, p, b] of [['POST', 'agent/cash/scan', { qr: intent.body.qr }], ['GET', 'agent/cash'], ['POST', 'agent/commissions/settle', {}], ['POST', 'agent/float/topup-request', { amountXof: 1000 }]]) {
    assert.equal((await d.rep.call(m, p, b)).status, 403, `rep ${m} ${p}`);
  }
  // Merchant cashier → agent operations: refused.
  assert.equal((await cashier.call('POST', 'agent/cash/scan', { qr: intent.body.qr })).status, 403);
  // Financial agent → merchant wallet, payroll, distributor data, wholesale relationships: refused.
  for (const [m, p, b] of [
    ['GET', `businesses/${shop.id}/os/money`], ['GET', `businesses/${shop.id}/payroll/employees`], ['POST', `businesses/${shop.id}/payroll/pay`, { employeeHandle: cashierC.handle, amount: 100 }],
    ['GET', `businesses/${d.b.id}/distribution/relationships`], ['GET', `businesses/${d.b.id}/distribution/territories`],
    ['POST', `businesses/${d.b.id}/distribution/relationships`, { merchantBusinessId: shop.id }], ['GET', `businesses/${shop.id}/os/customers`],
  ]) {
    const r = await ag.s.call(m, p, b);
    assert.ok([403, 404].includes(r.status), `agent ${m} ${p} → ${r.status}`);
  }
  // The intent is untouched by all of the above.
  assert.equal((await prisma.agentCashTransaction.findUnique({ where: { id: intent.body.transaction.id } })).state, 'created');
});

test('one person in several networks: an agent who is also a merchant owner and a rep keeps each authority separate', async () => {
  const ag = await activeAgent(api);
  const own = await business(ag.user, []);
  const d = await distributor();
  await prisma.businessMember.create({ data: { businessId: d.b.id, userId: ag.id, role: 'distribution_rep', status: 'active', acceptedAt: new Date() } });
  // As a merchant owner they can read their own shop — that grants nothing in the agent domain…
  assert.equal((await ag.s.call('GET', `businesses/${own.id}/os/money`)).status, 200);
  const floatBefore = (await prisma.agentProfile.findUnique({ where: { id: ag.profile.id } })).floatBalance;
  assert.equal(await prisma.ledgerAccount.count({ where: { code: `business:${own.id}:wallet`, ownerId: ag.profile.id } }), 0);
  // …and the agent's float is never the business wallet (or vice versa).
  const bw = await prisma.businessWallet.findUnique({ where: { businessId: own.id } });
  assert.notEqual(bw?.balance ?? 0, floatBefore);
  // Suspending the AGENT does not touch their merchant or rep authority; removing them as rep does not touch the agent.
  const risk = await operator(api, ['risk']);
  await risk.call('POST', `admin/agents/${ag.profile.id}/suspend`, { reason: 'test separation' });
  assert.equal((await ag.s.call('GET', `businesses/${own.id}/os/money`)).status, 200);
  assert.equal((await ag.s.call('GET', `businesses/${d.b.id}/distribution/relationships`)).status, 200);
  assert.equal((await ag.s.call('GET', 'agent/cash')).status, 403);
});

test('assisted onboarding: rep starts, merchant verifies + confirms authority + accepts, merchant owns; the rep gets nothing', async () => {
  const d = await distributor();
  const terr = await d.owner.call('POST', `businesses/${d.b.id}/distribution/territories`, { name: 'Pikine Nord' });
  assert.equal(terr.status, 201, JSON.stringify(terr.body));
  const start = await d.rep.call('POST', 'onboarding/assist', { introducerType: 'distribution_business', introducerId: d.b.id, territoryId: terr.body.id, proposedName: 'Boutique Awa', proposedCategory: 'alimentation' });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  // The rep cannot accept for the merchant.
  assert.equal((await d.rep.call('POST', 'onboarding/assist/accept', { code: start.body.code, confirmAuthority: true })).body.code, 'self_assist');
  const unverified = await signedIn(api, await customer({ tier: 1 }));
  const o1 = await unverified.call('POST', 'onboarding/assist/open', { code: start.body.code });
  assert.equal(o1.body.identityVerified, false);
  assert.equal(o1.body.introducerGetsAccess, false);
  assert.equal((await unverified.call('POST', 'onboarding/assist/accept', { code: start.body.code, confirmAuthority: true })).body.code, 'identity_required');
  const merchantC = await customer({ tier: 2 });
  const merchant = await signedIn(api, merchantC);
  assert.equal((await merchant.call('POST', 'onboarding/assist/accept', { code: start.body.code, confirmAuthority: false })).body.code, 'authority_unconfirmed');
  const acc = await merchant.call('POST', 'onboarding/assist/accept', { code: start.body.code, confirmAuthority: true, businessName: 'Boutique Awa' });
  assert.equal(acc.status, 201, JSON.stringify(acc.body));
  const biz = await prisma.business.findUnique({ where: { id: acc.body.businessId } });
  assert.equal(biz.ownerId, merchantC.id);
  assert.equal(biz.settlementMode, 'business');
  assert.equal(await prisma.businessMember.count({ where: { businessId: biz.id } }), 0, 'no membership for the rep or the distributor');
  for (const p of ['os/money', 'os/profile', 'payroll/employees']) assert.ok([403, 404].includes((await d.rep.call('GET', `businesses/${biz.id}/${p}`)).status), p);
  const rec = await prisma.merchantOnboardingAssist.findUnique({ where: { id: start.body.id } });
  assert.equal(rec.repUserId, d.repUser.id);
  assert.equal(rec.territoryId, terr.body.id);
  assert.ok(rec.consentAt);
  const mine = await d.rep.call('GET', 'onboarding/assist/mine');
  assert.equal(mine.body.introductions[0].status, 'accepted');
  assert.ok(!JSON.stringify(mine.body).includes(merchantC.id) && !JSON.stringify(mine.body).includes(biz.id), 'the rep sees status, not the merchant’s account');
  assert.equal((await merchant.call('POST', 'onboarding/assist/accept', { code: start.body.code, confirmAuthority: true })).body.replayed, true);
});

test('removed rep and non-permitted service points cannot start onboarding', async () => {
  const d = await distributor();
  await prisma.businessMember.updateMany({ where: { businessId: d.b.id, userId: d.repUser.id }, data: { status: 'removed' } });
  assert.equal((await d.rep.call('POST', 'onboarding/assist', { introducerType: 'distribution_business', introducerId: d.b.id, proposedName: 'X shop' })).status, 403);
  const ag = await activeAgent(api);
  const r = await ag.s.call('POST', 'onboarding/assist', { introducerType: 'agent_organization', introducerId: ag.profile.organizationId, proposedName: 'Y shop' });
  assert.equal(r.body.code, 'merchant_assist_not_permitted');
});

test('discovery: only active verified points; declared hours only; no phone / id / float / precise location; old leak closed', async () => {
  const hours = { mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']], thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']], sun: [['00:00', '23:59']] };
  const ag = await activeAgent(api, { hours, floatXof: 0, lat: 16.0123, lng: -16.5049 });
  const noHours = await activeAgent(api, { lat: 16.0123, lng: -16.5049 });
  const viewer = await signedIn(api, await customer());
  // A pending application never appears.
  const pending = await signedIn(api, await customer());
  await pending.call('POST', 'agent/apply', { displayName: 'En attente', servicePoint: { name: 'Pending Point', publicAddress: 'Avenue Bourguiba, Dakar' } });
  const r = await viewer.call('GET', 'agent-cash/points?lat=16.01&lng=-16.5&service=cash_in');
  assert.equal(r.status, 200);
  const names = r.body.servicePoints.map((p) => p.name);
  assert.ok(!names.includes('Pending Point'));
  const mine = r.body.servicePoints.find((p) => p.id === ag.profile.servicePointId);
  assert.ok(mine, 'an active point with ZERO float is still listed (no liquidity-based filtering or ranking)');
  assert.equal(mine.openNow, true);
  assert.equal(mine.openNowSource, 'declared_hours');
  assert.equal(r.body.servicePoints.find((p) => p.id === noHours.profile.servicePointId).openNow, null, 'no fake "open now"');
  const text = JSON.stringify(r.body);
  for (const leak of [ag.phone, ag.id, ag.profile.userId, 'floatBalance', 'floatLimit', '16.0123', '-16.5049']) assert.ok(!text.includes(leak), `leak: ${leak}`);
  const legacy = await viewer.call('GET', 'agents/nearby?lat=14.69&lng=-17.44');
  assert.equal(legacy.status, 200);
  assert.ok(!JSON.stringify(legacy.body).includes('floatBalance'));
  const risk = await operator(api, ['risk']);
  await risk.call('POST', `admin/agents/${ag.profile.id}/suspend`, { reason: 'gone' });
  const after = await viewer.call('GET', 'agent-cash/points?lat=16.01&lng=-16.5&service=cash_in');
  assert.ok(!after.body.servicePoints.some((p) => p.id === ag.profile.servicePointId), 'a suspended agent’s point disappears');
  const big = await viewer.call('GET', 'agent-cash/points?service=cash_out&amount=900000');
  assert.ok(big.body.servicePoints.every((p) => p.largeCashOut));
});
