/**
 * J12 — offline drafts (non-financial only) and network-status reporting. Pure: no DB, no network.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_TTL_MS, clearUserDrafts, loadDraft, saveDraft, sanitizeDraft } from '../../src/lib/drafts.js';
import { __resetNetworkState, networkMessage, networkState, reportBrowserOnline, reportRequest, subscribeNetwork, SLOW_MS } from '../../src/lib/network-state.js';

const mem = () => { let v = null; return { get: async () => v, set: async (x) => { v = x; }, peek: () => v }; };
const NOW = Date.UTC(2026, 9, 13, 9);

test('only allowlisted, non-financial forms can be drafted; money/credential fields are stripped', async () => {
  const s = mem();
  assert.equal(await saveDraft({ userId: 'A', form: 'send-money', fields: { note: 'x' } }, s), false, 'a payment form is never drafted');
  assert.deepEqual(sanitizeDraft({ title: 'Inventaire', rate: '2000', amountKori: '500', recipientHandle: '@x', pin: '1234', description: 'Compter le stock' }), { title: 'Inventaire', description: 'Compter le stock' });
  await saveDraft({ userId: 'A', form: 'work-post', scope: 'b1', fields: { title: 'Inventaire', rate: '7319' }, now: NOW }, s);
  assert.ok(!s.peek().includes('7319') && !s.peek().includes('rate'), 'the pay rate never reaches storage');
  assert.deepEqual((await loadDraft({ userId: 'A', form: 'work-post', scope: 'b1', now: NOW + 1000 }, s)).fields, { title: 'Inventaire' });
});

test('per user and per scope; expired or clock-ambiguous drafts are not restored; sign-out removes them', async () => {
  const s = mem();
  await saveDraft({ userId: 'A', form: 'mbolo-compose', scope: 't1', fields: { text: 'salut' }, now: NOW }, s);
  assert.equal(await loadDraft({ userId: 'B', form: 'mbolo-compose', scope: 't1', now: NOW }, s), null, 'B never sees A’s draft');
  assert.equal(await loadDraft({ userId: 'A', form: 'mbolo-compose', scope: 't2', now: NOW }, s), null, 'another thread');
  assert.equal(await loadDraft({ userId: 'A', form: 'mbolo-compose', scope: 't1', now: NOW + DRAFT_TTL_MS + 1 }, s), null, 'expired');
  assert.equal(await loadDraft({ userId: 'A', form: 'mbolo-compose', scope: 't1', now: NOW - 10 * 60_000 }, s), null, 'clock moved back');
  await saveDraft({ userId: 'B', form: 'support-ticket', fields: { text: 'aide' }, now: NOW }, s);
  await clearUserDrafts('A', { now: NOW }, s);
  assert.equal(await loadDraft({ userId: 'A', form: 'mbolo-compose', scope: 't1', now: NOW }, s), null, 'signed out → gone');
  assert.ok(await loadDraft({ userId: 'B', form: 'support-ticket', now: NOW }, s), 'other users’ drafts untouched');
});

beforeEach(() => __resetNetworkState());
test('network status follows real requests: offline, slow/retried → weak, answered → online; honest copy', () => {
  const seen = [];
  subscribeNetwork((s) => seen.push(s.status));
  reportRequest({ ok: false, unreachable: true });
  assert.equal(networkState().status, 'offline');
  reportRequest({ ok: true, ms: SLOW_MS + 1 });
  assert.equal(networkState().status, 'weak');
  reportRequest({ ok: true, ms: 200, retried: true });
  assert.equal(networkState().status, 'weak', 'needed its retry');
  reportRequest({ ok: true, ms: 200 });
  assert.equal(networkState().status, 'online');
  reportBrowserOnline(false);
  assert.deepEqual(seen, ['offline', 'weak', 'online', 'offline']);
  assert.match(networkMessage('offline'), /un paiement ne part jamais hors ligne/);
  assert.equal(networkMessage('online'), null);
});
