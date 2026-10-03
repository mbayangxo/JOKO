import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  isBiometricEnabled,
  isPinConfigured,
  isSessionInactive,
  SESSION_INACTIVITY_MS,
  setBiometricEnabled as persistBiometric,
  setPinConfigured,
  touchActivity,
} from '../lib/secure-storage.js';
import { authBiometricEnable, authPinSet, authPinVerify } from '../lib/api-client.js';
import { authenticateWithBiometrics, canUseBiometrics } from '../lib/biometric.js';
import { assessDeviceRisk } from '../lib/device-security.js';

const SecurityContext = createContext(null);

export function SecurityProvider({ children }) {
  const [locked, setLocked] = useState(true);
  const [pinReady, setPinReady] = useState(false);
  const [biometricReady, setBiometricReady] = useState(false);
  const [deviceRisk, setDeviceRisk] = useState(null);
  const [stepUpToken, setStepUpToken] = useState(null);
  const [unlockMode, setUnlockMode] = useState('pin');
  // Server invalidated the PIN (forced credential reset / recovery): the user
  // must choose a new one before using the app.
  const [pinResetRequired, setPinResetRequired] = useState(false);
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    (async () => {
      const [pin, bio, risk] = await Promise.all([isPinConfigured(), isBiometricEnabled(), assessDeviceRisk()]);
      setPinReady(pin);
      setBiometricReady(bio);
      setDeviceRisk(risk);
      if (!pin) {
        setLocked(false);
        return;
      }
      const inactive = await isSessionInactive();
      setLocked(inactive);
    })();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      if (appState.current.match(/inactive|background/) && next === 'active' && pinReady) {
        const inactive = await isSessionInactive();
        if (inactive) setLocked(true);
      }
      appState.current = next;
    });
    return () => sub.remove();
  }, [pinReady]);

  const lock = useCallback(() => setLocked(true), []);

  const unlockWithPin = useCallback(async (pin) => {
    try {
      const result = await authPinVerify(pin, false);
      setStepUpToken(result.stepUpToken ?? null);
      await touchActivity();
      setLocked(false);
      return { ok: true };
    } catch (error) {
      if (error.code === 'pin_not_set') {
        setPinResetRequired(true);
        return { ok: false, needsSetup: true, message: 'Choisis un nouveau code PIN.' };
      }
      if (error.status === 401 || error.code === 'invalid_pin') {
        return { ok: false, message: error.message };
      }
      if (error.status === 423 || error.code === 'locked' || error.code === 'account_locked') {
        return { ok: false, locked: true, message: error.message };
      }
      return { ok: false, message: 'Connexion requise pour vérifier le PIN' };
    }
  }, []);

  const unlockWithBiometric = useCallback(async () => {
    const result = await authenticateWithBiometrics();
    if (!result.success) return { ok: false, message: 'Biométrie refusée' };
    await touchActivity();
    setLocked(false);
    return { ok: true };
  }, []);

  const setupPin = useCallback(async (pin) => {
    // The server is the source of truth: never mark a PIN configured locally
    // if the server refused it (e.g. re-verification required after a reset).
    await authPinSet(pin);
    await setPinConfigured(true);
    setPinReady(true);
    setPinResetRequired(false);
    setLocked(false);
  }, []);

  const enableBiometric = useCallback(async () => {
    const can = await canUseBiometrics();
    if (!can) return { ok: false, message: 'Biométrie non disponible' };
    const auth = await authenticateWithBiometrics('Activer la connexion biométrique');
    if (!auth.success) return { ok: false, message: 'Vérification biométrique échouée' };
    try {
      await authBiometricEnable(true);
    } catch {
      /* offline */
    }
    await persistBiometric(true);
    setBiometricReady(true);
    return { ok: true };
  }, []);

  const requestStepUp = useCallback(async (pin) => {
    try {
      const result = await authPinVerify(pin, true);
      setStepUpToken(result.stepUpToken);
      return { ok: true, stepUpToken: result.stepUpToken };
    } catch (error) {
      return { ok: false, message: error.message, code: error.code };
    }
  }, []);

  const value = useMemo(
    () => ({
      locked,
      pinReady,
      pinResetRequired,
      biometricReady,
      deviceRisk,
      stepUpToken,
      unlockMode,
      setUnlockMode,
      lock,
      unlockWithPin,
      unlockWithBiometric,
      setupPin,
      enableBiometric,
      requestStepUp,
      clearStepUp: () => setStepUpToken(null),
      sessionInactivityMs: SESSION_INACTIVITY_MS,
    }),
    [
      locked,
      pinReady,
      pinResetRequired,
      biometricReady,
      deviceRisk,
      stepUpToken,
      unlockMode,
      lock,
      unlockWithPin,
      unlockWithBiometric,
      setupPin,
      enableBiometric,
      requestStepUp,
    ],
  );

  return <SecurityContext.Provider value={value}>{children}</SecurityContext.Provider>;
}

export function useSecurity() {
  const ctx = useContext(SecurityContext);
  if (!ctx) throw new Error('useSecurity must be used within SecurityProvider');
  return ctx;
}
