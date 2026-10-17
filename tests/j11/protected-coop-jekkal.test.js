/**
 * J11.2 — protected projects / campaigns (dormant), Jekkal DIRECT with beneficiary consent (J11-F3),
 * cooperative capital records (records only). Over real HTTP with the dormant flags switched on locally.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { business, customer, operator, signedIn } from '../j3/helpers.js';
import { checkCollectiveInvariants } from '../../lib/collective/invariants.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';

let on;
let off;
before(async () => {
  [on, off] = await Promise.all([startApiServer({ JOKKO_PROTECTED_FUNDS_ENABLED: 'true', JOKKO_COLLECTIVE_ENABLED: 'true' }), startApiServer()]);
});
after(async () => {
  await Promise.all([on?.stop(), off?.stop()]);
  const r = await checkCollectiveInvariants();
  assert.ok(r.ok, JSON.stringify(r.violations));
  await assertInvariants(prisma);
  await prisma.$disconnect();
});

const ok = (r, msg = '') => { assert.ok(r.status < 300, `${msg} ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const bal = async (u) => (await prisma.wallet.findUnique({ where: { userId: u.id } })).koriBalance;
const key = () => ({ headers: { 'idempotency-key': crypto.randomBytes(8).toString('hex') } });
const person = async (opts = {}) => signedIn(on, await customer({ koriBalance: 50_000, ...opts }));
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

test('dormant by default: protected funds answer 503 without the flag', async () => {
  const u = await signedIn(off, await customer({}));
  assert.equal((await u.call('GET', 'protected/funds')).status, 503);
});

test('protected project: verified recipient, independent approvers; approval never moves money; release only via a second operator', async () => {
  const [org, rec, ap1, ap2, d1, d2] = await Promise.all([person(), person(), person(), person(), person(), person()]);
  const unverified = await person({ tier: 1 });
  const base = { kind: 'project', title: 'Puits du village', purpose: 'Forage et pompe solaire pour le quartier', goalKori: 3000, deadline: inDays(30), approvalsRequired: 2,
    milestones: [{ title: 'Forage', amountKori: 2000 }, { title: 'Pompe', amountKori: 1000 }] };
  assert.equal((await org.call('POST', 'protected/funds', { ...base, recipientHandle: unverified.handle, approverHandles: [ap1.handle, ap2.handle] })).body.code, 'recipient_not_verified');
  assert.equal((await org.call('POST', 'protected/funds', { ...base, recipientHandle: rec.handle, approverHandles: [org.handle, ap2.handle] })).body.code, 'approver_not_independent');
  const f = ok(await org.call('POST', 'protected/funds', { ...base, recipientHandle: rec.handle, approverHandles: [ap1.handle, ap2.handle] }));
  assert.equal((await d1.call('GET', `protected/funds/${f.id}`)).status, 404, 'a draft is private');
  assert.equal((await org.call('POST', `protected/funds/${f.id}/publish`)).body.code, 'recipient_consent_required');
  ok(await rec.call('POST', `protected/funds/${f.id}/recipient`, { accept: true }));
  assert.equal((await org.call('POST', `protected/funds/${f.id}/publish`)).body.code, 'approvers_pending');
  ok(await ap1.call('POST', `protected/funds/${f.id}/approver`));
  ok(await ap2.call('POST', `protected/funds/${f.id}/approver`));
  ok(await org.call('POST', `protected/funds/${f.id}/publish`));

  assert.equal((await rec.call('POST', `protected/funds/${f.id}/contribute`, { amountKori: 100 }, key())).body.code, 'self_contribution');
  ok(await d1.call('POST', `protected/funds/${f.id}/contribute`, { amountKori: 2000 }, key()));
  assert.equal((await d2.call('POST', `protected/funds/${f.id}/contribute`, { amountKori: 1001 }, key())).body.code, 'invalid_amount', 'no overfunding');
  ok(await d2.call('POST', `protected/funds/${f.id}/contribute`, { amountKori: 1000 }, key()));
  assert.equal(ok(await d1.call('GET', `protected/funds/${f.id}`)).status, 'funded');

  const recBefore = await bal(rec);
  ok(await ap1.call('POST', `protected/funds/${f.id}/decide`, { decision: 'approve' }));
  const second = ok(await ap2.call('POST', `protected/funds/${f.id}/decide`, { decision: 'approve', note: 'Photos du forage vérifiées sur place' }));
  assert.equal(second.status, 'approved');
  assert.equal(await bal(rec), recBefore, 'approval alone moved nothing');

  const ops = await operator(on, ['collective_ops']);
  const fin = await operator(on, ['finance_ops']);
  assert.equal((await ops.call('POST', `admin/protected/funds/${f.id}/release`, { seq: 2, reason: 'Pompe : pas encore approuvée' })).status, 201);
  const req1 = ok(await ops.call('POST', `admin/protected/funds/${f.id}/release`, { seq: 1, reason: 'Étape 1 approuvée par 2 approbateurs' }));
  assert.equal((await ops.call('POST', `admin/approvals/${req1.approval.id}/approve`)).status, 403, 'the requesting operator cannot execute');
  ok(await fin.call('POST', `admin/approvals/${req1.approval.id}/approve`));
  assert.equal(await bal(rec), recBefore + 2000, 'released to the verified recipient after the second operator');
  // milestone 2 was never approved: a settlement request for it cannot execute
  const pend = await prisma.adminApproval.findFirst({ where: { action: 'protected_release', status: 'requested', payloadJson: { contains: `"seq":2` } }, orderBy: { createdAt: 'desc' } });
  assert.notEqual((await fin.call('POST', `admin/approvals/${pend.id}/approve`)).status, 200);

  // the recipient is frozen by K21 → no release; then the project is cancelled → pro-rata refund of what remains
  await prisma.user.update({ where: { id: rec.id }, data: { frozenByAdminAt: new Date() } });
  ok(await ap1.call('POST', `protected/funds/${f.id}/decide`, { decision: 'approve' }));
  ok(await ap2.call('POST', `protected/funds/${f.id}/decide`, { decision: 'approve' }));
  const req2 = ok(await ops.call('POST', `admin/protected/funds/${f.id}/release`, { seq: 2, reason: 'Pompe approuvée, à verser' }));
  assert.notEqual((await fin.call('POST', `admin/approvals/${req2.approval.id}/approve`)).status, 200, 'a suspended recipient is never paid');
  const [b1, b2] = [await bal(d1), await bal(d2)];
  const cx = ok(await ops.call('POST', `admin/protected/funds/${f.id}/cancel`, { reason: 'Bénéficiaire suspendu, projet arrêté' }));
  ok(await fin.call('POST', `admin/approvals/${cx.approval.id}/approve`));
  assert.equal((await bal(d1)) - b1 + (await bal(d2)) - b2, 1000, 'exactly what stayed in escrow came back');
  assert.equal((await bal(d1)) - b1, 667, 'pro-rata 2/3 (largest remainder)');
  assert.equal((await bal(d2)) - b2, 333);
  await prisma.user.update({ where: { id: rec.id }, data: { frozenByAdminAt: null } });
});

test('failed project: deadline passes without the goal → everyone refunded in full by the scheduler', async () => {
  const [org, rec, ap, d] = await Promise.all([person(), person(), person(), person()]);
  const f = ok(await org.call('POST', 'protected/funds', { kind: 'project', title: 'Salle de classe', purpose: 'Toiture de la salle de classe', goalKori: 5000, deadline: inDays(10), recipientHandle: rec.handle, approverHandles: [ap.handle], approvalsRequired: 1, milestones: [{ title: 'Toiture', amountKori: 5000 }] }));
  ok(await rec.call('POST', `protected/funds/${f.id}/recipient`, { accept: true }));
  ok(await ap.call('POST', `protected/funds/${f.id}/approver`));
  ok(await org.call('POST', `protected/funds/${f.id}/publish`));
  const before = await bal(d);
  ok(await d.call('POST', `protected/funds/${f.id}/contribute`, { amountKori: 1200 }, key()));
  await prisma.protectedFund.update({ where: { id: f.id }, data: { deadline: new Date(Date.now() - 1000) } });
  process.env.JOKKO_PROTECTED_FUNDS_ENABLED = 'true';
  const { runProtectedMaintenance } = await import('../../lib/collective/protected.js');
  const r = await runProtectedMaintenance();
  assert.ok(r.failed >= 1);
  assert.equal(await bal(d), before);
  assert.equal(ok(await d.call('GET', `protected/funds/${f.id}`)).status, 'failed');
});

test('protected campaign: one per beneficiary; 3 independent reports freeze it; a frozen campaign takes no money', async () => {
  const [org, ben, r1, r2, r3] = await Promise.all([person(), person(), person(), person(), person()]);
  const body = { kind: 'campaign', title: 'Opération de Awa', purpose: 'Frais d’hôpital pour une opération urgente', goalKori: 4000, deadline: inDays(20), recipientHandle: ben.handle };
  const f = ok(await org.call('POST', 'protected/funds', body));
  assert.equal((await org.call('POST', 'protected/funds', body)).body.code, 'duplicate_campaign');
  ok(await ben.call('POST', `protected/funds/${f.id}/recipient`, { accept: true }));
  ok(await org.call('POST', `protected/funds/${f.id}/publish`));
  for (const r of [r1, r2]) ok(await r.call('POST', `protected/funds/${f.id}/report`, { reason: 'Je pense que cette histoire est inventée' }));
  ok(await r3.call('POST', `protected/funds/${f.id}/contribute`, { amountKori: 500 }, key()));
  ok(await r3.call('POST', `protected/funds/${f.id}/report`, { reason: 'Même photo vue sur une autre collecte' }));
  assert.equal((await r3.call('POST', `protected/funds/${f.id}/contribute`, { amountKori: 500 }, key())).status, 423);
  assert.equal(ok(await r1.call('GET', `protected/funds/${f.id}`)).frozen, true);
});

test('Jekkal DIRECT: a campaign for someone else opens only with their consent; existing self-campaigns unchanged', async () => {
  const [creator, ben, donor, stranger] = await Promise.all([person(), person(), person(), person()]);
  const c = ok(await creator.call('POST', 'jekkal/campaigns', { title: 'Aide pour Moussa', goalAmount: 50_000, beneficiaryHandle: ben.handle }));
  assert.equal(c.status, 'pending_beneficiary');
  assert.equal(c.mode, 'direct');
  assert.match(c.disclosure, /transféré tout de suite/, 'P-J11-9: discloses a direct transfer');
  assert.doesNotMatch(c.disclosure, /jamais rembours|aucun remboursement/i, 'P-J11-9: no absolute no-refund promise');
  assert.match(c.disclosure, /support/, 'a remedy route exists');
  assert.equal((await stranger.call('GET', `jekkal/campaigns/${c.id}`)).status, 404, 'not public before consent');
  assert.equal((await donor.call('POST', `jekkal/campaigns/${c.id}/contribute`, { amount: 1000 })).status, 400, 'no gift before consent');
  assert.equal((await creator.call('POST', `jekkal/campaigns/${c.id}/beneficiary`, { accept: true })).status, 404, 'only the beneficiary consents');
  assert.equal(ok(await ben.call('POST', `jekkal/campaigns/${c.id}/beneficiary`, { accept: true })).status, 'active');
  assert.equal((await stranger.call('GET', `jekkal/campaigns/${c.id}`)).status, 200);
  const own = ok(await creator.call('POST', 'jekkal/campaigns', { title: 'Mes frais de scolarité', goalAmount: 30_000 }));
  assert.equal(own.status, 'active', 'a campaign for oneself needs no extra consent');
});

test('coop capital: records only — kinds kept apart, no investment returns, member confirms, history immutable, no money moves', async () => {
  const admin = await customer({ koriBalance: 0 });
  const member = await person();
  const outsider = await person();
  const biz = await business(admin);
  await prisma.business.update({ where: { id: biz.id }, data: { type: 'cooperative' } });
  const a = await signedIn(on, admin);
  const before = await bal(member);
  const at = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal((await a.call('POST', `businesses/${biz.id}/coop/capital`, { memberHandle: member.handle, kind: 'investment_return', direction: 'out', amountXof: 5000, occurredOn: at })).body.code, 'not_licensed');
  assert.equal((await outsider.call('POST', `businesses/${biz.id}/coop/capital`, { memberHandle: member.handle, kind: 'gift', direction: 'in', amountXof: 5000, occurredOn: at })).status, 404);
  const r = ok(await a.call('POST', `businesses/${biz.id}/coop/capital`, { memberHandle: member.handle, kind: 'member_capital', direction: 'in', amountXof: 25_000, occurredOn: at, note: 'Part payée en espèces à l’AG' }));
  ok(await a.call('POST', `businesses/${biz.id}/coop/capital`, { memberHandle: member.handle, kind: 'loan', direction: 'in', amountXof: 10_000, occurredOn: at }));
  assert.equal((await outsider.call('POST', `coop/capital/${r.id}/respond`, { confirm: true })).status, 404);
  ok(await member.call('POST', `coop/capital/${r.id}/respond`, { confirm: true }));
  const st = ok(await member.call('GET', 'coop/capital/mine'));
  const mine = st.coops.find((x) => x.businessId === biz.id);
  assert.equal(mine.totals.member_capital.inXof, 25_000);
  assert.equal(mine.totals.loan.inXof, 10_000, 'a loan is never counted as capital');
  assert.match(st.disclaimer, /aucun dividende/);
  assert.equal(await bal(member), before, 'records move no money');
  await assert.rejects(prisma.coopCapitalRecord.update({ where: { id: r.id }, data: { amountXof: 1 } }), /append-only/);
  await assert.rejects(prisma.coopCapitalRecord.delete({ where: { id: r.id } }), /never deleted/);
});
