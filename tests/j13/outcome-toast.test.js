/**
 * J13 (validates bb10ac2) — a money screen never words an unconfirmed outcome as a success.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeToast } from '../../src/lib/money-ux.js';

test('success wording only for a server-confirmed done', () => {
  assert.equal(outcomeToast({ state: 'done' }, 'Paiement envoyé ✓'), 'Paiement envoyé ✓');
  for (const out of [
    { state: 'accepted_pending', message: 'Opération en vérification. Ne la renouvelle pas.' },
    { state: 'accepted_pending' },
    { state: 'checking' },
    { state: 'failed_safe', message: 'Opération refusée — aucun argent n’a été débité.' },
    { state: 'blocked', message: 'Limite atteinte' },
    { state: 'safe_to_retry', message: 'Le paiement n’a pas été reçu.' },
    undefined,
  ]) {
    const t = outcomeToast(out, 'Paiement envoyé ✓');
    assert.notEqual(t, 'Paiement envoyé ✓', JSON.stringify(out));
    assert.ok(!/✓|envoyé|effectué/i.test(t) || /pas été reçu/.test(t), `no success wording for ${JSON.stringify(out)}: ${t}`);
  }
});
