import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import K21QrCode from '../components/K21QrCode';
import GlowButton from '../components/GlowButton';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import StepUpOverlay from '../components/StepUpOverlay';
import { useScreenshotBlock } from '../hooks/useScreenshotBlock';
import { useToast } from '../components/Toast';
import { cancelCashTx, confirmCashTx, createCashIntent, getCashTx, listCashTx, reissueCashChallenge } from '../lib/api-client';
import { newIntentKey } from '../lib/money-ux';
import { formatKori } from '../lib/kori.js';
import { useAppState } from '../state/AppState';
import { colors, fontFamily, radius, spacing, type } from '../theme';

/**
 * J6 customer side of a cash-in / cash-out at an agent (J6.4 / J6.5 / J6.15).
 *
 *  pending   QR shown → a point scans → the screen shows WHICH point and the
 *            amount → the customer confirms (cash-in) or authorizes with the
 *            PIN (cash-out)
 *  checking  the point finalizes; after a timeout / app restart we read the
 *            server state — the screen never asks to repeat a cash handoff
 *  completed receipt
 *  failed_cancelled  nothing moved (or the reserved ₭ came back)
 *
 * One intent key per attempt; on mount an OPEN transaction of this kind is
 * resumed instead of creating a new one.
 */
const fmt = (n) => Math.round(n).toLocaleString('fr-FR').replace(/ /g, ' ');
const countdown = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function AgentCashScreen({ navigation, route, kind: kindProp }) {
  useScreenshotBlock(true);
  const showToast = useToast();
  const { refreshWallet } = useAppState();
  const kind = kindProp ?? (route.params?.kind === 'cash_out' ? 'cash_out' : 'cash_in');
  const amountXof = route.params?.amount ?? 5000;
  const intentKey = useRef(newIntentKey());
  const [tx, setTx] = useState(null);
  const [qr, setQr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState(null); // 'create' | 'authorize'
  const [now, setNow] = useState(Date.now());

  const start = useCallback(async (stepUpToken) => {
    setLoading(true);
    try {
      // Resume an open operation (app restart / lost response) before creating anything.
      const mine = await listCashTx().catch(() => null);
      const open = mine?.open?.find((t) => t.kind === kind && t.amountXof === amountXof);
      if (open) {
        setTx(open);
        return;
      }
      const res = await createCashIntent({ kind, amountXof, intentKey: intentKey.current, stepUpToken });
      setTx(res.transaction);
      setQr(res.qr ?? null);
    } catch (e) {
      if (e?.code === 'step_up_required') {
        setStepUp('create');
        return;
      }
      showToast(e?.message ?? 'Opération impossible');
      navigation.goBack();
    } finally {
      setLoading(false);
    }
  }, [amountXof, kind, navigation, showToast]);

  useEffect(() => { start(); }, [start]);

  // Poll the authoritative state while the operation is open.
  useEffect(() => {
    if (!tx || !['pending', 'checking'].includes(tx.status)) return undefined;
    const poll = setInterval(async () => {
      try {
        const r = await getCashTx(tx.id);
        setTx(r.transaction);
        if (r.transaction.status === 'completed') refreshWallet().catch(() => {});
      } catch {
        // offline: keep the last known state; never suggest redoing the cash
      }
    }, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [tx?.id, tx?.status, refreshWallet]);

  const newQr = async () => {
    setBusy(true);
    try {
      const r = await reissueCashChallenge(tx.id);
      setTx(r.transaction);
      setQr(r.qr);
    } catch (e) {
      showToast(e?.message ?? 'Impossible de renouveler le code');
    } finally {
      setBusy(false);
    }
  };

  const commit = async (stepUpToken) => {
    setBusy(true);
    try {
      const r = await confirmCashTx(tx.id, tx.bindingHash, stepUpToken);
      setTx(r.transaction);
    } catch (e) {
      if (e?.code === 'step_up_required') setStepUp('authorize');
      else showToast(e?.message ?? 'Confirmation impossible');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      const r = await cancelCashTx(tx.id);
      setTx(r.transaction);
      refreshWallet().catch(() => {});
    } catch (e) {
      showToast(e?.message ?? 'Annulation impossible');
    } finally {
      setBusy(false);
    }
  };

  const onVerified = (token) => {
    const what = stepUp;
    setStepUp(null);
    if (what === 'create') start(token);
    else commit(token);
  };

  if (loading || !tx) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <SafeAreaView style={styles.center}>
          <ActivityIndicator size="large" color={colors.greenDark} />
          <Text style={styles.muted}>Préparation…</Text>
        </SafeAreaView>
        <StepUpOverlay visible={Boolean(stepUp)} onCancel={() => { setStepUp(null); navigation.goBack(); }} onVerified={onVerified} />
      </View>
    );
  }

  const isOut = kind === 'cash_out';
  const bound = ['agent_bound'].includes(tx.state);
  const unbound = ['created', 'funds_held'].includes(tx.state);
  const left = new Date(tx.challengeExpiresAt).getTime() - now;
  const title = tx.status === 'completed' ? (isOut ? 'Retrait terminé' : 'Dépôt terminé')
    : tx.status === 'failed_cancelled' ? 'Opération arrêtée'
      : tx.status === 'checking' ? 'Finalisation en cours'
        : bound ? 'Vérifie le point de service' : 'Montre ce code au point de service';

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <ScreenHeader onBack={() => navigation.goBack()} eyebrow={isOut ? 'RETRAIT AGENT' : 'DÉPÔT AGENT'} title={title} style={styles.header} />
          <Text style={styles.amount}>{fmt(tx.amountXof)} F CFA</Text>
          <Text style={styles.kori}>{isOut ? '−' : '+'}{formatKori(tx.amountKori)}</Text>
          {isOut && unbound ? <Text style={styles.note}>Montant réservé sur ton solde — rendu si l’opération n’aboutit pas.</Text> : null}

          {unbound && qr && left > 0 ? (
            <>
              <View style={styles.qrWrap}><K21QrCode value={qr} size={200} /></View>
              <Text style={styles.muted}>Expire dans {countdown(left)} · {tx.reference}</Text>
            </>
          ) : null}
          {unbound && (!qr || left <= 0) && tx.state !== 'risk_hold' ? (
            <GlowButton label="Afficher un nouveau code" onPress={newQr} disabled={busy} style={styles.btn} />
          ) : null}

          {bound && tx.servicePoint ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{tx.servicePoint.name ?? tx.servicePoint.agentName}</Text>
              <Text style={styles.muted}>{tx.servicePoint.publicAddress}</Text>
              <Text style={styles.code}>{tx.servicePoint.agentCode}</Text>
              <Text style={styles.note}>
                {isOut
                  ? 'Si c’est bien ce point et ce montant, autorise avec ton code PIN. L’agent te remet ensuite le cash.'
                  : 'Si c’est bien ce point et ce montant, confirme puis remets le cash à l’agent.'}
              </Text>
              <GlowButton label={isOut ? 'Autoriser avec mon PIN' : 'Je confirme ce point'} onPress={() => commit()} disabled={busy} style={styles.btn} />
            </View>
          ) : null}

          <Text style={styles.next}>{tx.nextStep}</Text>

          {unbound || bound || tx.state === 'risk_hold' ? (
            <GlowButton label="Annuler" tone="ink" onPress={cancel} disabled={busy} style={styles.btn} />
          ) : null}
          {tx.status === 'completed' || tx.status === 'failed_cancelled' ? (
            <GlowButton label="Terminer" onPress={() => navigation.popToTop()} style={styles.btn} />
          ) : null}
        </ScrollView>
      </SafeAreaView>
      <StepUpOverlay visible={Boolean(stepUp)} onCancel={() => setStepUp(null)} onVerified={onVerified} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  scroll: { paddingHorizontal: spacing.huge, paddingBottom: spacing.giant },
  header: { marginTop: spacing.lg, marginBottom: spacing.xl },
  amount: { fontFamily: fontFamily.displayBlack, fontSize: 36, color: colors.ink, textAlign: 'center' },
  kori: { ...type.body, color: colors.terracotta, textAlign: 'center', marginBottom: spacing.lg },
  qrWrap: { alignItems: 'center', marginVertical: spacing.lg },
  muted: { ...type.caption, color: colors.appCanvas.textMuted, textAlign: 'center' },
  note: { ...type.caption, color: colors.appCanvas.textMuted, textAlign: 'center', lineHeight: 18, marginTop: spacing.sm },
  next: { ...type.body, color: colors.ink, textAlign: 'center', marginTop: spacing.xl, lineHeight: 22 },
  card: { backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: radius.lg, padding: spacing.lg, marginTop: spacing.lg },
  cardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 18, color: colors.ink, textAlign: 'center' },
  code: { fontFamily: fontFamily.bodySemiBold, fontSize: 12, color: colors.greenDark, textAlign: 'center', marginTop: spacing.xs },
  btn: { marginTop: spacing.lg },
});
