/**
 * J15-L6 — found by the L6 soak (seed 9003: one payer's key booked on two charges). Execution was deduplicated per
 * (user, route path, key), but intent lookup, void and crash recovery resolve a key per (user, key): the ledger
 * carries `user:key`, not the route. A key reused on a second operation therefore ran a second time, and a crash of
 * that second run would have been reported "completed" from the FIRST run's ledger entry although nothing moved.
 * One key is now one intent per user across every route: reuse on another operation is refused (422), nothing moves.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { business, customer, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

const key = () => `lab-${crypto.randomBytes(8).toString('hex')}`;
const paidEntries = (code) => prisma.journalEntry.count({ where: { kind: 'charge_payment', reference: { startsWith: `charge:${code}` } } });

async function setup() {
  const owner = await signedIn(api, await customer({ koriBalance: 0 }));
  const biz = await business(owner);
  const p = await customer({ koriBalance: 0 });
  await fundUser(p.id, 5000);
  const payer = await signedIn(api, p);
  const charge = async (amountKori) => {
    const r = await owner.call('POST', 'money/charges', { businessId: biz.id, amountKori });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.code;
  };
  return { owner, payer, charge };
}

test('a key already used for one charge is refused on another charge: nothing paid, the first still replays', async () => {
  const { payer, charge } = await setup();
  const k = key();
  const c1 = await charge(300);
  const c2 = await charge(400);
  const first = await payer.call('POST', `money/charges/${c1}/pay`, { expectedAmountKori: 300 }, { headers: { 'idempotency-key': k } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const reuse = await payer.call('POST', `money/charges/${c2}/pay`, { expectedAmountKori: 400 }, { headers: { 'idempotency-key': k } });
  assert.equal(reuse.status, 422, JSON.stringify(reuse.body));
  assert.equal(reuse.body.code, 'idempotency_key_reuse');
  assert.equal(await paidEntries(c2), 0, 'the second charge was not paid');
  assert.equal((await prisma.merchantCharge.findUnique({ where: { code: c2 } })).status, 'open');
  const replay = await payer.call('POST', `money/charges/${c1}/pay`, { expectedAmountKori: 300 }, { headers: { 'idempotency-key': k } });
  assert.equal(replay.headers['idempotent-replay'], 'true');
  assert.equal(await paidEntries(c1), 1);
  const told = await payer.call('GET', `money/intents/${k}`);
  assert.equal(told.body.state, 'completed');
  assert.deepEqual(told.body.references.map((r) => r.startsWith(`charge:${c1}`)), [true], 'the intent names only the first payment');
  await assertInvariants(prisma);
});

test('a key used for a charge is refused on another route (transfers/send): nothing moves', async () => {
  const { owner, payer, charge } = await setup();
  const k = key();
  const c1 = await charge(250);
  assert.equal((await payer.call('POST', `money/charges/${c1}/pay`, { expectedAmountKori: 250 }, { headers: { 'idempotency-key': k } })).status, 201);
  const before = await prisma.journalEntry.count({ where: { kind: 'p2p_transfer' } });
  const send = await payer.call('POST', 'transfers/send', { recipientHandle: owner.handle, amount: 100 }, { headers: { 'idempotency-key': k } });
  assert.equal(send.status, 422, JSON.stringify(send.body));
  assert.equal(await prisma.journalEntry.count({ where: { kind: 'p2p_transfer' } }), before);
  await assertInvariants(prisma);
});

test('the same key on two charges at the same moment: at most one is paid, and only a paid one is reported paid', async () => {
  for (let round = 0; round < 6; round += 1) {
    const { payer, charge } = await setup();
    const k = key();
    const [c1, c2] = [await charge(120), await charge(130)];
    const rs = await Promise.all([
      payer.call('POST', `money/charges/${c1}/pay`, { expectedAmountKori: 120 }, { headers: { 'idempotency-key': k } }),
      payer.call('POST', `money/charges/${c2}/pay`, { expectedAmountKori: 130 }, { headers: { 'idempotency-key': k } }),
    ]);
    const paid = [await paidEntries(c1), await paidEntries(c2)];
    assert.ok(paid[0] + paid[1] <= 1, `round ${round}: one key paid ${paid[0] + paid[1]} charges`);
    rs.forEach((r, i) => {
      if (r.status < 300) assert.equal(paid[i], 1, `round ${round}: reported paid but not paid`);
      else assert.equal(paid[i], 0, `round ${round}: refused (${r.status}) but paid`);
    });
  }
  await assertInvariants(prisma);
});
