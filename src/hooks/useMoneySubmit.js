import { useCallback, useEffect, useRef, useState } from 'react';
import { getMoneyIntent } from '../lib/api-client';
import { classifyIntent, classifySubmission, newIntentKey } from '../lib/money-ux';
import { getAccessToken } from '../lib/secure-storage';
import { instructionFingerprint, sameKeyRetryAllowed, subjectOf } from '../lib/offline-policy';
import { forgetPendingIntent, pendingIntentsToLookUp, rememberPendingIntent } from '../lib/pending-intents';

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
 *              needs_pin | blocked | failed_safe | safe_to_retry
 */
const POLL_MS = 2000;
const POLL_TRIES = 15;
const RESOLVED = new Set(['done', 'accepted_pending', 'failed_safe', 'blocked', 'safe_to_retry']);

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

  const poll = useCallback(async (resumed = false) => {
    const key = keyRef.current;
    for (let i = 0; i < POLL_TRIES; i += 1) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        let out = classifyIntent(await getMoneyIntent(key));
        if (out.stopPolling) {
          if (RESOLVED.has(out.state)) forgetPendingIntent(key).catch(() => {});
          // After a restart the original instruction is gone: "nothing received" means start afresh.
          if (resumed && out.state === 'safe_to_retry') out = { ...out, canRetrySameIntent: false, newIntentAllowed: true, message: 'Le paiement précédent n’a pas été reçu — aucun argent n’a été débité. Recommence si besoin.' };
          setPhase({ ...out, afterCheck: true, ...(resumed ? { resumed: true } : {}) }); // shown by MoneyPhaseBanner
          if (out.newIntentAllowed) rotate();
          return out;
        }
      } catch {
        // still offline: keep showing "checking" — never suggest paying again
      }
    }
    const still = { state: 'checking', message: 'Toujours en vérification. Consulte ton historique avant de renouveler.', stopPolling: true };
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
      attemptRef.current = null; // the instruction is unknown here: same-key retry is never offered
      setPhase({ state: 'checking', resumed: true, message: 'Un paiement précédent est en vérification… Ne le renouvelle pas.' });
      poll(true);
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
          if (userId) await rememberPendingIntent({ key, userId, flow }).catch(() => {});
          const resolved = await poll();
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
