import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { useAppState } from '../state/AppState';
import { intentReconciler, reconcileNow } from '../lib/intent-reconciliation';
import { FOREGROUND_INTERVAL_MS } from '../lib/intent-reconciler';

/**
 * J13-F17 — keeps unknown money attempts moving to a final, server-confirmed answer while the app is in the
 * FOREGROUND: on start, on resume (app active / tab visible) and every FOREGROUND_INTERVAL_MS while visible.
 * Background execution is never assumed. When an answer arrives the balance is refreshed from the server;
 * screens that show the attempt or the history subscribe to the same events. Renders nothing.
 */
export default function IntentReconciliationRunner() {
  const { refreshWallet } = useAppState();

  useEffect(() => {
    const visible = () => Platform.OS !== 'web' || typeof document === 'undefined' || document.visibilityState !== 'hidden';
    reconcileNow();
    const unsubscribe = intentReconciler.subscribe(() => {
      refreshWallet?.().catch(() => {});
    });
    const sub = AppState.addEventListener?.('change', (s) => {
      if (s === 'active') reconcileNow();
    });
    const onVisible = () => {
      if (visible()) reconcileNow();
    };
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisible);
    const timer = setInterval(() => {
      if (visible()) reconcileNow(); // reads the local list; touches the network only when something is unknown
    }, FOREGROUND_INTERVAL_MS);
    return () => {
      unsubscribe();
      sub?.remove?.();
      if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [refreshWallet]);

  return null;
}
