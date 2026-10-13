/**
 * P0-B (delivery-dispute ruling open to ordinary users) — containment probe on the CURRENT production base
 * b0318b5 (= 7d262de + P0-A) + emergency-7d262de.patch. Every caller, every outcome, with or without the
 * shared key: 403 operator_required, and no escrow/dispute/wallet row changes.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createUserWithWallet, mockReq, mockRes, prisma } from '../helpers/db.js';
import { deliveriesDisputeResolve } from '../../lib/handlers.js';

after(async () => { await prisma.$disconnect(); });
const call = async (opts) => { const req = mockReq(opts); const res = mockRes(); await deliveriesDisputeResolve(req, res); return res; };
const snapshot = async () => ({
  escrows: await prisma.deliveryEscrow.findMany({ orderBy: { id: 'asc' } }),
  disputes: await prisma.deliveryDispute.findMany({ orderBy: { id: 'asc' } }),
  wallets: (await prisma.wallet.findMany({ orderBy: { userId: 'asc' }, select: { userId: true, balance: true, koriBalance: true } })),
});

test('P0-B contained on b0318b5: nobody can rule a delivery dispute through the user route', async () => {
  const stranger = await createUserWithWallet({ balance: 0, koriBalance: 0 });
  const before = await snapshot();
  for (const outcome of ['rider', 'customer']) {
    for (const headers of [{}, { 'x-admin-key': 'guess' }, { 'x-admin-key': process.env.ADMIN_API_KEY ?? '' }]) {
      const r = await call({ userId: stranger.id, query: { id: 'any-delivery' }, body: { outcome, note: 'probe' }, headers });
      assert.equal(r.statusCode, 403);
      assert.equal(r.body.code, 'operator_required');
    }
  }
  assert.deepEqual(await snapshot(), before, 'no escrow, dispute or wallet changed');
});
