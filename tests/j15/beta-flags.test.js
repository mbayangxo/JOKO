/**
 * J15 security review S-1: ALLOW_BETA_DEPOSITS bypassed the KYC requirement for creating a business account even
 * with NODE_ENV=production (a misconfigured production env would let unverified users open business wallets). The
 * beta switches are test conveniences only and must be inert in production.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertCanCreateBusiness } from '../../lib/tier-service.js';
import { getPlatformConfig } from '../../lib/platform-config.js';
import { betaDepositsAllowed } from '../../lib/runtime-safety.js';

const KEYS = ['NODE_ENV', 'ALLOW_BETA_DEPOSITS'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const unverified = { id: 'u-lab', verificationTier: 0, afriId: null, cniVerifiedAt: null, addressVerifiedAt: null };

test('production + ALLOW_BETA_DEPOSITS=true: no KYC bypass for business creation, no beta deposits advertised', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_BETA_DEPOSITS = 'true';
  assert.equal(betaDepositsAllowed(), false);
  await assert.rejects(assertCanCreateBusiness(unverified), (e) => e.code === 'tier_business_blocked');
  assert.equal(JSON.stringify(getPlatformConfig()).includes('"betaDeposits":true'), false);
});

test('outside production the beta convenience still works (local / test only)', async () => {
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_BETA_DEPOSITS = 'true';
  assert.equal(betaDepositsAllowed(), true);
  await assertCanCreateBusiness(unverified);
});
