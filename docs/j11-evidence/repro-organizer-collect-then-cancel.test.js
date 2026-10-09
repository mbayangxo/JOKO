/**
 * J11.0 finding J11-F2 (branch escrow model, flag-gated, NOT in production 7d262de).
 * The organizer is forced to rotation position 1 by startTontine, and cancelTontine (organizer only,
 * any time) refunds only the CURRENT cycle. So: everyone pays cycle 1 → the organizer is paid the pot →
 * the organizer cancels in cycle 2 → members' cycle-1 money stays with the organizer.
 * This test DOCUMENTS the current behaviour (it asserts the loss). It is evidence, not part of npm test.
 * Run: node --test docs/j11-evidence/repro-organizer-collect-then-cancel.test.js
 */
import '../../tests/helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createUserWithWallet, prisma } from '../../tests/helpers/db.js';
import { createTontine, respondToInvitation, startTontine, contribute, releaseCyclePayout, cancelTontine } from '../../lib/tontine-service.js';

after(() => prisma.$disconnect());
const bal = async (u) => (await prisma.wallet.findUnique({ where: { userId: u.id } })).koriBalance;

test('J11-F2: organizer collects cycle 1 first, then cancels; members lose their cycle-1 contribution', async () => {
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
  const cancelled = await cancelTontine(g.id, org.id); // cycle 2, nobody has paid yet
  const after_ = { org: await bal(org), a: await bal(a), b: await bal(b) };

  const delta = { org: after_.org - before.org, a: after_.a - before.a, b: after_.b - before.b };
  console.log('deltas (Kori):', delta, 'cancel:', cancelled?.status ?? cancelled);
  assert.equal(delta.org, 2000, 'organizer nets +2 contributions');
  assert.equal(delta.a, -1000, 'member a loses a contribution with no future turn');
  assert.equal(delta.b, -1000, 'member b loses a contribution with no future turn');
  assert.equal(delta.org + delta.a + delta.b, 0, 'no money created or destroyed: a transfer to the organizer');
});
