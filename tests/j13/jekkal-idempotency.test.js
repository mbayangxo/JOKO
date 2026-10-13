/**
 * J13 step 1 (validates bb10ac2) — Jekkal donations are money: one intent key per attempt.
 * Real HTTP (NODE_ENV=production). Proves: concurrent duplicates of one attempt donate ONCE; a changed
 * amount cannot reuse the key; a lost reply is replayed (never re-executed); the intent lookup reports it;
 * two genuinely different attempts are two donations. J2 invariants after every test.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { customer, signedIn } from '../j3/helpers.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { intentOutcome } from '../../lib/api-idempotency.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const ok = (r, msg = '') => { assert.ok(r.status < 300, `${msg} ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const k = () => `intent-${crypto.randomBytes(8).toString('hex')}`;
const wallet = async (id) => prisma.wallet.findUnique({ where: { userId: id } });
const spent = async (id, w0) => { const w = await wallet(id); return (w0.balance - w.balance) + (w0.koriBalance - w.koriBalance); };

async function campaignAndDonor() {
  const creator = await signedIn(api, await customer({ koriBalance: 0 }));
  const c = ok(await creator.call('POST', 'jekkal/campaigns', { title: `Frais de scolarité ${k().slice(-5)}`, goalAmount: 50_000 }), 'campaign');
  const donor = await signedIn(api, await customer({ koriBalance: 50_000 }));
  return { c, donor };
}
const give = (donor, c, key, amount = 1000) => donor.call('POST', `jekkal/campaigns/${c.id}/contribute`, { amount }, { headers: { 'idempotency-key': key } });

test('10 concurrent duplicates of one donation attempt donate exactly once', async () => {
  const { c, donor } = await campaignAndDonor();
  const w0 = await wallet(donor.id);
  const key = k();
  const rs = await Promise.all(Array.from({ length: 10 }, () => give(donor, c, key)));
  const st = rs.map((r) => r.status);
  assert.ok(st.every((s) => s < 300 || s === 409), JSON.stringify(st));
  const once = await spent(donor.id, w0);
  assert.ok(once > 0, 'the donation happened');
  assert.equal(await prisma.solidarityContribution.count({ where: { campaignId: c.id } }), 1, 'one contribution row');
  // a later retry of the same attempt (lost reply) replays, never debits again
  const again = await give(donor, c, key);
  assert.ok(again.status < 300, JSON.stringify(again.body));
  assert.equal(await spent(donor.id, w0), once, 'still debited once');
  assert.equal((await intentOutcome(donor.id, key)).state, 'completed');
});

test('a changed amount can never reuse the key; different attempts are different donations', async () => {
  const { c, donor } = await campaignAndDonor();
  const w0 = await wallet(donor.id);
  const key = k();
  ok(await give(donor, c, key, 1000));
  const changed = await give(donor, c, key, 5000);
  assert.equal(changed.status, 422);
  assert.equal(changed.body.code, 'idempotency_key_reuse');
  const one = await spent(donor.id, w0);
  ok(await give(donor, c, k(), 1000), 'a second, deliberate donation (new attempt) goes through');
  assert.equal(await spent(donor.id, w0), one * 2);
});
