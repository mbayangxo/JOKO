/**
 * J15 — found while reproducing P0-B under lab concurrency. On 7d262de two concurrent rulings (rider and
 * customer) both paid out of ONE escrow (docs/incidents/lab-p0). On the current branch the money is safe (both
 * paths lock the escrow and the ledger escrow account cannot go negative), but the losing ruling still
 * rewrote the record: a customer ruling that lost the race marked the dispute "resolved_customer" and the
 * delivery "cancelled" although the courier had been paid. The record must always match the money.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, operator, signedIn } from '../j3/helpers.js';

process.env.LEGACY_CONSUMER_DELIVERY_ENABLED = 'true'; // D41: the legacy courier marketplace, re-enabled for this test

let api;
before(async () => { api = await startApiServer({ ADMIN_API_KEY: '' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const bal = async (id) => (await prisma.wallet.findUnique({ where: { userId: id } })).koriBalance;

async function disputed() {
  const buyerC = await customer();
  await fundUser(buyerC.id, 5000);
  const buyer = await signedIn(api, buyerC);
  const riderC = await customer();
  await prisma.accountRole.upsert({ where: { userId_role: { userId: riderC.id, role: 'driver' } }, create: { userId: riderC.id, role: 'driver', status: 'active' }, update: { status: 'active' } });
  const rider = await signedIn(api, riderC);
  const d = await buyer.call('POST', 'deliveries', { pickupLabel: 'Boutique', pickupAddress: 'Rue 1', dropoffArea: 'Plateau', dropoffAddress: 'Rue 2' });
  const id = d.body.id;
  assert.equal((await rider.call('POST', `deliveries/${id}/accept`, {}, { headers: { 'idempotency-key': `k-${id}` } })).status, 201);
  await rider.call('POST', `deliveries/${id}/pickup`, {});
  await rider.call('POST', `deliveries/${id}/deliver`, {});
  assert.equal((await buyer.call('POST', `deliveries/${id}/dispute`, { note: 'jamais reçu' })).status, 201);
  return { id, buyerC, riderC };
}

test('concurrent operator rulings (rider ‖ customer): exactly one wins, money and record agree, one audit event', async () => {
  const risk = await operator(api, ['risk']);
  for (let round = 0; round < 15; round += 1) {
    const x = await disputed();
    const before = { rider: await bal(x.riderC.id), buyer: await bal(x.buyerC.id) };
    const rulings = await Promise.all(['rider', 'customer', 'rider', 'customer'].map((outcome) =>
      risk.call('POST', `admin/deliveries/${x.id}/dispute/resolve`, { outcome, resolutionNote: `course ${round} ${outcome}` })));
    const won = rulings.filter((r) => r.status === 200);
    assert.equal(won.length, 1, `round ${round}: ${rulings.map((r) => r.status).join(',')}`);
    const riderGain = (await bal(x.riderC.id)) - before.rider;
    const buyerGain = (await bal(x.buyerC.id)) - before.buyer;
    const escrow = await prisma.deliveryEscrow.findUnique({ where: { deliveryTaskId: x.id } });
    const dispute = await prisma.deliveryDispute.findUnique({ where: { deliveryTaskId: x.id } });
    const task = await prisma.deliveryTask.findUnique({ where: { id: x.id } });
    if (escrow.status === 'released') {
      assert.ok(riderGain > 0 && buyerGain === 0, `round ${round}: courier paid once, buyer not refunded`);
      assert.equal(dispute.status, 'resolved_rider', `round ${round}: the record says what the money did`);
      assert.equal(task.status, 'completed');
    } else {
      assert.equal(escrow.status, 'refunded', `round ${round}`);
      assert.ok(buyerGain > 0 && riderGain === 0, `round ${round}: buyer refunded once, courier not paid`);
      assert.equal(dispute.status, 'resolved_customer', `round ${round}`);
      assert.equal(task.status, 'cancelled');
    }
    assert.equal(await prisma.identityAuditEvent.count({ where: { action: 'delivery_dispute_resolved', subjectId: x.id } }), 1, `round ${round}: one ruling audited`);
  }
});
