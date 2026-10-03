import '../helpers/setup.js';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { settleRailFromWebhook, startCashIn, startCashOut } from '../../lib/rail-service.js';
import { RAIL_PROCESSING_MESSAGE } from '../../lib/external-fetch.js';
import { createUserWithWallet, prisma, resetReserveToWallets, uniqueRef } from '../helpers/db.js';

const realFetch = globalThis.fetch;

beforeEach(async () => {
  delete process.env.JULAYA_API_KEY;
  delete process.env.JULAYA_API_KEY_SANDBOX;
  globalThis.fetch = realFetch;
  await resetReserveToWallets();
});

after(async () => {
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
});

function railParams(user, amount, overrides = {}) {
  return {
    userId: user.id,
    wallet: user.wallet,
    country: 'SN',
    amount,
    operator: 'orange_money',
    phone: user.phone,
    reference: uniqueRef('RAIL'),
    ...overrides,
  };
}

test('full cash-in in Julaya sandbox: wallet credited, Kori minted, reserve backed, ledger written', async () => {
  const user = await createUserWithWallet({ balance: 0, koriBalance: 0 });
  const result = await startCashIn(prisma, railParams(user, 10_000));

  assert.equal(result.rail.status, 'completed');
  assert.equal(result.mint.koriMinted, 1_000);
  assert.equal(result.wallet.balance, 0);
  assert.equal(result.wallet.koriBalance, 1_000);

  const ledger = await prisma.ledgerEntry.findUnique({ where: { reference: result.rail.reference } });
  assert.equal(ledger.type, 'cash_in');
  assert.equal(ledger.amount, 1_000);

  // J2: backing is the provider's confirmed obligation (clearing), linked to the operation.
  const op = await prisma.externalOperation.findUnique({ where: { reference: result.rail.reference } });
  assert.equal(op.state, 'confirmed');
  const confirm = await prisma.journalEntry.findUnique({ where: { reference: `${result.rail.reference}-CONFIRM` }, include: { postings: { include: { account: true } } } });
  assert.equal(confirm.externalOperationId, op.id);
  const clearing = confirm.postings.find((p) => p.account.type === 'ext_clearing_in');
  assert.equal(Number(clearing.amount), 10_000);
});

test('full cash-out in Julaya sandbox: wallet debited exactly once, rail completed', async () => {
  const user = await createUserWithWallet({ balance: 0, koriBalance: 5_000 });

  const result = await startCashOut(prisma, railParams(user, 20_000));

  assert.equal(result.rail.status, 'completed');
  assert.equal(result.rail.walletDebited, true);
  assert.equal(result.wallet.koriBalance, 3_000);

  const ledger = await prisma.ledgerEntry.findUnique({ where: { reference: result.rail.reference } });
  assert.equal(ledger.type, 'cash_out');
  assert.equal(ledger.amount, -2_000);
});

test('replaying the same idempotency key returns the cached result — no double spend', async () => {
  const user = await createUserWithWallet({ balance: 0, koriBalance: 5_000 });
  const idempotencyKey = `replay-${uniqueRef('KEY')}`;

  const first = await startCashOut(prisma, railParams(user, 10_000, { idempotencyKey }));
  const second = await startCashOut(prisma, railParams(user, 10_000, { idempotencyKey }));

  assert.equal(first.cached ?? false, false);
  assert.equal(second.cached, true);
  assert.equal(second.rail.reference, first.rail.reference);

  const wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.koriBalance, 4_000, 'only one debit despite two calls');
  assert.equal(await prisma.railTransaction.count({ where: { idempotencyKey } }), 1);
});

test('Julaya API timeout: transaction stays PENDING and the funds stay HELD (cannot be double-spent)', async () => {
  process.env.JULAYA_API_KEY_SANDBOX = 'test-sandbox-key';
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });

  const user = await createUserWithWallet({ balance: 0, koriBalance: 5_000 });
  const result = await startCashOut(prisma, railParams(user, 20_000));

  assert.equal(result.rail.status, 'pending');
  // J1: cash-out funds are held at initiation. Leaving them spendable while the
  // payout may still complete allowed a proven double-spend (spend, then payout).
  assert.equal(result.rail.walletDebited, true);
  assert.equal(result.userMessage, RAIL_PROCESSING_MESSAGE);

  const wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.koriBalance, 3_000, 'ambiguous outcome: 2 000 ₭ held exactly once, not refunded, not spendable');
});

test('Julaya explicit rejection marks the rail failed without debiting', async () => {
  process.env.JULAYA_API_KEY_SANDBOX = 'test-sandbox-key';
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ message: 'Invalid recipient phone' }),
  });

  const user = await createUserWithWallet({ balance: 0, koriBalance: 5_000 });
  const result = await startCashOut(prisma, railParams(user, 20_000));

  assert.equal(result.rail.status, 'failed');
  assert.equal(result.rail.failureReason, 'Invalid recipient phone');

  const wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.koriBalance, 5_000);
});

test('webhook settles a pending cash-out: debit happens exactly once, replays are no-ops', async () => {
  process.env.JULAYA_API_KEY_SANDBOX = 'test-sandbox-key';
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });

  const user = await createUserWithWallet({ balance: 0, koriBalance: 5_000 });
  const extId = uniqueRef('julaya-ext');
  const pending = await startCashOut(prisma, railParams(user, 20_000));
  assert.equal(pending.rail.status, 'pending');

  const settled = await settleRailFromWebhook(prisma, {
    reference: pending.rail.reference,
    status: 'completed',
    externalId: extId,
  });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.walletDebited, true);

  let wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.koriBalance, 3_000);

  // Partner retries the webhook — must not debit again.
  await settleRailFromWebhook(prisma, {
    reference: pending.rail.reference,
    status: 'completed',
    externalId: extId,
  });
  wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.koriBalance, 3_000, 'webhook replay must be idempotent');
});

test('webhook settles a pending cash-in: funds + Kori credited exactly once', async () => {
  const user = await createUserWithWallet({ balance: 0, koriBalance: 0 });
  const reference = uniqueRef('RAIL');
  await prisma.railTransaction.create({
    data: {
      userId: user.id,
      direction: 'in',
      amount: 10_000,
      operator: 'wave',
      phone: user.phone,
      status: 'pending',
      reference,
    },
  });

  await settleRailFromWebhook(prisma, { reference, status: 'success', externalId: 'jx-2' });
  await settleRailFromWebhook(prisma, { reference, status: 'success', externalId: 'jx-2' });

  const wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.koriBalance, 1_000);
});

test('failed webhook on an already-debited cash-out refunds the wallet', async () => {
  const user = await createUserWithWallet({ balance: 0, koriBalance: 3_000 });
  const reference = uniqueRef('RAIL');
  // Rail was debited earlier, then the partner reports terminal failure.
  await prisma.railTransaction.create({
    data: {
      userId: user.id,
      direction: 'out',
      amount: 20_000,
      status: 'pending',
      walletDebited: true,
      reference,
    },
  });

  const settled = await settleRailFromWebhook(prisma, {
    reference,
    status: 'failed',
    failureReason: 'Operator unavailable',
  });
  assert.equal(settled.status, 'failed');

  const wallet = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
  assert.equal(wallet.koriBalance, 5_000, 'debited amount returned to the user');
});
