/**
 * Database-level guarantees of the Money Kernel — each proven by trying to
 * break it directly (bypassing the application).
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { createUserWithWallet, prisma, uniqueRef } from '../helpers/db.js';
import { account, customer, testFund } from '../../lib/money-kernel/index.js';
import { createOperation, transition } from '../../lib/money-kernel/external-ops.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';

after(() => prisma.$disconnect());

const newOp = (tx, user, direction = 'in') =>
  createOperation(tx, {
    provider: 'julaya', direction, reference: uniqueRef('OPG'), amountMinor: 1_000, currency: 'XOF',
    userId: user.id, accountCode: `customer:${user.id}:available`, providerMode: 'sandbox',
  });

test('invalid state transitions are refused by the database (even by raw SQL)', async () => {
  const u = await createUserWithWallet();
  const op = await prisma.$transaction((tx) => newOp(tx, u));
  await assert.rejects(prisma.$executeRawUnsafe(`UPDATE "ExternalOperation" SET state = 'settled' WHERE id = '${op.id}'`), /invalid external operation transition/);
  await assert.rejects(prisma.$executeRawUnsafe(`UPDATE "ExternalOperation" SET "amountMinor" = 999999 WHERE id = '${op.id}'`), /immutable/);
  await assert.rejects(prisma.externalOperation.delete({ where: { id: op.id } }), /never deleted/);
});

test('a confirmed state without its ledger entry is refused at COMMIT (no "paid" label on unmoved money)', async () => {
  const u = await createUserWithWallet();
  const op = await prisma.$transaction(async (tx) => {
    const o = await newOp(tx, u);
    await transition(tx, o.id, 'submitted', { source: 'api' });
    return o;
  });
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "ExternalOperation" SET state = 'confirmed' WHERE id = '${op.id}'`),
    /without a confirmation entry/,
  );
  assert.equal((await prisma.wallet.findUnique({ where: { userId: u.id } })).koriBalance, 0);
});

test('a cash-out cannot be marked authorized without actually holding the funds', async () => {
  const u = await createUserWithWallet({ koriBalance: 100 });
  const op = await prisma.$transaction((tx) => newOp(tx, u, 'out'));
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "ExternalOperation" SET state = 'authorized' WHERE id = '${op.id}'`),
    /without a hold entry/,
  );
});

test('accounts open at zero and projections are created at zero — value only via postings', async () => {
  await assert.rejects(
    prisma.ledgerAccount.create({ data: { code: uniqueRef('acct'), type: 'x', currency: 'KRI', normalSide: 'credit', balance: 500n } }),
    /must open at 0/,
  );
  const u = await prisma.user.create({ data: { phone: `+221779${Date.now() % 1_000_000}`, handle: uniqueRef('h').toLowerCase().slice(0, 20) } });
  await assert.rejects(prisma.wallet.create({ data: { userId: u.id, koriBalance: 50 } }), /must be created at 0/);
});

test('the test faucet is refused in production', async () => {
  const u = await createUserWithWallet();
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(
      prisma.$transaction((tx) => testFund(tx, { userId: u.id, amount: 10, reference: uniqueRef('PRODFAUCET') })),
      /never available in production/,
    );
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('posting currency must match the account currency', async () => {
  const u = await createUserWithWallet({ koriBalance: 10 });
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const acct = await customer(tx, u.id);
      const xof = await account(tx, 'cashOffice', 'office', 'XOF');
      const e = await tx.journalEntry.create({ data: { reference: uniqueRef('CUR'), kind: 'x', payloadHash: 'x', actorType: 'system' } });
      await tx.posting.createMany({ data: [
        { entryId: e.id, accountId: acct.id, side: 'credit', amount: 5n, currency: 'XOF' },
        { entryId: e.id, accountId: xof.id, side: 'debit', amount: 5n, currency: 'XOF' },
      ] });
    }),
    /does not match account/,
  );
});

test('invariants hold after the guard attacks', async () => {
  await assertInvariants(prisma);
});
