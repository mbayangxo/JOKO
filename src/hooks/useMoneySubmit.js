import { useCallback, useEffect, useRef, useState } from 'react';
import { classifySubmission, newIntentKey, PROVISIONAL } from '../lib/money-ux';
import { getAccessToken } from '../lib/secure-storage';
import { instructionFingerprint, sameKeyRetryAllowed, subjectOf } from '../lib/offline-policy';
import { pendingIntentsToLookUp, rememberPendingIntent } from '../lib/pending-intents';
import { intentReconciler } from '../lib/intent-reconciliation';

/**
 * J4 — one money submission = one intent key, reused for every retry of that
 * attempt (step-up re-submit, "réessayer" after an unknown outcome). When the
 * response is lost, the hook polls GET /api/money/intents/:key and never lets
 * the screen fire a second payment while the first one's outcome is unknown.
 *
 * J12 — offline-safe:
 *  - an unknown outcome is REMEMBERED (key only) for the signed-in user, so after an app restart,
 *    account switch back or long network loss the screen looks it up instead of paying again;
 *  - a remembered intent is only ever LOOKED UP, never re-submitted automatically;
 *  - reusing the same key is allowed only for the identical instruction within a short window —
 *    a changed amount/recipient, or an old attempt, always gets a new key (fresh confirmation).
 *  - nothing is ever shown as completed until the server says so.
 *
 * phase.state: idle | submitting | done | accepted_pending | checking |
 *              needs_pin | blocked | failed_safe   (J13-F17: no 'safe_to_retry' — "not received yet" is
 *              'checking' until the server confirms or the key is closed)
 */
const POLL_MS = 2000;
const POLL_TRIES = 15;
// Final answers end the attempt. "Nothing received YET" is NOT final (J13-F17): it stays "checking" until the
// server confirms an outcome or the key is closed by the reconciler (lib/intent-reconciler.js).
const FINAL = new Set(['done', 'accepted_pending', 'failed_safe', 'blocked']);

const currentUser = async () => subjectOf(await getAccessToken().catch(() => null));

export function useMoneySubmit(flow = 'money') {
  const keyRef = useRef(newIntentKey());
  const attemptRef = useRef(null); // { userId, fingerprint, createdAt } of the first use of keyRef
  const [phase, setPhase] = useState({ state: 'idle' });

  const rotate = useCallback(() => {
    keyRef.current = newIntentKey();
    attemptRef.current = null;
  }, []);

  const reset = useCallback(() => {
    rotate();
    setPhase({ state: 'idle' });
  }, [rotate]);

  // J13-F17: an answer found later (app resume, history refresh, foreground interval) replaces the provisional
  // banner of the attempt it belongs to — and only that one.
  useEffect(() => intentReconciler.subscribe((event) => {
    if (event.key !== keyRef.current) return;
    setPhase((p) => ({ ...event, afterCheck: true, ...(p.resumed ? { resumed: true } : {}) }));
    if (event.newIntentAllowed) rotate();
  }), [rotate]);

  const poll = useCallback(async (rec, resumed = false) => {
    for (let i = 0; i < POLL_TRIES; i += 1) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (keyRef.current !== rec.key) return { state: 'superseded' };
      // Lookup only (and, once overdue, closing a key nothing ran under) — never a re-submission.
      const out = await intentReconciler.reconcileOne(rec);
      if (FINAL.has(out.state)) {
        setPhase({ ...out, afterCheck: true, ...(resumed ? { resumed: true } : {}) }); // shown by MoneyPhaseBanner
        if (out.newIntentAllowed) rotate();
        return out;
      }
    }
    // Still unknown: keep blocking a second payment; the app-wide reconciler keeps checking in the foreground.
    const still = { state: 'checking', unknown: true, message: PROVISIONAL, stopPolling: true, ...(resumed ? { resumed: true } : {}) };
    setPhase(still);
    return still;
  }, [rotate]);

  // J12: on mount, resume any unknown outcome left by a previous session of this screen (same user).
  useEffect(() => {
    let alive = true;
    (async () => {
      const userId = await currentUser();
      if (!userId) return;
      const [rec] = await pendingIntentsToLookUp({ userId, flow }).catch(() => []);
      if (!alive || !rec) return;
      keyRef.current = rec.key;
      attemptRef.current = null; // an unknown attempt is only ever looked up — never re-bound for a retry
      setPhase({ state: 'checking', resumed: true, unknown: true, message: 'Nous vérifions le statut d’un paiement précédent. Ne le renouvelle pas pour le moment.' });
      poll(rec, true);
    })();
    return () => {
      alive = false;
    };
  }, [flow, poll]);

  /**
   * `run(intentKey)` must perform exactly one API write using that key.
   * `instruction` = what is paid and to whom (amount, recipient, charge code…), never the PIN token.
   */
  const submit = useCallback(
    async (run, { instruction } = {}) => {
      if (phase.state === 'submitting' || phase.state === 'checking') return { ok: false, state: phase.state };
      const userId = await currentUser();
      const fingerprint = instructionFingerprint(flow, instruction);
      // Same key only for the identical instruction, same user, recent attempt. Rotating is always safe
      // here: we only get here after a definite answer (refused / needs PIN / nothing received).
      if (attemptRef.current && !sameKeyRetryAllowed(attemptRef.current, { userId, fingerprint })) rotate();
      if (!attemptRef.current) attemptRef.current = { userId, fingerprint, createdAt: Date.now() };
      const key = keyRef.current;
      setPhase({ state: 'submitting' });
      try {
        const response = await run(key);
        const c = classifySubmission({ response });
        setPhase({ ...c, response });
        if (c.newIntentAllowed) rotate();
        return { ok: true, response, ...c };
      } catch (error) {
        const c = classifySubmission({ error });
        setPhase({ ...c, error });
        if (c.newIntentAllowed) rotate();
        if (c.state === 'checking') {
          const createdAt = attemptRef.current?.createdAt ?? Date.now();
          if (userId) await rememberPendingIntent({ key, userId, flow, fp: fingerprint, now: createdAt }).catch(() => {});
          const resolved = await poll({ key, userId, flow, createdAt });
          return { ok: resolved.state === 'done', error, ...resolved };
        }
        return { ok: false, error, ...c };
      }
    },
    [phase.state, poll, flow, rotate],
  );

  const busy = phase.state === 'submitting' || phase.state === 'checking';
  return { phase, submit, reset, busy, intentKey: keyRef };
}
