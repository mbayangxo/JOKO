import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  InsufficientFundsError,
  WalletNotFoundError,
  creditNational,
  debitNational,
  runMoneyTransaction,
  transferKori,
  transferNational,
} from '../../lib/wallet-atomic.js';
import { account, customerHeld } from '../../lib/money-kernel/index.js';
import { createUserWithWallet, prisma, uniqueRef } from '../helpers/db.js';

after(() => prisma.$disconnect());

function transferParams(sender, recipient, amount, reference) {
  return {
    amount,
    senderWalletId: sender.wallet.id,
    recipientWalletId: recipient.wallet.id,
    senderUserId: sender.id,
    recipientUserId: recipient.id,
    reference,
    senderLedger: { type: 'send', counterpartyName: recipient.name },
    recipientLedger: { type: 'receive', counterpartyName: sender.name },
  };
}

test('transfer debits sender and credits recipient atomically with both ledger rows', async () => {
  const sender = await createUserWithWallet({ balance: 10_000 });
  const recipient = await createUserWithWallet({ balance: 500 });
  const ref = uniqueRef('TX');

  await runMoneyTransaction(prisma, (tx) => transferNational(tx, transferParams(sender, recipient, 3_000, ref)));

  const s = await prisma.wallet.findUnique({ where: { id: sender.wallet.id } });
  const r = await prisma.wallet.findUnique({ where: { id: recipient.wallet.id } });
  assert.equal(s.koriBalance, 7_000);
  assert.equal(r.koriBalance, 3_500);

  const entries = await prisma.ledgerEntry.findMany({ where: { reference: { startsWith: ref } } });
  assert.equal(entries.length, 2);
  const amounts = entries.map((e) => e.amount).sort((a, b) => a - b);
  assert.deepEqual(amounts, [-3_000, 3_000], 'ledger double-entry must net to zero');
});

test('balance cannot go below zero — insufficient transfer rolls back entirely', async () => {
  const sender = await createUserWithWallet({ balance: 1_000 });
  const recipient = await createUserWithWallet();
  const ref = uniqueRef('TX');

  await assert.rejects(
    runMoneyTransaction(prisma, (tx) => transferNational(tx, transferParams(sender, recipient, 1_001, ref))),
    InsufficientFundsError,
  );

  const s = await prisma.wallet.findUnique({ where: { id: sender.wallet.id } });
  const r = await prisma.wallet.findUnique({ where: { id: recipient.wallet.id } });
  assert.equal(s.koriBalance, 1_000, 'sender keeps their money');
  assert.equal(r.koriBalance, 0, 'recipient receives nothing');
  assert.equal(await prisma.ledgerEntry.count({ where: { reference: { startsWith: ref } } }), 0);
});

test('exact-balance transfer succeeds and lands on zero, not below', async () => {
  const sender = await createUserWithWallet({ balance: 2_500 });
  const recipient = await createUserWithWallet();

  await runMoneyTransaction(prisma, (tx) =>
    transferNational(tx, transferParams(sender, recipient, 2_500, uniqueRef('TX'))),
  );

  const s = await prisma.wallet.findUnique({ where: { id: sender.wallet.id } });
  assert.equal(s.koriBalance, 0);

  await assert.rejects(
    runMoneyTransaction(prisma, (tx) => transferNational(tx, transferParams(sender, recipient, 1, uniqueRef('TX')))),
    InsufficientFundsError,
  );
});

test('Kori transfer enforces Kori balance floor', async () => {
  const sender = await createUserWithWallet({ koriBalance: 100 });
  const recipient = await createUserWithWallet();

  await assert.rejects(
    runMoneyTransaction(prisma, (tx) =>
      transferKori(tx, {
        amountKori: 101,
        senderWalletId: sender.wallet.id,
        recipientWalletId: recipient.wallet.id,
        senderId: sender.id,
        recipientId: recipient.id,
        reference: uniqueRef('KTX'),
      }),
    ),
    InsufficientFundsError,
  );

  const s = await prisma.wallet.findUnique({ where: { id: sender.wallet.id } });
  assert.equal(s.koriBalance, 100);
});

test('failure AFTER debit rolls back the debit (crash mid-transaction)', async () => {
  const user = await createUserWithWallet({ balance: 5_000 });
  const ref = uniqueRef('TX');

  await assert.rejects(
    runMoneyTransaction(prisma, async (tx) => {
      await debitNational(tx, {
        walletId: user.wallet.id,
        userId: user.id,
        amount: 4_000,
        reference: ref,
        ledger: { type: 'cash_out' },
        to: await customerHeld(tx, user.id),
      });
      throw new Error('simulated crash after debit, before partner call');
    }),
    /simulated crash/,
  );

  const w = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(w.koriBalance, 5_000, 'debit must be rolled back');
  assert.equal(await prisma.ledgerEntry.count({ where: { reference: ref } }), 0);
});

test('creditNational is idempotent by reference — no double credit', async () => {
  const user = await createUserWithWallet({ balance: 0 });
  const ref = uniqueRef('DEP');
  const params = {
    walletId: user.wallet.id,
    userId: user.id,
    amount: 2_000,
    reference: ref,
    ledger: { type: 'cash_in' },
  };

  // J2: a credit always names its source account (here the test faucet).
  await runMoneyTransaction(prisma, async (tx) => creditNational(tx, { ...params, from: await account(tx, 'testFaucet') }));
  await runMoneyTransaction(prisma, async (tx) => creditNational(tx, { ...params, from: await account(tx, 'testFaucet') }));

  const w = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(w.koriBalance, 2_000, 'replayed credit with same reference must be a no-op');
  assert.equal(await prisma.ledgerEntry.count({ where: { reference: ref } }), 1);
});

test('transfer to unknown wallet fails without debiting sender', async () => {
  const sender = await createUserWithWallet({ balance: 1_000 });

  await assert.rejects(
    runMoneyTransaction(prisma, (tx) =>
      transferNational(tx, {
        amount: 100,
        senderWalletId: 'nonexistent-wallet-id',
        recipientWalletId: sender.wallet.id,
        senderUserId: 'ghost',
        recipientUserId: sender.id,
        reference: uniqueRef('TX'),
        senderLedger: { type: 'send' },
        recipientLedger: { type: 'receive' },
      }),
    ),
    WalletNotFoundError,
  );
});
