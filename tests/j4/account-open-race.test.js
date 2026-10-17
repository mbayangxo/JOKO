/**
 * J4 item P — root cause of the intermittent ~1/1000 concurrent-send failure:
 * the first credits to a brand-new recipient race to open its ledger account.
 * `ON CONFLICT ("code")` did not cover the second unique index
 * ("projTable","projId"), so the losing transfer failed with 23505.
 * Here every trial sends concurrently to a fresh recipient — no retries.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { createUserWithWallet, fundUser, prisma } from '../helpers/db.js';
import { transferNational } from '../../lib/wallet-atomic.js';
import { checkInvariants } from '../../lib/money-kernel/invariants.js';

after(async () => { await prisma.$disconnect(); });

test('concurrent first credits to a new recipient all succeed (no 23505 on account open), exactly once each', { timeout: 300_000 }, async () => {
  const TRIALS = 25;
  const PER = 8;
  const failures = [];
  for (let t = 0; t < TRIALS; t++) {
    const recipient = await createUserWithWallet({ koriBalance: 0, tier: 3 });
    const senders = await Promise.all(Array.from({ length: PER }, () => createUserWithWallet({ koriBalance: 0, tier: 2 })));
    for (const s of senders) await fundUser(s.id, 100);
    const results = await Promise.allSettled(
      senders.map((s) =>
        prisma.$transaction((tx) =>
          transferNational(tx, {
            amount: 40,
            senderWalletId: s.wallet.id,
            recipientWalletId: recipient.wallet.id,
            senderUserId: s.id,
            recipientUserId: recipient.id,
            reference: `RACE-${s.id}`,
            senderLedger: { type: 'send' },
            recipientLedger: { type: 'receive' },
          }),
        ),
      ),
    );
    for (const r of results) if (r.status === 'rejected') failures.push(`${r.reason?.code ?? ''} ${r.reason?.meta?.code ?? ''} ${String(r.reason?.message).slice(-160)}`);
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal((await prisma.wallet.findUnique({ where: { id: recipient.wallet.id } })).koriBalance, okCount * 40, 'no lost or duplicated money');
    assert.equal(await prisma.ledgerAccount.count({ where: { ownerId: recipient.id, type: { startsWith: 'customer' } } }) >= 1, true);
  }
  assert.deepEqual(failures, []);
  assert.equal((await checkInvariants(prisma)).ok, true);
});
