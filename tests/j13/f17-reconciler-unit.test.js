/**
 * J13-F17 — the reconciler, deterministic (fake API, fake storage, fake wall + monotonic clocks; no sleeps).
 * Proves: unknown stays unknown until a final server answer; the key is closed only when overdue (wall clock
 * OR monotonic, so clock jumps cannot keep it open or close it in a way that hides a payment); lookups only —
 * it has no way to submit; another account's records are never touched; a restart resumes from storage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntentReconciler, VOID_AFTER_MS, VOID_AFTER_MONO_MS } from '../../src/lib/intent-reconciler.js';

function world({ user = 'u1', records = [], server = {} } = {}) {
  const w = {
    user,
    wall: 1_000_000,
    mono: 0,
    records: [...records],
    server: { ...server }, // key → { state } as the server would answer
    calls: [],
  };
  w.deps = {
    getIntent: async (key) => {
      w.calls.push(['get', key]);
      if (w.server[key] === 'unreachable') throw new Error('network');
      return { state: w.server[key] ?? 'not_found', references: [] };
    },
    voidIntent: async (key) => {
      w.calls.push(['void', key]);
      const s = w.server[key] ?? 'not_found';
      if (s === 'not_found') {
        w.server[key] = 'voided';
        return { state: 'voided' };
      }
      return { state: s }; // the original arrived first: it decides, nothing is closed
    },
    listPending: async (userId) => w.records.filter((r) => r.userId === userId),
    forget: async (key) => {
      w.records = w.records.filter((r) => r.key !== key);
    },
    currentUser: async () => w.user,
    now: () => w.wall,
    mono: () => w.mono,
  };
  return w;
}
const rec = (key, userId = 'u1', createdAt = 1_000_000) => ({ key, userId, flow: 'p2p', createdAt });

test('young "not found" stays UNKNOWN (no void, no final event); never a final answer by itself', async () => {
  const w = world({ records: [rec('k1')] });
  const r = createIntentReconciler(w.deps);
  const events = [];
  r.subscribe((e) => events.push(e));
  const [out] = await r.reconcileAll();
  assert.equal(out.state, 'checking');
  assert.equal(out.unknown, true);
  assert.deepEqual(w.calls, [['get', 'k1']]);
  assert.equal(events.length, 0);
  assert.equal(w.records.length, 1, 'still remembered');
  assert.equal(r.hasPending(), true);
});

test('overdue by WALL clock → the key is closed once → confirmed "not received", forgotten, event emitted', async () => {
  const w = world({ records: [rec('k1')] });
  const r = createIntentReconciler(w.deps);
  const events = [];
  r.subscribe((e) => events.push(e));
  w.wall += VOID_AFTER_MS;
  const [out] = await r.reconcileAll();
  assert.equal(out.state, 'failed_safe');
  assert.equal(out.voided, true);
  assert.deepEqual(w.calls, [['get', 'k1'], ['void', 'k1']]);
  assert.equal(events.length, 1);
  assert.equal(w.records.length, 0);
  assert.equal(r.hasPending(), false);
});

test('clock moved BACKWARDS: the monotonic rule still closes it; a forward jump closes early (always safe)', async () => {
  const w = world({ records: [rec('k1')] });
  const r = createIntentReconciler(w.deps);
  w.wall -= 12 * 3600_000; // user set the clock back 12 h
  assert.equal((await r.reconcileAll())[0].state, 'checking');
  w.mono += VOID_AFTER_MONO_MS - 1;
  assert.equal((await r.reconcileAll())[0].state, 'checking');
  w.mono += 1;
  assert.equal((await r.reconcileAll())[0].state, 'failed_safe');

  const v = world({ records: [rec('k2')] });
  const r2 = createIntentReconciler(v.deps);
  v.wall += 48 * 3600_000;
  assert.equal((await r2.reconcileAll())[0].voided, true, 'forward jump: closed — the server would refuse to close a key that ran');
});

test('lost reply: the original DID run → completed (never voided), even when overdue', async () => {
  const w = world({ records: [rec('k1')], server: { k1: 'completed' } });
  const r = createIntentReconciler(w.deps);
  w.wall += VOID_AFTER_MS * 10;
  const [out] = await r.reconcileAll();
  assert.equal(out.state, 'done');
  assert.ok(!w.calls.some(([op]) => op === 'void'), 'no close attempted on a completed key');
});

test('delayed execution racing the close: if the original wins, the close reports it and nothing is voided', async () => {
  const w = world({ records: [rec('k1')] });
  const r = createIntentReconciler(w.deps);
  w.wall += VOID_AFTER_MS;
  w.deps.getIntent = async (key) => { w.calls.push(['get', key]); return { state: 'not_found' }; };
  w.server.k1 = 'completed'; // arrives between the lookup and the close
  const [out] = await r.reconcileAll();
  assert.equal(out.state, 'done');
  assert.notEqual(w.server.k1, 'voided');
});

test('risk-review hold → "under review" (accepted_pending): final for the attempt, never success or failure', async () => {
  const w = world({ records: [rec('k1')], server: { k1: 'accepted_pending' } });
  const r = createIntentReconciler(w.deps);
  w.wall += VOID_AFTER_MS * 2;
  const [out] = await r.reconcileAll();
  assert.equal(out.state, 'accepted_pending');
  assert.ok(!w.calls.some(([op]) => op === 'void'));
});

test('confirmed failure (refused) → failed_safe confirmed, not voided', async () => {
  const w = world({ records: [rec('k1')], server: { k1: 'refused' } });
  const [out] = await createIntentReconciler(w.deps).reconcileAll();
  assert.deepEqual([out.state, out.confirmed, out.voided], ['failed_safe', true, undefined]);
});

test('still unreachable → stays unknown; nothing is closed while the server cannot be asked', async () => {
  const w = world({ records: [rec('k1')], server: { k1: 'unreachable' } });
  const r = createIntentReconciler(w.deps);
  w.wall += VOID_AFTER_MS * 5;
  const [out] = await r.reconcileAll();
  assert.equal(out.state, 'checking');
  assert.ok(!w.calls.some(([op]) => op === 'void'));
});

test('account switching: only the signed-in user\'s records are looked up or closed', async () => {
  const w = world({ user: 'u2', records: [rec('kA', 'u1'), rec('kB', 'u2')] });
  const r = createIntentReconciler(w.deps);
  w.wall += VOID_AFTER_MS;
  await r.reconcileAll();
  assert.deepEqual(w.calls.map(([, k]) => k), ['kB', 'kB']);
  assert.ok(w.records.some((x) => x.key === 'kA'), 'the other account\'s record is untouched');
  w.user = null; // signed out: nothing at all
  w.calls = [];
  assert.deepEqual(await r.reconcileAll(), []);
  assert.deepEqual(w.calls, []);
});

test('repeated restarts: a NEW reconciler (fresh process) resumes from storage and reaches the same answer once', async () => {
  const w = world({ records: [rec('k1')] });
  assert.equal((await createIntentReconciler(w.deps).reconcileAll())[0].state, 'checking'); // run 1
  assert.equal((await createIntentReconciler(w.deps).reconcileAll())[0].state, 'checking'); // run 2 (restart)
  w.wall += VOID_AFTER_MS;
  const events = [];
  const r3 = createIntentReconciler(w.deps);
  r3.subscribe((e) => events.push(e));
  assert.equal((await r3.reconcileAll())[0].state, 'failed_safe'); // run 3
  assert.equal((await createIntentReconciler(w.deps).reconcileAll()).length, 0, 'forgotten after the final answer');
  assert.equal(w.calls.filter(([op]) => op === 'void').length, 1, 'closed exactly once');
  assert.equal(events.length, 1);
});

test('eventual settlement after "unknown": the final answer is emitted (history/balance refresh hook) exactly once', async () => {
  const w = world({ records: [rec('k1')], server: { k1: 'in_progress' } });
  const r = createIntentReconciler(w.deps);
  const events = [];
  r.subscribe((e) => events.push(e));
  assert.equal((await r.reconcileAll())[0].state, 'checking');
  w.server.k1 = 'completed';
  assert.equal((await r.reconcileAll())[0].state, 'done');
  await r.reconcileAll();
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'k1');
});

test('the reconciler has no way to pay: its only server operations are lookup and close', async () => {
  const w = world({ records: [rec('k1'), rec('k2')], server: { k2: 'in_progress' } });
  const r = createIntentReconciler(w.deps);
  for (let i = 0; i < 5; i += 1) {
    w.wall += 30_000;
    w.mono += 30_000;
    await r.reconcileAll();
  }
  assert.ok(w.calls.every(([op]) => op === 'get' || op === 'void'));
  assert.ok(!w.calls.some(([op, k]) => op === 'void' && k === 'k2'), 'in-progress is never closed');
});

test('an answer found before the flow\'s screen opened is handed to that screen once (same user + flow only)', async () => {
  const w = world({ records: [rec('k1')], server: { k1: 'completed' } });
  const r = createIntentReconciler(w.deps);
  const events = [];
  r.subscribe((e) => events.push(e));
  await r.reconcileAll(); // app start, before any screen
  assert.equal(events[0].source, 'background');
  assert.equal(r.takeRecent('u2', 'p2p'), null, 'another user never gets it');
  assert.equal(r.takeRecent('u1', 'merchant_pay'), null, 'another flow never gets it');
  assert.equal(r.takeRecent('u1', 'p2p').state, 'done');
  assert.equal(r.takeRecent('u1', 'p2p'), null, 'consumed once');
});

test('a handed-over answer expires after 10 minutes of monotonic time', async () => {
  const w = world({ records: [rec('k1')], server: { k1: 'refused' } });
  const r = createIntentReconciler(w.deps);
  await r.reconcileAll();
  w.mono += 10 * 60_000 + 1;
  assert.equal(r.takeRecent('u1', 'p2p'), null);
});
