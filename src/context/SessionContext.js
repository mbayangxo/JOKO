import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearSession, getAccessToken, getRefreshToken, setPinConfigured } from '../lib/secure-storage.js';
import { authLogout } from '../lib/api-client.js';
import { restoreSession } from '../lib/session.js';
import { useAppState } from '../state/AppState.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const { hydrateFromApi, resetSession: resetAppState } = useAppState();
  const [bootstrapped, setBootstrapped] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [bootstrapError, setBootstrapError] = useState(null);

  const bootstrap = useCallback(async () => {
    setBootstrapError(null);
    try {
      const payload = await restoreSession();
      if (payload) {
        hydrateFromApi(payload);
        if (payload.profile?.pinConfigured) {
          await setPinConfigured(true);
        }
        setHasSession(true);
      } else {
        setHasSession(false);
      }
    } catch (error) {
      const authFailure =
        error?.status === 401 ||
        ['token_expired', 'token_invalid', 'no_token', 'profile_incomplete'].includes(error?.code);

      if (authFailure) {
        await clearSession();
        resetAppState();
        setHasSession(false);
        return;
      }

      const token = await getAccessToken();
      if (token && (error?.code === 'network' || error?.code === 'timeout')) {
        setHasSession(true);
        setBootstrapError(error?.message ?? 'Connexion impossible — réessaie');
        return;
      }

      setHasSession(false);
      setBootstrapError(error?.message ?? 'Session introuvable');
    } finally {
      setBootstrapped(true);
    }
  }, [hydrateFromApi, resetAppState]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const markSignedIn = useCallback(() => setHasSession(true), []);

  const signOut = useCallback(async () => {
    // Revoke the refresh token server-side; never block sign-out on the network.
    try {
      const refreshToken = await getRefreshToken();
      if (refreshToken) await Promise.race([authLogout(refreshToken), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      /* offline: local sign-out still happens */
    }
    await clearSession();
    resetAppState();
    setHasSession(false);
    setBootstrapError(null);
  }, [resetAppState]);

  const value = useMemo(
    () => ({
      bootstrapped,
      hasSession,
      bootstrapError,
      markSignedIn,
      signOut,
      refreshBootstrap: bootstrap,
    }),
    [bootstrapped, hasSession, bootstrapError, markSignedIn, signOut, bootstrap],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
