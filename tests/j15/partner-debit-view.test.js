/** J15-D2 — the S4 approval screen's view model: never approvable unless requested, in time, funded, confirmed, not self. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalState, countdownLabel, explainDecision, formatKori, secondsLeft, sortedRecipients, STATUS_LABEL } from '../../src/lib/partner-debit-view.js';

const base = (o = {}) => ({ status: 'requested', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), serverNow: new Date().toISOString(), sufficientFunds: true, recipients: [{ line: 0, handle: 'awa' }], ...o });

test('approval gating: requested + in time + funded + confirmed + not a recipient', () => {
  assert.equal(approvalState(base(), { sec: 600, confirmed: true, meUserHandle: 'boss' }).canApprove, true);
  assert.equal(approvalState(base(), { sec: 600, confirmed: false }).blocker, 'confirm_required');
  assert.equal(approvalState(base(), { sec: 0, confirmed: true }).blocker, 'expired');
  assert.equal(approvalState(base({ sufficientFunds: false }), { sec: 600, confirmed: true }).blocker, 'insufficient_funds');
  assert.equal(approvalState(base(), { sec: 600, confirmed: true, meUserHandle: 'awa' }).blocker, 'self');
  for (const status of ['executed', 'rejected', 'cancelled', 'expired', 'invalidated', 'failed']) {
    const st = approvalState(base({ status }), { sec: 600, confirmed: true });
    assert.deepEqual([st.canApprove, st.canReject], [false, false], status);
    assert.ok(STATUS_LABEL[status]);
  }
  assert.equal(approvalState(null).canApprove, false);
});

test('expiry uses the SERVER clock: a phone clock 1 h behind cannot extend the window', () => {
  const server = Date.parse('2026-10-15T10:00:00Z');
  const d = { expiresAt: new Date(server + 5 * 60_000).toISOString(), serverNow: new Date(server).toISOString() };
  const phoneAtFetch = server - 3600_000;
  assert.equal(secondsLeft(d, phoneAtFetch, phoneAtFetch), 300);
  assert.equal(secondsLeft(d, phoneAtFetch + 301_000, phoneAtFetch), 0);
  assert.equal(countdownLabel(0), 'Expirée');
  assert.equal(countdownLabel(125), 'Expire dans 2 min 05 s');
});

test('explanations, amounts and recipient ordering (changed handles first)', () => {
  assert.match(explainDecision({ status: 'invalidated', decisionReason: 'line_1_roster_changed,business_unlinked' }), /salarié.*relié/);
  assert.equal(explainDecision({ status: 'failed', failureCode: 'insufficient_funds' }), 'Solde du commerce insuffisant');
  assert.equal(formatKori(1500000), '1 500 000 ₭');
  const r = sortedRecipients({ recipients: [{ line: 0, handleChanged: false }, { line: 1, handleChanged: true }, { line: 2, handleChanged: false }] });
  assert.deepEqual(r.map((x) => x.line), [1, 0, 2]);
});
