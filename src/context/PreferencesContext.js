import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { loadPreferences, savePreferences } from '../lib/preferences-storage';

const PreferencesContext = createContext(null);

export function PreferencesProvider({ children }) {
  const [prefs, setPrefs] = useState({ lowDataMode: false, largeText: false, ready: false });

  useEffect(() => {
    loadPreferences().then((loaded) => setPrefs({ ...loaded, ready: true }));
  }, []);

  // J13-F10: the system "reduce motion" setting also stops decorative loops (accessibility + low-end Android).
  const [osReduceMotion, setOsReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (alive) setOsReduceMotion(Boolean(v)); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v) => setOsReduceMotion(Boolean(v)));
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  const setLowDataMode = useCallback(async (lowDataMode) => {
    const next = await savePreferences({ lowDataMode });
    setPrefs((p) => ({ ...p, ...next }));
  }, []);

  const setLargeText = useCallback(async (largeText) => {
    const next = await savePreferences({ largeText });
    setPrefs((p) => ({ ...p, ...next }));
  }, []);

  const value = useMemo(
    () => ({
      lowDataMode: prefs.lowDataMode,
      largeText: prefs.largeText,
      ready: prefs.ready,
      setLowDataMode,
      setLargeText,
      /** Skip decorative animations and heavy visuals on slow connections. */
      reduceMotion: prefs.lowDataMode || osReduceMotion,
    }),
    [prefs, osReduceMotion, setLowDataMode, setLargeText],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences must be used within PreferencesProvider');
  return ctx;
}

/** Null-safe: decorative animation hooks may render outside the provider (e.g. the splash). */
export function useReduceMotion() {
  return Boolean(useContext(PreferencesContext)?.reduceMotion);
}
