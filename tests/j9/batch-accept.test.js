/**
 * A6 / D42: a large employer validates many milestones in one request without tripping its own
 * account block, while abuse protection stays: the request counts once on the strict account-wide
 * limiter, every item counts on the work_accept budget (targeted 429, no security block), outsiders
 * are refused before any item, duplicates are refused (the worker-self check is acceptMilestone's, per item).
 * J2 + J9 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertWorkInvariants } from '../../lib/work/invariants.js';
import { employer, hire, ok, post, worker } from './fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_WORK_MONEY_ENABLED: 'true', RL_WORK_ACCEPT_PER_MIN: '30' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertWorkInvariants(prisma);
});

/** Setup traffic is not what is under test: start the measured minute clean. */
const freshMinute = (userId) => Promise.all([
  prisma.userRateLimit.deleteMany({ where: { userId } }),
  prisma.rateLimitBucket.deleteMany({ where: { key: { contains: userId } } }),
]);

async function submittedMany(e, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const w = await worker(api);
    const { assignment } = await hire(api, e, w, { opp: await post(e) });
    ok(await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, content: `Inventaire rayon ${i} terminé.` }));
    out.push({ w, assignmentId: assignment.id });
    if (i % 10 === 9) await freshMinute(e.ownerC.user.id);
  }
  return out;
}

test('one batch validates 25 milestones: counted once on the account limiter, 25 on the work_accept budget, no block', async () => {
  const e = await employer(api, { fund: 200_000 });
  const subs = await submittedMany(e, 25);
  const uid = e.ownerC.user.id;
  await freshMinute(uid);
  const r = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/milestones/accept-batch`, { items: subs.map((s) => ({ assignmentId: s.assignmentId, seq: 1 })) }));
  assert.deepEqual([r.accepted, r.failed], [25, 0]);
  assert.equal(await prisma.workEarning.count({ where: { assignmentId: { in: subs.map((s) => s.assignmentId) } } }), 25);
  const lim = await prisma.userRateLimit.findUnique({ where: { userId: uid } });
  assert.equal(lim.requestCount, 1, 'the whole batch is one request on the account-wide limiter');
  assert.equal(lim.blockedUntil, null);
  const bucket = await prisma.rateLimitBucket.findUnique({ where: { key: `user-work_accept:${uid}` } });
  assert.equal(bucket.count, 25, 'every item counts on the per-item budget');
  // Replay: already accepted items fail individually, money moves once.
  const again = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/milestones/accept-batch`, { items: subs.slice(0, 3).map((s) => ({ assignmentId: s.assignmentId, seq: 1 })) }));
  assert.equal(await prisma.workEarning.count({ where: { assignmentId: { in: subs.map((s) => s.assignmentId) } } }), 25, 'no double accrual');
  assert.equal(again.items.length, 3);
  // Budget (30/min in this test): the next batch of 5 exceeds it → targeted 429, NOT a security block.
  const over = await e.owner.call('POST', `businesses/${e.b.id}/work/milestones/accept-batch`, { items: subs.slice(3, 8).map((s) => ({ assignmentId: s.assignmentId, seq: 1 })) });
  assert.equal(over.status, 429);
  assert.equal((await prisma.userRateLimit.findUnique({ where: { userId: uid } })).blockedUntil, null, 'no account lockout');
  assert.equal((await e.owner.call('GET', `businesses/${e.b.id}/work/assignments`)).status, 200, 'the employer keeps working');
});

test('outsiders are refused before any item; cross-business ids fail per item; duplicates are refused; ≤ 50 items', async () => {
  const e = await employer(api);
  const [s] = await submittedMany(e, 1);
  const other = await employer(api);
  const out = await other.owner.call('POST', `businesses/${e.b.id}/work/milestones/accept-batch`, { items: [{ assignmentId: s.assignmentId, seq: 1 }] });
  assert.ok([403, 404].includes(out.status), `refused: ${out.status}`);
  assert.equal(await prisma.workEarning.count({ where: { assignmentId: s.assignmentId } }), 0);
  // The other employer cannot reach this assignment through its own business either.
  const cross = ok(await other.owner.call('POST', `businesses/${other.b.id}/work/milestones/accept-batch`, { items: [{ assignmentId: s.assignmentId, seq: 1 }] }));
  assert.deepEqual([cross.accepted, cross.items[0].status], [0, 404]);
  const dup = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/milestones/accept-batch`, { items: [{ assignmentId: s.assignmentId, seq: 1 }, { assignmentId: s.assignmentId, seq: 1 }] }));
  assert.deepEqual([dup.accepted, dup.items[1].error], [1, 'duplicate_item']);
  assert.equal(await prisma.workEarning.count({ where: { assignmentId: s.assignmentId } }), 1);
  // > 50 items: refused (the per-item budget is charged before the schema check, so 429 or 400).
  const big = await e.owner.call('POST', `businesses/${e.b.id}/work/milestones/accept-batch`, { items: Array.from({ length: 51 }, () => ({ assignmentId: s.assignmentId, seq: 1 })) });
  assert.ok([400, 429].includes(big.status), `refused: ${big.status}`);
});
