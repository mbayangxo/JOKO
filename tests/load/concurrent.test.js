import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { InsufficientFundsError, transferNational } from '../../lib/wallet-atomic.js';
import { startCashOut } from '../../lib/rail-service.js';
import {
  LOAD_CONCURRENCY,
  createUserWithWallet,
  prisma,
  retryTransient,
  runWithConcurrency,
  uniquePhone,
  uniqueRef,
} from '../helpers/db.js';

after(() => prisma.$disconnect());

const CONCURRENT_USERS = 1_000;
const SEND_AMOUNT = 250;
const STARTING_BALANCE = 1_000;

function loadTransaction(fn) {
  return prisma.$transaction(fn, { maxWait: 120_000, timeout: 60_000 });
}

test(`${CONCURRENT_USERS} users sending simultaneously: no lost money, no duplicates`, async () => {
  const recipient = await createUserWithWallet({ tier: 3, balance: 0 });

  const senders = Array.from({ length: CONCURRENT_USERS }, (_, i) => ({
    userId: crypto.randomUUID(),
    walletId: crypto.randomUUID(),
    index: i,
  }));

  await prisma.user.createMany({
    data: senders.map((s) => ({
      id: s.userId,
      phone: uniquePhone(),
      name: `Load Sender ${s.index}`,
      country: 'SN',
      verificationTier: 2,
      verificationStatus: 'cni_verified',
      cniVerifiedAt: new Date(),
    })),
  });
  await prisma.wallet.createMany({
    data: senders.map((s) => ({
      id: s.walletId,
      userId: s.userId,
      koriBalance: STARTING_BALANCE,
      currency: 'XOF',
    })),
  });

  // ₭ (koriBalance) is the only spendable balance — Wallet.balance is legacy.
  const totalBefore =
    (await prisma.wallet.aggregate({ _sum: { koriBalance: true } }))._sum.koriBalance ?? 0;

  const tasks = senders.map(
    (s) => () =>
      retryTransient(() =>
        loadTransaction((tx) =>
          transferNational(tx, {
            amount: SEND_AMOUNT,
            senderWalletId: s.walletId,
            recipientWalletId: recipient.wallet.id,
            senderUserId: s.userId,
            recipientUserId: recipient.id,
            reference: `LOAD-${s.userId}`,
            senderLedger: { type: 'send' },
            recipientLedger: { type: 'receive' },
          }),
        ),
      ),
  );

  const results = await runWithConcurrency(tasks, LOAD_CONCURRENCY);
  const failures = results.filter((r) => !r.ok);
  assert.equal(
    failures.length,
    0,
    `all sends must succeed; first error: ${failures[0]?.error?.message}`,
  );

  const recipientWallet = await prisma.wallet.findUnique({ where: { id: recipient.wallet.id } });
  assert.equal(recipientWallet.koriBalance, CONCURRENT_USERS * SEND_AMOUNT);

  const senderBalances = await prisma.wallet.findMany({
    where: { id: { in: senders.map((s) => s.walletId) } },
    select: { koriBalance: true },
  });
  assert.ok(
    senderBalances.every((w) => w.koriBalance === STARTING_BALANCE - SEND_AMOUNT),
    'every sender must end at exactly starting balance minus one send',
  );

  const totalAfter =
    (await prisma.wallet.aggregate({ _sum: { koriBalance: true } }))._sum.koriBalance ?? 0;
  assert.equal(totalAfter, totalBefore, 'total ₭ in the system must not change');

  const debitCount = await prisma.ledgerEntry.count({
    where: { reference: { in: senders.map((s) => `LOAD-${s.userId}`) } },
  });
  const creditCount = await prisma.ledgerEntry.count({
    where: { reference: { in: senders.map((s) => `LOAD-${s.userId}-R`) } },
  });
  assert.equal(debitCount, CONCURRENT_USERS);
  assert.equal(creditCount, CONCURRENT_USERS);
});

test('race on one wallet: concurrent overdraft attempts never push balance below zero', async () => {
  const AMOUNT = 500;
  const AFFORDABLE = 10;
  const ATTEMPTS = 30;

  const sender = await createUserWithWallet({ balance: AMOUNT * AFFORDABLE });
  const recipient = await createUserWithWallet({ tier: 3 });

  const tasks = Array.from({ length: ATTEMPTS }, (_, i) => () =>
    retryTransient(() =>
      loadTransaction((tx) =>
        transferNational(tx, {
          amount: AMOUNT,
          senderWalletId: sender.wallet.id,
          recipientWalletId: recipient.wallet.id,
          senderUserId: sender.id,
          recipientUserId: recipient.id,
          reference: uniqueRef(`RACE${i}`),
          senderLedger: { type: 'send' },
          recipientLedger: { type: 'receive' },
        }),
      ),
    ),
  );

  const results = await runWithConcurrency(tasks, LOAD_CONCURRENCY);
  const succeeded = results.filter((r) => r.ok).length;
  const insufficient = results.filter(
    (r) => !r.ok && r.error instanceof InsufficientFundsError,
  ).length;
  const transient = results.filter(
    (r) => !r.ok && !(r.error instanceof InsufficientFundsError),
  ).length;

  assert.equal(succeeded, AFFORDABLE, 'exactly the affordable number of sends succeed');
  assert.equal(
    insufficient + transient,
    ATTEMPTS - AFFORDABLE,
    'the rest fail cleanly (insufficient or transient proxy retry exhaustion)',
  );

  const wallet = await prisma.wallet.findUnique({ where: { id: sender.wallet.id } });
  assert.equal(wallet.koriBalance, 0, 'never below zero, never above');
  assert.ok(wallet.koriBalance >= 0, 'balance floor invariant');

  const recipientWallet = await prisma.wallet.findUnique({ where: { id: recipient.wallet.id } });
  assert.equal(recipientWallet.koriBalance, AMOUNT * succeeded);
});

test('duplicate submission storm: one idempotency key debits exactly once', async () => {
  const user = await createUserWithWallet({ balance: 100_000 });
  const idempotencyKey = `storm-${uniqueRef('KEY')}`;
  const params = {
    userId: user.id,
    wallet: user.wallet,
    country: 'SN',
    amount: 10_000,
    operator: 'wave',
    phone: user.phone,
    reference: uniqueRef('RAIL'),
    idempotencyKey,
  };

  const tasks = Array.from({ length: 10 }, () => () => retryTransient(() => startCashOut(prisma, { ...params })));
  const results = await runWithConcurrency(tasks, LOAD_CONCURRENCY);
  const failures = results.filter((r) => !r.ok);
  assert.equal(failures.length, 0, `no call should throw: ${failures[0]?.error?.message}`);

  assert.equal(
    await prisma.railTransaction.count({ where: { idempotencyKey } }),
    1,
    'exactly one rail transaction created for the key',
  );

  // 10 000 XOF cash-out = 1 000 ₭, held once at initiation.
  const wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.koriBalance, 99_000, 'wallet debited exactly once despite 10 submissions');
});
