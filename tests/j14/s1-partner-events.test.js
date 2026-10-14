/**
 * J14-S1 — signed partner event delivery from the CommerceEvent outbox (D-J14-2).
 * Real HTTP Partner API (production mode) + a local receiver; the delivery worker runs in this process with
 * injected clocks so retries, replay windows and retention are deterministic. Invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { emitCommerceEvent } from '../../lib/commerce/events.js';
import { business, customer, operator } from '../j3/helpers.js';

process.env.PARTNER_EVENTS_ENABLED = 'true';
process.env.PARTNER_EVENTS_ALLOW_LOCAL = 'true';
// Subscription secrets are encrypted at rest; the API process and the in-process worker share the key (as in production).
const DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.DATA_ENCRYPTION_KEY = DATA_ENCRYPTION_KEY;
const PE = await import('../../lib/integrations/partner-events.js');

const KEBU = `kebu_${crypto.randomBytes(8).toString('hex')}`;
const RECT = `rect_${crypto.randomBytes(8).toString('hex')}`;
let api;
let receiver;
let got = []; // { headers, body }
let reply = () => 200;

before(async () => {
  receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      got.push({ headers: req.headers, body: raw });
      const r = reply(raw);
      if (r === 302) {
        res.writeHead(302, { Location: 'http://169.254.169.254/' });
        return res.end();
      }
      res.writeHead(r);
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  api = await startApiServer({ JOKO_API_KEYS: `kebu:${KEBU},rect:${RECT}`, PARTNER_EVENTS_ENABLED: 'true', PARTNER_EVENTS_ALLOW_LOCAL: 'true', DATA_ENCRYPTION_KEY });
});
after(async () => { await api?.stop(); await new Promise((r) => receiver.close(r)); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  got = [];
  reply = () => 200;
});

const url = () => `http://127.0.0.1:${receiver.address().port}/hooks`;
const as = (key) => ({ headers: { 'x-api-key': key } });
const subscribe = (key, body = {}) => api.client('POST', 'v1/event-subscriptions', { ...as(key), body: { url: url(), ...body } });
const hex = () => crypto.randomBytes(4).toString('hex');

async function linkedBusiness(partnerId = 'kebu') {
  const owner = await customer();
  const b = await business(owner.user);
  const ext = `shop_${hex()}`;
  await prisma.externalLink.create({ data: { system: partnerId, objectType: 'business', externalId: ext, jokkoType: 'business', jokkoId: b.id, businessId: b.id, status: 'active' } });
  return { b, ext };
}
const emit = (type, businessId, payload = {}, aggregateType = 'order') =>
  prisma.$transaction((tx) => emitCommerceEvent(tx, { type, businessId, aggregateType, aggregateId: `agg_${hex()}`, payload }));
/** Run the worker: fan-out then deliver whatever is due "now". */
const pump = async (opts = {}) => {
  await PE.fanOutEvents(prisma, opts.now ? { now: opts.now } : {});
  return PE.deliverDue(prisma, { limit: 500, ...opts });
};
const freshSub = async (key = KEBU, body = {}) => {
  const r = await subscribe(key, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const disableAll = () => prisma.partnerEventSubscription.updateMany({ where: { status: 'active' }, data: { status: 'disabled' } });

test('disabled by default: a server without PARTNER_EVENTS_ENABLED refuses subscriptions; the worker does nothing', async () => {
  const off = await startApiServer({ JOKO_API_KEYS: `kebu:${KEBU}`, DATA_ENCRYPTION_KEY });
  try {
    const r = await off.client('POST', 'v1/event-subscriptions', { ...as(KEBU), body: { url: 'https://example.test/h' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'disabled');
  } finally {
    await off.stop();
  }
  process.env.PARTNER_EVENTS_ENABLED = 'false';
  try {
    assert.deepEqual(await PE.fanOutEvents(prisma), { enabled: false, created: 0 });
    assert.equal((await PE.deliverDue(prisma)).enabled, false);
  } finally {
    process.env.PARTNER_EVENTS_ENABLED = 'true';
  }
});

test('subscription: https only, no credentials in URL, allowlisted types only; secret shown once, never listed', async () => {
  await disableAll();
  for (const bad of ['http://example.com/h', 'ftp://x/y', 'https://user:pw@example.com/h', 'not a url']) {
    const r = await subscribe(KEBU, { url: bad });
    assert.equal(r.status, 400, `${bad}: ${r.status}`);
  }
  const t = await subscribe(KEBU, { event_types: ['order.paid', 'customer.created'] });
  assert.equal(t.status, 400);
  assert.equal(t.body.code, 'event_type_not_allowed');
  const s = await freshSub(KEBU, { event_types: ['order.paid'] });
  assert.match(s.secret, /^whsec_/);
  const list = await api.client('GET', 'v1/event-subscriptions', as(KEBU));
  assert.ok(!JSON.stringify(list.body).includes(s.secret), 'the secret is never listed');
  const row = await prisma.partnerEventSubscription.findUnique({ where: { id: s.id } });
  assert.ok(!row.secretEnc.includes(s.secret), 'stored encrypted');
});

test('only the partner\'s LINKED businesses, only allowlisted types; signature verifies; payload has ids/amounts only', async () => {
  await disableAll();
  const s = await freshSub(KEBU, { event_types: ['order.paid', 'payment.recorded'] });
  const mine = await linkedBusiness('kebu');
  const theirs = await linkedBusiness('rect');
  const unlinked = await business((await customer()).user);
  const e1 = await emit('order.paid', mine.b.id, { totalKori: 1500, channel: 'online', buyerName: 'Awa Diop', phone: '+221770000000', address: 'Rue 10' });
  await emit('order.paid', theirs.b.id, { totalKori: 9 });
  await emit('order.paid', unlinked.id, { totalKori: 9 });
  await emit('order.refunded', mine.b.id, { refundedKori: 5 }); // not subscribed
  await emit('relationship.invited', mine.b.id, { territory: 'x' }, 'merchant_relationship'); // not allowlisted
  const out = await pump();
  assert.equal(out.delivered, 1, JSON.stringify(out));
  assert.equal(got.length, 1);
  const [{ headers, body }] = got;
  assert.equal(headers['x-jokko-event-id'], e1.id);
  assert.ok(PE.verifyEventSignature(s.secret, { timestamp: headers['x-jokko-event-timestamp'], eventId: headers['x-jokko-event-id'], body, signature: headers['x-jokko-event-signature'] }));
  const parsed = JSON.parse(body);
  assert.equal(parsed.business.external_id, mine.ext);
  assert.deepEqual(parsed.data, { totalKori: 1500, channel: 'online' });
  for (const pii of ['Awa', '+22177', 'Rue 10', mine.b.id]) assert.ok(!body.includes(pii), `leaks ${pii}`);
});

test('replay protection: an old timestamp, a tampered body or a wrong secret never verifies', async () => {
  const secret = 'whsec_test';
  const body = '{"a":1}';
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const sig = `v1=${PE.signEvent(secret, { timestamp: ts, eventId: 'e1', body })}`;
  assert.ok(PE.verifyEventSignature(secret, { timestamp: ts, eventId: 'e1', body, signature: sig, now }));
  assert.ok(!PE.verifyEventSignature(secret, { timestamp: ts, eventId: 'e1', body, signature: sig, now: now + (PE.REPLAY_WINDOW_S + 1) * 1000 }), 'too old');
  assert.ok(!PE.verifyEventSignature(secret, { timestamp: ts, eventId: 'e1', body: '{"a":2}', signature: sig, now }), 'tampered');
  assert.ok(!PE.verifyEventSignature(secret, { timestamp: ts, eventId: 'e2', body, signature: sig, now }), 'id is signed');
  assert.ok(!PE.verifyEventSignature('whsec_other', { timestamp: ts, eventId: 'e1', body, signature: sig, now }), 'wrong secret');
});

test('rotation: during the overlap both secrets verify; after it only the new one; old subscription secret is replaced', async () => {
  await disableAll();
  const s = await freshSub(KEBU, { event_types: ['order.paid'] });
  const rot = await api.client('POST', `v1/event-subscriptions/${s.id}/rotate-secret`, { ...as(KEBU), body: {} });
  assert.equal(rot.status, 200);
  const m = await linkedBusiness('kebu');
  await emit('order.paid', m.b.id, { totalKori: 10 });
  await pump();
  const h = got[0].headers;
  const v = (secret, now = Date.now()) => PE.verifyEventSignature(secret, { timestamp: h['x-jokko-event-timestamp'], eventId: h['x-jokko-event-id'], body: got[0].body, signature: h['x-jokko-event-signature'], now });
  assert.ok(v(rot.body.secret) && v(s.secret), 'both during the overlap');
  got = [];
  await prisma.partnerEventSubscription.update({ where: { id: s.id }, data: { previousValidUntil: new Date(Date.now() - 1000) } });
  await emit('order.paid', m.b.id, { totalKori: 11 });
  await pump();
  const h2 = got[0].headers;
  const v2 = (secret) => PE.verifyEventSignature(secret, { timestamp: h2['x-jokko-event-timestamp'], eventId: h2['x-jokko-event-id'], body: got[0].body, signature: h2['x-jokko-event-signature'] });
  assert.ok(v2(rot.body.secret) && !v2(s.secret), 'after the overlap only the new secret');
});

test('retries with backoff → dead-letter after MAX_ATTEMPTS; operator replay (reason required, audited) redelivers the SAME event id', async () => {
  await disableAll();
  await freshSub(KEBU, { event_types: ['order.paid'] });
  const m = await linkedBusiness('kebu');
  const e = await emit('order.paid', m.b.id, { totalKori: 10 });
  reply = () => 500;
  let now = Date.now();
  await pump({ now });
  let d = await prisma.partnerEventDelivery.findFirst({ where: { eventId: e.id } });
  assert.deepEqual([d.status, d.attempts], ['pending', 1]);
  assert.ok(d.nextAttemptAt.getTime() > now, 'backoff');
  for (let i = 0; i < PE.MAX_ATTEMPTS + 2; i += 1) {
    now += 7 * 3600_000;
    await PE.deliverDue(prisma, { now });
  }
  d = await prisma.partnerEventDelivery.findFirst({ where: { eventId: e.id } });
  assert.deepEqual([d.status, d.attempts], ['dead', PE.MAX_ATTEMPTS]);
  const op = await operator(api, ['integration_ops']);
  const noReason = await op.call('POST', `admin/partner-events/deliveries/${d.id}/replay`, {});
  assert.equal(noReason.status, 400);
  const r = await op.call('POST', `admin/partner-events/deliveries/${d.id}/replay`, { reason: 'receiver fixed its endpoint' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'partner_events.replay', targetId: d.id } }), 1);
  reply = () => 200;
  got = [];
  await PE.deliverDue(prisma);
  assert.equal(got.length, 1);
  assert.equal(got[0].headers['x-jokko-event-id'], e.id, 'same event id: receivers dedupe');
  const noPerm = await operator(api, ['trust_safety']);
  assert.equal((await noPerm.call('POST', `admin/partner-events/deliveries/${d.id}/replay`, { reason: 'not my job at all' })).status, 403);
});

test('a redirect is never followed (treated as a failed attempt)', async () => {
  await disableAll();
  await freshSub(KEBU, { event_types: ['order.paid'] });
  const m = await linkedBusiness('kebu');
  await emit('order.paid', m.b.id, { totalKori: 10 });
  reply = () => 302;
  const out = await pump();
  assert.equal(out.delivered, 0);
  assert.equal(got.length, 1, 'only the original request; the redirect target is never contacted');
});

test('unlinked AFTER fan-out → never sent (dead "unlinked"); a disabled subscription sends nothing', async () => {
  await disableAll();
  const s = await freshSub(KEBU, { event_types: ['order.paid'] });
  const m = await linkedBusiness('kebu');
  const e = await emit('order.paid', m.b.id, { totalKori: 10 });
  await PE.fanOutEvents(prisma);
  await prisma.externalLink.updateMany({ where: { jokkoId: m.b.id, system: 'kebu' }, data: { status: 'revoked', revokedAt: new Date() } });
  await PE.deliverDue(prisma);
  assert.equal(got.length, 0);
  assert.equal((await prisma.partnerEventDelivery.findFirst({ where: { eventId: e.id } })).lastError, 'unlinked');
  const dis = await api.client('POST', `v1/event-subscriptions/${s.id}/disable`, { ...as(KEBU), body: {} });
  assert.equal(dis.status, 200);
  const m2 = await linkedBusiness('kebu');
  await emit('order.paid', m2.b.id, { totalKori: 10 });
  await pump();
  assert.equal(got.length, 0);
});

test('concurrency + idempotency: repeated fan-outs never duplicate; two workers never send the same delivery twice', async () => {
  await disableAll();
  await freshSub(KEBU, { event_types: ['order.paid'] });
  const m = await linkedBusiness('kebu');
  const ids = [];
  for (let i = 0; i < 12; i += 1) ids.push((await emit('order.paid', m.b.id, { totalKori: i + 1 })).id);
  await Promise.all([PE.fanOutEvents(prisma), PE.fanOutEvents(prisma), PE.fanOutEvents(prisma)]);
  assert.equal(await prisma.partnerEventDelivery.count({ where: { eventId: { in: ids } } }), 12);
  await Promise.all([PE.deliverDue(prisma, { limit: 500 }), PE.deliverDue(prisma, { limit: 500 }), PE.deliverDue(prisma, { limit: 500 })]);
  const perEvent = new Map();
  for (const g of got) perEvent.set(g.headers['x-jokko-event-id'], (perEvent.get(g.headers['x-jokko-event-id']) ?? 0) + 1);
  assert.equal(perEvent.size, 12);
  assert.ok([...perEvent.values()].every((n) => n === 1), JSON.stringify([...perEvent.values()]));
});

test('a worker that died mid-send never loses the delivery: the claim lease expires and exactly one worker takes it over', async () => {
  await disableAll();
  await freshSub(KEBU, { event_types: ['order.paid'] });
  const m = await linkedBusiness('kebu');
  const e = await emit('order.paid', m.b.id, { totalKori: 10 });
  await PE.fanOutEvents(prisma);
  // Simulate the crash: the row is claimed ("sending") and its worker never comes back.
  const now = Date.now();
  await prisma.partnerEventDelivery.updateMany({ where: { eventId: e.id }, data: { status: 'sending', nextAttemptAt: new Date(now + PE.CLAIM_LEASE_MS) } });
  await PE.deliverDue(prisma, { now });
  assert.equal(got.length, 0, 'inside the lease nobody else sends it');
  const later = now + PE.CLAIM_LEASE_MS + 1000;
  await Promise.all([PE.deliverDue(prisma, { now: later }), PE.deliverDue(prisma, { now: later }), PE.deliverDue(prisma, { now: later })]);
  assert.equal(got.filter((g) => g.headers['x-jokko-event-id'] === e.id).length, 1, 'taken over by exactly one worker');
  assert.equal((await prisma.partnerEventDelivery.findFirst({ where: { eventId: e.id } })).status, 'delivered');
});

test('an event whose transaction commits after a later event was fanned out is still delivered (cursor trails by FANOUT_LAG_MS)', async () => {
  await disableAll();
  const s = await freshSub(KEBU, { event_types: ['order.paid'] });
  // The subscription predates both events (events before a subscription existed are never sent).
  await prisma.partnerEventSubscription.update({ where: { id: s.id }, data: { createdAt: new Date(Date.now() - 600_000) } });
  const m = await linkedBusiness('kebu');
  await emit('order.paid', m.b.id, { totalKori: 1 });
  await PE.fanOutEvents(prisma);
  // A row stamped 30 s ago becomes visible only now (long-running transaction committed late).
  const late = await emit('order.paid', m.b.id, { totalKori: 2 });
  await prisma.commerceEvent.update({ where: { id: late.id }, data: { createdAt: new Date(Date.now() - 30_000) } });
  await pump();
  assert.ok(got.some((g) => g.headers['x-jokko-event-id'] === late.id), 'late-committed event delivered');
  const sub = await prisma.partnerEventSubscription.findUnique({ where: { id: s.id } });
  assert.ok(!sub.fannedThrough || sub.fannedThrough.getTime() <= Date.now() - PE.FANOUT_LAG_MS + 1000, 'cursor trails now');
});

test('cross-partner isolation: another partner cannot see, rotate or disable my subscription, nor see my deliveries', async () => {
  await disableAll();
  const s = await freshSub(KEBU, { event_types: ['order.paid'] });
  assert.equal((await api.client('POST', `v1/event-subscriptions/${s.id}/rotate-secret`, { ...as(RECT), body: {} })).status, 404);
  assert.equal((await api.client('POST', `v1/event-subscriptions/${s.id}/disable`, { ...as(RECT), body: {} })).status, 404);
  const list = await api.client('GET', 'v1/event-subscriptions', as(RECT));
  assert.ok(!list.body.subscriptions.some((x) => x.id === s.id));
  const m = await linkedBusiness('kebu');
  await emit('order.paid', m.b.id, { totalKori: 10 });
  await pump();
  const theirs = await api.client('GET', 'v1/event-deliveries', as(RECT));
  assert.ok(!theirs.body.deliveries.some((x) => x.subscription_id === s.id));
  const mineList = await api.client('GET', 'v1/event-deliveries', as(KEBU));
  assert.ok(mineList.body.deliveries.some((x) => x.subscription_id === s.id));
  assert.equal((await api.client('GET', 'v1/event-subscriptions', { headers: {} })).status, 401);
});

test('30-day retention purges operational delivery logs only — events (and financial records) are kept', async () => {
  await disableAll();
  await freshSub(KEBU, { event_types: ['order.paid'] });
  const m = await linkedBusiness('kebu');
  const e = await emit('order.paid', m.b.id, { totalKori: 10 });
  await pump();
  await prisma.partnerEventDelivery.updateMany({ where: { eventId: e.id }, data: { createdAt: new Date(Date.now() - 31 * 24 * 3600_000) } });
  const r = await PE.purgeDeliveryLogs(prisma);
  assert.ok(r.purged >= 1);
  assert.equal(await prisma.partnerEventDelivery.count({ where: { eventId: e.id } }), 0);
  assert.ok(await prisma.commerceEvent.findUnique({ where: { id: e.id } }), 'the event itself is kept');
});
