/**
 * J9 end-to-end pilots over HTTP (local test ledger only):
 *   courier earns exactly once from a verified J8 delivery · rep earns only on an eligible
 *   completed (received + paid) first sale · pickup-point fee on a verified release · cooperative
 *   work without dividends counted as wages · worker disputes nonpayment · employer disputes false
 *   completion (before and after acceptance; paid = never clawed back) · maker/checker settlement.
 * J2 + J8 + J9 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, fundBusiness } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { assertWorkInvariants } from '../../lib/work/invariants.js';
import { processWorkOutcomes } from '../../lib/work/rules.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';
import { runWorkMaintenance } from '../../lib/work/money.js';
import { runMoneyTransaction } from '../../lib/wallet-atomic.js';
import { createRequestInTx } from '../../lib/logistics/intake.js';
import { business, customer, operator, signedIn } from '../j3/helpers.js';
import { member, merchant, submit, supplier } from '../j7/fixture.js';
import { shipmentFor } from '../j8/fixture.js';
import { bizBal, employer, hire, idemH, ok, post, walletBal, withStepUp, worker } from './fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_WORK_MONEY_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
  await assertWorkInvariants(prisma);
});

/** This test process runs the processors directly: J9 money on for the call only. */
async function runOutcomes() {
  process.env.JOKKO_WORK_MONEY_ENABLED = 'true';
  try {
    return await processWorkOutcomes(prisma);
  } finally {
    delete process.env.JOKKO_WORK_MONEY_ENABLED;
  }
}
const asEmployer = async (sup) => {
  await prisma.business.update({ where: { id: sup.b.id }, data: { verificationStatus: 'verified', verified: true } });
  await fundBusiness(sup.b.id, 50_000);
  return { b: sup.b, owner: sup.owner, ownerC: sup.ownerC };
};
async function readyPoFor(sup, m, { packs = 1 } = {}) {
  const po = ok(await submit(m, sup, { packs }), 'submit');
  ok(await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/accept`, {}), 'po accept');
  ok(await m.owner.call('POST', `businesses/${m.b.id}/b2b/purchase-orders/${po.id}/pay`, { expectedAmountKori: po.totalKori }, await withStepUp(m.owner)), 'pay');
  for (const to of ['preparing', 'ready']) ok(await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to }), to);
  return po;
}
/** Tracked own-fleet delivery by `driver`, verified by the merchant's per-line receiving. */
async function deliver(sup, m, po, driver, units) {
  ok(await sup.owner.call('POST', `businesses/${sup.b.id}/b2b/purchase-orders/${po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }), 'handoff');
  const sh = await shipmentFor(po.id);
  ok(await sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: driver.id }), 'assign');
  const pc = ok(await sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' }));
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }), 'pickup');
  ok(await driver.call('POST', `logistics/shipments/${sh.id}/step`, { step: 'arrive_delivery' }));
  ok(await m.owner.call('POST', `logistics/shipments/${sh.id}/receiving`, { lines: [{ productId: sup.product.id, received: units }] }), 'receiving');
  return sh;
}

test('pilot — courier: hired through J9 for the business’s own fleet, earns exactly once per verified J8 delivery; unused budget refunded; role revoked', async () => {
  const sup = await supplier(api, { stock: 600 });
  const e = await asEmployer(sup);
  const c = await worker(api);
  const opp = await post(e, { type: 'courier', arrangement: 'contract', payKind: 'per_unit', rateKori: 300, units: 3, title: 'Livreur flotte Pikine', description: 'Livrer nos commandes aux boutiques de Pikine avec la moto de l’entreprise.' });
  const before = await bizBal(e.b.id);
  const { assignment, offer } = await hire(api, e, c, { opp, offer: { rateKori: 300, units: 3 } });
  assert.equal(offer.totalKori, 900);
  assert.equal(await bizBal(e.b.id), before - 900);
  assert.ok(await prisma.businessMember.findFirst({ where: { businessId: e.b.id, userId: c.id, role: 'fleet_driver', status: 'active' } }), 'explicit fleet_driver grant');
  const m = await merchant(api, sup);
  const po = await readyPoFor(sup, m);
  const sh = await deliver(sup, m, po, c, 12);
  // Processing before / after: exactly one earning, never with a J8 courier earning.
  const r1 = await runOutcomes();
  assert.equal(r1.courierDeliveries, 1);
  assert.equal((await runOutcomes()).courierDeliveries, 0, 'replay pays nothing');
  assert.equal(await prisma.courierEarning.count({ where: { shipmentId: sh.id } }), 0, 'no J8 earning on an own-fleet delivery');
  const earn = await prisma.workEarning.findMany({ where: { assignmentId: assignment.id } });
  assert.deepEqual(earn.map((x) => [x.sourceKey, x.amountKori, x.classification]), [[`shipment:${sh.id}`, 300, 'contractor_payment']]);
  // Ending: the unused 600 goes back; the earned 300 stays; fleet_driver revoked.
  const end = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/end`, { reason: 'fin de saison' }));
  assert.equal(end.status, 'completed');
  assert.equal(await bizBal(e.b.id), before - 300 + po.totalKori, 'PO revenue in, 300 earned out, 600 back');
  assert.equal(await prisma.businessMember.count({ where: { businessId: e.b.id, userId: c.id, role: 'fleet_driver', status: 'active' } }), 0);
});

test('pilot — rep: commission only on the merchant’s first RECEIVED and PAID order, once; dual-controlled, prefunded rule; self-dealing and staff-owned merchants refused', async () => {
  const sup = await supplier(api, { stock: 1200 });
  const e = await asEmployer(sup);
  const rep = await worker(api);
  const opp = await post(e, { type: 'rep', arrangement: 'contract', payKind: 'commission', rateKori: 0, title: 'Commercial terrain Guédiawaye', description: 'Présenter notre catalogue grossiste aux boutiques du quartier.' });
  ok(await rep.call('POST', `work/opportunities/${opp.id}/apply`, {}));
  const app = (await prisma.workApplication.findFirst({ where: { opportunityId: opp.id } })).id;
  const of = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/offers`, { applicationId: app, startDate: '2026-11-02', duties: 'Démarcher les boutiques et les présenter au catalogue.' }));
  assert.equal(of.totalKori, 0);
  ok(await rep.call('POST', `work/offers/${of.id}/accept`, { termsHash: of.termsHash }));
  // Rule: proposed by the owner (0 by default, then 1000), approved by ANOTHER member holding business.pay, prefunded.
  const zero = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/rules`, { kind: 'rep_first_received_order' }));
  assert.equal(zero.amountKori, 0);
  const fin = await member(api, e.b, 'finance');
  assert.equal((await fin.call('POST', `businesses/${e.b.id}/work/rules/${zero.id}/approve`, {})).body.code, 'zero_rate');
  const rule = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/rules`, { kind: 'rep_first_received_order', amountKori: 1000 }));
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/rules/${rule.id}/approve`, {})).body.code, 'dual_control');
  assert.equal((await rep.call('POST', `businesses/${e.b.id}/work/rules/${rule.id}/approve`, {})).status, 403, 'the rep cannot approve their own pay rule');
  ok(await fin.call('POST', `businesses/${e.b.id}/work/rules/${rule.id}/approve`, {}));
  ok(await fin.call('POST', `businesses/${e.b.id}/work/rules/${rule.id}/fund`, { amountKori: 1500 }, await withStepUp(fin)));
  // A merchant the rep introduced: first order placed and paid but NOT yet received → nothing.
  const m = await merchant(api, sup, { connect: false });
  await prisma.merchantRelationship.create({ data: { distributorBusinessId: sup.b.id, merchantBusinessId: m.b.id, introducedByUserId: rep.id, status: 'active', respondedAt: new Date() } });
  const po = await readyPoFor(sup, m);
  assert.equal((await runOutcomes()).repCommissions, 0, 'placed / paid is not enough');
  const driver = await member(api, sup.b, 'fleet_driver');
  await deliver(sup, m, po, driver, 12);
  const r = await runOutcomes();
  assert.equal(r.repCommissions, 1);
  const e1 = await prisma.workEarning.findFirst({ where: { workerUserId: rep.id, classification: 'commission' } });
  assert.equal(e1.amountKori, 1000);
  assert.ok(e1.releasableAt > new Date(Date.now() + 100 * 3600_000), 'longer hold for commissions');
  // Second order from the same merchant: no second commission.
  const po2 = await readyPoFor(sup, m);
  await deliver(sup, m, po2, driver, 12);
  assert.equal((await runOutcomes()).repCommissions, 0);
  // Fake account: a merchant the rep owns → ineligible (recorded once, never paid).
  const fakeBiz = await business(rep.user);
  await prisma.merchantRelationship.create({ data: { distributorBusinessId: sup.b.id, merchantBusinessId: fakeBiz.id, introducedByUserId: rep.id, status: 'active', respondedAt: new Date() } });
  const fake = { b: fakeBiz, owner: rep, ownerC: rep };
  await ensureBusinessWallet(fakeBiz.id, prisma);
  await fundBusiness(fakeBiz.id, 50_000);
  const fpo = await readyPoFor(sup, fake);
  await deliver(sup, fake, fpo, driver, 12);
  const r3 = await runOutcomes();
  assert.equal(r3.repCommissions, 0);
  const out = await prisma.workOutcome.findUnique({ where: { outcomeKey: `rule:${rule.id}:merchant:${fakeBiz.id}` } });
  assert.deepEqual([out.status, out.reason], ['ineligible', 'self_dealing_rep_runs_merchant']);
  // Budget: 1500 − 1000 = 500 left; ending the rule returns it.
  ok(await fin.call('POST', `businesses/${e.b.id}/work/rules/${rule.id}/end`, {}));
  assert.equal(Number((await prisma.ledgerAccount.findUnique({ where: { code: `escrow:work_rule:${rule.id}` } })).balance), 0);
});

test('pilot — pickup point: fee only on a verified release (recipient code) at the rule’s point, once; credited to the operator after the hold', async () => {
  const shop = await employer(api);
  const pointOwnerC = await customer();
  const pointOwner = await signedIn(api, pointOwnerC);
  const pointBiz = await business(pointOwnerC.user);
  const point = ok(await pointOwner.call('POST', `businesses/${pointBiz.id}/pickup-points`, { name: 'Relais Thiaroye', services: ['customer_pickup'] }));
  const comp = await operator(api, ['compliance']);
  ok(await comp.call('POST', `admin/pickup-points/${point.id}/decide`, { status: 'active', reason: 'visite effectuée' }));
  const rule = ok(await shop.owner.call('POST', `businesses/${shop.b.id}/work/rules`, { kind: 'pickup_release_fee', amountKori: 150, pickupPointId: point.id }));
  const fin = await member(api, shop.b, 'finance');
  ok(await fin.call('POST', `businesses/${shop.b.id}/work/rules/${rule.id}/approve`, {}));
  ok(await fin.call('POST', `businesses/${shop.b.id}/work/rules/${rule.id}/fund`, { amountKori: 450 }, await withStepUp(fin)));
  const buyerC = await customer();
  const buyer = await signedIn(api, buyerC);
  const { shipment } = await runMoneyTransaction(prisma, (tx) => createRequestInTx(tx, {
    sourceSystem: 'kabu', sourceId: `ord-${Date.now()}`, fulfilmentOwner: 'CUSTOMER_PICKUP', fulfillerBusinessId: shop.b.id, originBusinessId: shop.b.id,
    destinationUserId: buyerC.id, pickupPointId: point.id, lines: [], createdBy: shop.ownerC.id,
  }));
  ok(await pointOwner.call('POST', `logistics/shipments/${shipment.id}/drop`, {}));
  assert.equal((await runOutcomes()).pickupFees, 0, 'drop-off is not a release');
  const cc = ok(await buyer.call('POST', `logistics/shipments/${shipment.id}/codes`, { purpose: 'collection' }));
  ok(await pointOwner.call('POST', `logistics/shipments/${shipment.id}/release`, { code: cc.code }));
  assert.equal((await runOutcomes()).pickupFees, 1);
  assert.equal((await runOutcomes()).pickupFees, 0, 'once per release');
  const before = await bizBal(pointBiz.id);
  await prisma.workEarning.updateMany({ where: { payeeBusinessId: pointBiz.id }, data: { releasableAt: new Date(Date.now() - 1000) } });
  const m = await runWorkMaintenance(prisma);
  assert.equal(m.businessCredited, 1);
  assert.equal(await bizBal(pointBiz.id), before + 150);
  assert.equal((await runWorkMaintenance(prisma)).businessCredited, 0);
});

test('pilot — cooperative work: member work payment, never wages and never a dividend', async () => {
  const coop = await employer(api, { type: 'cooperative' });
  assert.equal((await coop.owner.call('POST', `businesses/${coop.b.id}/work/opportunities`, { type: 'coop_work', arrangement: 'employment', title: 'Récolte arachide', description: 'Récolte collective de la parcelle de la coopérative.', payKind: 'wage', rateKori: 1 })).body.code, 'invalid_arrangement');
  const notCoop = await employer(api);
  assert.equal((await notCoop.owner.call('POST', `businesses/${notCoop.b.id}/work/opportunities`, { type: 'coop_work', arrangement: 'coop_member', title: 'Récolte arachide', description: 'Récolte collective de la parcelle de la coopérative.', payKind: 'fixed', rateKori: 1500 })).body.code, 'invalid');
  const opp = await post(coop, { type: 'coop_work', arrangement: 'coop_member', payKind: 'fixed', rateKori: 1500, title: 'Récolte arachide', description: 'Récolte collective de la parcelle de la coopérative.' });
  const w = await worker(api);
  const { assignment } = await hire(api, coop, w, { opp });
  ok(await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, content: 'Deux journées de récolte faites.' }));
  ok(await coop.owner.call('POST', `businesses/${coop.b.id}/work/assignments/${assignment.id}/accept`, { seq: 1 }));
  const e = await prisma.workEarning.findFirst({ where: { assignmentId: assignment.id } });
  assert.equal(e.classification, 'member_work_payment');
  assert.equal(await prisma.payrollRun.count({ where: { businessId: coop.b.id } }), 0, 'not payroll');
});

async function submitted(e, w, extra = {}) {
  const { assignment, offer } = await hire(api, e, w, extra);
  ok(await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, content: 'Travail terminé, photos envoyées.' }));
  return { assignment, offer };
}

test('pilot — worker disputes nonpayment: auto-accept frozen, ruling by work ops, money only after a second (finance) operator, once', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const { assignment } = await submitted(e, w);
  const d = ok(await w.call('POST', `work/assignments/${assignment.id}/disputes`, { kind: 'nonpayment', reason: 'Travail livré, aucune réponse de l’entreprise.', milestoneSeq: 1 }));
  assert.equal((await w.call('POST', `work/assignments/${assignment.id}/disputes`, { kind: 'nonpayment', reason: 'Travail livré, aucune réponse de l’entreprise.', milestoneSeq: 1 })).body.replayed, true);
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/accept`, { seq: 1 })).body.code, 'invalid_state', 'in dispute');
  await prisma.workMilestone.updateMany({ where: { assignmentId: assignment.id }, data: { acceptDeadline: new Date(Date.now() - 1000) } });
  assert.equal((await runWorkMaintenance(prisma)).autoAccepted, 0, 'disputed: no auto-accept');
  ok(await e.owner.call('POST', `businesses/${e.b.id}/work/disputes/${d.id}/evidence`, { content: 'Le travail était incomplet.' }));
  const view = ok(await w.call('GET', `work/disputes/${d.id}`));
  assert.equal(view.evidence.length, 2);
  assert.ok(!JSON.stringify(view).includes(e.owner.id), 'no counterparty user ids');
  const ops = await operator(api, ['work_ops']);
  assert.equal((await ops.call('POST', `admin/work/disputes/${d.id}/resolve`, { outcome: 'finding_only', note: 'Constat sans argent.' })).body.code, 'money_at_stake');
  const res = ok(await ops.call('POST', `admin/work/disputes/${d.id}/resolve`, { outcome: 'worker', note: 'Photos et témoins : travail fait.' }));
  assert.equal(res.dispute.status, 'awaiting_settlement');
  assert.equal(await prisma.workEarning.count({ where: { assignmentId: assignment.id } }), 0, 'no money on the ruling alone');
  assert.equal((await ops.call('POST', `admin/approvals/${res.approval.id}/approve`, {})).status, 403, 'the ruling operator cannot execute');
  const fin = await operator(api, ['finance_ops']);
  ok(await fin.call('POST', `admin/approvals/${res.approval.id}/approve`, {}));
  await fin.call('POST', `admin/approvals/${res.approval.id}/approve`, {}); // replay / refusal: either way, no second execution
  const earn = await prisma.workEarning.findMany({ where: { assignmentId: assignment.id } });
  assert.equal(earn.length, 1);
  assert.equal(earn[0].amountKori, 2000);
  assert.equal((await prisma.workAssignment.findUnique({ where: { id: assignment.id } })).status, 'completed');
});

test('pilot — employer disputes false completion: before acceptance → refund (or split); after acceptance → unpaid earning reversed; paid → never clawed back', async () => {
  const e = await employer(api);
  const ops = await operator(api, ['work_ops']);
  const fin = await operator(api, ['finance_ops']);
  const settle = async (d, body) => {
    const r = ok(await ops.call('POST', `admin/work/disputes/${d.id}/resolve`, body));
    ok(await fin.call('POST', `admin/approvals/${r.approval.id}/approve`, {}));
  };
  // (a) before acceptance → business wins → refund.
  const before = await bizBal(e.b.id);
  const w1 = await worker(api);
  const a1 = await submitted(e, w1);
  const d1 = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${a1.assignment.id}/disputes`, { kind: 'false_completion', reason: 'Rien n’a été fait sur place.', milestoneSeq: 1 }));
  assert.equal((await w1.call('POST', `work/assignments/${a1.assignment.id}/disputes`, { kind: 'false_completion', reason: 'Je conteste moi-même ?', milestoneSeq: 1 })).status, 400, 'a worker cannot claim false completion');
  await settle(d1, { outcome: 'business', note: 'Aucune preuve de présence ni de travail.' });
  assert.equal(await bizBal(e.b.id), before);
  // (b) split.
  const w2 = await worker(api);
  const a2 = await submitted(e, w2);
  const d2 = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${a2.assignment.id}/disputes`, { kind: 'false_completion', reason: 'Moitié du travail seulement.', milestoneSeq: 1 }));
  await settle(d2, { outcome: 'split', splitWorkerKori: 800, note: 'Travail partiel constaté sur photos.' });
  assert.equal((await prisma.workEarning.findFirst({ where: { assignmentId: a2.assignment.id } })).amountKori, 800);
  // (c) after acceptance, earning unpaid → reversal.
  const w3 = await worker(api);
  const a3 = await submitted(e, w3);
  ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${a3.assignment.id}/accept`, { seq: 1 }));
  const mid = await bizBal(e.b.id);
  const d3 = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${a3.assignment.id}/disputes`, { kind: 'false_completion', reason: 'Validé par erreur : marchandise non rangée.', milestoneSeq: 1 }));
  await prisma.workEarning.updateMany({ where: { assignmentId: a3.assignment.id }, data: { releasableAt: new Date(Date.now() - 1000) } });
  await runWorkMaintenance(prisma);
  assert.equal((await prisma.workEarning.findFirst({ where: { assignmentId: a3.assignment.id } })).status, 'accrued', 'frozen by the open dispute');
  assert.equal(ok(await w3.call('POST', 'work/earnings/payout', {}, idemH())).paidKori, 0);
  await settle(d3, { outcome: 'business', note: 'Constat sur place : travail non fait.' });
  assert.equal((await prisma.workEarning.findFirst({ where: { assignmentId: a3.assignment.id } })).status, 'reversed');
  assert.equal(await bizBal(e.b.id), mid + 2000);
  // (d) already paid → the worker keeps it; the dispute route refuses (support / legal path, no auto clawback).
  const w4 = await worker(api);
  const a4 = await submitted(e, w4);
  ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${a4.assignment.id}/accept`, { seq: 1 }));
  await prisma.workEarning.updateMany({ where: { assignmentId: a4.assignment.id }, data: { releasableAt: new Date(Date.now() - 1000) } });
  await runWorkMaintenance(prisma);
  const w0 = await walletBal(w4.id);
  ok(await w4.call('POST', 'work/earnings/payout', {}, idemH()));
  assert.equal(await walletBal(w4.id), w0 + 2000);
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${a4.assignment.id}/disputes`, { kind: 'false_completion', reason: 'Je regrette d’avoir validé.', milestoneSeq: 1 })).body.code, 'already_paid');
  assert.equal(await walletBal(w4.id), w0 + 2000);
});

test('feedback: once per side after real work; contested feedback leaves aggregates until an operator rules', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const { assignment } = await submitted(e, w);
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/feedback`, { rating: 1 })).body.code, 'invalid_state', 'not before the work is settled');
  ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/accept`, { seq: 1 }));
  const f = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/feedback`, { rating: 1, comment: 'Lent.' }));
  assert.equal((await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/feedback`, { rating: 5 })).body.code, 'already_rated');
  const other = await worker(api);
  assert.equal((await other.call('POST', `work/feedback/${f.id}/contest`, { note: 'Pas moi mais je conteste.' })).status, 404);
  ok(await w.call('POST', `work/feedback/${f.id}/contest`, { note: 'J’ai fini avant l’heure prévue, voir les codes de présence.' }));
  assert.equal((await prisma.workFeedback.findUnique({ where: { id: f.id } })).status, 'contested');
  const ops = await operator(api, ['work_ops']);
  ok(await ops.call('POST', `admin/work/feedback/${f.id}/rule`, { decision: 'removed', note: 'Avis non étayé, contredit par les preuves.' }));
  assert.equal(ok(await w.call('GET', 'work/feedback'))[0].status, 'removed');
});
