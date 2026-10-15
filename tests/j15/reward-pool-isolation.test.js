/**
 * J15 — root cause of the historical J4 P2P failures (2026-10-09 01:43, journeys-pay #1/#2/#3/#7).
 * Evidence from the original database: in that run every P2P send also booked a `reward` (+2 ₭) from the
 * shared incentive pool, left funded by tests/money/torture.test.js (it funds 60 ₭ and pays 50 ₭ rewards,
 * leaving (start + 60) mod 50). The money was right; the tests' exact balances assumed an empty pool.
 * This test pins both halves: a funded pool pays exactly KORI_EARN.send from the pool (never minted), and
 * journeys-pay style net-of-rewards balances are exact whatever the pool holds.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { runMoneyTransaction } from '../../lib/wallet-atomic.js';
import { account, testFund } from '../../lib/money-kernel/flows.js';
import { KORI_EARN } from '../../lib/kori.js';
import { customer, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

const pool = async () => Number((await prisma.ledgerAccount.findUnique({ where: { code: 'incentives:funded' } }))?.balance ?? 0);
const avail = async (s) => (await s.call('GET', 'money/home')).body.balance.availableKori;

test('funded incentive pool: a P2P send pays the sender exactly KORI_EARN.send, from the pool only', async () => {
  await runMoneyTransaction(prisma, async (tx) => testFund(tx, { to: await account(tx, 'incentivesFunded'), amount: 10, reference: `POOL-J15-${Date.now()}` }));
  const a = await customer({ koriBalance: 0 });
  await fundUser(a.id, 5000);
  const A = await signedIn(api, a);
  const B = await signedIn(api, await customer());
  const poolBefore = await pool();
  assert.ok(poolBefore >= KORI_EARN.send);
  const r = await A.call('POST', 'transfers/send', { recipientHandle: B.handle, amount: 1200 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const reward = await prisma.journalEntry.findUnique({ where: { reference: `${r.body.reference}-EARN` } });
  assert.ok(reward, 'the funded pool paid a reward');
  assert.equal(reward.kind, 'reward');
  assert.equal(await pool(), poolBefore - KORI_EARN.send, 'the reward came out of the pool');
  assert.equal(await avail(A), 5000 - 1200 + KORI_EARN.send, 'debited once, rewarded once');
  assert.equal(await avail(B), 1200, 'the recipient gets exactly the amount');
  await assertInvariants(prisma);
});
