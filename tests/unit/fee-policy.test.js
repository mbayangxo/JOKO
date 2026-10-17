/**
 * D18 — fees are 0 on every flow, and a configured schedule can never make a
 * preview disclose a fee the ledger would not post.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeFor, feeScheduleBps, preview } from '../../lib/money/policy.js';

const FLOWS = ['p2p', 'request_payment', 'merchant_pay', 'cash_in', 'cash_out'];

test('every flow charges 0 by default', () => {
  for (const f of FLOWS) {
    assert.equal(feeScheduleBps()[f], 0, f);
    assert.equal(feeFor(f, 10_000).feeKori, 0, f);
    assert.equal(feeFor(f, 10_000).basis, 'no_fee', f);
  }
});

test('a MONEY_FEES_BPS override is ignored until a flow posts its fee as a separate ledger line', () => {
  const prev = process.env.MONEY_FEES_BPS;
  process.env.MONEY_FEES_BPS = JSON.stringify(Object.fromEntries(FLOWS.map((f) => [f, 150])));
  try {
    for (const f of FLOWS) {
      assert.equal(feeFor(f, 10_000).feeKori, 0, f);
      assert.equal(preview(f, 10_000).feeKori, 0, f);
    }
  } finally {
    if (prev === undefined) delete process.env.MONEY_FEES_BPS;
    else process.env.MONEY_FEES_BPS = prev;
  }
});
