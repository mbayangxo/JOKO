/**
 * J9 core lifecycle over HTTP: opportunity → apply → funded offer → acceptance → evidence →
 * acceptance / auto-accept → hold → payout; refunds; employment vs contract; minors; review;
 * self-dealing; concurrency; retries. J2 + J9 (W1–W7) invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertWorkInvariants, checkWorkInvariants } from '../../lib/work/invariants.js';
import { runWorkMaintenance } from '../../lib/work/money.js';
import { createOffer } from '../../lib/work/service.js';
import { customer, operator, signedIn } from '../j3/helpers.js';
import { GIG, bizBal, employer, hire, idemH, key, ok, post, walletBal, withStepUp, worker } from './fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_WORK_MONEY_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertWorkInvariants(prisma);
});

const escrowOf = async (offerId) => Number((await prisma.ledgerAccount.findUnique({ where: { code: `escrow:work:${offerId}` } }))?.balance ?? 0);
const makeReleasable = (assignmentId) => prisma.workEarning.updateMany({ where: { assignmentId }, data: { releasableAt: new Date(Date.now() - 1000) } });
const payout = (w) => w.call('POST', 'work/earnings/payout', {}, idemH());

test('gig end to end: funded before acceptance, evidence, business acceptance, hold, payout once', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const before = await bizBal(e.b.id);
  const opp = await post(e);
  assert.equal(opp.status, 'open');
  const disc = ok(await w.call('GET', 'work/opportunities?area=pikine'));
  assert.ok(disc.items.some((o) => o.id === opp.id && o.business.verified));
  const { offer, assignment } = await hire(api, e, w, { opp });
  assert.equal(offer.fundingStatus, 'held');
  assert.equal(await bizBal(e.b.id), before - 2000, 'escrowed when the offer was sent');
  assert.equal(await escrowOf(offer.id), 2000);
  assert.equal(assignment.status, 'active');
  assert.equal(assignment.terms.classification, 'contractor_payment');
  // Evidence is required; the business cannot accept before submission.
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/accept`, { seq: 1 })).body.code, 'invalid_state');
  assert.equal((await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, content: '' })).status, 400);
  ok(await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, kind: 'note', content: 'Inventaire saisi : 214 références.' }));
  assert.equal((await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, kind: 'note', content: 'Inventaire saisi : 214 références.' })).body.replayed, true);
  const acc = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/accept`, { seq: 1 }));
  assert.equal(acc.status, 'completed');
  assert.equal(acc.earnings[0].status, 'accrued');
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/accept`, { seq: 1 })).body.replayed, true);
  // On hold: nothing payable yet.
  assert.equal(ok(await payout(w)).paidKori, 0);
  await makeReleasable(assignment.id);
  await runWorkMaintenance(prisma);
  const w0 = await walletBal(w.id);
  const p = ok(await payout(w));
  assert.equal(p.paidKori, 2000);
  assert.equal(await walletBal(w.id), w0 + 2000);
  assert.equal(ok(await payout(w)).paidKori, 0, 'never twice');
  assert.equal(await escrowOf(offer.id), 0);
  const earn = ok(await w.call('GET', 'work/earnings'));
  assert.equal(earn.totals.paidKori, 2000);
});

test('no unfunded paid work: money flag off refuses prepaid offers; insufficient funds create nothing', async () => {
  const e = await employer(api, { fund: 1000 });
  const w = await worker(api);
  const opp = await post(e);
  const app = ok(await w.call('POST', `work/opportunities/${opp.id}/apply`, {}));
  // This test process has JOKKO_WORK_MONEY_ENABLED unset (production default): refused in-process.
  await assert.rejects(createOffer(e.owner.id, e.b.id, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter le stock du rayon.' }), (err) => err.code === 'work_money_not_activated');
  // Prepaid offers move business money: step-up required.
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/offers`, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter le stock du rayon.' })).status, 403);
  // Over HTTP (flag on in the server) but the business cannot fund it.
  const r = await e.owner.call('POST', `businesses/${e.b.id}/work/offers`, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter le stock du rayon.' }, await withStepUp(e.owner));
  assert.equal(r.body.code, 'insufficient', JSON.stringify(r.body));
  assert.equal(await prisma.workOffer.count({ where: { applicationId: app.id } }), 0, 'atomic: no offer without funding');
  assert.equal(await bizBal(e.b.id), 1000);
});

test('decline, withdraw and expiry refund the escrow exactly once; acceptance needs the exact terms', async () => {
  const e = await employer(api);
  const before = await bizBal(e.b.id);
  const mk = async () => {
    const w = await worker(api);
    const opp = await post(e, { headcount: 3 });
    const app = ok(await w.call('POST', `work/opportunities/${opp.id}/apply`, {}));
    const of = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/offers`, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter le stock du rayon.' }, await withStepUp(e.owner)));
    return { w, of };
  };
  const a = await mk();
  assert.equal((await a.w.call('POST', `work/offers/${a.of.id}/accept`, { termsHash: 'f'.repeat(64) })).body.code, 'terms_changed');
  ok(await a.w.call('POST', `work/offers/${a.of.id}/decline`, {}));
  assert.equal((await a.w.call('POST', `work/offers/${a.of.id}/decline`, {})).body.replayed, true);
  assert.equal((await a.w.call('POST', `work/offers/${a.of.id}/accept`, { termsHash: a.of.termsHash })).body.code, 'invalid_state');
  const b = await mk();
  ok(await e.owner.call('POST', `businesses/${e.b.id}/work/offers/${b.of.id}/withdraw`, {}));
  const c = await mk();
  await prisma.workOffer.update({ where: { id: c.of.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await c.w.call('POST', `work/offers/${c.of.id}/accept`, { termsHash: c.of.termsHash })).body.code, 'offer_expired');
  const m = await runWorkMaintenance(prisma);
  assert.ok(m.offersExpired >= 1);
  assert.equal(await bizBal(e.b.id), before, 'every escrow came back, once');
  for (const x of [a, b, c]) assert.equal(await escrowOf(x.of.id), 0);
});

test('auto-accept: a business that neither accepts nor disputes in the agreed window cannot withhold payment', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const { assignment } = await hire(api, e, w, { offer: { acceptanceWindowHours: 24 } });
  ok(await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, content: 'Travail livré et photographié.' }));
  assert.equal((await runWorkMaintenance(prisma)).autoAccepted, 0, 'not before the deadline');
  await prisma.workMilestone.updateMany({ where: { assignmentId: assignment.id }, data: { acceptDeadline: new Date(Date.now() - 1000) } });
  const m = await runWorkMaintenance(prisma);
  assert.equal(m.autoAccepted, 1);
  const a = ok(await w.call('GET', `work/assignments/${assignment.id}`));
  assert.equal(a.milestones[0].acceptedBy, 'auto');
  assert.equal(a.earnings.length, 1);
});

test('concurrency: parallel accepts, milestone accepts and payouts never duplicate', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const opp = await post(e);
  const app = ok(await w.call('POST', `work/opportunities/${opp.id}/apply`, {}));
  const of = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/offers`, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter le stock du rayon.' }, await withStepUp(e.owner)));
  const acc = await Promise.all(Array.from({ length: 5 }, () => w.call('POST', `work/offers/${of.id}/accept`, { termsHash: of.termsHash })));
  assert.ok(acc.every((r) => r.status === 200), JSON.stringify(acc.map((r) => r.body.code)));
  assert.equal(await prisma.workAssignment.count({ where: { offerId: of.id } }), 1);
  const aid = acc[0].body.id;
  ok(await w.call('POST', `work/assignments/${aid}/submit`, { seq: 1, content: 'Inventaire terminé.' }));
  const ms = await Promise.all(Array.from({ length: 5 }, () => e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${aid}/accept`, { seq: 1 })));
  assert.ok(ms.every((r) => r.status === 200 || r.body.code === 'invalid_state'), JSON.stringify(ms.map((r) => r.body.code)));
  assert.equal(await prisma.workEarning.count({ where: { assignmentId: aid } }), 1);
  await makeReleasable(aid);
  await runWorkMaintenance(prisma);
  const w0 = await walletBal(w.id);
  const k = key();
  const pays = await Promise.all(Array.from({ length: 4 }, () => w.call('POST', 'work/earnings/payout', {}, idemH(k))));
  assert.ok(pays.some((r) => r.status === 200));
  const pays2 = await Promise.all(Array.from({ length: 3 }, () => payout(w)));
  assert.ok(pays2.every((r) => r.status === 200 || r.status === 409));
  assert.equal(await walletBal(w.id), w0 + 2000, 'paid exactly once');
});

test('attendance needs the business’s single-use code: no fabricated attendance, brute force locked', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const opp = await post(e, { type: 'staffing', title: 'Renfort caisse samedi', description: 'Tenir la caisse le samedi de 9h à 17h au magasin.' });
  const { assignment } = await hire(api, e, w, { opp, offer: { evidenceRequired: 'attendance', schedule: 'samedi 9h–17h' } });
  assert.equal((await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, content: 'J’ai travaillé samedi.' })).body.code, 'attendance_required');
  assert.equal((await w.call('POST', `work/assignments/${assignment.id}/attendance`, { purpose: 'checkin', code: 'ABCDEFGH' })).body.code, 'code_invalid');
  const c = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/attendance-code`, { purpose: 'checkin' }));
  for (let i = 0; i < 5; i += 1) assert.equal((await w.call('POST', `work/assignments/${assignment.id}/attendance`, { purpose: 'checkin', code: 'ZZZZZZZZ' })).body.code, 'code_invalid');
  assert.equal((await w.call('POST', `work/assignments/${assignment.id}/attendance`, { purpose: 'checkin', code: c.code })).body.code, 'code_locked');
  const c2 = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/attendance-code`, { purpose: 'checkin' }));
  ok(await w.call('POST', `work/assignments/${assignment.id}/attendance`, { purpose: 'checkin', code: c2.code }));
  assert.equal((await w.call('POST', `work/assignments/${assignment.id}/attendance`, { purpose: 'checkin', code: c2.code })).body.replayed, true);
  // After check-in the business cannot unilaterally cancel (would take back wages for attended work).
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/end`, { reason: 'plus besoin' })).body.code, 'work_in_progress');
  const c3 = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/attendance-code`, { purpose: 'checkout' }));
  ok(await w.call('POST', `work/assignments/${assignment.id}/attendance`, { purpose: 'checkout', code: c3.code }));
  ok(await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, kind: 'attendance', content: 'Présence confirmée par codes.' }));
});

test('ending before work refunds unearned escrow; the worker can withdraw too', async () => {
  const e = await employer(api);
  const before = await bizBal(e.b.id);
  const w = await worker(api);
  const { assignment, offer } = await hire(api, e, w, { offer: { milestones: [{ title: 'Jour 1', amountKori: 1000 }, { title: 'Jour 2', amountKori: 1500 }] } });
  assert.equal(await bizBal(e.b.id), before - 2500);
  const r = ok(await w.call('POST', `work/assignments/${assignment.id}/end`, { reason: 'empêchement' }));
  assert.equal(r.status, 'cancelled');
  assert.equal(await bizBal(e.b.id), before);
  assert.equal(await escrowOf(offer.id), 0);
});

test('employment is not contract work: wage via payroll (obligation recorded, nothing escrowed, no J9 earnings); job-like contracts refused', async () => {
  const e = await employer(api);
  const before = await bizBal(e.b.id);
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/opportunities`, { ...GIG, type: 'staffing', title: 'Vendeur à plein temps', hoursPerWeek: 40, durationWeeks: 26 })).body.code, 'classification_requires_employment');
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/opportunities`, { ...GIG, payKind: 'wage' })).body.code, 'invalid_arrangement');
  const opp = await post(e, { type: 'staffing', arrangement: 'employment', payKind: 'wage', title: 'Vendeur·se en boutique', rateKori: 60000, hoursPerWeek: 40, durationWeeks: 52 });
  assert.equal(opp.funding, 'payroll');
  const w = await worker(api);
  const { assignment } = await hire(api, e, w, { opp, offer: { rateKori: 60000, wagePeriod: 'month' } });
  assert.equal(assignment.terms.paidThrough, 'payroll');
  assert.equal(await bizBal(e.b.id), before, 'nothing escrowed');
  const pe = await prisma.payrollEmployee.findUnique({ where: { businessId_userId: { businessId: e.b.id, userId: w.id } } });
  assert.equal(pe.payAmount, 60000);
  // Missing prefunding never removes the obligation: the worker can still claim nonpayment.
  const d = ok(await w.call('POST', `work/assignments/${assignment.id}/disputes`, { kind: 'nonpayment', reason: 'Salaire d’octobre non versé.' }));
  const ops = await operator(api, ['work_ops']);
  assert.equal((await ops.call('POST', `admin/work/disputes/${d.id}/resolve`, { outcome: 'worker', note: 'Salaire dû selon contrat.' })).body.code, 'invalid', 'J9 never pays wages');
  const res = ok(await ops.call('POST', `admin/work/disputes/${d.id}/resolve`, { outcome: 'finding_only', note: 'Salaire d’octobre dû par l’employeur : obligation constatée.' }));
  assert.equal(res.dispute.status, 'resolved');
  assert.equal(await prisma.workEarning.count({ where: { assignmentId: assignment.id } }), 0);
});

test('fake jobs and fee scams: unverified businesses cannot post; worker-fee language is held for review, invisible until approved', async () => {
  const u = await employer(api, { verified: false });
  assert.equal((await u.owner.call('POST', `businesses/${u.b.id}/work/opportunities`, GIG)).body.code, 'business_not_verified');
  const e = await employer(api);
  const w = await worker(api);
  const scam = await post(e, { description: 'Travail facile. Frais d’inscription de 5000 à payer avant de commencer.' });
  assert.equal(scam.status, 'under_review');
  assert.ok(!ok(await w.call('GET', 'work/opportunities')).items.some((o) => o.id === scam.id));
  assert.equal((await w.call('POST', `work/opportunities/${scam.id}/apply`, {})).body.code, 'invalid_state');
  const ops = await operator(api, ['work_ops']);
  const q = ok(await ops.call('GET', 'admin/work/review'));
  assert.ok(q.opportunities.some((o) => o.id === scam.id && o.flags.includes('worker_fee_language')));
  ok(await ops.call('POST', `admin/work/opportunities/${scam.id}/review`, { decision: 'reject', note: 'Frais demandés aux travailleurs : interdit.' }));
  const outsider = await operator(api, ['support']);
  assert.equal((await outsider.call('GET', 'admin/work/review')).status, 403);
});

test('self-dealing: people who run the business cannot be hired by it or accept their own work', async () => {
  const e = await employer(api);
  const opp = await post(e);
  assert.equal((await e.owner.call('POST', `work/opportunities/${opp.id}/apply`, {})).body.code, 'conflict_of_interest');
  const mgrC = await customer();
  await prisma.businessMember.create({ data: { businessId: e.b.id, userId: mgrC.id, role: 'manager', status: 'active', acceptedAt: new Date() } });
  const mgr = await signedIn(api, mgrC);
  assert.equal((await mgr.call('POST', `work/opportunities/${opp.id}/apply`, {})).body.code, 'conflict_of_interest');
});

test('minors and hazardous work: verified 17-year-olds get non-hazardous work only; unknown age must attest; hazardous needs verification', async () => {
  const e = await employer(api);
  const teen = await worker(api, { age: 17 });
  const hazard = await post(e, { title: 'Chargement camion', description: 'Charger des sacs de 50 kg sur un camion en hauteur.', hazardous: true });
  assert.equal(hazard.minAge, 18);
  assert.equal((await teen.call('POST', `work/opportunities/${hazard.id}/apply`, {})).body.code, 'minor_restricted');
  const disc = ok(await teen.call('GET', 'work/opportunities'));
  assert.equal(disc.items.find((o) => o.id === hazard.id).eligible, false);
  const unknown = await worker(api, { age: null });
  assert.equal((await unknown.call('POST', `work/opportunities/${hazard.id}/apply`, {})).body.code, 'age_verification_required');
  const appr = await post(e, { type: 'apprenticeship', arrangement: 'apprenticeship', payKind: 'stipend', rateKori: 500, minAge: 16, durationWeeks: 12, title: 'Apprenti couture', description: 'Apprendre la couture avec un tailleur expérimenté, 3 jours par semaine.' });
  const { assignment } = await hire(api, e, teen, { opp: appr, offer: { learningPlan: 'Semaines 1–4 : prises de mesures ; 5–8 : coupe ; 9–12 : assemblage.' } });
  assert.equal(assignment.terms.classification, 'apprenticeship_stipend');
  const gig = await post(e);
  const app = ok(await unknown.call('POST', `work/opportunities/${gig.id}/apply`, {}));
  const of = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/offers`, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter le stock du rayon.' }, await withStepUp(e.owner)));
  assert.equal((await unknown.call('POST', `work/offers/${of.id}/accept`, { termsHash: of.termsHash })).body.code, 'age_attestation_required');
  ok(await unknown.call('POST', `work/offers/${of.id}/accept`, { termsHash: of.termsHash, ageAttested: true }));
});

test('privacy and authorization: applicant cards carry no contact or protected data; other businesses and outsiders see nothing', async () => {
  const e = await employer(api);
  const other = await employer(api);
  const w = await worker(api);
  const opp = await post(e);
  ok(await w.call('POST', `work/opportunities/${opp.id}/apply`, {}));
  const list = ok(await e.owner.call('GET', `businesses/${e.b.id}/work/opportunities/${opp.id}/applicants`));
  const card = JSON.stringify(list[0]);
  for (const f of ['phone', 'email', 'dateOfBirth', 'country', 'nationality', 'language', 'avatar', 'address']) assert.ok(!card.includes(f), `no ${f}`);
  assert.equal((await other.owner.call('GET', `businesses/${e.b.id}/work/opportunities/${opp.id}/applicants`)).status, 403);
  assert.equal((await other.owner.call('GET', `businesses/${other.b.id}/work/opportunities/${opp.id}/applicants`)).status, 404);
  const { assignment } = await hire(api, e, await worker(api), { opp: await post(e) });
  assert.equal((await other.owner.call('GET', `businesses/${other.b.id}/work/assignments/${assignment.id}`)).status, 404);
  assert.equal((await w.call('GET', `work/assignments/${assignment.id}`)).status, 404, 'another worker');
  // Fair discovery: no ranking by the worker's attributes; private profiles are not searchable.
  const priv = await worker(api, { visibility: 'private', skills: ['rare-skill'] });
  assert.equal(ok(await e.owner.call('GET', `businesses/${e.b.id}/work/workers?skill=rare-skill`)).length, 0);
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/opportunities/${opp.id}/invite`, { workerHandle: priv.handle })).status, 404);
});

test('harassment protection: a worker blocks a business — pending offers withdrawn and refunded, invitations impossible', async () => {
  const e = await employer(api);
  const before = await bizBal(e.b.id);
  const w = await worker(api);
  const opp = await post(e);
  const app = ok(await w.call('POST', `work/opportunities/${opp.id}/apply`, {}));
  ok(await e.owner.call('POST', `businesses/${e.b.id}/work/offers`, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter le stock du rayon.' }, await withStepUp(e.owner)));
  ok(await w.call('POST', 'work/blocks', { businessId: e.b.id }));
  assert.equal(await bizBal(e.b.id), before);
  const opp2 = await post(e);
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/opportunities/${opp2.id}/invite`, { workerHandle: w.handle })).status, 404);
  assert.ok(!ok(await w.call('GET', 'work/opportunities')).items.some((o) => o.businessId === e.b.id || o.business?.id === e.b.id));
});

test('W-invariants detect a forged earning and a drained escrow', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const { offer } = await hire(api, e, w);
  await prisma.$executeRawUnsafe('ALTER TABLE "WorkEarning" DISABLE TRIGGER USER');
  try {
    const f = await prisma.workEarning.create({ data: { sourceKey: `forged:${key()}`, workerUserId: w.id, payerBusinessId: e.b.id, classification: 'contractor_payment', amountKori: 999, releasableAt: new Date() } });
    try {
      const chk = await checkWorkInvariants(prisma);
      assert.ok(chk.violations.some((v) => v.id === 'W2') && chk.violations.some((v) => v.id === 'W7'), JSON.stringify(chk.violations));
    } finally {
      await prisma.workEarning.delete({ where: { id: f.id } });
    }
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "WorkEarning" ENABLE TRIGGER USER');
  }
  await assert.rejects(prisma.workOffer.update({ where: { id: offer.id }, data: { totalKori: 1 } }), 'terms immutable');
  await assert.rejects(prisma.workEvidence.deleteMany({ where: {} }), 'evidence append-only');
});
