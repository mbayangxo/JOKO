/**
 * J12-F16 — a confirmation toast shown while the previous toast is fading out must stay visible.
 * Found in the final gate (J9 E2E "Offre acceptée" never rendered; on-screen recorder evidence).
 * The fake animation mimics React Native: stopping or replacing a running animation calls its completion
 * callback with { finished: false }; a completed one calls it with { finished: true }.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToastScheduler, visibleMsFor } from '../../src/components/toast-scheduler.js';

function harness(factory) {
  let message = null;
  const timers = [];
  let running = null; // the pending completion callback of the running animation
  const finishRunning = (finished) => {
    const cb = running;
    running = null;
    cb?.({ finished });
  };
  const deps = {
    setMessage: (m) => { message = m; },
    stop: () => finishRunning(false),
    show: () => finishRunning(false), // a new spring replaces any running fade
    hide: (cb) => { running = cb; },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (id) => { timers[id - 1] = null; },
  };
  const show = factory(deps);
  return { show, msg: () => message, fireTimer: (i) => timers[i]?.(), fadeEnds: () => finishRunning(true) };
}

// The scheduling used before the fix (Toast.js at 3c85a83), for the before/after proof.
const oldScheduler = ({ setMessage, show, hide, setTimer, clearTimer }) => {
  let timer = null;
  return (text) => {
    if (timer) clearTimer(timer);
    setMessage(text);
    show();
    timer = setTimer(() => hide(() => setMessage(null)), visibleMsFor(text));
  };
};

const scenario = (h) => {
  h.show('Candidature envoyée');
  h.fireTimer(0); // first toast starts fading out …
  h.show('Offre acceptée — la mission commence'); // … and the next confirmation arrives meanwhile
  return h.msg();
};

test('fixed: a toast arriving during the previous fade-out stays on screen', () => {
  const h = harness(createToastScheduler);
  assert.equal(scenario(h), 'Offre acceptée — la mission commence');
  h.fireTimer(1);
  h.fadeEnds();
  assert.equal(h.msg(), null, 'and it is hidden normally after its own time');
});

test('before the fix: the same interleaving erased the new toast (the bug this test pins)', () => {
  const h = harness(oldScheduler);
  assert.equal(scenario(h), null, 'old scheduling: the interrupted fade cleared the NEW message');
});

test('an old timer never hides a newer toast; normal single toast hides after its own duration', () => {
  const h = harness(createToastScheduler);
  h.show('A');
  h.show('B');
  h.fireTimer(0); // A's timer (cleared in real life; even if it fired, it must not touch B)
  assert.equal(h.msg(), 'B');
  h.fireTimer(1);
  h.fadeEnds();
  assert.equal(h.msg(), null);
  assert.equal(visibleMsFor('court'), 2200);
  assert.equal(visibleMsFor('x'.repeat(200)), 6000);
});

test('rapid consecutive toasts: only the last is shown, and only its own timer can hide it', () => {
  const h = harness(createToastScheduler);
  for (let i = 0; i < 20; i += 1) h.show(`t${i}`);
  assert.equal(h.msg(), 't19');
  for (let i = 0; i < 19; i += 1) {
    h.fireTimer(i); // stale timers (cleared in real life) must not hide t19
    h.fadeEnds();
  }
  assert.equal(h.msg(), 't19');
  h.fireTimer(19);
  h.fadeEnds();
  assert.equal(h.msg(), null);
});

test('an interrupted fade (finished: false) never clears the message', () => {
  const h = harness(createToastScheduler);
  h.show('A');
  h.fireTimer(0); // fade starts …
  h.show('B'); // … and is interrupted by the next toast (callback with finished:false)
  assert.equal(h.msg(), 'B');
});

test('after unmount (dispose): late timers and animation callbacks are no-ops; new toasts are ignored', () => {
  let sets = 0;
  const timers = [];
  let running = null;
  const show = createToastScheduler({
    setMessage: () => { sets += 1; },
    stop: () => {},
    show: () => {},
    hide: (cb) => { running = cb; },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  show('A');
  timers[0](); // the fade starts …
  show.dispose(); // … the provider unmounts
  const before = sets;
  running?.({ finished: true }); // the animation completes after unmount
  timers[0](); // a timer fires after unmount
  show('late'); // a caller still holding the old function
  assert.equal(sets, before, 'no state update after unmount');
});
