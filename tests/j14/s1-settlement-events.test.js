/**
 * J14-S1 — real flow: a Kabu payment for a MAPPED merchant (J6.0, consented owner-code link) settles into the
 * business wallet, and the signed `settlement.completed` event reaches the partner exactly once per event id,
 * even though the provider confirms twice. Delivery never changes any balance. Invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { startFakeJulaya } from '../helpers/fake-julaya.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { pegFor } from '../../lib/money-kernel/accounts.js';
import { business, customer, signedIn } from '../j3/helpers.js';

process.env.PARTNER_EVENTS_ENABLED = 'true';
process.env.PARTNER_EVENTS_ALLOW_LOCAL = 'true';
// Subscription secrets are encrypted at rest; the API process and the in-process worker share the key (as in production).
const DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.DATA_ENCRYPTION_KEY = DATA_ENCRYPTION_KEY;
const PE = await import('../../lib/integrations/partner-events.js');

const KABU_KEY = `j14-kabu-${crypto.randomBytes(8).toString('hex')}`;
const WEBHOOK_SECRET = 'j14-julaya-webhook-secret';
const K = 5000 / pegFor('XOF');
let api;
let julaya;
let receiver;
const got = [];

before(async () => {
  julaya = await startFakeJulaya();
  const platform = await createUserWithWallet({ koriBalance: 0 });
  receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { got.push({ headers: req.headers, body: raw }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  api = await startApiServer({
    JOKO_API_KEYS: `kebu:${KABU_KEY}`,
    JULAYA_API_KEY: julaya.apiKey,
    JULAYA_API_URL_PRODUCTION: julaya.url,
    JULAYA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PARTNER_SETTLEMENT_USER_ID: platform.id,
    PARTNER_EVENTS_ENABLED: 'true',
    PARTNER_EVENTS_ALLOW_LOCAL: 'true',
    DATA_ENCRYPTION_KEY,
  });
});
after(async () => { await Promise.all([api?.stop(), julaya?.close(), new Promise((r) => receiver.close(r))]); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const kabu = { 'x-api-key': KABU_KEY };
const rid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const bizBal = async (id) => (await prisma.businessWallet.findUnique({ where: { businessId: id } }))?.balance ?? 0;
function providerConfirms(payment) {
  const raw = JSON.stringify({ reference: `pp_${payment.id}`, status: 'completed', amount: payment.amount_xof, id: rid('jul') });
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return api.client('POST', 'webhooks/julaya', { raw, headers: { 'x-julaya-signature': sig } });
}

test('mapped Kabu payment → settlement.completed delivered once, signed, minimal, linked business only; balances untouched by delivery', async () => {
  await prisma.partnerEventSubscription.updateMany({ where: { status: 'active' }, data: { status: 'disabled' } });
  const sub = await api.client('POST', 'v1/event-subscriptions', { headers: kabu, body: { url: `http://127.0.0.1:${receiver.address().port}/h`, event_types: ['settlement.completed', 'settlement.held'] } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));

  const owner = await customer();
  const b = await business(owner.user);
  const s = await signedIn(api, owner);
  const code = await s.call('POST', `businesses/${b.id}/os/integrations/link-code`, {});
  const externalId = rid('kabu_shop');
  const linked = await api.client('POST', 'v1/business-links', { headers: kabu, body: { code: code.body.code, external_business_id: externalId } });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));

  const ref = rid('kabu_order');
  const created = await api.client('POST', 'v1/payments/collect', { headers: kabu, body: { amount_xof: 5000, phone: '+221771234567', method: 'wave', reference: ref, merchant: { external_business_id: externalId } } });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  assert.equal((await providerConfirms(created.body)).status, 200);
  await providerConfirms(created.body); // provider re-sends: still one settlement, one event
  assert.equal(await bizBal(b.id), K);

  await PE.fanOutEvents(prisma);
  await PE.deliverDue(prisma, { limit: 500 });
  await PE.fanOutEvents(prisma);
  await PE.deliverDue(prisma, { limit: 500 });
  assert.equal(await bizBal(b.id), K, 'delivery never changes money');

  const mine = got.filter((g) => JSON.parse(g.body).data?.partnerReference === ref);
  assert.equal(mine.length, 1, `exactly one settlement event: ${mine.length}`);
  const g = mine[0];
  const body = JSON.parse(g.body);
  assert.equal(body.type, 'settlement.completed');
  assert.equal(body.business.external_id, externalId);
  assert.equal(body.data.amountKori, K);
  assert.ok(PE.verifyEventSignature(sub.body.secret, { timestamp: g.headers['x-jokko-event-timestamp'], eventId: g.headers['x-jokko-event-id'], body: g.body, signature: g.headers['x-jokko-event-signature'] }));
  assert.ok(!g.body.includes(b.id), 'no Jokko business id leaves');
  assert.ok(!g.body.includes('+221'), 'no phone leaves');
  assert.equal(await prisma.commerceEvent.count({ where: { type: 'settlement.completed', aggregateId: created.body.id } }), 1);
});
