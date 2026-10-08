/**
 * D42 — role/action-aware rate limiting. A depot doing legitimate high-volume
 * dispatch is never locked out of its account; abuse is still stopped, with a
 * TARGETED response (429 on that action class), and money / credential / unknown
 * routes keep the strict account-wide limiter.
 * Test budgets (server env): dispatch 100/min, custody codes 10/min.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { actionClass } from '../../lib/rate-limit.js';
import { fleetDriver, readyPo, shipmentFor } from './fixture.js';
import { merchant, submit } from '../j7/fixture.js';

let api;
before(async () => { api = await startApiServer({ RL_DISPATCH_PER_MIN: '100', RL_CUSTODY_PER_MIN: '10' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
});

async function tracked() {
  const x = await readyPo(api, { packs: 1 });
  await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true });
  const sh = await shipmentFor(x.po.id);
  const d = await fleetDriver(api, x.sup.b);
  await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: d.id });
  await prisma.userRateLimit.deleteMany({ where: { userId: x.sup.owner.id } });
  await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: x.sup.owner.id } } });
  return { ...x, sh, d };
}
const blocked = async (userId) => {
  const s = await prisma.userRateLimit.findUnique({ where: { userId } });
  return Boolean(s?.blockedUntil && s.blockedUntil > new Date());
};

test('classification: money and credential routes stay in the strict default class', () => {
  assert.equal(actionClass('POST transfers/send'), 'default');
  assert.equal(actionClass('POST auth/pin/verify'), 'default');
  assert.equal(actionClass('POST businesses/:id/b2b/purchase-orders/:subId/pay'), 'default');
  assert.equal(actionClass('POST logistics/earnings/payout'), 'default');
  assert.equal(actionClass('POST logistics/shipments/:id/codes'), 'dispatch');
  assert.equal(actionClass('POST logistics/shipments/:id/deliver'), 'custody');
  assert.equal(actionClass('GET logistics/shipments/:id'), 'read');
  assert.equal(actionClass(undefined), 'default');
});

test('peak dispatch: 90 legitimate dispatch actions in one minute (above the old 80 lock) → no account block; the money side still works', async () => {
  const x = await tracked();
  const rs = [];
  for (let i = 0; i < 90; i += 1) rs.push(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.filter((r) => r.status !== 201).slice(0, 2).map((r) => r.body)));
  assert.equal(await blocked(x.sup.owner.id), false, 'no 15-minute account lockout from normal dispatch');
  // A strict-class action still goes through (the account was never flagged).
  const r = await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/os/catalog`, { title: 'Article test', priceKori: 10 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // 40 concurrent dispatch actions: all counted, none lost, no block.
  const par = await Promise.all(Array.from({ length: 9 }, () => x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' })));
  assert.ok(par.every((p) => p.status === 201));
  assert.equal(await blocked(x.sup.owner.id), false);
});

test('dispatch over budget → targeted 429 for dispatch only; no account block; other classes unaffected', async () => {
  const x = await tracked();
  let first429 = null;
  for (let i = 0; i < 105; i += 1) {
    const r = await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' });
    if (r.status === 429 && first429 === null) first429 = i;
  }
  assert.equal(first429, 100, 'the 101st dispatch action in the minute is refused');
  assert.equal(await blocked(x.sup.owner.id), false);
  assert.equal((await x.sup.owner.call('GET', `logistics/shipments/${x.sh.id}`)).status, 200, 'reads still work');
  assert.equal((await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/os/catalog`, { title: 'Article test', priceKori: 10 })).status, 201, 'strict class still works');
});

test('custody-code guessing has its own tight budget (and each code still locks after 5 misses)', async () => {
  const x = await tracked();
  await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: x.d.id } } });
  const statuses = [];
  for (let i = 0; i < 12; i += 1) statuses.push((await x.d.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: `WRONG${String(i).padStart(3, '0')}` })).status);
  assert.deepEqual(statuses.slice(0, 5), [409, 409, 409, 409, 409]);
  assert.ok(statuses.slice(5, 10).every((s) => s === 409 || s === 423), JSON.stringify(statuses));
  assert.deepEqual(statuses.slice(10), [429, 429], 'over 10 code entries per minute → 429');
  assert.equal(await blocked(x.d.id), false);
});

test('default-class abuse still earns the account-wide block, and the block applies to dispatch too', async () => {
  const x = await tracked();
  let blockAt = null;
  for (let i = 0; i < 85; i += 1) {
    const r = await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/os/catalog`, { title: `Spam ${i}`, priceKori: 1 });
    if (r.body?.code === 'security_block') { blockAt = i; break; }
  }
  assert.ok(blockAt !== null && blockAt >= 78, `blocked at ${blockAt}`);
  const d = await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' });
  assert.equal(d.body.code, 'security_block');
});

test('batches: codes for a load and PO accepts — per-item authorization, size cap, items counted against the budget', async () => {
  const a = await tracked();
  const b = await tracked(); // a foreign shipment (another distributor)
  const r = await a.sup.owner.call('POST', 'logistics/shipments/batch/codes', { shipmentIds: [a.sh.id, b.sh.id], purpose: 'pickup' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mine = r.body.items.find((i) => i.shipmentId === a.sh.id);
  const foreign = r.body.items.find((i) => i.shipmentId === b.sh.id);
  assert.equal(mine.code.length, 8);
  assert.equal(foreign.error, 'not_found', 'another distributor’s shipment in my batch is refused, nothing leaks');
  assert.equal(foreign.code, undefined);
  assert.equal((await a.sup.owner.call('POST', 'logistics/shipments/batch/codes', { shipmentIds: Array.from({ length: 61 }, (_, i) => `x${i}`), purpose: 'pickup' })).status, 400);
  // 60 items count as 60: two such batches exceed the 100/min test budget.
  await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: a.sup.owner.id } } });
  const ids = Array.from({ length: 60 }, () => a.sh.id);
  assert.equal((await a.sup.owner.call('POST', 'logistics/shipments/batch/codes', { shipmentIds: ids, purpose: 'pickup' })).status, 200);
  assert.equal((await a.sup.owner.call('POST', 'logistics/shipments/batch/codes', { shipmentIds: ids, purpose: 'pickup' })).status, 429);
  // PO batch: accept several of my own orders; a foreign order fails alone.
  const m1 = await merchant(api, a.sup);
  const m2 = await merchant(api, a.sup);
  const p1 = (await submit(m1, a.sup, { packs: 1 })).body;
  const p2 = (await submit(m2, a.sup, { packs: 1 })).body;
  const fm = await merchant(api, b.sup);
  const pf = (await submit(fm, b.sup, { packs: 1 })).body;
  await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: a.sup.owner.id } } });
  const br = await a.sup.owner.call('POST', `businesses/${a.sup.b.id}/b2b/purchase-orders/batch`, { items: [p1, p2, pf].map((p) => ({ poId: p.id, action: 'accept' })) });
  assert.equal(br.status, 200, JSON.stringify(br.body));
  assert.deepEqual(br.body.items.map((i) => i.error ?? i.status), ['accepted', 'accepted', 'not_found']);
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: pf.id } })).status, 'submitted', 'foreign order untouched');
});
