/**
 * J8.0 P0 regression: a delivery dispute ruling moves the escrowed fee, so it
 * is an operator decision. The legacy USER route `POST deliveries/:id/dispute/resolve`
 * used to accept any signed-in caller whenever the retired ADMIN_API_KEY was
 * unset — the courier could rule for themselves and take the buyer's fee.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, operator, signedIn } from '../j3/helpers.js';
// D41: the legacy open-claim courier marketplace is off by default; these tests cover it explicitly re-enabled.
process.env.LEGACY_CONSUMER_DELIVERY_ENABLED = 'true';

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
  return { id, buyer, buyerC, rider, riderC };
}

test('nobody rules a delivery dispute through the user route — courier, buyer, stranger, with or without the retired admin key', async () => {
  const x = await disputed();
  const stranger = await signedIn(api, await customer());
  const before = { rider: await bal(x.riderC.id), buyer: await bal(x.buyerC.id) };
  for (const [who, outcome] of [[x.rider, 'rider'], [x.buyer, 'customer'], [stranger, 'rider'], [stranger, 'customer']]) {
    const r = await who.call('POST', `deliveries/${x.id}/dispute/resolve`, { outcome }, { headers: { 'x-admin-key': 'anything' } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'operator_required');
  }
  assert.deepEqual({ rider: await bal(x.riderC.id), buyer: await bal(x.buyerC.id) }, before, 'no money moved');
  assert.equal((await prisma.deliveryEscrow.findUnique({ where: { deliveryTaskId: x.id } })).status, 'disputed_held');
});

test('operator ruling: needs deliveries.disputes.resolve (risk), a reason, and is audited; support cannot', async () => {
  const x = await disputed();
  const support = await operator(api, ['support']);
  assert.equal((await support.call('POST', `admin/deliveries/${x.id}/dispute/resolve`, { outcome: 'rider', resolutionNote: 'preuve photo reçue' })).status, 403);
  const risk = await operator(api, ['risk']);
  assert.equal((await risk.call('POST', `admin/deliveries/${x.id}/dispute/resolve`, { outcome: 'customer' })).status, 400, 'reason required');
  const before = await bal(x.buyerC.id);
  const r = await risk.call('POST', `admin/deliveries/${x.id}/dispute/resolve`, { outcome: 'customer', resolutionNote: 'aucune preuve de remise' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal(x.buyerC.id), before + 150, 'escrowed fee refunded once');
  const again = await risk.call('POST', `admin/deliveries/${x.id}/dispute/resolve`, { outcome: 'rider', resolutionNote: 'deuxième décision' });
  assert.ok(again.status >= 400, 'a ruling is final');
  assert.equal(await prisma.identityAuditEvent.count({ where: { action: 'delivery_dispute_resolved', subjectId: x.id } }), 1);
});
