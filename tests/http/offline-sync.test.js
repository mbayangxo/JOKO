/**
 * Offline sync (Phase 17) — real HTTP, NODE_ENV=production.
 * Queue items are idempotent per user; clientIds can't be hijacked across
 * users or businesses; malformed/forbidden items are rejected per item,
 * never a 500; no phone numbers come back.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { createUserWithWallet, createVerifiedDevice, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

async function actor() {
  const user = await createUserWithWallet({ tier: 2 });
  const device = await createVerifiedDevice(user.id);
  return { user, id: user.id, handle: user.handle, device, token: jwt.sign({ sub: user.id, type: 'access' }, ACCESS_SECRET), ip: freshIp() };
}
const call = (m, p, a, body) => api.client(m, p, { token: a.token, device: a.device, ip: a.ip, headers: { 'x-vercel-ip-country': 'SN' }, body });
const coop = async (owner) => (await call('POST', 'businesses', owner, { name: `Coop ${crypto.randomBytes(3).toString('hex')}`, type: 'merchant' })).body;
const item = (clientId, businessId, extra = {}) => ({
  clientId,
  entityType: 'farmer_delivery',
  payload: { businessId, quantityTons: 1.5, periodStart: '2026-09-01', periodEnd: '2026-09-30', ...extra },
});

test('replay is idempotent; another user cannot reuse (or overwrite) my clientId', async () => {
  const a = await actor();
  const b = await actor();
  const bizA = await coop(a);
  const bizB = await coop(b);
  const cid = `off-${crypto.randomBytes(8).toString('hex')}`;

  const first = await call('POST', 'offline/sync', a, { items: [item(cid, bizA.id)] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.synced[0].status, 'synced');
  const again = await call('POST', 'offline/sync', a, { items: [item(cid, bizA.id)] });
  assert.equal(again.body.synced[0].status, 'already_synced');
  assert.equal(await prisma.farmerDeliveryLog.count({ where: { offlineClientId: cid } }), 1);

  const hijack = await call('POST', 'offline/sync', b, { items: [item(cid, bizB.id, { quantityTons: 999 })] });
  assert.equal(hijack.status, 200);
  assert.equal(hijack.body.synced[0].status, 'rejected');
  assert.equal(hijack.body.synced[0].code, 'client_id_conflict');
  const q = await prisma.offlineSyncQueue.findUnique({ where: { clientId: cid } });
  assert.equal(q.userId, a.id);
  assert.ok(!q.payload.includes('999'), 'payload not overwritten');

  // The online endpoint can't fetch A's log through B's business either.
  const online = await call('POST', `businesses/${bizB.id}/cooperative/deliveries`, b, {
    farmerUserId: b.id, quantityTons: 1, periodStart: '2026-09-01', periodEnd: '2026-09-30', offlineClientId: cid,
  });
  assert.equal(online.status, 409);
  assert.ok(!JSON.stringify(online.body).includes(bizA.id));
});

test('non-member, malformed and oversized items are rejected per item — never a 500', async () => {
  const a = await actor();
  const outsider = await actor();
  const bizA = await coop(a);
  const r = await call('POST', 'offline/sync', outsider, {
    items: [
      item(`off-${crypto.randomBytes(8).toString('hex')}`, bizA.id),
      item(`off-${crypto.randomBytes(8).toString('hex')}`, bizA.id, { quantityTons: -5 }),
      item(`off-${crypto.randomBytes(8).toString('hex')}`, bizA.id, { periodStart: 'not-a-date' }),
      item(`off-${crypto.randomBytes(8).toString('hex')}`, bizA.id, { note: 'x'.repeat(9000) }),
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.synced.map((s) => s.code), ['forbidden', 'invalid_payload', 'invalid_payload', 'payload_too_large']);
  assert.equal(await prisma.farmerDeliveryLog.count({ where: { businessId: bizA.id } }), 0);
  assert.equal((await call('POST', 'offline/sync', a, { items: Array.from({ length: 101 }, (_, i) => item(`bulk-${i}-${crypto.randomBytes(4).toString('hex')}`, bizA.id)) })).status, 400);
});

test('logging a delivery against any handle never reveals that person’s phone', async () => {
  const owner = await actor();
  const stranger = await actor();
  const biz = await coop(owner);
  const r = await call('POST', `businesses/${biz.id}/cooperative/deliveries`, owner, {
    farmerHandle: stranger.handle, quantityTons: 1, periodStart: '2026-09-01', periodEnd: '2026-09-30',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(!JSON.stringify(r.body).includes(stranger.user.phone));
});
