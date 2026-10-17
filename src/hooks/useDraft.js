import { useCallback, useEffect, useRef, useState } from 'react';
import { getAccessToken } from '../lib/secure-storage';
import { subjectOf } from '../lib/offline-policy';
import { clearDraft, loadDraft, saveDraft } from '../lib/drafts';

/**
 * J12 — `const { restored, save, discard } = useDraft('work-post', scope)`.
 * Restores the signed-in user's draft once (never submits), saves typed text (debounced), discards on send.
 */
export function useDraft(form, scope = '') {
  const [restored, setRestored] = useState(null);
  const user = useRef(null);
  const timer = useRef(null);
  useEffect(() => {
    let alive = true;
    if (scope === null) return undefined; // scope not known yet (e.g. business still loading): no draft
    (async () => {
      user.current = subjectOf(await getAccessToken().catch(() => null));
      const d = user.current ? await loadDraft({ userId: user.current, form, scope }).catch(() => null) : null;
      if (alive && d) setRestored(d);
    })();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [form, scope]);
  const save = useCallback(
    (fields) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (user.current && scope !== null) saveDraft({ userId: user.current, form, scope, fields }).catch(() => {});
      }, 600);
    },
    [form, scope],
  );
  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setRestored(null);
    if (user.current) clearDraft({ userId: user.current, form, scope }).catch(() => {});
  }, [form, scope]);
  return { restored, save, discard };
}
