/**
 * J12-F12 / P-J12-4 — balance-by-SMS is opt-in and PIN-confirmed. No SMS can move money.
 * Real HTTP (NODE_ENV=production) for the preference; the inbound keyword handler is called directly
 * (no SMS provider or webhook secret is configured in tests; nothing is sent anywhere).
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { customer, signedIn, stepUp } from '../j3/helpers.js';
import { handleInboundSms } from '../../lib/sms-service.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

test('a new account does not answer SOLDE by SMS until its owner opts in with the PIN', async () => {
  const c = await customer({ koriBalance: 4321 });
  assert.equal((await prisma.user.findUnique({ where: { id: c.id } })).smsBalanceQueryEnabled, false, 'off by default');
  const off = await handleInboundSms({ from: c.phone, text: 'SOLDE', provider: 'mock' });
  assert.ok(!String(off.reply).includes('4321') && !String(off.reply).includes('4 321'), 'no balance disclosed while off');

  const s = await signedIn(api, c);
  const noPin = await s.call('POST', 'sms/preferences', { smsBalanceQueryEnabled: true });
  assert.equal(noPin.status, 403);
  assert.equal(noPin.body.code, 'step_up_required');
  assert.equal((await prisma.user.findUnique({ where: { id: c.id } })).smsBalanceQueryEnabled, false);

  const withPin = await s.call('POST', 'sms/preferences', { smsBalanceQueryEnabled: true }, { headers: { 'x-step-up-token': await stepUp(s) } });
  assert.equal(withPin.status, 200, JSON.stringify(withPin.body));
  assert.equal(withPin.body.smsBalanceQueryEnabled, true);

  const turnOff = await s.call('POST', 'sms/preferences', { smsBalanceQueryEnabled: false });
  assert.equal(turnOff.status, 200, 'switching off never needs the PIN');
});

test('an SMS is never a payment instruction: only SOLDE / AIDE are understood', async () => {
  const c = await customer({ koriBalance: 9000 });
  const before = (await prisma.wallet.findUnique({ where: { userId: c.id } })).koriBalance;
  for (const text of ['ENVOI 5000 @awa', 'PAY 1000', 'RETRAIT 2000', 'TRANSFER 300 771234567']) {
    const r = await handleInboundSms({ from: c.phone, text, provider: 'mock' });
    assert.ok(typeof r.reply === 'string');
  }
  assert.equal((await prisma.wallet.findUnique({ where: { userId: c.id } })).koriBalance, before, 'no SMS moved money');
});
