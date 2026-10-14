/**
 * J14 D-J14-3 — close the legacy unmapped settlement path for NEW partners only, after the mapped replacement
 * passes complete reconciliation and migration tests. Real HTTP, production mode, fake Julaya with signed
 * webhooks. Existing partners and default behaviour unchanged. Invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { startFakeJulaya } from '../helpers/fake-julaya.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { reconcilePartnerSettlements } from '../../lib/integrations/partner-settlement-reconcile.js';
import { business, customer, signedIn } from '../j3/helpers.js';

const KEBU = `d3-kebu-${crypto.randomBytes(8).toString('hex')}`;
const NEWP = `d3-newp-${crypto.randomBytes(8).toString('hex')}`;
const NEW_ID = `newp${crypto.randomBytes(3).toString('hex')}`;
const SECRET = 'd3-julaya-webhook-secret';
let julaya;
let platform;
const since = new Date(Date.now() - 1000); // reconcile what THIS file created (other suites seed synthetic rows)
const servers = [];

before(async () => {
  julaya = await startFakeJulaya();
  platform = await createUserWithWallet({ koriBalance: 0 });
});
after(async () => { await Promise.all([...servers.map((s) => s.stop()), julaya?.close()]); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

async function server(extra = {}) {
  const s = await startApiServer({
    JOKO_API_KEYS: `kebu:${KEBU},${NEW_ID}:${NEWP}`, JULAYA_API_KEY: julaya.apiKey, JULAYA_API_URL_PRODUCTION: julaya.url,
    JULAYA_WEBHOOK_SECRET: SECRET, PARTNER_SETTLEMENT_USER_ID: platform.id, ...extra,
  });
  servers.push(s);
  return s;
}
const rid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const as = (key) => ({ 'x-api-key': key });
const collect = (api, key, body) => api.client('POST', 'v1/payments/collect', { headers: as(key), body: { amount_xof: 5000, phone: '+221771234567', method: 'wave', reference: rid('ord'), ...body } });
function confirm(api, payment) {
  const raw = JSON.stringify({ reference: `pp_${payment.id}`, status: 'completed', amount: payment.amount_xof, id: rid('jul') });
  return api.client('POST', 'webhooks/julaya', { raw, headers: { 'x-julaya-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex') } });
}
async function linkedShop(api, key, system) {
  const owner = await customer();
  const b = await business(owner.user);
  const s = await signedIn(api, owner);
  const code = await s.call('POST', `businesses/${b.id}/os/integrations/link-code`, system ? { system } : {});
  assert.equal(code.status, 201, JSON.stringify(code.body));
  const ext = rid('shop');
  const l = await api.client('POST', 'v1/business-links', { headers: as(key), body: { code: code.body.code, external_business_id: ext } });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  return { b, s, ext, linkId: l.body.link_id };
}

test('reconciliation: a real mix (mapped settled, held, legacy settled, pending) reconciles exactly; synthetic defects are caught', async () => {
  const api = await server();
  const shop = await linkedShop(api, KEBU);
  const mapped = await collect(api, KEBU, { merchant: { external_business_id: shop.ext } });
  await confirm(api, mapped.body);
  await confirm(api, mapped.body); // provider re-sends
  const shop2 = await linkedShop(api, KEBU);
  const held = await collect(api, KEBU, { merchant: { external_business_id: shop2.ext } });
  await shop2.s.call('POST', `businesses/${shop2.b.id}/os/integrations/${shop2.linkId}/revoke`, {});
  await confirm(api, held.body);
  const legacy = await collect(api, KEBU, {});
  await confirm(api, legacy.body);
  await collect(api, KEBU, {}); // stays pending
  const ids = [mapped.body.id, held.body.id, legacy.body.id];
  const rows = await prisma.partnerPayment.findMany({ where: { id: { in: ids } } });
  assert.deepEqual(rows.map((r) => r.settlementTarget).sort(), ['business_wallet', 'held_for_review', 'legacy_platform']);
  const rep = await reconcilePartnerSettlements(prisma, { partnerId: 'kebu', since });
  assert.equal(rep.ok, true, JSON.stringify(rep.exceptions.slice(0, 5)));
  assert.ok(rep.totals.business_wallet.count >= 1 && rep.totals.held_for_review.count >= 1 && rep.totals.legacy_platform.count >= 1);

  // Synthetic defects: a "completed" payment with no booking, and a pending one carrying a settlement claim.
  const ghost = await prisma.partnerPayment.create({ data: { partnerId: 'kebu', reference: rid('ghost'), amountXof: 1000, status: 'completed', settlementTarget: 'business_wallet', settlementBusinessId: shop.b.id, checkoutToken: crypto.randomBytes(12).toString('hex') } });
  const bad = await reconcilePartnerSettlements(prisma, { partnerId: 'kebu', since });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.exceptions.filter((e) => e.paymentId === ghost.id).map((e) => e.problem), ['no_operation']);
  await prisma.partnerPayment.update({ where: { id: ghost.id }, data: { status: 'failed' } }); // leave the ledger world clean
  assert.equal((await reconcilePartnerSettlements(prisma, { partnerId: 'kebu', since })).ok, true);
});

test('default unchanged: with PARTNER_LEGACY_SETTLEMENT_PARTNERS unset, every partner (old or new) may still use the legacy path', async () => {
  const api = await server();
  const r = await collect(api, NEWP, {});
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  assert.equal(r.body.settlement.target, 'legacy_platform');
});

test('migration: closing legacy for NEW partners never interrupts an existing partner or an in-flight legacy payment; reconciliation stays exact', async () => {
  const before = await server();
  const inflight = await collect(before, KEBU, {}); // created under the old rules
  const newInflight = await collect(before, NEWP, {}); // a new partner's legacy payment created BEFORE the switch
  assert.equal(inflight.body.settlement.target, 'legacy_platform');

  const after = await server({ PARTNER_LEGACY_SETTLEMENT_PARTNERS: 'kebu' });
  // Existing partner: unchanged.
  const kebuLegacy = await collect(after, KEBU, {});
  assert.ok([200, 201].includes(kebuLegacy.status), JSON.stringify(kebuLegacy.body));
  // New partner: unmapped refused, nothing created; mapped works.
  const refusedRef = rid('ord');
  const refused = await collect(after, NEWP, { reference: refusedRef });
  assert.deepEqual([refused.status, refused.body.code], [400, 'merchant_required']);
  assert.equal(await prisma.partnerPayment.count({ where: { reference: refusedRef } }), 0);
  const shop = await linkedShop(after, NEWP, NEW_ID);
  // The owner can only name a partner that exists.
  const o = await customer();
  const ob = await business(o.user);
  const os = await signedIn(after, o);
  assert.deepEqual((await os.call('POST', `businesses/${ob.id}/os/integrations/link-code`, { system: 'nosuchpartner' })).body.code, 'unknown_partner');
  // A code issued for one partner is useless to another.
  const kebuCode = await os.call('POST', `businesses/${ob.id}/os/integrations/link-code`, {});
  assert.equal((await after.client('POST', 'v1/business-links', { headers: as(NEWP), body: { code: kebuCode.body.code, external_business_id: rid('x') } })).status, 404);
  const mapped = await collect(after, NEWP, { merchant: { external_business_id: shop.ext } });
  assert.equal(mapped.body.settlement.target, 'business_wallet');
  // In-flight payments created before the switch settle exactly as created — even the new partner's.
  const p0 = (await prisma.wallet.findUnique({ where: { userId: platform.id } })).koriBalance;
  for (const p of [inflight.body, newInflight.body, kebuLegacy.body, mapped.body]) assert.equal((await confirm(after, p)).status, 200);
  const rows = await prisma.partnerPayment.findMany({ where: { id: { in: [inflight.body.id, newInflight.body.id, kebuLegacy.body.id, mapped.body.id] } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(newInflight.body.id).settlementTarget, 'legacy_platform', 'never re-targeted after the switch');
  assert.equal(byId.get(mapped.body.id).settlementTarget, 'business_wallet');
  assert.ok(rows.every((r) => r.status === 'completed'));
  const K = Number((await prisma.externalOperation.findUnique({ where: { reference: `partner_${inflight.body.id}` } })).amountKori);
  assert.equal((await prisma.wallet.findUnique({ where: { userId: platform.id } })).koriBalance, p0 + 3 * K, 'three legacy settlements to the platform wallet');
  for (const pid of ['kebu', NEW_ID]) {
    const rep = await reconcilePartnerSettlements(prisma, { partnerId: pid, since });
    assert.equal(rep.ok, true, `${pid}: ${JSON.stringify(rep.exceptions.slice(0, 5))}`);
  }
  // The global switch still closes it for everyone.
  const closed = await server({ PARTNER_LEGACY_PLATFORM_SETTLEMENT: 'false' });
  assert.equal((await collect(closed, KEBU, {})).body.code, 'merchant_required');
});
