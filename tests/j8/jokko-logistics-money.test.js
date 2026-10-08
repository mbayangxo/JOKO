/**
 * J8.10 / J8.11 / J8.19 / J8.20 — Jokko Logistics money (only when explicitly
 * enabled): server fee held in escrow, released ONLY on verified delivery
 * (courier earning + delivery revenue), refunded on cancel / operational failure,
 * earning hold, payout once, disputes freeze earnings, money reversal only via
 * maker/checker. J2 invariants (incl. I20 / I21) after every test.
 */
import '../helpers/setup.js';
import crypto from 'node:crypto';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertLogisticsInvariants } from '../../lib/logistics/invariants.js';
import { promoteReleasableEarnings } from '../../lib/logistics/fees.js';
import { operator } from '../j3/helpers.js';
import { bizBal } from '../j7/fixture.js';
import { jokkoCourier, readyPo, shipmentFor } from './fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_LOGISTICS_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertLogisticsInvariants(prisma);
});

const ok = (r, what = '') => {
  assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const walletBal = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).koriBalance;
const escrowBal = async (requestId) => (await prisma.ledgerAccount.findFirst({ where: { code: `escrow:shipment_fee:${requestId}` } }))?.balance ?? 0n;
const earnAcct = async (userId) => (await prisma.ledgerAccount.findFirst({ where: { code: `courier:${userId}:earnings` } }))?.balance ?? 0n;
const idem = () => ({ headers: { 'idempotency-key': `k-${crypto.randomBytes(8).toString('hex')}` } });

/** PO handed to Jokko Logistics, accepted by ops, made ready by the seller, assigned to a Jokko courier, picked up. */
async function inTransit({ pickup = true } = {}) {
  const x = await readyPo(api, { packs: 1 });
  const ops = await operator(api, ['logistics_ops']);
  const courier = await jokkoCourier(api);
  const sellerBefore = await bizBal(x.sup.b.id);
  ok(await x.sup.owner.call('POST', `businesses/${x.sup.b.id}/b2b/purchase-orders/${x.po.id}/advance`, { to: 'fulfilment_requested', fulfilmentMode: 'jokko_logistics' }), 'handoff');
  const sh = await shipmentFor(x.po.id);
  const req = await prisma.fulfilmentRequest.findUnique({ where: { id: sh.requestId } });
  assert.equal(req.fulfilmentOwner, 'JOKKO_LOGISTICS');
  assert.equal(req.feeKori, 150, 'server fee, never client-sent');
  assert.equal(req.courierEarningKori, 120);
  assert.equal(req.feeStatus, 'held');
  assert.equal(await bizBal(x.sup.b.id), sellerBefore - 150, 'sender charged once into escrow');
  assert.equal(await escrowBal(req.id), 150n);
  assert.equal(sh.status, 'requested');
  ok(await ops.call('POST', `admin/logistics/shipments/${sh.id}/accept`, {}), 'ops accept');
  ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/ready`, {}), 'ready');
  // The seller's own fleet cannot take over a Jokko Logistics shipment; only ops assign.
  assert.equal((await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/assign`, { courierUserId: courier.id })).status, 404);
  ok(await ops.call('POST', `admin/logistics/shipments/${sh.id}/assign`, { courierUserId: courier.id }), 'ops assign');
  if (pickup) {
    const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${sh.id}/codes`, { purpose: 'pickup' }));
    ok(await courier.call('POST', `logistics/shipments/${sh.id}/pickup`, { code: pc.code }), 'pickup');
  }
  return { ...x, ops, courier, sh, req, sellerBefore };
}

test('verified delivery releases the fee once: 120 courier earning (held 24h) + 30 revenue; payout once; replay safe', async () => {
  const x = await inTransit();
  assert.equal((await x.courier.call('POST', 'logistics/earnings/payout', {}, idem())).body.paidKori, 0, 'nothing to pay before delivery');
  const dc = ok(await x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'delivery' }));
  ok(await x.courier.call('POST', `logistics/shipments/${x.sh.id}/deliver`, { code: dc.code }), 'deliver');
  const req = await prisma.fulfilmentRequest.findUnique({ where: { id: x.req.id } });
  assert.equal(req.feeStatus, 'released');
  assert.equal(await escrowBal(req.id), 0n);
  assert.equal(await earnAcct(x.courier.id), 120n);
  const e = await prisma.courierEarning.findUnique({ where: { shipmentId: x.sh.id } });
  assert.equal(e.status, 'accrued');
  // Replaying the delivery never pays twice.
  assert.equal((await x.courier.call('POST', `logistics/shipments/${x.sh.id}/deliver`, { code: dc.code })).body.replayed, true);
  assert.equal(await prisma.courierEarning.count({ where: { shipmentId: x.sh.id } }), 1);
  // Hold: not payable yet.
  const w0 = await walletBal(x.courier.id);
  assert.equal((await x.courier.call('POST', 'logistics/earnings/payout', {}, idem())).body.paidKori, 0);
  await prisma.courierEarning.update({ where: { id: e.id }, data: { releasableAt: new Date(Date.now() - 1000) } });
  await promoteReleasableEarnings(prisma);
  // Payout requires an idempotency key; same key replays; a second key finds nothing.
  assert.ok([400, 428].includes((await x.courier.call('POST', 'logistics/earnings/payout', {})).status));
  const k = idem();
  const p1 = ok(await x.courier.call('POST', 'logistics/earnings/payout', {}, k), 'payout');
  assert.equal(p1.paidKori, 120);
  const p2 = ok(await x.courier.call('POST', 'logistics/earnings/payout', {}, k), 'payout replay');
  assert.equal(p2.paidKori, 120);
  assert.equal((await x.courier.call('POST', 'logistics/earnings/payout', {}, idem())).body.paidKori, 0);
  assert.equal(await walletBal(x.courier.id), w0 + 120, 'paid exactly once');
  assert.equal(await earnAcct(x.courier.id), 0n);
  const mine = ok(await x.courier.call('GET', 'logistics/earnings'));
  assert.equal(mine.paidKori, 120);
  // A stranger sees only their own (empty) earnings.
  const stranger = await jokkoCourier(api);
  assert.equal(ok(await stranger.call('GET', 'logistics/earnings')).items.length, 0);
});

test('cancel before pickup (ops or seller) refunds the held fee once; nothing is earned', async () => {
  const x = await inTransit({ pickup: false });
  ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/cancel`, { reason: 'commande reportée' }), 'cancel');
  assert.equal(await bizBal(x.sup.b.id), x.sellerBefore, 'fee refunded');
  assert.equal((await prisma.fulfilmentRequest.findUnique({ where: { id: x.req.id } })).feeStatus, 'refunded');
  assert.equal((await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/cancel`, { reason: 'encore' })).body.code, 'invalid_state');
  assert.equal(await bizBal(x.sup.b.id), x.sellerBefore, 'refunded once');
  assert.equal(await prisma.courierEarning.count({ where: { shipmentId: x.sh.id } }), 0);
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: x.po.id } })).status, 'ready');
});

test('failure: operational (unsafe) → refund; receiver-side (merchant closed) → courier still earns; both only once the goods are back', async () => {
  const a = await inTransit();
  ok(await a.courier.call('POST', `logistics/shipments/${a.sh.id}/fail`, { reason: 'unsafe' }));
  assert.equal((await prisma.fulfilmentRequest.findUnique({ where: { id: a.req.id } })).feeStatus, 'held', 'nothing settles while the courier still holds the goods');
  ok(await a.courier.call('POST', `logistics/shipments/${a.sh.id}/return/start`, {}));
  const rc = ok(await a.sup.owner.call('POST', `logistics/shipments/${a.sh.id}/codes`, { purpose: 'return_delivery' }));
  ok(await a.courier.call('POST', `logistics/shipments/${a.sh.id}/return/complete`, { code: rc.code }));
  assert.equal((await prisma.fulfilmentRequest.findUnique({ where: { id: a.req.id } })).feeStatus, 'refunded');
  assert.equal(await bizBal(a.sup.b.id), a.sellerBefore);

  const b = await inTransit();
  ok(await b.courier.call('POST', `logistics/shipments/${b.sh.id}/fail`, { reason: 'merchant_closed' }));
  ok(await b.courier.call('POST', `logistics/shipments/${b.sh.id}/return/start`, {}));
  const rc2 = ok(await b.sup.owner.call('POST', `logistics/shipments/${b.sh.id}/codes`, { purpose: 'return_delivery' }));
  ok(await b.courier.call('POST', `logistics/shipments/${b.sh.id}/return/complete`, { code: rc2.code }));
  assert.equal((await prisma.fulfilmentRequest.findUnique({ where: { id: b.req.id } })).feeStatus, 'released');
  assert.equal((await prisma.courierEarning.findUnique({ where: { shipmentId: b.sh.id } })).amountKori, 120);
});

test('courier claim without receiver proof is an exception: only logistics_ops rules it; ruling delivered releases once and is audited', async () => {
  const x = await inTransit();
  assert.equal((await x.courier.call('POST', `logistics/shipments/${x.sh.id}/exception`, { note: 'court' })).status, 400);
  ok(await x.courier.call('POST', `logistics/shipments/${x.sh.id}/exception`, { note: 'remis au gérant, pas de code reçu' }));
  assert.equal((await prisma.fulfilmentRequest.findUnique({ where: { id: x.req.id } })).feeStatus, 'held', 'a claim pays nothing');
  // Receiving is blocked while the exception is open.
  assert.equal((await x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 12 }] })).status, 409);
  const support = await operator(api, ['support']);
  assert.equal((await support.call('POST', `admin/logistics/shipments/${x.sh.id}/rule`, { outcome: 'delivered', evidence: 'appel au destinataire confirmé' })).status, 403);
  assert.equal((await x.ops.call('POST', `admin/logistics/shipments/${x.sh.id}/rule`, { outcome: 'delivered', evidence: 'court' })).status, 400);
  const r = ok(await x.ops.call('POST', `admin/logistics/shipments/${x.sh.id}/rule`, { outcome: 'delivered', evidence: 'appel au destinataire confirmé' }));
  assert.equal(r.deliveryProof, 'operator_ruling');
  assert.equal((await x.ops.call('POST', `admin/logistics/shipments/${x.sh.id}/rule`, { outcome: 'delivered', evidence: 'appel au destinataire confirmé' })).body.code, 'invalid_state', 'ruled once');
  assert.equal((await prisma.fulfilmentRequest.findUnique({ where: { id: x.req.id } })).feeStatus, 'released');
  assert.equal(await prisma.identityAuditEvent.count({ where: { action: 'shipment_exception_ruled', subjectId: x.sh.id, actorId: x.ops.id } }), 1);
  // Receiving after the ruling still records the facts (and credits stock once).
  ok(await x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/receiving`, { lines: [{ productId: x.sup.product.id, received: 12 }] }));
});

test('disputes: party opens, earning frozen; nobody but an operator resolves; money reversal needs a second (finance) operator, runs once', async () => {
  const x = await inTransit();
  const dc = ok(await x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'delivery' }));
  ok(await x.courier.call('POST', `logistics/shipments/${x.sh.id}/deliver`, { code: dc.code }));
  const e = await prisma.courierEarning.findUnique({ where: { shipmentId: x.sh.id } });
  await prisma.courierEarning.update({ where: { id: e.id }, data: { releasableAt: new Date(Date.now() - 1000) } });
  await promoteReleasableEarnings(prisma);
  assert.equal((await prisma.courierEarning.findUnique({ where: { id: e.id } })).status, 'releasable');

  const stranger = await jokkoCourier(api);
  assert.equal((await stranger.call('POST', `logistics/shipments/${x.sh.id}/dispute`, { reason: 'je veux un litige aussi' })).status, 404);
  const d = ok(await x.m.owner.call('POST', `logistics/shipments/${x.sh.id}/dispute`, { reason: 'colis livré incomplet, carton ouvert' }));
  assert.equal(d.openedByRole, 'receiver');
  assert.equal((await prisma.courierEarning.findUnique({ where: { id: e.id } })).status, 'accrued', 'frozen');
  assert.equal((await x.courier.call('POST', 'logistics/earnings/payout', {}, idem())).body.paidKori, 0);
  await promoteReleasableEarnings(prisma);
  assert.equal((await prisma.courierEarning.findUnique({ where: { id: e.id } })).status, 'accrued', 'stays frozen while disputed');
  // Evidence: parties only, append-only; the courier may answer.
  ok(await x.courier.call('POST', `logistics/disputes/${d.id}/evidence`, { content: 'photo du carton fermé à la remise', kind: 'photo_ref' }));
  assert.equal((await stranger.call('POST', `logistics/disputes/${d.id}/evidence`, { content: 'bruit' })).status, 404);
  const view = ok(await x.m.owner.call('GET', `logistics/disputes/${d.id}`));
  assert.equal(view.evidence.length, 1);
  assert.equal(view.evidence[0].userId, undefined, 'no counterpart user ids');
  await assert.rejects(prisma.shipmentDisputeEvidence.deleteMany({ where: { disputeId: d.id } }));
  // No user route resolves a dispute; support cannot; ops resolves with a reason.
  const support = await operator(api, ['support']);
  assert.equal((await support.call('POST', `admin/logistics/disputes/${d.id}/resolve`, { outcome: 'upheld_reverse', note: 'colis incomplet confirmé' })).status, 403);
  const res = ok(await x.ops.call('POST', `admin/logistics/disputes/${d.id}/resolve`, { outcome: 'upheld_reverse', note: 'colis incomplet confirmé par photos' }));
  assert.equal(res.dispute.status, 'awaiting_reversal');
  assert.ok(res.approval?.id, 'a maker/checker request was filed');
  assert.equal((await x.ops.call('POST', `admin/logistics/disputes/${d.id}/resolve`, { outcome: 'rejected', note: 'changement d’avis' })).body.code, 'already_resolved');
  // The same operator cannot approve; logistics_ops lacks the reverse permission anyway; finance_ops approves once.
  assert.equal((await x.ops.call('POST', `admin/approvals/${res.approval.id}/approve`, {})).status, 403);
  const sellerBefore = await bizBal(x.sup.b.id);
  const fin = await operator(api, ['finance_ops']);
  ok(await fin.call('POST', `admin/approvals/${res.approval.id}/approve`, {}), 'approve');
  assert.equal(await bizBal(x.sup.b.id), sellerBefore + 150, 'earning (120) and revenue (30) returned to the fee payer');
  assert.equal((await prisma.courierEarning.findUnique({ where: { id: e.id } })).status, 'reversed');
  assert.equal(await earnAcct(x.courier.id), 0n);
  const again = await fin.call('POST', `admin/approvals/${res.approval.id}/approve`, {});
  assert.ok(again.status === 200 || again.status === 409);
  assert.equal(await bizBal(x.sup.b.id), sellerBefore + 150, 'reversed once');
  assert.equal((await prisma.shipmentDispute.findUnique({ where: { id: d.id } })).status, 'resolved');
});

test('a suspended courier loses custody rights immediately; a courier can never carry a shipment to their own business', async () => {
  const x = await inTransit({ pickup: false });
  await prisma.accountRole.update({ where: { userId_role: { userId: x.courier.id, role: 'driver' } }, data: { status: 'suspended' } });
  const pc = ok(await x.sup.owner.call('POST', `logistics/shipments/${x.sh.id}/codes`, { purpose: 'pickup' }));
  assert.equal((await x.courier.call('POST', `logistics/shipments/${x.sh.id}/pickup`, { code: pc.code })).body.code, 'courier_inactive');
  ok(await x.ops.call('POST', `admin/logistics/shipments/${x.sh.id}/unassign`, { reason: 'coursier suspendu' }));
  // The buyer's owner, even if an approved courier, cannot be assigned their own delivery.
  await prisma.accountRole.upsert({ where: { userId_role: { userId: x.m.owner.id, role: 'driver' } }, create: { userId: x.m.owner.id, role: 'driver', status: 'active' }, update: { status: 'active' } });
  assert.equal((await x.ops.call('POST', `admin/logistics/shipments/${x.sh.id}/assign`, { courierUserId: x.m.owner.id })).body.code, 'courier_is_party');
});
