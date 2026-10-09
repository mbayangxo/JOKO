/**
 * J10-S1 Aujourd'hui: built only from the person's own real objects (money requests, work offers,
 * school fees, tickets, connection requests, open work), prioritized, honest when empty, never
 * showing someone else's items, and cheap to re-poll (ETag → 304).
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { business, customer, signedIn } from '../j3/helpers.js';
import { employer, ok, post, withStepUp, worker } from '../j9/fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_WORK_MONEY_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
const tag = () => crypto.randomBytes(4).toString('hex');

test('a new person gets an honest empty state — nothing invented', async () => {
  const s = await signedIn(api, await customer());
  const t = ok(await s.call('GET', 'me/today'));
  assert.deepEqual([t.empty, t.items.length], [true, 0]);
});

test('real items from several sources, prioritized; nobody else sees them; ETag 304 when unchanged', async () => {
  const w = await worker(api);
  const requester = await customer();
  await prisma.moneyRequest.create({ data: { requesterId: requester.id, payerId: w.id, amount: 2500, reference: `MR-${tag()}` } });
  await prisma.friendRequest.create({ data: { fromId: requester.id, toId: w.id } });
  // A real work offer from a verified employer.
  const e = await employer(api);
  const opp = await post(e);
  const app = ok(await w.call('POST', `work/opportunities/${opp.id}/apply`, { note: 'Disponible' }));
  ok(await e.owner.call('POST', `businesses/${e.b.id}/work/offers`, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter le stock du rayon épicerie.' }, await withStepUp(e.owner)));
  // A school fee due for the person's child, and an upcoming event ticket.
  const schoolOwner = await customer();
  const school = await business(schoolOwner.user);
  const student = await prisma.schoolStudent.create({ data: { businessId: school.id, studentName: 'Fatou', parentUserId: w.id } });
  const period = await prisma.schoolFeePeriod.create({ data: { businessId: school.id, label: 'Novembre', amount: 15000, dueDate: new Date(Date.now() - 86_400_000) } });
  await prisma.schoolFeePayment.create({ data: { periodId: period.id, studentId: student.id, parentUserId: w.id, amount: 15000 } });
  const ev = await prisma.event.create({ data: { promoterId: schoolOwner.id, title: 'Kermesse de l’école', startsAt: new Date(Date.now() + 3 * 86_400_000), ticketPrice: 500 } });
  await prisma.ticket.create({ data: { eventId: ev.id, buyerId: w.id, quantity: 2, amount: 1000 } });

  const r = await w.call('GET', 'me/today');
  const t = ok(r);
  const types = t.items.map((i) => i.type);
  for (const x of ['money_request', 'work_offer', 'school_fee', 'connection_requests', 'ticket']) assert.ok(types.includes(x), `${x} in ${types}`);
  assert.equal(t.empty, false);
  // Priority: things that need action now come first; tickets last.
  assert.ok(types.indexOf('money_request') < types.indexOf('ticket') && types.indexOf('school_fee') < types.indexOf('ticket'));
  assert.ok(t.items.find((i) => i.type === 'school_fee').title.includes('Fatou'));
  // Isolation: the requester sees none of it.
  const rs = await signedIn(api, requester);
  assert.ok(!ok(await rs.call('GET', 'me/today')).items.some((i) => ['school_fee', 'work_offer', 'ticket'].includes(i.type)));
  // Low bandwidth: unchanged → 304 with no body.
  const etag = r.headers.etag;
  assert.ok(etag);
  assert.equal((await w.call('GET', 'me/today', undefined, { headers: { 'if-none-match': etag } })).status, 304);
  // Read-only: polling changed nothing.
  assert.equal(await prisma.moneyRequest.count({ where: { payerId: w.id, status: 'pending' } }), 1);
});
