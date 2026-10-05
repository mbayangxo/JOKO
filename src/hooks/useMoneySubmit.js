import { useCallback, useRef, useState } from 'react';
import { getMoneyIntent } from '../lib/api-client';
import { classifyIntent, classifySubmission, newIntentKey } from '../lib/money-ux';

/**
 * J4 — one money submission = one intent key, reused for every retry of that
 * attempt (step-up re-submit, "réessayer" after an unknown outcome). When the
 * response is lost, the hook polls GET /api/money/intents/:key and never lets
 * the screen fire a second payment while the first one's outcome is unknown.
 *
 * phase.state: idle | submitting | done | accepted_pending | checking |
 *              needs_pin | blocked | failed_safe | safe_to_retry
 */
const POLL_MS = 2000;
const POLL_TRIES = 15;

export function useMoneySubmit() {
  const keyRef = useRef(newIntentKey());
  const [phase, setPhase] = useState({ state: 'idle' });

  const reset = useCallback(() => {
    keyRef.current = newIntentKey();
    setPhase({ state: 'idle' });
  }, []);

  const poll = useCallback(async () => {
    for (let i = 0; i < POLL_TRIES; i += 1) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const out = classifyIntent(await getMoneyIntent(keyRef.current));
        if (out.stopPolling) {
          setPhase(out);
          if (out.newIntentAllowed) keyRef.current = newIntentKey();
          return out;
        }
      } catch {
        // still offline: keep showing "checking" — never suggest paying again
      }
    }
    const still = { state: 'checking', message: 'Toujours en vérification. Consulte ton historique avant de renouveler.', stopPolling: true };
    setPhase(still);
    return still;
  }, []);

  /** `run(intentKey)` must perform exactly one API write using that key. */
  const submit = useCallback(
    async (run) => {
      if (phase.state === 'submitting' || phase.state === 'checking') return { ok: false, state: phase.state };
      setPhase({ state: 'submitting' });
      try {
        const response = await run(keyRef.current);
        const c = classifySubmission({ response });
        setPhase({ ...c, response });
        if (c.newIntentAllowed) keyRef.current = newIntentKey();
        return { ok: true, response, ...c };
      } catch (error) {
        const c = classifySubmission({ error });
        setPhase({ ...c, error });
        if (c.newIntentAllowed) keyRef.current = newIntentKey();
        if (c.state === 'checking') {
          const resolved = await poll();
          return { ok: resolved.state === 'done', error, ...resolved };
        }
        return { ok: false, error, ...c };
      }
    },
    [phase.state, poll],
  );

  const busy = phase.state === 'submitting' || phase.state === 'checking';
  return { phase, submit, reset, busy, intentKey: keyRef };
}
