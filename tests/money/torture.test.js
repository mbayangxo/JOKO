/**
 * J2 Money Kernel destruction suite. Every scenario attacks exactly-once,
 * conservation or authorization, then runs the full invariant checker
 * (lib/money-kernel/invariants.js). The final state must reconcile.
 */
import '../helpers/setup.js';
import { test, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createUserWithWallet, prisma, uniqueRef, fundUser } from '../helpers/db.js';
import {
  LedgerConflictError,
  account,
  customer,
  customerToCustomer,
  move,
  post,
  testFund,
} from '../../lib/money-kernel/index.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { expireOverdue, transition } from '../../lib/money-kernel/external-ops.js';
import { approveAdjustment, importProviderStatement, requestAdjustment } from '../../lib/money-kernel/admin.js';
import { runMoneyTransaction, InsufficientFundsError } from '../../lib/wallet-atomic.js';
import { settleRailFromWebhook, startCashIn, startCashOut } from '../../lib/rail-service.js';
import { runPendingTransactionResolver } from '../../lib/cron/pending-transactions.js';
import { acceptDelivery, confirmDelivery, createDeliveryTask, markDelivered, markPickedUp, openDispute, resolveDispute } from '../../lib/delivery-service.js';
import { createTransferUndoInTx, undoTransfer } from '../../lib/transfer-undo-service.js';
import { cancelTontine, contribute, createTontine, respondToInvitation, startTontine } from '../../lib/tontine-service.js';
import { settleStripeDepositFromSession } from '../../lib/stripe-service.js';

const realFetch = globalThis.fetch;
const env0 = { ...process.env };
beforeEach(() => {
  delete process.env.JULAYA_API_KEY;
  delete process.env.JULAYA_API_KEY_SANDBOX;
  process.env.TONTINE_ESCROW_ENABLED = 'true';
  globalThis.fetch = realFetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env = { ...env0 };
  await assertInvariants(prisma); // after EVERY destructive scenario
});
after(() => prisma.$disconnect());

const kori = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).koriBalance;
const heldOf = async (userId) => Number((await prisma.ledgerAccount.findUnique({ where: { code: `customer:${userId}:held` } }))?.balance ?? 0);
const settledAll = (ps) => Promise.allSettled(ps);
const ok = (rs) => rs.filter((r) => r.status === 'fulfilled');

/** Scripted Julaya (sandbox key + fetch stub): initiate → `init`, status lookups → `status`. */
function julaya({ init = { status: 'pending' }, status = { status: 'pending' } } = {}) {
  process.env.JULAYA_API_KEY_SANDBOX = 'torture-sandbox-key';
  const state = { init, status, calls: 0 };
  globalThis.fetch = async (url, _opts) => {
    state.calls += 1;
    const u = String(url);
    const body = /collections|transfers/.test(u) ? state.init : state.status;
    if (body === 'timeout') return new Promise((_r, rej) => setTimeout(() => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), 5));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return state;
}
const rail = (user, amount, extra = {}) => ({ userId: user.id, wallet: user.wallet, country: 'SN', amount, operator: 'wave', phone: user.phone, reference: uniqueRef('TRT'), ...extra });

// ---------------------------------------------------------------------------

test('100 simultaneous spends against one balance: exactly the affordable ones succeed, never negative', async () => {
  const payer = await createUserWithWallet({ koriBalance: 500 });
  const payee = await createUserWithWallet({ koriBalance: 0 });
  const rs = await settledAll(
    Array.from({ length: 100 }, (_, i) =>
      runMoneyTransaction(prisma, (tx) => customerToCustomer(tx, { fromUserId: payer.id, toUserId: payee.id, amount: 10, reference: uniqueRef(`SP${i}`), kind: 'p2p_transfer' })),
    ),
  );
  assert.equal(ok(rs).length, 50);
  assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof InsufficientFundsError));
  assert.equal(await kori(payer.id), 0);
  assert.equal(await kori(payee.id), 500);
});

test('insufficient-funds race with uneven amounts: total debited never exceeds the balance', async () => {
  const payer = await createUserWithWallet({ koriBalance: 1_000 });
  const payee = await createUserWithWallet({ koriBalance: 0 });
  const amounts = Array.from({ length: 40 }, () => crypto.randomInt(1, 120));
  const rs = await settledAll(amounts.map((a, i) =>
    runMoneyTransaction(prisma, (tx) => customerToCustomer(tx, { fromUserId: payer.id, toUserId: payee.id, amount: a, reference: uniqueRef(`IR${i}`), kind: 'p2p_transfer' })),
  ));
  const paid = rs.reduce((s, r, i) => s + (r.status === 'fulfilled' ? amounts[i] : 0), 0);
  assert.ok(paid <= 1_000);
  assert.equal(await kori(payer.id), 1_000 - paid);
  assert.equal(await kori(payee.id), paid);
});

test('duplicate P2P (same business reference, concurrent): one movement, every caller sees the same entry', async () => {
  const a = await createUserWithWallet({ koriBalance: 300 });
  const b = await createUserWithWallet({ koriBalance: 0 });
  const reference = uniqueRef('DUP');
  const rs = await settledAll(Array.from({ length: 10 }, () =>
    runMoneyTransaction(prisma, (tx) => customerToCustomer(tx, { fromUserId: a.id, toUserId: b.id, amount: 100, reference, kind: 'p2p_transfer' })),
  ));
  assert.equal(ok(rs).length, 10);
  assert.equal(new Set(ok(rs).map((r) => r.value.entry.id)).size, 1);
  assert.equal(await kori(a.id), 200);
  assert.equal(await prisma.journalEntry.count({ where: { reference } }), 1);
});

test('same idempotency reference with a different payload is refused (conflict), nothing moves', async () => {
  const a = await createUserWithWallet({ koriBalance: 300 });
  const b = await createUserWithWallet({ koriBalance: 0 });
  const reference = uniqueRef('IDEM');
  await runMoneyTransaction(prisma, (tx) => customerToCustomer(tx, { fromUserId: a.id, toUserId: b.id, amount: 100, reference, kind: 'p2p_transfer' }));
  await assert.rejects(
    runMoneyTransaction(prisma, (tx) => customerToCustomer(tx, { fromUserId: a.id, toUserId: b.id, amount: 150, reference, kind: 'p2p_transfer' })),
    LedgerConflictError,
  );
  assert.equal(await kori(a.id), 200);
});

test('duplicate cash-in webhook (10 concurrent "completed"): credited exactly once', async () => {
  julaya({ init: { status: 'pending', id: uniqueRef('ext') } });
  const u = await createUserWithWallet({ koriBalance: 0 });
  const r = await startCashIn(prisma, rail(u, 10_000));
  assert.equal(r.rail.status, 'pending');
  const ext = r.rail.externalId;
  await settledAll(Array.from({ length: 10 }, () => settleRailFromWebhook(prisma, { reference: r.rail.reference, status: 'completed', externalId: ext })));
  assert.equal(await kori(u.id), 1_000);
  assert.equal(await prisma.journalEntry.count({ where: { reference: `${r.rail.reference}-CONFIRM` } }), 1);
});

test('duplicate cash-out callback (concurrent): ₭ retired exactly once, hold never released twice', async () => {
  julaya({ init: { status: 'pending', id: uniqueRef('ext') } });
  const u = await createUserWithWallet({ koriBalance: 5_000 });
  const r = await startCashOut(prisma, rail(u, 20_000));
  assert.equal(await kori(u.id), 3_000);
  assert.equal(await heldOf(u.id), 2_000);
  await settledAll(Array.from({ length: 8 }, () => settleRailFromWebhook(prisma, { reference: r.rail.reference, status: 'completed', externalId: r.rail.externalId })));
  assert.equal(await heldOf(u.id), 0);
  assert.equal(await kori(u.id), 3_000);
  assert.equal(await prisma.journalEntry.count({ where: { reference: `${r.rail.reference}-CONFIRM` } }), 1);
});

test('out-of-order callbacks: completed, then pending, then failed → stays confirmed, no refund', async () => {
  julaya({ init: { status: 'pending', id: uniqueRef('ext') } });
  const u = await createUserWithWallet({ koriBalance: 5_000 });
  const r = await startCashOut(prisma, rail(u, 10_000));
  const ref = r.rail.reference;
  await settleRailFromWebhook(prisma, { reference: ref, status: 'completed', externalId: r.rail.externalId });
  await settleRailFromWebhook(prisma, { reference: ref, status: 'pending', externalId: r.rail.externalId });
  await settleRailFromWebhook(prisma, { reference: ref, status: 'failed', externalId: r.rail.externalId, failureReason: 'late' });
  const op = await prisma.externalOperation.findUnique({ where: { reference: ref } });
  assert.equal(op.state, 'confirmed');
  assert.equal(await kori(u.id), 4_000, 'no refund after confirmation');
  assert.equal(await prisma.journalEntry.count({ where: { reference: `${ref}-RELEASE` } }), 0);
});

test('provider timeout, deadline passes (expired = review, nothing credited), later success credits once', async () => {
  julaya({ init: 'timeout' });
  const u = await createUserWithWallet({ koriBalance: 0 });
  const r = await startCashIn(prisma, rail(u, 5_000));
  const ref = r.rail.reference;
  await prisma.$executeRawUnsafe(`UPDATE "ExternalOperation" SET "outcomeDeadline" = now() - interval '1 minute' WHERE reference = '${ref}'`);
  await expireOverdue(prisma);
  let op = await prisma.externalOperation.findUnique({ where: { reference: ref } });
  assert.equal(op.state, 'expired');
  assert.equal(await kori(u.id), 0, 'a timeout is not a confirmation');
  await settleRailFromWebhook(prisma, { reference: ref, status: 'completed', externalId: uniqueRef('late') });
  op = await prisma.externalOperation.findUnique({ where: { reference: ref } });
  assert.equal(op.state, 'confirmed');
  assert.equal(await kori(u.id), 500);
});

test('provider acceptance is not settlement: "submitted" credits nothing', async () => {
  julaya({ init: { status: 'pending', id: uniqueRef('ext') } });
  const u = await createUserWithWallet({ koriBalance: 0 });
  const r = await startCashIn(prisma, rail(u, 5_000));
  const op = await prisma.externalOperation.findUnique({ where: { reference: r.rail.reference } });
  assert.equal(op.state, 'submitted');
  assert.equal(await kori(u.id), 0);
});

test('provider failure after authorization: hold released exactly once (concurrent failure signals)', async () => {
  julaya({ init: { status: 'pending', id: uniqueRef('ext') } });
  const u = await createUserWithWallet({ koriBalance: 3_000 });
  const r = await startCashOut(prisma, rail(u, 10_000));
  assert.equal(await kori(u.id), 2_000);
  await settledAll(Array.from({ length: 6 }, () => settleRailFromWebhook(prisma, { reference: r.rail.reference, status: 'failed', externalId: r.rail.externalId, failureReason: 'MNO down' })));
  assert.equal(await kori(u.id), 3_000);
  assert.equal(await heldOf(u.id), 0);
  assert.equal(await prisma.journalEntry.count({ where: { reference: `${r.rail.reference}-RELEASE` } }), 1);
});

test('different keys, same provider reference: the second operation cannot claim it (no double credit)', async () => {
  const shared = uniqueRef('SHARED');
  julaya({ init: { status: 'pending', id: shared } });
  const u = await createUserWithWallet({ koriBalance: 0 });
  const first = await startCashIn(prisma, rail(u, 2_000));
  julaya({ init: { status: 'pending' } });
  const second = await startCashIn(prisma, rail(u, 2_000));
  await settleRailFromWebhook(prisma, { reference: first.rail.reference, status: 'completed', externalId: shared });
  await settleRailFromWebhook(prisma, { reference: second.rail.reference, status: 'completed', externalId: shared });
  assert.equal(await kori(u.id), 200, 'one provider transaction credits once');
  const ex = await prisma.reconciliationException.findFirst({ where: { kind: 'provider_reference_conflict', providerReference: shared } });
  assert.ok(ex, 'conflict recorded for reconciliation');
});

test('DB/process failure between postings: nothing persists; a one-sided posting is refused at COMMIT', async () => {
  const a = await createUserWithWallet({ koriBalance: 500 });
  const b = await createUserWithWallet({ koriBalance: 0 });
  const reference = uniqueRef('CRASH');
  await assert.rejects(
    runMoneyTransaction(prisma, async (tx) => {
      await customerToCustomer(tx, { fromUserId: a.id, toUserId: b.id, amount: 200, reference, kind: 'p2p_transfer' });
      throw new Error('process crashed after posting');
    }),
    /process crashed/,
  );
  assert.equal(await kori(a.id), 500);
  assert.equal(await prisma.journalEntry.count({ where: { reference } }), 0);

  await assert.rejects(
    runMoneyTransaction(prisma, async (tx) => {
      const acc = await customer(tx, b.id);
      const e = await tx.journalEntry.create({ data: { reference: uniqueRef('HALF'), kind: 'crash', payloadHash: 'x', actorType: 'system' } });
      await tx.posting.create({ data: { entryId: e.id, accountId: acc.id, side: 'credit', amount: 999n, currency: 'KRI' } });
    }),
    /does not balance|at least 2/,
  );
  assert.equal(await kori(b.id), 0);
});

test('repeated worker execution (resolver + expiry run concurrently, many times): same outcome', async () => {
  julaya({ init: { status: 'pending', id: uniqueRef('ext') }, status: { status: 'completed', amount: 3_000, currency: 'XOF' } });
  const u = await createUserWithWallet({ koriBalance: 0 });
  const r = await startCashIn(prisma, rail(u, 3_000));
  await prisma.$executeRawUnsafe(`UPDATE "RailTransaction" SET "createdAt" = now() - interval '40 minutes' WHERE reference = '${r.rail.reference}'`);
  await settledAll([...Array.from({ length: 5 }, () => runPendingTransactionResolver(prisma)), ...Array.from({ length: 5 }, () => expireOverdue(prisma))]);
  await runPendingTransactionResolver(prisma);
  assert.equal(await kori(u.id), 300);
  assert.equal(await prisma.journalEntry.count({ where: { reference: `${r.rail.reference}-CONFIRM` } }), 1);
});

test('application restart halfway through a pending payout: state survives, completion applies once', async () => {
  julaya({ init: { status: 'pending', id: uniqueRef('ext') } });
  const u = await createUserWithWallet({ koriBalance: 4_000 });
  const r = await startCashOut(prisma, rail(u, 10_000));
  // "Restart": a brand-new client/connection pool picks up from the database.
  const { PrismaClient } = await import('@prisma/client');
  const fresh = new PrismaClient();
  try {
    const op = await fresh.externalOperation.findUnique({ where: { reference: r.rail.reference } });
    assert.equal(op.state, 'submitted');
    await settleRailFromWebhook(fresh, { reference: r.rail.reference, status: 'completed', externalId: r.rail.externalId });
    await settleRailFromWebhook(fresh, { reference: r.rail.reference, status: 'completed', externalId: r.rail.externalId });
  } finally {
    await fresh.$disconnect();
  }
  assert.equal(await kori(u.id), 3_000);
  assert.equal(await heldOf(u.id), 0);
});

test('provider reversal after confirmation: inverse entry; a spent shortfall goes to suspense, never negative', async () => {
  julaya({ init: { status: 'pending', id: uniqueRef('ext') } });
  const u = await createUserWithWallet({ koriBalance: 0 });
  const other = await createUserWithWallet({ koriBalance: 0 });
  const r = await startCashIn(prisma, rail(u, 10_000));
  await settleRailFromWebhook(prisma, { reference: r.rail.reference, status: 'completed', externalId: r.rail.externalId });
  await runMoneyTransaction(prisma, (tx) => customerToCustomer(tx, { fromUserId: u.id, toUserId: other.id, amount: 700, reference: uniqueRef('SPEND'), kind: 'p2p_transfer' }));
  const op = await prisma.externalOperation.findUnique({ where: { reference: r.rail.reference } });
  await runMoneyTransaction(prisma, (tx) => transition(tx, op.id, 'reversed', { source: 'webhook', failureReason: 'chargeback' }));
  assert.equal(await kori(u.id), 0);
  const ex = await prisma.reconciliationException.findFirst({ where: { kind: 'reversal_shortfall', operationId: op.id } });
  assert.equal(Number(ex.amountMinor), 700);
});

test('refund twice (escrow refund raced by two dispute rulings): buyer refunded once', async () => {
  const { buyer, rider, task } = await deliveryFixture();
  await acceptDelivery(prisma, { taskId: task.id, riderId: rider.id, reference: uniqueRef('ESC') });
  await markPickedUp(prisma, { taskId: task.id, riderId: rider.id });
  await markDelivered(prisma, { taskId: task.id, riderId: rider.id });
  await openDispute(prisma, { taskId: task.id, buyerId: buyer.id, note: 'lost' });
  await settledAll([1, 2, 3].map(() => resolveDispute(prisma, { taskId: task.id, outcome: 'customer', resolutionNote: 'refund' })));
  assert.equal(await kori(buyer.id), 1_000);
  assert.equal(await kori(rider.id), 0);
});

test('escrow release twice (concurrent confirmations): rider paid once', async () => {
  const { buyer, rider, task } = await deliveryFixture();
  await acceptDelivery(prisma, { taskId: task.id, riderId: rider.id, reference: uniqueRef('ESC') });
  await markPickedUp(prisma, { taskId: task.id, riderId: rider.id });
  await markDelivered(prisma, { taskId: task.id, riderId: rider.id });
  await settledAll(Array.from({ length: 5 }, () => confirmDelivery(prisma, { taskId: task.id, buyerId: buyer.id })));
  assert.equal(await kori(rider.id), 150);
  assert.equal(await kori(buyer.id), 850);
});

test('refund concurrent with cash-out: the customer can never spend the same ₭ twice', async () => {
  julaya({ init: { status: 'pending', id: uniqueRef('ext') } });
  const { buyer, rider, task } = await deliveryFixture({ buyerKori: 1_000 });
  await acceptDelivery(prisma, { taskId: task.id, riderId: rider.id, reference: uniqueRef('ESC') });
  await markPickedUp(prisma, { taskId: task.id, riderId: rider.id });
  await markDelivered(prisma, { taskId: task.id, riderId: rider.id });
  await openDispute(prisma, { taskId: task.id, buyerId: buyer.id, note: 'x' });
  // Buyer has 850 spendable + 150 in escrow; a 1 000 ₭ cash-out races the escrow refund.
  const [refund, cashOut] = await settledAll([
    resolveDispute(prisma, { taskId: task.id, outcome: 'customer', resolutionNote: 'refund' }),
    startCashOut(prisma, rail(buyer, 10_000)),
  ]);
  assert.equal(refund.status, 'fulfilled');
  const spendable = await kori(buyer.id);
  const held = await heldOf(buyer.id);
  assert.equal(spendable + held, 1_000, 'value conserved');
  assert.ok(held === 0 || held === 1_000, 'cash-out either fully held (after refund) or refused');
  if (cashOut.status === 'rejected') assert.equal(held, 0);
});

test('reversal (undo) concurrent with the recipient spending: exactly one wins, nothing negative', async () => {
  const s = await createUserWithWallet({ koriBalance: 1_000 });
  const r = await createUserWithWallet({ koriBalance: 0 });
  const third = await createUserWithWallet({ koriBalance: 0 });
  const reference = uniqueRef('P2P');
  await runMoneyTransaction(prisma, async (tx) => {
    await customerToCustomer(tx, { fromUserId: s.id, toUserId: r.id, amount: 600, reference, kind: 'p2p_transfer' });
    await createTransferUndoInTx(tx, { senderUserId: s.id, recipientUserId: r.id, amount: 600, originalReference: reference, recipientReference: `${reference}-R` });
  });
  const [undo, spend] = await settledAll([
    undoTransfer(prisma, { reference, userId: s.id }),
    runMoneyTransaction(prisma, (tx) => customerToCustomer(tx, { fromUserId: r.id, toUserId: third.id, amount: 600, reference: uniqueRef('SPEND'), kind: 'p2p_transfer' })),
  ]);
  assert.equal([undo, spend].filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal((await kori(s.id)) + (await kori(r.id)) + (await kori(third.id)), 1_000);
  // A second undo is impossible (unique reversesId).
  await assert.rejects(undoTransfer(prisma, { reference, userId: s.id }));
});

test('tontine collection concurrent with the member spending the same funds: one wins, pot reconciles', async () => {
  const creator = await createUserWithWallet({ koriBalance: 1_000 });
  const member = await createUserWithWallet({ koriBalance: 500 });
  const sink = await createUserWithWallet({ koriBalance: 0 });
  const group = await createTontine(creator.id, { name: 'Race', amountPerMember: 500, frequency: 'mensuel', memberHandles: [member.handle] });
  await respondToInvitation(group.id, member.id, true);
  await startTontine(group.id, creator.id);
  const [contrib, spend] = await settledAll([
    contribute(group.id, member.id, { idempotencyKey: uniqueRef('IK') }),
    runMoneyTransaction(prisma, (tx) => customerToCustomer(tx, { fromUserId: member.id, toUserId: sink.id, amount: 500, reference: uniqueRef('SPEND'), kind: 'p2p_transfer' })),
  ]);
  assert.equal([contrib, spend].filter((x) => x.status === 'fulfilled').length, 1);
  const pot = (await prisma.tontineGroup.findUnique({ where: { id: group.id } })).potBalance;
  assert.equal(pot + (await kori(member.id)) + (await kori(sink.id)), 500);
  await cancelTontine(group.id, creator.id);
});

test('agent cash-out concurrent with an ordinary cash-out of the same ₭: only one is funded', async () => {
  julaya({ init: { status: 'pending', id: uniqueRef('ext') } });
  const u = await createUserWithWallet({ koriBalance: 1_000 });
  const { createAgentProfile, createAgentWithdrawSession, confirmAgentWithdraw } = await import('../../lib/agent-service.js');
  const agentUser = await createUserWithWallet({ koriBalance: 0 });
  const agent = await createAgentProfile({ userId: agentUser.id, displayName: 'Torture agent', initialFloat: 0, floatLimit: 500_000 });
  const w = await createAgentWithdrawSession(u.id, 10_000);
  const [agentRes, railRes] = await settledAll([
    confirmAgentWithdraw(w.id ?? w.withdrawal?.id, agentUser.id),
    startCashOut(prisma, rail(u, 10_000)),
  ]);
  const funded = [agentRes, railRes].filter((x) => x.status === 'fulfilled' && !(x.value?.rail?.status === 'failed')).length;
  assert.equal(funded, 1, `agent=${agentRes.status} rail=${railRes.status}`);
  assert.equal((await kori(u.id)) + (await heldOf(u.id)) <= 1_000, true);
  assert.ok(agent);
});

test('rewards never create value: no funded budget → no reward; funded → paid from the budget only', async () => {
  const { creditKoriEarn } = await import('../../lib/kori-service.js');
  const u = await createUserWithWallet({ koriBalance: 0 });
  const pool = await prisma.ledgerAccount.findUnique({ where: { code: 'incentives:funded' } });
  const start = Number(pool?.balance ?? 0);
  if (start === 0) {
    const paid = await runMoneyTransaction(prisma, (tx) => creditKoriEarn(tx, u.id, u.wallet.id, 'refer_friend', uniqueRef('EARN')));
    assert.equal(paid, 0);
  }
  // Fund 60 ₭ (test treasury path) and race 5 rewards of 50.
  await runMoneyTransaction(prisma, async (tx) => testFund(tx, { to: await account(tx, 'incentivesFunded'), amount: 60, reference: uniqueRef('POOL') }));
  const rs = await settledAll(Array.from({ length: 5 }, () => runMoneyTransaction(prisma, (tx) => creditKoriEarn(tx, u.id, u.wallet.id, 'refer_friend', uniqueRef('EARN')))));
  const paid = rs.filter((r) => r.status === 'fulfilled').reduce((s, r) => s + r.value, 0);
  assert.equal(paid, 50 * Math.floor((start + 60) / 50), 'exactly what the budget covers');
  assert.ok(paid <= start + 60, 'never more than the budget');
});

test('Stripe webhook replayed 5× concurrently: one operation, one credit, own provider clearing', async () => {
  const u = await createUserWithWallet({ koriBalance: 0 });
  const ref = uniqueRef('STR');
  await prisma.stripeDeposit.create({ data: { userId: u.id, amountXof: 20_000, amountEurCents: 3049, reference: ref } });
  const session = { id: uniqueRef('cs'), payment_intent: uniqueRef('pi'), metadata: { k21Reference: ref } };
  await settledAll(Array.from({ length: 5 }, () => settleStripeDepositFromSession(session)));
  assert.equal(await kori(u.id), 2_000);
  const op = await prisma.externalOperation.findUnique({ where: { reference: ref } });
  assert.equal(op.provider, 'stripe');
  assert.equal(op.state, 'confirmed');
});

test('statement import: matched → settled exactly once (re-import is a no-op); mismatches become exceptions', async () => {
  const ext = uniqueRef('ext');
  julaya({ init: { status: 'pending', id: ext } });
  const u = await createUserWithWallet({ koriBalance: 0 });
  const r = await startCashIn(prisma, rail(u, 7_000));
  await settleRailFromWebhook(prisma, { reference: r.rail.reference, status: 'completed', externalId: ext });
  const rows = [
    { id: ext, direction: 'in', amount: 7_000, currency: 'XOF' },
    { id: uniqueRef('ghost'), direction: 'in', amount: 999, currency: 'XOF' },
  ];
  const statementId = uniqueRef('STM');
  const first = await importProviderStatement(prisma, { provider: 'julaya', statementId, rows });
  const again = await importProviderStatement(prisma, { provider: 'julaya', statementId, rows });
  assert.equal(first.settled, 1);
  assert.equal(first.exceptions, 1);
  assert.equal(again.duplicates, 2);
  const op = await prisma.externalOperation.findUnique({ where: { reference: r.rail.reference } });
  assert.equal(op.state, 'settled');
  assert.equal(await prisma.journalEntry.count({ where: { reference: `${r.rail.reference}-SETTLE` } }), 1);
});

test('admin adjustment: no single-admin money movement; dual approval posts once; legacy key refused', async () => {
  const u = await createUserWithWallet({ koriBalance: 0 });
  await runMoneyTransaction(prisma, async (tx) => testFund(tx, { to: await account(tx, 'refundsBudget'), amount: 500, reference: uniqueRef('RB') }));
  const req = await requestAdjustment(prisma, 'admin-A', {
    idempotencyKey: uniqueRef('ADJ'), debitAccount: 'platform:refunds', creditAccount: `customer:${u.id}:available`, amount: 300, reason: 'Goodwill for failed delivery',
  });
  await assert.rejects(approveAdjustment(prisma, 'admin-A', req.id), /second, different admin/);
  await assert.rejects(approveAdjustment(prisma, 'legacy-api-key', req.id), /named, TOTP-verified admin/);
  assert.equal(await kori(u.id), 0);
  await settledAll([1, 2, 3].map(() => approveAdjustment(prisma, 'admin-B', req.id)));
  assert.equal(await kori(u.id), 300);
  assert.equal(await prisma.journalEntry.count({ where: { reference: `adjustment:${req.id}` } }), 1);
  await assert.rejects(requestAdjustment(prisma, 'admin-A', {
    idempotencyKey: uniqueRef('ADJ'), debitAccount: 'platform:refunds', creditAccount: `customer:${u.id}:available`, amount: 10_000_000, reason: 'over the policy cap',
  }), /capped/);
});

test('cross-user debit without authorization is refused by the kernel', async () => {
  const victim = await createUserWithWallet({ koriBalance: 500 });
  const thief = await createUserWithWallet({ koriBalance: 0 });
  await assert.rejects(
    runMoneyTransaction(prisma, async (tx) =>
      move(tx, { from: await customer(tx, victim.id), to: await customer(tx, thief.id), amount: 100, reference: uniqueRef('THEFT'), kind: 'p2p_transfer', actor: { type: 'user', id: thief.id } }),
    ),
    /authorization basis/,
  );
  assert.equal(await kori(victim.id), 500);
});

test('journal is append-only: posted entries cannot be edited or deleted', async () => {
  const a = await createUserWithWallet({ koriBalance: 100 });
  const entry = await prisma.journalEntry.findFirst({ where: { kind: 'test_funding' }, orderBy: { createdAt: 'desc' } });
  await assert.rejects(prisma.journalEntry.update({ where: { id: entry.id }, data: { reason: 'edited' } }), /append-only/);
  await assert.rejects(prisma.journalEntry.delete({ where: { id: entry.id } }), /append-only/);
  await assert.rejects(prisma.posting.deleteMany({ where: { entryId: entry.id } }), /append-only/);
  assert.ok(a);
});

// ---------------------------------------------------------------------------

async function deliveryFixture({ fee = 1500, buyerKori = 1000 } = {}) {
  const buyer = await createUserWithWallet({ koriBalance: buyerKori });
  const rider = await createUserWithWallet({ koriBalance: 0 });
  await prisma.accountRole.create({ data: { userId: rider.id, role: 'driver', status: 'active' } });
  const merchant = await createUserWithWallet();
  const business = await prisma.business.create({ data: { ownerId: merchant.id, name: 'Torture shop', type: 'merchant' } });
  const order = await prisma.order.create({ data: { buyerId: buyer.id, businessId: business.id, totalAmount: 1000, status: 'paid', orderReference: uniqueRef('ORD') } });
  const task = await createDeliveryTask(prisma, { orderId: order.id, buyerId: buyer.id, dropoffArea: 'Plateau', dropoffAddress: 'Rue 1', deliveryFeeNational: fee });
  return { buyer, rider, task };
}

// keep imports used
void fundUser;
void post;
