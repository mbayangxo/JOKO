/**
 * J11-F7 / P-J11-5 safe default: collective money never pushes a wallet beyond its KYC-tier balance cap.
 * Rules are refused when a full pot exceeds the lowest member's cap; a payout with no headroom is HELD in
 * the pot (never forced, never lost) and pays once there is room.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import * as C from '../../lib/collective/engine.js';
import { checkCollectiveInvariants } from '../../lib/collective/invariants.js';

process.env.JOKKO_COLLECTIVE_ENABLED = 'true';
after(async () => {
  const r = await checkCollectiveInvariants();
  assert.ok(r.ok, JSON.stringify(r.violations));
  await prisma.$disconnect();
});
const key = () => crypto.randomBytes(8).toString('hex');
async function formed(us, contributionKori) {
  const [org, ...rest] = us;
  const g = await C.createGroup(org.id, { kind: 'rotating', name: `Cap-${key().slice(0, 4)}`, contributionKori, frequency: 'weekly', rotationMethod: 'fixed' });
  await C.inviteMembers(g.id, org.id, rest.map((u) => u.handle));
  for (const u of rest) await C.respondToInvite(g.id, u.id, true);
  return g.id;
}

test('rules are refused when a full pot would exceed the lowest member’s tier cap', async () => {
  const org = await createUserWithWallet({ koriBalance: 3000, tier: 2 });
  const phoneOnly = await createUserWithWallet({ koriBalance: 3000, tier: 1 }); // cap 5 000 ₭
  const third = await createUserWithWallet({ koriBalance: 3000, tier: 2 });
  const id = await formed([org, phoneOnly, third], 2000); // pot 6 000 > 5 000
  await assert.rejects(C.proposeRules(id, org.id, { order: [org.id, phoneOnly.id, third.id], startAt: new Date(Date.now() + 1000) }), (e) => e.code === 'exceeds_tier_cap');
});

test('a complete pot that would overflow the recipient’s cap is held, then pays when there is headroom', async () => {
  const rec = await createUserWithWallet({ koriBalance: 199_000, tier: 2 }); // cap 200 000
  const b = await createUserWithWallet({ koriBalance: 5000, tier: 2 });
  const c = await createUserWithWallet({ koriBalance: 5000, tier: 2 });
  const id = await formed([rec, b, c], 1000);
  const p = await C.proposeRules(id, rec.id, { order: [rec.id, b.id, c.id], startAt: new Date(Date.now() + 1000) });
  for (const u of [rec, b, c]) await C.acceptRules(id, u.id, { rulesHash: p.rulesHash });
  for (const u of [rec, b, c]) {
    const r = await C.contribute(id, u.id, { idempotencyKey: key() });
    assert.equal(r.payout, null, 'no automatic payout into an over-cap wallet');
  }
  await assert.rejects(C.releaseCycle(id, b.id), (e) => e.code === 'recipient_cap');
  assert.equal(Number((await prisma.ledgerAccount.findUnique({ where: { code: `collective:${id}:pot` } })).balance), 3000, 'the pot is held, not lost');
  // The recipient makes room (here: a plain transfer out of their own wallet) → the rules pay out.
  const { customerToCustomer } = await import('../../lib/money-kernel/flows.js');
  const { runMoneyTransaction } = await import('../../lib/wallet-atomic.js');
  await runMoneyTransaction(prisma, (tx) => customerToCustomer(tx, { fromUserId: rec.id, toUserId: b.id, amount: 5000, reference: `CAP-${key()}`, kind: 'test_transfer' }));
  const paid = await C.releaseCycle(id, b.id);
  assert.equal(paid.amountKori, 3000);
  assert.equal(paid.recipientId, rec.id);
});
