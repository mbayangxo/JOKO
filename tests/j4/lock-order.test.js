/**
 * J4 item P — second soak finding: lock-order inversion. The kernel locks
 * LedgerAccount rows and its trigger then updates the Wallet projection;
 * legacy callers that locked the Wallet row FIRST (lockWallets / agent /
 * tontine / fund / voucher locks) could deadlock against a concurrent
 * kernel posting on the same wallet (Postgres 40P01). Deterministic: the
 * legacy-style transaction holds its lock while the kernel transfer starts.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { createUserWithWallet, fundUser, prisma } from '../helpers/db.js';
import { lockWallets, transferNational } from '../../lib/wallet-atomic.js';
import { checkInvariants } from '../../lib/money-kernel/invariants.js';

after(async () => { await prisma.$disconnect(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const send = (tx, from, to, amount, reference) =>
  transferNational(tx, {
    amount,
    senderWalletId: from.wallet.id,
    recipientWalletId: to.wallet.id,
    senderUserId: from.id,
    recipientUserId: to.id,
    reference,
    senderLedger: { type: 'send' },
    recipientLedger: { type: 'receive' },
  });

test('a legacy wallet pre-lock + kernel posting never deadlocks against a concurrent third-party kernel transfer into that wallet', { timeout: 120_000 }, async () => {
  for (let i = 0; i < 5; i++) {
    // a: the customer a legacy flow pre-locks (tontine contribution / agent
    // cash-in style), paying b; c: a third party paying a at the same time.
    const a = await createUserWithWallet({ koriBalance: 0 });
    const b = await createUserWithWallet({ koriBalance: 0 });
    const c = await createUserWithWallet({ koriBalance: 0 });
    await fundUser(a.id, 100);
    await fundUser(c.id, 100);
    const tag = `${Date.now()}-${i}`;
    let locked;
    const lockedP = new Promise((r) => { locked = r; });
    const legacy = prisma.$transaction(async (tx) => {
      await lockWallets(tx, [a.wallet.id]);
      locked();
      await sleep(300); // the kernel transfer below starts while we hold the lock
      await send(tx, a, b, 10, `LOCK-A-${tag}`);
    }, { timeout: 20_000 });
    await lockedP;
    const kernel = prisma.$transaction((tx) => send(tx, c, a, 5, `LOCK-C-${tag}`), { timeout: 20_000 });
    const results = await Promise.allSettled([legacy, kernel]);
    const errs = results.filter((r) => r.status === 'rejected').map((r) => `${r.reason?.code ?? ''} ${String(r.reason?.message).slice(-200)}`);
    assert.deepEqual(errs, [], 'no deadlock / no failure');
    assert.equal((await prisma.wallet.findUnique({ where: { id: a.wallet.id } })).koriBalance, 95);
    assert.equal((await prisma.wallet.findUnique({ where: { id: b.wallet.id } })).koriBalance, 10);
    assert.equal((await prisma.wallet.findUnique({ where: { id: c.wallet.id } })).koriBalance, 95);
  }
  assert.equal((await checkInvariants(prisma)).ok, true);
});
