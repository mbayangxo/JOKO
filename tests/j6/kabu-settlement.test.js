/**
 * J6.0 — Kabu mapped-merchant settlement (D23/D24) over real HTTP, production
 * mode, provider = local fake Julaya with signed webhooks.
 *
 * Kabu payment → partner key → consented ExternalLink (same partner, active)
 * → merchant active → J2 ExternalOperation bound to business:<id>:wallet →
 * canonical ledger reference returned. A mapped merchant's money never
 * reaches the platform settlement wallet or another business; anything not
 * routable at confirmation is held (partner unallocated + exception) and
 * released only by maker/checker to the business bound at creation.
 * J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createUserWithWallet, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { startFakeJulaya } from '../helpers/fake-julaya.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { pegFor } from '../../lib/money-kernel/accounts.js';

const K = 5000 / pegFor('XOF'); // ₭ for a 5 000 XOF payment
import { business, customer, operator, signedIn } from '../j3/helpers.js';

const KABU_KEY = 'j6-kabu-partner-key-0123456789';
const OTHER_KEY = 'j6-other-partner-key-0123456789';
const WEBHOOK_SECRET = 'j6-julaya-webhook-secret';
let api;
let julaya;
let platform; // legacy PARTNER_SETTLEMENT_USER_ID wallet

before(async () => {
  julaya = await startFakeJulaya();
  platform = await createUserWithWallet({ koriBalance: 0 });
  api = await startApiServer({
    JOKO_API_KEYS: `kebu:${KABU_KEY},rect:${OTHER_KEY}`,
    JULAYA_API_KEY: julaya.apiKey,
    JULAYA_API_URL_PRODUCTION: julaya.url,
    JULAYA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PARTNER_SETTLEMENT_USER_ID: platform.id,
  });
});
after(async () => { await Promise.all([api?.stop(), julaya?.close()]); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const kabu = { 'x-api-key': KABU_KEY };
const rid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const platformBal = async () => (await prisma.wallet.findUnique({ where: { userId: platform.id } })).koriBalance;
const bizBal = async (id) => (await prisma.businessWallet.findUnique({ where: { businessId: id } }))?.balance ?? 0;
const unallocated = async (p = 'kebu') => Number((await prisma.ledgerAccount.findUnique({ where: { code: `partner:${p}:unallocated` } }))?.balance ?? 0);

function webhook(payload) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return api.client('POST', 'webhooks/julaya', { raw, headers: { 'x-julaya-signature': sig } });
}
const providerConfirms = (payment, extra = {}) => webhook({ reference: `pp_${payment.id}`, status: 'completed', amount: payment.amount_xof, id: rid('jul'), ...extra });

/** A Jokko merchant linked to a Kabu shop through the consented owner-code flow. */
async function linkedMerchant({ partnerKey = KABU_KEY, externalId = rid('kabu_shop') } = {}) {
  const owner = await customer();
  const b = await business(owner.user);
  const s = await signedIn(api, owner);
  const code = await s.call('POST', `businesses/${b.id}/os/integrations/link-code`, {});
  assert.equal(code.status, 201, JSON.stringify(code.body));
  const linked = await api.client('POST', 'v1/business-links', { headers: { 'x-api-key': partnerKey }, body: { code: code.body.code, external_business_id: externalId } });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  return { b, s, owner, externalId, linkId: linked.body.link_id };
}
async function relink(m, externalId = m.externalId) {
  const code = await m.s.call('POST', `businesses/${m.b.id}/os/integrations/link-code`, {});
  return api.client('POST', 'v1/business-links', { headers: kabu, body: { code: code.body.code, external_business_id: externalId } });
}
const collect = (body, headers = kabu) => api.client('POST', 'v1/payments/collect', { headers, body: { amount_xof: 5000, phone: '+221771234567', method: 'wave', ...body } });

test('mapped merchant: Kabu payment settles to the merchant business wallet, never the platform wallet; canonical ledger reference returned', async () => {
  const m = await linkedMerchant();
  const p0 = await platformBal();
  const ref = rid('kabu_order');
  const created = await collect({ reference: ref, merchant: { external_business_id: m.externalId } });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  assert.equal(created.body.settlement.target, 'business_wallet');
  assert.equal(created.body.settlement.legacy, false);
  assert.equal(created.body.settlement.status, 'pending');
  assert.equal(created.body.settlement.ledger_reference, null);
  assert.ok(!JSON.stringify(created.body.settlement).includes(m.b.id), 'no Jokko business id leaks to the partner');

  const w = await providerConfirms(created.body);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(await bizBal(m.b.id), K, '₭ at the XOF peg land in the business wallet');
  assert.equal(await platformBal(), p0, 'platform settlement wallet untouched');

  const got = await api.client('GET', `v1/payments/${ref}`, { headers: kabu });
  assert.equal(got.body.status, 'completed');
  assert.equal(got.body.settlement.status, 'settled');
  assert.equal(got.body.settlement.ledger_reference, `partner_${created.body.id}-CONFIRM`);
  const entry = await prisma.journalEntry.findUnique({ where: { reference: got.body.settlement.ledger_reference }, include: { postings: { include: { account: true } } } });
  assert.ok(entry.postings.some((p) => p.account.code === `business:${m.b.id}:wallet` && p.side === 'credit'));
  const pr = await prisma.paymentRecord.findUnique({ where: { ledgerReference: got.body.settlement.ledger_reference } });
  assert.equal(pr.businessId, m.b.id);
  assert.equal(pr.method, 'partner_checkout');
  assert.equal(pr.sourceSystem, 'kebu');

  // Response lost → Kabu retries the create, then the provider re-sends: one settlement.
  const retry = await collect({ reference: ref, merchant: { external_business_id: m.externalId } });
  assert.equal(retry.body.id, created.body.id);
  assert.equal(retry.body.settlement.ledger_reference, got.body.settlement.ledger_reference);
  await providerConfirms(created.body);
  await webhook({ reference: `pp_${created.body.id}`, status: 'submitted' }); // stale signal
  assert.equal(await bizBal(m.b.id), K, 'replays never double-credit');
  assert.equal(await prisma.journalEntry.count({ where: { reference: { startsWith: `partner_${created.body.id}` } } }), 1);
});

test('missing / revoked / foreign mapping and inactive merchant are refused at creation — nothing falls back to the platform wallet', async () => {
  const p0 = await platformBal();
  const missing = await collect({ reference: rid('o'), merchant: { external_business_id: 'never_linked' } });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'merchant_not_linked');

  const m = await linkedMerchant();
  await m.s.call('POST', `businesses/${m.b.id}/os/integrations/${m.linkId}/revoke`, {});
  const revoked = await collect({ reference: rid('o'), merchant: { external_business_id: m.externalId } });
  assert.equal(revoked.body.code, 'merchant_not_linked');

  // Another partner cannot settle into Kabu's merchant (mappings are per partner system).
  const k = await linkedMerchant();
  const foreign = await collect({ reference: rid('o'), merchant: { external_business_id: k.externalId } }, { 'x-api-key': OTHER_KEY });
  assert.equal(foreign.body.code, 'merchant_not_linked');

  // A Jokko business id is an assertion, never an instruction.
  const other = await linkedMerchant();
  const wrongJokko = await collect({ reference: rid('o'), merchant: { external_business_id: k.externalId, jokko_business_id: other.b.id } });
  assert.equal(wrongJokko.status, 409);
  assert.equal(wrongJokko.body.code, 'mapping_mismatch');
  const jokkoOnly = await collect({ reference: rid('o'), jokko_business_id: k.b.id });
  assert.equal(jokkoOnly.status, 400);
  const rightJokko = await collect({ reference: rid('o'), merchant: { external_business_id: k.externalId, jokko_business_id: k.b.id } });
  assert.ok([200, 201].includes(rightJokko.status));

  const ops = await operator(api, ['compliance']);
  assert.equal((await ops.call('POST', `admin/businesses/${k.b.id}/status`, { status: 'suspended', reason: 'compliance review pending' })).status, 200);
  const inactive = await collect({ reference: rid('o'), merchant: { external_business_id: k.externalId } });
  assert.equal(inactive.body.code, 'merchant_inactive');
  assert.equal(await prisma.partnerPayment.count({ where: { externalBusinessId: { in: ['never_linked', m.externalId] } } }), 0);
  assert.equal(await platformBal(), p0);
});

test('idempotency: same reference + same request returns the same payment; a different amount or merchant conflicts; concurrent creates make one row', async () => {
  const m = await linkedMerchant();
  const n = await linkedMerchant();
  const ref = rid('o');
  const runs = await Promise.all([1, 2, 3, 4, 5].map(() => collect({ reference: ref, merchant: { external_business_id: m.externalId } })));
  assert.ok(runs.every((r) => r.status < 300), JSON.stringify(runs.map((r) => r.body)));
  assert.equal(new Set(runs.map((r) => r.body.id)).size, 1);
  assert.equal((await collect({ reference: ref, amount_xof: 9000, merchant: { external_business_id: m.externalId } })).body.code, 'idempotency_conflict');
  assert.equal((await collect({ reference: ref, merchant: { external_business_id: n.externalId } })).body.code, 'idempotency_conflict', 'a reference cannot be re-pointed to another merchant');
  assert.equal((await collect({ reference: ref })).body.code, 'idempotency_conflict', 'nor to the legacy platform wallet');
});

test('mapping revoked during payment → held for review (not the merchant, not the platform); release only after relink, maker ≠ checker, constrained route only', async () => {
  const m = await linkedMerchant();
  const p0 = await platformBal();
  const created = await collect({ reference: rid('o'), merchant: { external_business_id: m.externalId } });
  await m.s.call('POST', `businesses/${m.b.id}/os/integrations/${m.linkId}/revoke`, {});
  const u0 = await unallocated();
  await providerConfirms(created.body);
  const got = await api.client('GET', `v1/payments/${created.body.reference}`, { headers: kabu });
  assert.equal(got.body.status, 'completed', 'the provider did collect');
  assert.equal(got.body.settlement.status, 'held_for_review');
  assert.equal(await bizBal(m.b.id), 0);
  assert.equal(await platformBal(), p0);
  assert.equal(await unallocated(), u0 + K);
  const ex = await prisma.reconciliationException.findFirst({ where: { kind: 'partner_settlement_held', providerReference: `partner_${created.body.id}` } });
  assert.equal(ex.status, 'open');
  assert.match(ex.detail, /mapping_revoked/);

  const maker = await operator(api, ['finance_ops']);
  const checker = await operator(api, ['finance_approver']);
  const support = await operator(api, ['support']);
  const R = `admin/partner-payments/${created.body.id}/release`;
  assert.equal((await support.call('POST', R, { reason: 'support should not move money' })).status, 403);
  const early = await maker.call('POST', R, { reason: 'merchant confirmed link restored' });
  assert.equal(early.body.code, 'mapping_not_active', 'no release while the mapping is revoked');

  assert.equal((await relink(m)).status, 201);
  const req = await maker.call('POST', R, { reason: 'merchant confirmed link restored' });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  assert.equal(req.body.creditAccount, `business:${m.b.id}:wallet`);
  assert.equal((await checker.call('POST', `admin/money/adjustments/${req.body.id}/approve`, {})).body.code, 'constrained_request', 'generic approve cannot bypass the workflow');
  const makerAsChecker = await operator(api, ['finance_ops', 'finance_approver']);
  const selfReq = await makerAsChecker.call('POST', R, { reason: 'merchant confirmed link restored' });
  assert.equal(selfReq.body.id, req.body.id);
  const ok = await checker.call('POST', `${R}/approve`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await bizBal(m.b.id), K);
  assert.equal(await unallocated(), u0);
  assert.equal((await prisma.reconciliationException.findUnique({ where: { id: ex.id } })).status, 'resolved');
  assert.equal((await checker.call('POST', `${R}/approve`, {})).body.code, 'not_held', 'released once');
  assert.equal(await bizBal(m.b.id), K);
});

test('maker cannot approve their own release', async () => {
  const m = await linkedMerchant();
  const created = await collect({ reference: rid('o'), merchant: { external_business_id: m.externalId } });
  await m.s.call('POST', `businesses/${m.b.id}/os/integrations/${m.linkId}/revoke`, {});
  await providerConfirms(created.body);
  await relink(m);
  const both = await operator(api, ['finance_ops', 'finance_approver']);
  const R = `admin/partner-payments/${created.body.id}/release`;
  assert.equal((await both.call('POST', R, { reason: 'merchant confirmed link restored' })).status, 201);
  assert.equal((await both.call('POST', `${R}/approve`, {})).status, 403);
  assert.equal(await bizBal(m.b.id), 0);
});

test('mapping changed during payment (Kabu shop re-pointed to another business) → held; never follows the new mapping', async () => {
  const m = await linkedMerchant();
  const created = await collect({ reference: rid('o'), merchant: { external_business_id: m.externalId } });
  await m.s.call('POST', `businesses/${m.b.id}/os/integrations/${m.linkId}/revoke`, {});
  const other = await linkedMerchant({ externalId: m.externalId }); // same Kabu shop id → another Jokko business
  assert.equal((await prisma.externalLink.findUnique({ where: { id: m.linkId } })).businessId, other.b.id);
  await providerConfirms(created.body);
  assert.equal(await bizBal(m.b.id), 0);
  assert.equal(await bizBal(other.b.id), 0, 'the new mapping is never followed for an existing payment');
  const ex = await prisma.reconciliationException.findFirst({ where: { providerReference: `partner_${created.body.id}` } });
  assert.match(ex.detail, /mapping_changed/);
  const maker = await operator(api, ['finance_ops']);
  assert.equal((await maker.call('POST', `admin/partner-payments/${created.body.id}/release`, { reason: 'try to release elsewhere' })).body.code, 'mapping_not_active');
});

test('merchant suspended during payment → held; reactivation + maker/checker releases to the same merchant', async () => {
  const m = await linkedMerchant();
  const ops = await operator(api, ['compliance']);
  const created = await collect({ reference: rid('o'), merchant: { external_business_id: m.externalId } });
  await ops.call('POST', `admin/businesses/${m.b.id}/status`, { status: 'suspended', reason: 'documents under review' });
  await providerConfirms(created.body);
  assert.equal(await bizBal(m.b.id), 0);
  const support = await operator(api, ['support']);
  assert.equal((await support.call('POST', `admin/businesses/${m.b.id}/status`, { status: 'active', reason: 'support cannot do this' })).status, 403);
  await ops.call('POST', `admin/businesses/${m.b.id}/status`, { status: 'active', reason: 'documents verified ok' });
  const maker = await operator(api, ['finance_ops']);
  const checker = await operator(api, ['finance_approver']);
  assert.equal((await maker.call('POST', `admin/partner-payments/${created.body.id}/release`, { reason: 'merchant reactivated by compliance' })).status, 201);
  assert.equal((await checker.call('POST', `admin/partner-payments/${created.body.id}/release/approve`, {})).status, 200);
  assert.equal(await bizBal(m.b.id), K);
  const ev = await prisma.identityAuditEvent.findMany({ where: { subjectId: m.b.id, action: 'business_status_changed' } });
  assert.equal(ev.length, 2);
});

test('concurrency: parallel provider confirmations settle once; revoke racing confirmation is all-or-nothing', async () => {
  const m = await linkedMerchant();
  const created = await collect({ reference: rid('o'), merchant: { external_business_id: m.externalId } });
  const runs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => providerConfirms(created.body)));
  assert.ok(runs.every((r) => r.status === 200), JSON.stringify(runs.map((r) => r.body)));
  assert.equal(await bizBal(m.b.id), K);

  for (let i = 0; i < 4; i++) {
    const r = await linkedMerchant();
    const c = await collect({ reference: rid('o'), merchant: { external_business_id: r.externalId } });
    const u0 = await unallocated();
    await Promise.all([providerConfirms(c.body), r.s.call('POST', `businesses/${r.b.id}/os/integrations/${r.linkId}/revoke`, {})]);
    const row = await prisma.partnerPayment.findUnique({ where: { id: c.body.id } });
    const credited = await bizBal(r.b.id);
    const held = (await unallocated()) - u0;
    assert.equal(credited + held, K, `exactly one destination (${row.settlementTarget})`);
    assert.equal(row.settlementTarget, credited ? 'business_wallet' : 'held_for_review');
  }
});

test('legacy unmapped payment stays labelled legacy; amount-mismatch webhook never settles', async () => {
  const p0 = await platformBal();
  const created = await collect({ reference: rid('legacy') });
  assert.equal(created.body.settlement.target, 'legacy_platform');
  assert.equal(created.body.settlement.legacy, true);
  await providerConfirms(created.body);
  assert.equal(await platformBal(), p0 + K, 'unchanged legacy behaviour for unmapped payments');

  const m = await linkedMerchant();
  const c = await collect({ reference: rid('o'), merchant: { external_business_id: m.externalId } });
  await providerConfirms(c.body, { amount: 4999 });
  assert.equal((await prisma.partnerPayment.findUnique({ where: { id: c.body.id } })).status, 'requires_action');
  assert.equal(await bizBal(m.b.id), 0);
});

test('legacy platform settlement can be switched off: unmapped requests are refused', async () => {
  const strict = await startApiServer({ JOKO_API_KEY: KABU_KEY, JULAYA_API_KEY: julaya.apiKey, JULAYA_API_URL_PRODUCTION: julaya.url, PARTNER_LEGACY_PLATFORM_SETTLEMENT: 'false' });
  try {
    const r = await strict.client('POST', 'v1/payments/collect', { headers: kabu, body: { reference: rid('o'), amount_xof: 5000, phone: '+221771234567' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'merchant_required');
  } finally {
    await strict.stop();
  }
});
