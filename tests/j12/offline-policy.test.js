/**
 * J12 — offline / weak-network rules (src/lib/offline-policy.js, src/lib/pending-intents.js).
 * Cases: account switching on a shared phone, clock changes, stale entries, duplicate retries,
 * changed instructions, lost responses after an app restart. Pure: no database, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOCK_SKEW_MS, INTENT_LOOKUP_TTL_MS, INTENT_RETRY_WINDOW_MS, OUTBOX_MAX_AGE_MS,
  instructionFingerprint, isLowDataCacheable, lowDataCacheKey, outboxDecision, pendingIntentAction, sameKeyRetryAllowed, subjectOf,
} from '../../src/lib/offline-policy.js';
import { forgetPendingIntent, pendingIntentsToLookUp, rememberPendingIntent } from '../../src/lib/pending-intents.js';

const jwt = (sub) => `h.${Buffer.from(JSON.stringify({ sub, iat: 1 })).toString('base64url')}.sig`;
const mem = () => { let v = null; return { get: async () => v, set: async (x) => { v = x; }, peek: () => v }; };
const NOW = Date.UTC(2026, 9, 10, 12);

test('low-data cache: only public, non-money GETs; never balances, history, intents, groups, offers or messages', () => {
  for (const ok of ['/api/platform/config', '/api/work/types', '/api/products', 'https://x.app/api/marketplace/products/p1', '/api/channels?near=1', '/api/merchants/b1/public']) {
    assert.ok(isLowDataCacheable(ok), ok);
  }
  for (const no of ['/api/wallet', '/api/money/home', '/api/money/activity', '/api/money/intents/k1', '/api/transactions', '/api/collective/groups',
    '/api/collective/groups/g1', '/api/work/offers', '/api/mbolo/threads', '/api/me', '/api/me/today', '/api/channels/mine', '/api/channels/feed',
    '/api/businesses/b1/payroll/employees', '/api/tontine/groups', '/api/kyc/status', '/api/notifications']) {
    assert.ok(!isLowDataCacheable(no), no);
  }
});

test('account switching: cache entries are partitioned per user, and an anonymous request is never cached', () => {
  assert.equal(subjectOf(jwt('user-A')), 'user-A');
  assert.equal(subjectOf('garbage'), null);
  const a = lowDataCacheKey('/api/products', subjectOf(jwt('user-A')));
  const b = lowDataCacheKey('/api/products', subjectOf(jwt('user-B')));
  assert.ok(a && b && a !== b, 'user B can never read user A’s cached entry');
  assert.equal(lowDataCacheKey('/api/products', null), null);
  assert.equal(lowDataCacheKey('/api/wallet', 'user-A'), null);
});

test('offline outbox: only the author’s fresh text/sticker messages auto-send; stale or clock-ambiguous are held', () => {
  const e = (over = {}) => ({ userId: 'A', threadId: 't', payload: { kind: 'text', body: 'salut' }, createdAt: new Date(NOW - 60_000).toISOString(), ...over });
  assert.equal(outboxDecision(e(), { userId: 'A', now: NOW }), 'send');
  assert.equal(outboxDecision(e(), { userId: 'B', now: NOW }), 'not_mine', 'account switch: B never sends A’s messages');
  assert.equal(outboxDecision(e({ userId: undefined }), { userId: 'A', now: NOW }), 'not_mine', 'legacy entries with no owner are never sent');
  assert.equal(outboxDecision(e({ payload: { kind: 'payment' } }), { userId: 'A', now: NOW }), 'drop', 'nothing money-shaped is ever queued or replayed');
  assert.equal(outboxDecision(e({ createdAt: new Date(NOW - OUTBOX_MAX_AGE_MS - 1).toISOString() }), { userId: 'A', now: NOW }), 'hold', 'stale');
  assert.equal(outboxDecision(e({ createdAt: new Date(NOW + CLOCK_SKEW_MS + 1).toISOString() }), { userId: 'A', now: NOW }), 'hold', 'clock went backwards');
  assert.equal(outboxDecision(e({ createdAt: 'not-a-date' }), { userId: 'A', now: NOW }), 'hold');
});

test('same-key retry: identical instruction, same user, inside the window, sane clock — anything else needs a new intent', () => {
  const fp = instructionFingerprint('p2p', { to: '@awa', amount: 500 });
  assert.equal(fp, instructionFingerprint('p2p', { amount: 500, to: '@awa' }), 'field order does not matter');
  const rec = { userId: 'A', fingerprint: fp, createdAt: NOW };
  assert.ok(sameKeyRetryAllowed(rec, { userId: 'A', fingerprint: fp, now: NOW + 1000 }), 'duplicate retry of the same payment reuses the key');
  assert.ok(!sameKeyRetryAllowed(rec, { userId: 'A', fingerprint: instructionFingerprint('p2p', { to: '@awa', amount: 5000 }), now: NOW + 1000 }), 'materially changed amount');
  assert.ok(!sameKeyRetryAllowed(rec, { userId: 'A', fingerprint: instructionFingerprint('p2p', { to: '@moussa', amount: 500 }), now: NOW + 1000 }), 'changed recipient');
  assert.ok(!sameKeyRetryAllowed(rec, { userId: 'B', fingerprint: fp, now: NOW + 1000 }), 'another account');
  assert.ok(!sameKeyRetryAllowed(rec, { userId: 'A', fingerprint: fp, now: NOW + INTENT_RETRY_WINDOW_MS + 1 }), 'expired instruction');
  assert.ok(!sameKeyRetryAllowed(rec, { userId: 'A', fingerprint: fp, now: NOW - CLOCK_SKEW_MS - 1 }), 'clock moved backwards');
});

test('lost response + app restart: the pending intent is remembered for LOOKUP only, per user, and expires', async () => {
  const s = mem();
  await rememberPendingIntent({ key: 'k-A1', userId: 'A', flow: 'p2p', now: NOW }, s);
  await rememberPendingIntent({ key: 'k-B1', userId: 'B', flow: 'p2p', now: NOW }, s);
  await rememberPendingIntent({ key: 'k-A2', userId: 'A', flow: 'cash', now: NOW + 5 }, s);
  const stored = JSON.parse(s.peek());
  assert.ok(stored.every((r) => Object.keys(r).sort().join() === 'createdAt,flow,key,userId'), 'no amount, recipient or balance is stored');
  assert.deepEqual((await pendingIntentsToLookUp({ userId: 'A', flow: 'p2p', now: NOW + 1000 }, s)).map((r) => r.key), ['k-A1']);
  assert.deepEqual((await pendingIntentsToLookUp({ userId: 'B', flow: 'p2p', now: NOW + 1000 }, s)).map((r) => r.key), ['k-B1'], 'B sees only B’s');
  assert.equal(pendingIntentAction({ key: 'k', userId: 'A', createdAt: NOW }, { userId: 'B', now: NOW }), 'ignore');
  await forgetPendingIntent('k-A1', s);
  assert.deepEqual(await pendingIntentsToLookUp({ userId: 'A', flow: 'p2p', now: NOW + 1000 }, s), []);
  assert.deepEqual(await pendingIntentsToLookUp({ userId: 'B', flow: 'p2p', now: NOW + INTENT_LOOKUP_TTL_MS + 10 }, s), [], 'expired');
  assert.equal(JSON.parse(s.peek()).length, 0, 'expired records are pruned from the device');
});
