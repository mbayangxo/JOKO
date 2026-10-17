import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { getWallet, getTransactions } from '../lib/api-client.js';

function generateId(prefix) {
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${part()}-${part()}`;
}

const EMPTY_PROFILE = {
  accountType: 'personal',
  name: '',
  handle: '',
  phone: '',
  email: '',
  arrondissement: { key: '', icon: '📍', name: '' },
  afriId: '',
  avatarEmoji: '👤',
  avatarUrl: null,
  verification: null,
  studentPass: null,
  business: null,
  businesses: [],
  pinConfigured: false,
  country: 'SN',
};

const AppStateContext = createContext(null);

export function AppStateProvider({ children }) {
  const [profile, setProfileState] = useState(EMPTY_PROFILE);
  const [balance, setBalance] = useState(0);
  const [transactions, setTransactions] = useState([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [pendingMboloShare, setPendingMboloShare] = useState(null);
  const [walletRefreshError, setWalletRefreshError] = useState(null);

  const setProfile = useCallback((partial) => {
    setProfileState((prev) => ({ ...prev, ...partial }));
  }, []);

  const hydrateFromApi = useCallback(({ profile: p, balance: b, transactions: txs }) => {
    setProfileState({
      accountType: p.accountType ?? 'personal',
      name: p.name ?? '',
      handle: p.handle ?? '',
      phone: p.phone ?? '',
      email: p.email ?? '',
      arrondissement: p.arrondissement ?? EMPTY_PROFILE.arrondissement,
      afriId: p.afriId ?? '',
      afri: p.afri ?? null,
      avatarEmoji: p.avatarEmoji ?? '👤',
      avatarUrl: p.avatarUrl ?? null,
      verification: p.verification ?? null,
      studentPass: p.studentPass ?? null,
      payQrUrl: p.payQrUrl ?? null,
      pinConfigured: Boolean(p.pinConfigured),
      country: p.country ?? 'SN',
      business: p.business ?? null,
      businesses: p.businesses ?? [],
    });
    setBalance(b ?? 0);
    setTransactions(txs ?? []);
    setAuthenticated(true);
    setWalletRefreshError(null);
  }, []);

  const resetSession = useCallback(() => {
    setProfileState(EMPTY_PROFILE);
    setBalance(0);
    setTransactions([]);
    setAuthenticated(false);
    setWalletRefreshError(null);
  }, []);

  const refreshWallet = useCallback(async () => {
    try {
      const [wallet, txs] = await Promise.all([getWallet(), getTransactions()]);
      setBalance(wallet.balance ?? wallet.koriBalance ?? 0);
      setTransactions(txs);
      setWalletRefreshError(null);
      return { ok: true, wallet, transactions: txs };
    } catch (error) {
      setWalletRefreshError(error?.message ?? 'Impossible de charger le solde');
      return { ok: false, error };
    }
  }, []);

  const initAccount = useCallback(({ name, handle, arrondissement, fundAmount, transactions: txs, profile: apiProfile, afriId }) => {
    setProfileState((prev) => ({
      ...prev,
      accountType: 'personal',
      name: name ?? prev.name,
      handle: handle ?? prev.handle,
      arrondissement: arrondissement ?? prev.arrondissement,
      afriId: afriId ?? apiProfile?.afriId ?? prev.afriId ?? generateId('AFRI'),
      business: null,
    }));
    if (fundAmount != null) setBalance(fundAmount);
    setTransactions(Array.isArray(txs) ? txs : []);
    setAuthenticated(true);
  }, []);

  const initBusinessAccount = useCallback(({ businessName, category, arrondissement, businessId, kebuId, keboId, afriId, type }) => {
    setProfileState((prev) => ({
      ...prev,
      accountType: type === 'cooperative' ? 'cooperative' : 'business',
      arrondissement,
      afriId: afriId ?? prev.afriId,
      business: {
        id: businessId,
        name: businessName,
        category,
        type: type ?? 'merchant',
        kebuId: kebuId ?? keboId ?? prev.business?.kebuId,
      },
    }));
    setBalance(0);
    setTransactions([]);
    setAuthenticated(true);
  }, []);

  const value = useMemo(
    () => ({
      profile,
      setProfile,
      balance,
      transactions,
      authenticated,
      walletRefreshError,
      initAccount,
      initBusinessAccount,
      hydrateFromApi,
      resetSession,
      refreshWallet,
      pendingMboloShare,
      setPendingMboloShare,
    }),
    [
      profile,
      setProfile,
      balance,
      transactions,
      authenticated,
      walletRefreshError,
      initAccount,
      initBusinessAccount,
      hydrateFromApi,
      resetSession,
      refreshWallet,
      pendingMboloShare,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}
