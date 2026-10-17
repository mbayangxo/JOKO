/**
 * J10-S4: useful notifications. Categories, unread counts, mark-all, per-category mutes (money and
 * security never muted), dedupe of real events (inside a transaction that keeps working), and the
 * real J8 delivery / J9 work events reaching the right person — without leaking dispute reasons.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { runMoneyTransaction } from '../../lib/wallet-atomic.js';
import { createRequestInTx } from '../../lib/logistics/intake.js';
import { notifyEvent } from '../../lib/community/notify.js';
import { business, customer, operator, signedIn } from '../j3/helpers.js';
import { employer, hire, ok, worker } from '../j9/fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_WORK_MONEY_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

test('dedupe inside a transaction, categories, unread, mark-all, mutes (money / security never muted)', async () => {
  const c = await customer();
  const s = await signedIn(api, c);
  await prisma.$transaction(async (tx) => {
    await notifyEvent(tx, c.id, { category: 'community', title: 'Demande de contact', body: 'Awa veut te contacter', dedupeKey: 'friend-req:x1' });
    assert.equal(await notifyEvent(tx, c.id, { category: 'community', title: 'Demande de contact', body: 'Awa veut te contacter', dedupeKey: 'friend-req:x1' }), null, 'duplicate ignored');
    await tx.notification.count({ where: { userId: c.id } }); // the transaction is still usable after the conflict
  });
  await prisma.notification.create({ data: { userId: c.id, title: 'Argent reçu', body: '1 000 ₭', kind: 'money_receive' } }); // legacy row, no category
  const u = ok(await s.call('GET', 'notifications/unread'));
  assert.deepEqual([u.total, u.byCategory.community, u.byCategory.money], [2, 1, 1]);
  // Mute community (and try to mute money and security: ignored).
  const st = ok(await s.call('PUT', 'me/community-settings', { mutedCategories: ['community', 'money', 'security'] }));
  assert.deepEqual(st.mutedCategories, ['community']);
  assert.equal(ok(await s.call('GET', 'notifications/unread')).total, 1, 'muted categories are not counted');
  assert.equal(await notifyEvent(prisma, c.id, { category: 'community', title: 'x', body: 'y', dedupeKey: 'friend-req:x2' }), null, 'muted: not created');
  assert.ok(await notifyEvent(prisma, c.id, { category: 'security', title: 'Nouvel appareil', body: 'Connexion depuis un nouvel appareil', dedupeKey: 'sec:1' }), 'security always delivered');
  const feed = ok(await s.call('GET', 'notifications/feed?category=money'));
  assert.ok(feed.items.every((n) => n.category === 'money') && feed.items.length === 1);
  ok(await s.call('POST', 'notifications/read-all', { category: 'money' }));
  assert.equal(ok(await s.call('GET', 'notifications/unread')).byCategory.money, 0);
  assert.equal(ok(await s.call('GET', 'notifications/unread')).byCategory.security, 1, 'other categories untouched');
  // Another person cannot read or clear mine.
  const other = await signedIn(api, await customer());
  assert.equal(ok(await other.call('GET', 'notifications/feed')).items.length, 0);
  ok(await other.call('POST', 'notifications/read-all', {}));
  assert.equal(ok(await s.call('GET', 'notifications/unread')).byCategory.security, 1);
});

test('J9 work events reach the right person; the dispute notice never carries the reason', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const { assignment, offer } = await hire(api, e, w);
  const mine = (userId) => prisma.notification.findMany({ where: { userId, category: 'work' }, orderBy: { createdAt: 'asc' } });
  assert.ok((await mine(w.id)).some((n) => n.kind === 'work_offer' && n.refId === offer.id));
  ok(await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, content: 'Inventaire terminé.' }));
  const secret = 'Le travailleur a menti sur ses horaires (motif privé).';
  ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/disputes`, { kind: 'false_completion', milestoneSeq: 1, reason: secret }));
  const wn = await mine(w.id);
  const d = wn.find((n) => n.kind === 'work_dispute_opened');
  assert.ok(d, 'worker told a dispute is open');
  assert.ok(!d.body.includes('menti') && !d.title.includes('menti'), 'no reason text in the notice');
  assert.equal((await mine(e.ownerC.user.id)).filter((n) => n.kind === 'work_dispute_opened').length, 0, 'the opener is not notified of their own dispute');
});

test('J9 milestone accepted → worker notified once (even if accepted twice concurrently)', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const { assignment } = await hire(api, e, w);
  ok(await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, content: 'Livraison faite.' }));
  await Promise.all([1, 2].map(() => e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/accept`, { seq: 1 })));
  assert.equal(await prisma.notification.count({ where: { userId: w.id, kind: 'work_milestone_accepted' } }), 1);
});

test('J8: the parcel recipient is told when the parcel waits at the pickup point (once), nobody else is', async () => {
  const merchantC = await customer();
  const shop = await business(merchantC.user);
  const pointOwnerC = await customer();
  const pointOwner = await signedIn(api, pointOwnerC);
  const pointBiz = await business(pointOwnerC.user);
  const point = ok(await pointOwner.call('POST', `businesses/${pointBiz.id}/pickup-points`, { name: 'Relais Notif Médina', services: ['customer_pickup'] }));
  const comp = await operator(api, ['compliance']);
  ok(await comp.call('POST', `admin/pickup-points/${point.id}/decide`, { status: 'active', reason: 'visite effectuée' }));
  const buyerC = await customer();
  const { shipment } = await runMoneyTransaction(prisma, (tx) => createRequestInTx(tx, {
    sourceSystem: 'kabu', sourceId: `ord-n-${Date.now()}`, fulfilmentOwner: 'CUSTOMER_PICKUP', fulfillerBusinessId: shop.id, originBusinessId: shop.id,
    destinationUserId: buyerC.id, pickupPointId: point.id, lines: [], createdBy: merchantC.id,
  }));
  ok(await pointOwner.call('POST', `logistics/shipments/${shipment.id}/drop`, {}));
  await pointOwner.call('POST', `logistics/shipments/${shipment.id}/drop`, {}); // replay
  const n = await prisma.notification.findMany({ where: { userId: buyerC.id, category: 'deliveries' } });
  assert.equal(n.length, 1);
  assert.equal(n[0].kind, 'shipment_at_pickup_point');
  assert.equal(await prisma.notification.count({ where: { userId: pointOwnerC.id, category: 'deliveries' } }), 0);
});
