/**
 * J13-F17 — attribution: an earlier attempt's answer is never presented as the current payment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptLabel, attributedText, handoffDecision } from '../../src/lib/intent-handoff.js';

const NOW = new Date(2026, 9, 13, 15, 0, 0).getTime();
const ev = (key, minutesAgo, state = 'done', message = 'Paiement effectué.') => ({ key, createdAt: NOW - minutesAgo * 60_000, state, message, userId: 'u1', flow: 'p2p' });

test('never applied over an attempt this screen started or is checking', () => {
  for (const phaseState of ['submitting', 'checking', 'needs_pin', 'done', 'failed_safe', 'accepted_pending']) {
    assert.equal(handoffDecision({ phaseState, recent: [ev('k1', 2)], now: NOW }), null, phaseState);
  }
});

test('a still-unknown attempt is resumed (looked up), not replaced by an older answer', () => {
  const d = handoffDecision({ phaseState: 'idle', pending: { key: 'kP' }, recent: [ev('k1', 2)], now: NOW });
  assert.deepEqual(d, { kind: 'resume', rec: { key: 'kP' } });
});

test('two earlier attempts: the most recently STARTED is shown, labelled with its own start time; the other is counted', () => {
  const d = handoffDecision({ phaseState: 'idle', recent: [ev('kOld', 9, 'failed_safe', 'Opération refusée — aucun argent n’a été débité.'), ev('kNew', 3)], now: NOW });
  assert.equal(d.kind, 'show');
  assert.equal(d.phase.attemptKey, 'kNew');
  assert.equal(d.phase.earlierCount, 1);
  const text = attributedText(d.phase, d.phase.message);
  assert.match(text, /^Paiement commencé à 14:57 : Paiement effectué\. \(1 autre paiement précédent vérifié — consulte ton historique\.\)$/);
});

test('a label always names the attempt; another day shows the date', () => {
  assert.equal(attemptLabel(NOW - 60_000, NOW), 'Paiement commencé à 14:59');
  assert.equal(attemptLabel(NOW - 26 * 3600_000, NOW), 'Paiement commencé le 12/10 à 13:00');
  assert.equal(attributedText({}, 'x'), 'x', 'the current attempt is not relabelled');
});

test('nothing to show → no banner (history stays the source of truth)', () => {
  assert.equal(handoffDecision({ phaseState: 'idle', recent: [], now: NOW }), null);
});
