import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * J13-F11: a button whose handler returns a promise ignores further taps until it settles — a slow
 * network can no longer turn an impatient double tap into two submissions (two QR charges, two
 * invitations, two tickets). Money flows keep their own server-side idempotency; this is the UI layer.
 * Unmount-safe: no state update after the screen is gone.
 */
export function usePressGuard(onPress) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const guarded = useCallback((...args) => {
    if (!onPress || inFlight.current) return undefined;
    const out = onPress(...args);
    if (out && typeof out.then === 'function') {
      inFlight.current = true;
      setBusy(true);
      const done = () => {
        inFlight.current = false;
        if (alive.current) setBusy(false);
      };
      out.then(done, done);
    }
    return out;
  }, [onPress]);
  return { busy, onPress: onPress ? guarded : undefined };
}
