/**
 * J11.0 finding J11-F2 (branch escrow model, flag-gated, NOT in production 7d262de).
 * The organizer is forced to rotation position 1 by startTontine, and cancelTontine (organizer only,
 * any time) refunds only the CURRENT cycle. So: everyone pays cycle 1 → the organizer is paid the pot →
 * the organizer cancels in cycle 2 → members' cycle-1 money stays with the organizer.
 * Original result on the unfixed code (recorded in docs/JOKKO-J11-0-AUDIT.md): organizer +2000, members −1000 each.
 * After the fix (cancel refused once any pot was paid) this test asserts the drain is CLOSED.
 * It is evidence, not part of npm test.
 * Run: node --test docs/j11-evidence/repro-organizer-collect-then-cancel.test.js
 */
import '../../tests/helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createUserWithWallet, prisma } from '../../tests/helpers/db.js';
import { createTontine, respondToInvitation, startTontine, contribute, releaseCyclePayout, cancelTontine } from '../../lib/tontine-service.js';

after(() => prisma.$disconnect());
const bal = async (u) => (await prisma.wallet.findUnique({ where: { userId: u.id } })).koriBalance;

test('J11-F2 (fixed): after collecting cycle 1 the organizer can no longer cancel alone', async () => {
  const org = await createUserWithWallet({ koriBalance: 5000 });
  const a = await createUserWithWallet({ koriBalance: 5000 });
  const b = await createUserWithWallet({ koriBalance: 5000 });
  const g = await createTontine(org.id, { name: 'F2', amountPerMember: 10_000, frequency: 'mensuel', memberHandles: [a.handle, b.handle] });
  await respondToInvitation(g.id, a.id, true);
  await respondToInvitation(g.id, b.id, true);
  const started = await startTontine(g.id, org.id);
  const first = started.memberships.find((m) => m.rotationOrder === 0);
  assert.equal(first.userId, org.id, 'the organizer is forced to receive first');

  const before = { org: await bal(org), a: await bal(a), b: await bal(b) };
  for (const u of [org, a, b]) await contribute(g.id, u.id, { idempotencyKey: `c1-${u.id}` });
  await releaseCyclePayout(g.id, a.id); // anyone can trigger; destination is the rotation (organizer)
  await assert.rejects(cancelTontine(g.id, org.id), (e) => e.code === 'tontine_cancel_after_payout', 'cancel after a payout is refused');
  const after_ = { org: await bal(org), a: await bal(a), b: await bal(b) };
  const delta = { org: after_.org - before.org, a: after_.a - before.a, b: after_.b - before.b };
  console.log('deltas after the refused cancel (Kori):', delta);
  assert.equal(delta.org, 2000, 'the organizer received the cycle-1 pot (their turn) ...');
  assert.equal(delta.a, -1000, '... and every member still holds their remaining turns: the group continues');
  assert.equal((await prisma.tontineGroup.findUnique({ where: { id: g.id } })).status, 'active', 'not cancelled');
});
