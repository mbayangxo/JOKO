/**
 * J9 load (local): 6 employers × 10 workers run the whole paid-work lifecycle concurrently over
 * HTTP — applications, funded offers, acceptance storms (every accept sent twice), evidence,
 * milestone-acceptance storms, payout storms (same key twice + a second key). Money must be
 * conserved exactly: what the employers escrowed = what the workers received; nothing twice.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertWorkInvariants } from '../../lib/work/invariants.js';
import { runWorkMaintenance } from '../../lib/work/money.js';
import { stepUp } from '../j3/helpers.js';
import { bizBal, employer, key, ok, post, walletBal, worker } from '../j9/fixture.js';

const EMPLOYERS = 6;
const PER = 10;
const RATE = 2000;
let api;
before(async () => { api = await startApiServer({ JOKKO_WORK_MONEY_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

const timed = async (fn) => {
  const t = Date.now();
  const r = await fn();
  return { r, ms: Date.now() - t };
};
const p95 = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.95) - 1] ?? xs[xs.length - 1];

test(`${EMPLOYERS} employers × ${PER} workers: full paid lifecycle under concurrency, money conserved exactly`, async () => {
  const emps = await Promise.all(Array.from({ length: EMPLOYERS }, () => employer(api, { fund: PER * RATE + 5000 })));
  const lat = [];
  const groups = [];
  for (const e of emps) {
    const opp = await post(e, { headcount: PER, title: `Inventaire charge ${e.b.id.slice(-4)}` });
    const ws = await Promise.all(Array.from({ length: PER }, () => worker(api)));
    groups.push({ e, opp, ws, token: await stepUp(e.owner) });
  }
  const bizBefore = await Promise.all(emps.map((e) => bizBal(e.b.id)));
  const walletsBefore = new Map();
  for (const g of groups) for (const w of g.ws) walletsBefore.set(w.id, await walletBal(w.id));

  // 1. Applications (all 60 at once).
  const apps = await Promise.all(groups.flatMap((g) => g.ws.map(async (w) => {
    const { r, ms } = await timed(() => w.call('POST', `work/opportunities/${g.opp.id}/apply`, {}));
    lat.push(ms);
    return { g, w, app: ok(r, 'apply') };
  })));
  // 2. Funded offers (each employer 10 in parallel; all employers at once).
  const offers = await Promise.all(apps.map(async ({ g, w, app }) => {
    const { r, ms } = await timed(() => g.e.owner.call('POST', `businesses/${g.e.b.id}/work/offers`, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter et saisir le stock du rayon.' }, { headers: { 'idempotency-key': key(), 'x-step-up-token': g.token } }));
    lat.push(ms);
    return { g, w, offer: ok(r, 'offer') };
  }));
  for (const [i, e] of emps.entries()) assert.equal(await bizBal(e.b.id), bizBefore[i] - PER * RATE, 'escrowed once per offer');
  // 3. Acceptance storm: every accept sent twice concurrently.
  const accepted = await Promise.all(offers.map(async ({ g, w, offer }) => {
    const [a, b] = await Promise.all([1, 2].map(() => w.call('POST', `work/offers/${offer.id}/accept`, { termsHash: offer.termsHash })));
    assert.ok([a, b].every((r) => r.status === 200), `accept ${a.status}/${b.status} ${JSON.stringify(a.body.code ?? b.body.code)}`);
    return { g, w, aid: a.body.id };
  }));
  assert.equal(await prisma.workAssignment.count({ where: { opportunityId: { in: groups.map((g) => g.opp.id) } } }), EMPLOYERS * PER);
  // 4. Evidence.
  await Promise.all(accepted.map(({ w, aid }) => w.call('POST', `work/assignments/${aid}/submit`, { seq: 1, content: 'Inventaire terminé et signé.' }).then((r) => ok(r, 'submit'))));
  // 5. Milestone-acceptance storm (each sent twice).
  await Promise.all(accepted.map(async ({ g, aid }) => {
    const rs = await Promise.all([1, 2].map(() => timed(() => g.e.owner.call('POST', `businesses/${g.e.b.id}/work/assignments/${aid}/accept`, { seq: 1 }))));
    for (const { r, ms } of rs) {
      lat.push(ms);
      assert.ok(r.status === 200 || r.body.code === 'invalid_state', `${r.status} ${JSON.stringify(r.body)}`);
    }
  }));
  assert.equal(await prisma.workEarning.count({ where: { assignmentId: { in: accepted.map((a) => a.aid) } } }), EMPLOYERS * PER, 'exactly one earning per milestone');
  // 6. Hold passes; payout storm (same key twice + another key).
  await prisma.workEarning.updateMany({ where: { assignmentId: { in: accepted.map((a) => a.aid) } }, data: { releasableAt: new Date(Date.now() - 1000) } });
  await runWorkMaintenance(prisma);
  await Promise.all(accepted.map(async ({ w }) => {
    const k = key();
    await Promise.all([w.call('POST', 'work/earnings/payout', {}, { headers: { 'idempotency-key': k } }), w.call('POST', 'work/earnings/payout', {}, { headers: { 'idempotency-key': k } }), w.call('POST', 'work/earnings/payout', {}, { headers: { 'idempotency-key': key() } })]);
  }));
  for (const { w } of accepted) assert.equal(await walletBal(w.id), walletsBefore.get(w.id) + RATE, 'paid exactly once');
  const paid = await prisma.workEarning.count({ where: { assignmentId: { in: accepted.map((a) => a.aid) }, status: 'paid' } });
  assert.equal(paid, EMPLOYERS * PER);
  await assertInvariants(prisma);
  await assertWorkInvariants(prisma);
  process.stdout.write(`# j9-load requests=${lat.length} p95_ms=${p95([...lat])} max_ms=${Math.max(...lat)}\n`);
});
