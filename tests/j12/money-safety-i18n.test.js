/**
 * J12 (P-J12-2, P-J12-5) — payment-safety language and device-stored fingerprints.
 *  - French is the reviewed reference for every safety message; any other language is used ONLY with a
 *    native-speaker review record — an unreviewed translation can never be shown (this test fails the
 *    build if one is added without its review record).
 *  - The instruction fingerprint kept on the device is a hash: no amount, recipient or note in clear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MONEY_SAFETY, SAFETY_LANGS, isReviewed, safetyIdFor, safetyText } from '../../src/i18n/money-safety.js';
import { instructionFingerprint } from '../../src/lib/offline-policy.js';

test('every safety message has reviewed French; no unreviewed translation exists in the catalogue', () => {
  for (const [id, entry] of Object.entries(MONEY_SAFETY)) {
    assert.ok(typeof entry.fr === 'string' && entry.fr.length > 5, `${id}: French reference missing`);
    for (const [lang, t] of Object.entries(entry)) {
      if (lang === 'fr') continue;
      assert.ok(SAFETY_LANGS.includes(lang), `${id}: unexpected language ${lang}`);
      assert.ok(isReviewed(t), `${id}.${lang}: a translation without a native-speaker review record must not ship`);
    }
  }
});

test('the refusal and not-received messages keep the safety meaning: no money moved', () => {
  assert.match(MONEY_SAFETY.refused.fr, /aucun argent/);
  assert.match(MONEY_SAFETY.not_received.fr, /aucun argent/);
  for (const id of ['checking', 'resumed_checking', 'pending']) assert.match(MONEY_SAFETY[id].fr, /Ne (le|la) renouvelle pas/);
});

test('an unreviewed translation falls back to French; a reviewed one is used', () => {
  const saved = MONEY_SAFETY.done.wo;
  try {
    MONEY_SAFETY.done.wo = { text: 'brouillon non relu' };
    assert.equal(safetyText('done', 'wo'), MONEY_SAFETY.done.fr, 'unreviewed → French');
    MONEY_SAFETY.done.wo = { text: 'texte relu', reviewedBy: 'relecteur natif', reviewedAt: '2026-10-13', checkedAgainst: 'fr' };
    assert.equal(safetyText('done', 'wo'), 'texte relu');
    assert.equal(safetyText('done', 'ff'), MONEY_SAFETY.done.fr, 'no Pulaar yet → French');
  } finally {
    if (saved === undefined) delete MONEY_SAFETY.done.wo;
    else MONEY_SAFETY.done.wo = saved;
  }
});

test('every money phase maps to a safety message; "completed" only for a server-confirmed done', () => {
  assert.equal(safetyIdFor({ state: 'checking' }), 'checking');
  assert.equal(safetyIdFor({ state: 'checking', resumed: true }), 'resumed_checking');
  assert.equal(safetyIdFor({ state: 'accepted_pending' }), 'pending');
  assert.equal(safetyIdFor({ state: 'safe_to_retry' }), 'not_received');
  assert.equal(safetyIdFor({ state: 'failed_safe' }), 'refused');
  assert.equal(safetyIdFor({ state: 'done' }), 'done');
  assert.equal(safetyIdFor({ state: 'submitting' }), null);
});

test('the fingerprint stored on the device reveals neither amount, recipient nor note', () => {
  const fp = instructionFingerprint('p2p', { to: '@awa_diop', amount: 73500, note: 'loyer octobre' });
  assert.match(fp, /^fp1-[0-9a-f]{16}$/);
  for (const raw of ['awa', '73500', 'loyer']) assert.ok(!fp.includes(raw));
  assert.notEqual(fp, instructionFingerprint('p2p', { to: '@awa_diop', amount: 73501, note: 'loyer octobre' }));
});
