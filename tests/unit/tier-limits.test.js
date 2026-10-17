import '../helpers/setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TIER_LIMITS, effectiveTier, limitsForTier } from '../../lib/tier-limits.js';

test('Tier 1 (phone only): 50k/₭5k hold cap, 10k/day send, no cash-out', () => {
  const t1 = TIER_LIMITS[1];
  assert.equal(t1.maxNationalBalance, 50_000);
  assert.equal(t1.maxKoriBalance, 5_000);
  assert.equal(t1.maxSendPerDay, 10_000);
  assert.equal(t1.canCashOut, false);
  assert.equal(t1.maxCashOutPerDay, 0);
  assert.equal(t1.canInternational, false);
  assert.equal(t1.canCreateBusiness, false);
});

test('Tier 2 (CNI verified): 2M/₭200k hold cap, free sends, 500k/day cash-out, international', () => {
  const t2 = TIER_LIMITS[2];
  assert.equal(t2.maxNationalBalance, 2_000_000);
  assert.equal(t2.maxKoriBalance, 200_000);
  assert.equal(t2.maxSendPerDay, null);
  assert.equal(t2.canCashOut, true);
  assert.equal(t2.maxCashOutPerDay, 500_000);
  assert.equal(t2.canInternational, true);
  assert.equal(t2.canCreateBusiness, false);
});

test('Tier 3 (address verified): higher limits + business accounts', () => {
  const t3 = TIER_LIMITS[3];
  assert.ok(t3.maxNationalBalance > TIER_LIMITS[2].maxNationalBalance);
  assert.ok(t3.maxCashOutPerDay > TIER_LIMITS[2].maxCashOutPerDay);
  assert.equal(t3.canCreateBusiness, true);
});

test('effectiveTier never grants a tier without matching verification timestamps', () => {
  const now = new Date();
  // Claimed tier 3 but no verifications recorded → treated as tier 1
  assert.equal(effectiveTier({ verificationTier: 3, cniVerifiedAt: null, addressVerifiedAt: null }), 1);
  // Tier 2 requires cniVerifiedAt
  assert.equal(effectiveTier({ verificationTier: 2, cniVerifiedAt: null }), 1);
  assert.equal(effectiveTier({ verificationTier: 2, cniVerifiedAt: now }), 2);
  // Tier 3 requires addressVerifiedAt
  assert.equal(effectiveTier({ verificationTier: 3, cniVerifiedAt: now, addressVerifiedAt: null }), 2);
  assert.equal(effectiveTier({ verificationTier: 3, cniVerifiedAt: now, addressVerifiedAt: now }), 3);
});

test('unknown tier falls back to the most restrictive tier (J3: Tier 0, receive-only)', () => {
  assert.equal(limitsForTier(99), TIER_LIMITS[0]);
  assert.equal(limitsForTier(undefined), TIER_LIMITS[0]);
  assert.equal(TIER_LIMITS[0].maxSendPerDay, 0);
  assert.equal(TIER_LIMITS[0].canCashOut, false);
});

test('J3 Tier 0: an email-only account (synthetic phone) cannot send until a phone is verified', () => {
  assert.equal(effectiveTier({ phone: 'e:someone@example.com', verificationTier: 1 }), 0);
  assert.equal(effectiveTier({ phone: '+221770000000', verificationTier: 1 }), 1);
  // Submitted is not verified: a tier number without the verification timestamp does not count.
  assert.equal(effectiveTier({ phone: '+221770000000', verificationTier: 2, cniVerifiedAt: null }), 1);
  assert.equal(effectiveTier({ phone: '+221770000000', verificationTier: 3, cniVerifiedAt: null, addressVerifiedAt: new Date() }), 1);
});
