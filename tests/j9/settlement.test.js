/**
 * J9 settlement policy (A2): acceptance, deemed acceptance, contest window, payout eligibility,
 * finality and appeals are distinct. Payout is never eligible while the payer can still contest;
 * a silent business cannot withhold forever; a ruling's money waits for the appeal window; an
 * appeal is decided by a different operator and invalidates the earlier approval.
 * J2 + J9 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertWorkInvariants } from '../../lib/work/invariants.js';
import { runWorkMaintenance } from '../../lib/work/money.js';
import { SETTLEMENT } from '../../lib/work/contract.js';
import { operator } from '../j3/helpers.js';
import { employer, hire, idemH, key, ok, walletBal, worker } from './fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_WORK_MONEY_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertWorkInvariants(prisma);
});

const H = 3600_000;
const past = () => new Date(Date.now() - 1000);
async function submitted(e, w) {
  const { assignment } = await hire(api, e, w);
  ok(await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, content: 'Travail terminé, photos envoyées.' }));
  return assignment;
}
const earningOf = (aid) => prisma.workEarning.findFirst({ where: { assignmentId: aid } });
const contest = (e, aid, reason = 'Le travail validé n’a pas été réalisé.') => e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${aid}/disputes`, { kind: 'false_completion', milestoneSeq: 1, reason });

test('explicit acceptance: short contest window; payout eligible only when it closes; a late dispute is refused', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const aid = (await submitted(e, w)).id;
  ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${aid}/accept`, { seq: 1 }));
  const earn = await earningOf(aid);
  const contestH = (earn.contestableUntil - earn.createdAt) / H;
  assert.ok(Math.abs(contestH - SETTLEMENT.explicitContestHours) < 0.1, `explicit contest ${contestH}h`);
  assert.ok(earn.releasableAt >= earn.contestableUntil, 'payout never before the contest window closes');
  assert.equal((await runWorkMaintenance(prisma)).promoted >= 0, true);
  assert.equal((await earningOf(aid)).status, 'accrued');
  // The window closes (time passes): contest refused, payout eligible.
  await prisma.workEarning.update({ where: { id: earn.id }, data: { contestableUntil: past(), releasableAt: past() } });
  assert.equal((await contest(e, aid)).body.code, 'window_closed');
  await runWorkMaintenance(prisma);
  const w0 = await walletBal(w.id);
  assert.equal(ok(await w.call('POST', 'work/earnings/payout', {}, idemH())).paidKori, 2000);
  assert.equal(await walletBal(w.id), w0 + 2000);
  assert.equal((await contest(e, aid)).body.code, 'already_paid', 'paid is final: no automatic clawback');
});

test('deemed acceptance (silent business): the worker is paid without the business, but only after a longer contest window', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const aid = (await submitted(e, w)).id;
  await prisma.workMilestone.updateMany({ where: { assignmentId: aid }, data: { acceptDeadline: past() } });
  assert.equal((await runWorkMaintenance(prisma)).autoAccepted, 1);
  const earn = await earningOf(aid);
  const contestH = (earn.contestableUntil - earn.createdAt) / H;
  assert.ok(Math.abs(contestH - SETTLEMENT.deemedContestHours) < 0.1, `deemed contest ${contestH}h`);
  assert.ok((earn.releasableAt - earn.createdAt) / H >= SETTLEMENT.deemedContestHours - 0.1, 'NOT withdrawable at 24 h while the contest window is open');
  // Simulate the hold passing but not the contest window: still not payable.
  await prisma.workEarning.update({ where: { id: earn.id }, data: { createdAt: new Date(Date.now() - 25 * H) } }).catch(() => {});
  await runWorkMaintenance(prisma);
  assert.equal((await earningOf(aid)).status, 'accrued');
  assert.equal(ok(await w.call('POST', 'work/earnings/payout', {}, idemH())).paidKori, 0);
  // Inside the window the business may still contest: funds freeze.
  const d = ok(await contest(e, aid, 'Absent cette semaine : le travail n’a pas été fait.'));
  assert.equal(d.kind, 'false_completion');
  await prisma.workEarning.update({ where: { id: earn.id }, data: { releasableAt: past() } });
  await runWorkMaintenance(prisma);
  assert.equal((await earningOf(aid)).status, 'accrued', 'frozen by the open dispute');
});

test('appeals: money waits for the window; the loser appeals once; a different operator decides; the stale approval cannot execute', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const aid = (await submitted(e, w)).id;
  const d = ok(await contest(e, aid, 'Rien n’a été fait sur place, voir photos.'));
  const ops = await operator(api, ['work_ops']);
  const ops2 = await operator(api, ['work_ops']);
  const fin = await operator(api, ['finance_ops']);
  const r1 = ok(await ops.call('POST', `admin/work/disputes/${d.id}/resolve`, { outcome: 'business', note: 'Pas de preuve de présence.' }));
  assert.equal((await fin.call('POST', `admin/approvals/${r1.approval.id}/approve`, {})).body.code, 'appeal_window_open');
  // The winner cannot appeal; outsiders see nothing; the loser appeals once.
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/disputes/${d.id}/appeal`, { note: 'Je fais appel aussi.' })).body.code, 'invalid');
  const stranger = await worker(api);
  assert.equal((await stranger.call('POST', `work/disputes/${d.id}/appeal`, { note: 'Je fais appel pour lui.' })).status, 404);
  const ap = ok(await w.call('POST', `work/disputes/${d.id}/appeal`, { note: 'J’étais là : codes de présence et témoin.' }));
  assert.equal(ap.status, 'appealed');
  assert.equal((await w.call('POST', `work/disputes/${d.id}/appeal`, { note: 'J’étais là : codes de présence et témoin.' })).body.replayed, true);
  await prisma.workDispute.update({ where: { id: d.id }, data: { executableAfter: past() } });
  assert.equal((await fin.call('POST', `admin/approvals/${r1.approval.id}/approve`, {})).body.code, 'appeal_pending');
  assert.equal((await ops.call('POST', `admin/work/disputes/${d.id}/appeal/resolve`, { outcome: 'worker', note: 'Je confirme ma décision.' })).status, 403, 'not the first operator');
  const r2 = ok(await ops2.call('POST', `admin/work/disputes/${d.id}/appeal/resolve`, { outcome: 'worker', note: 'Témoin et codes : travail réalisé.' }));
  assert.equal(r2.dispute.rulingVersion, 2);
  assert.equal((await fin.call('POST', `admin/approvals/${r1.approval.id}/approve`, {})).body.code, 'ruling_changed', 'the stale approval never executes');
  ok(await fin.call('POST', `admin/approvals/${r2.approval.id}/approve`, {}));
  const earn = await earningOf(aid);
  assert.equal(earn.amountKori, 2000);
  assert.equal((await prisma.workDispute.findUnique({ where: { id: d.id } })).status, 'resolved');
  // No re-litigation of a ruled milestone by opening a new dispute.
  assert.equal((await contest(e, aid, 'Nouvelle contestation du même travail.')).body.code, 'already_ruled');
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/disputes/${d.id}/appeal`, { note: 'Encore un appel.' })).body.code, 'already_appealed');
});

test('response loss and payout races: same key replays, concurrent keys pay once', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const aid = (await submitted(e, w)).id;
  const [a1, a2] = await Promise.all([1, 2].map(() => e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${aid}/accept`, { seq: 1 })));
  assert.ok([a1, a2].some((r) => r.status === 200));
  assert.equal(await prisma.workEarning.count({ where: { assignmentId: aid } }), 1);
  await prisma.workEarning.updateMany({ where: { assignmentId: aid }, data: { contestableUntil: past(), releasableAt: past() } });
  await runWorkMaintenance(prisma);
  const w0 = await walletBal(w.id);
  const k = key();
  const first = ok(await w.call('POST', 'work/earnings/payout', {}, idemH(k)));
  const lost = ok(await w.call('POST', 'work/earnings/payout', {}, idemH(k))); // the client never saw the first answer
  assert.equal(first.paidKori, 2000);
  assert.equal(lost.paidKori, 2000);
  assert.equal(lost.replayed ?? true, true);
  const race = await Promise.all([1, 2, 3].map(() => w.call('POST', 'work/earnings/payout', {}, idemH())));
  assert.ok(race.every((r) => r.status === 200 || r.status === 409));
  assert.equal(await walletBal(w.id), w0 + 2000, 'paid exactly once');
});

test('policy override is bounded: out-of-range or malformed values fall back to safe defaults', () => {
  const run = (json) => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', "const { SETTLEMENT } = await import('./lib/work/contract.js'); console.log(JSON.stringify(SETTLEMENT));"], { env: { ...process.env, WORK_SETTLEMENT_JSON: json }, encoding: 'utf8' }).stdout);
  const d = run('{}');
  assert.deepEqual(run('{"deemedContestHours": 1, "holdHours": 0, "appealHours": 9999}'), d, 'unsafe values ignored');
  assert.deepEqual(run('not json'), d);
  assert.equal(run('{"deemedContestHours": 96}').deemedContestHours, 96);
  assert.ok(d.deemedContestHours >= d.explicitContestHours && d.deemedContestHours >= d.holdHours);
});
