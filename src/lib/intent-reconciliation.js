/**
 * J13-F17 — the app's single reconciler instance, wired to the real API, storage and session.
 * Screens and hooks share it, so one unknown attempt is never checked (or closed) by two code paths at once
 * beyond harmless, idempotent repeats.
 */
import { getMoneyIntent, voidMoneyIntent } from './api-client';
import { createIntentReconciler } from './intent-reconciler';
import { forgetPendingIntent, listPendingIntents } from './pending-intents';
import { getAccessToken } from './secure-storage';
import { subjectOf } from './offline-policy';

const mono = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export const intentReconciler = createIntentReconciler({
  getIntent: (key) => getMoneyIntent(key),
  voidIntent: (key) => voidMoneyIntent(key),
  listPending: (userId) => listPendingIntents({ userId }),
  forget: (key) => forgetPendingIntent(key).catch(() => {}),
  currentUser: async () => subjectOf(await getAccessToken().catch(() => null)),
  now: () => Date.now(),
  mono,
});

/** History refresh / app resume: reconcile everything this user left unknown (never throws). */
export function reconcileNow() {
  return intentReconciler.reconcileAll().catch(() => []);
}
