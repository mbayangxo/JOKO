/**
 * J4 — client money-UX rules (src/lib/money-ux.js), pure functions.
 * The one rule under test: when the outcome of a payment is unknown the app
 * shows "checking" and never offers a new payment intent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionButton, activityRow, balanceView, classifyIntent, classifySubmission, newIntentKey } from '../../src/lib/money-ux.js';
import { buildChargeUrl, parseK21Qr } from '../../lib/k21-qr.js';

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

test('intent keys are unique and accepted by the server Idempotency-Key format', () => {
  const keys = new Set(Array.from({ length: 500 }, newIntentKey));
  assert.equal(keys.size, 500);
  for (const k of keys) assert.match(k, KEY_RE);
});

test('unknown outcomes (timeout, network loss, app kill, 5xx, in-progress) → checking; never a new intent', () => {
  for (const error of [
    { code: 'outcome_unknown' },
    { code: 'timeout' },
    { code: 'network' },
    { code: 'idempotency_in_progress', status: 409 },
    { status: 500 },
    { status: 502 },
    { status: 504 },
  ]) {
    const c = classifySubmission({ error });
    assert.equal(c.state, 'checking', JSON.stringify(error));
    assert.equal(c.newIntentAllowed, false);
    assert.equal(c.canRetrySameIntent, false);
    assert.doesNotMatch(c.message, /réessa/i, 'never says "try again" when it may have paid');
  }
});

test('success and lost-response replay are "done"; provider pending is accepted, not repeatable', () => {
  assert.equal(classifySubmission({ response: { status: 'completed', reference: 'r' } }).state, 'done');
  assert.equal(classifySubmission({ response: { status: 'completed', code: 'completed_response_lost' } }).state, 'done');
  const pend = classifySubmission({ response: { rail: { status: 'pending' } } });
  assert.equal(pend.state, 'accepted_pending');
  assert.equal(pend.newIntentAllowed, false);
  assert.equal(classifySubmission({ error: { status: 202 } }).state, 'accepted_pending');
});

test('definite refusals: nothing debited, server message + next step shown, a new attempt is allowed', () => {
  const c = classifySubmission({ error: { status: 400, code: 'insufficient_funds', category: 'insufficient_funds', message: 'Solde insuffisant.', data: { nextStep: 'Recharge.' } } });
  assert.equal(c.state, 'blocked');
  assert.equal(c.message, 'Solde insuffisant.');
  assert.equal(c.nextStep, 'Recharge.');
  assert.equal(c.newIntentAllowed, true);
  const pin = classifySubmission({ error: { status: 403, code: 'step_up_required' } });
  assert.equal(pin.state, 'needs_pin');
  assert.equal(pin.canRetrySameIntent, true, 'PIN re-submit reuses the SAME key');
  assert.equal(pin.newIntentAllowed, false);
  const outage = classifySubmission({ error: { status: 503, message: 'Service indisponible' } });
  assert.equal(outage.state, 'failed_safe');
  assert.equal(outage.canRetrySameIntent, true);
});

test('intent polling: completed / pending / refused / not_found stop; in_progress keeps checking', () => {
  assert.deepEqual(
    [classifyIntent({ state: 'completed', references: ['a'] }), classifyIntent({ state: 'accepted_pending' }), classifyIntent({ state: 'refused' }), classifyIntent({ state: 'not_found' })].map((x) => [x.state, x.stopPolling]),
    [['done', true], ['accepted_pending', true], ['failed_safe', true], ['safe_to_retry', true]],
  );
  assert.equal(classifyIntent({ state: 'not_found' }).canRetrySameIntent, true);
  for (const s of [{ state: 'in_progress' }, null, {}]) assert.equal(classifyIntent(s).stopPolling, false);
});

test('history rows: plain states, linked reversals/refunds, pending cash-in marked not available', () => {
  const pending = activityRow({ reference: 'r1', direction: 'in', amountKori: 1000, title: 'Rechargement', status: 'pending', statusLabel: 'En cours', type: 'cash_in' });
  assert.equal(pending.spendable, false);
  assert.equal(pending.pendingNote, 'Pas encore disponible');
  assert.equal(pending.amountLabel, '+1000 ₭');
  assert.equal(activityRow({ reference: 'r2', direction: 'out', amountKori: 5, status: 'reversed', links: { reversedBy: 'x' } }).linkedNote, 'Cette opération a été annulée');
  assert.equal(activityRow({ reference: 'r3', direction: 'in', amountKori: 5, status: 'completed', links: { refundOf: 'y' } }).linkedNote, 'Remboursement d’un paiement');
  assert.equal(activityRow({ reference: 'r4', direction: 'out', amountKori: 5, status: 'partially_refunded', links: { refundedBy: ['z'], refundedKori: 2 } }).linkedNote, 'Remboursé : 2 ₭');
});

test('balance: only available is spendable; held and pending shown separately', () => {
  const v = balanceView({ balance: { availableKori: 100, heldKori: 20, pendingInKori: 30 } });
  assert.equal(v.spendableKori, 100);
  assert.equal(v.lines.length, 2);
  assert.equal(balanceView(null).spendableKori, 0);
  assert.deepEqual(actionButton({ allowed: false, category: 'new_device', message: 'm', nextStep: 'n' }), { enabled: false, reason: 'm', nextStep: 'n', category: 'new_device' });
  assert.equal(actionButton({ allowed: true, requiresPin: true }).requiresPin, true);
});

test('charge QR carries only an opaque code — no amount, no merchant id', () => {
  const url = buildChargeUrl('CHG7XK2P9QABZZ41');
  assert.equal(url, 'k21://charge/CHG7XK2P9QABZZ41');
  assert.deepEqual(parseK21Qr(url), { kind: 'pay_charge', code: 'CHG7XK2P9QABZZ41' });
  // A forged QR adding an amount is ignored: the code is all the client keeps.
  assert.deepEqual(parseK21Qr('k21://charge/CHG7XK2P9QABZZ41?amount=1'), { kind: 'pay_charge', code: 'CHG7XK2P9QABZZ41' });
});
