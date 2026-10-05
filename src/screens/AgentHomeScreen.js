import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import GlowButton from '../components/GlowButton';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import ReceiptCard from '../components/ReceiptCard';
import { useToast } from '../components/Toast';
import StepUpOverlay from '../components/StepUpOverlay';
import {
  agentCompleteCash,
  agentDeclineCash,
  agentScanCash,
  getAgentCommissions,
  getAgentMe,
  getCashTx,
  requestAgentFloatTopUp,
  getMyFloatTopUpRequests,
} from '../lib/api-client';
import KoriAmount from '../components/KoriAmount';
import { colors, fontFamily, radius, spacing, type } from '../theme';

function formatAmount(n) {
  return Math.round(n).toLocaleString('fr-FR').replace(/ /g, ' ');
}

export default function AgentHomeScreen({ navigation, route }) {
  const showToast = useToast();
  const [loading, setLoading] = useState(true);
  const [agentData, setAgentData] = useState(null);
  const [qrInput, setQrInput] = useState('');
  const [pending, setPending] = useState(null);
  const [stepUpVisible, setStepUpVisible] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [lastReceipt, setLastReceipt] = useState(null);
  const [payoutInfo, setPayoutInfo] = useState(null);
  const [topUpRequests, setTopUpRequests] = useState([]);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpNote, setTopUpNote] = useState('');
  const [topUpRequesting, setTopUpRequesting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [me, payouts, requests] = await Promise.all([
        getAgentMe(),
        getAgentCommissions().catch(() => null),
        getMyFloatTopUpRequests().catch(() => ({ requests: [] })),
      ]);
      setAgentData(me);
      setPayoutInfo(payouts);
      setTopUpRequests(requests.requests ?? []);
    } catch (err) {
      showToast(err.message ?? 'Accès agent refusé');
      navigation.goBack();
    } finally {
      setLoading(false);
    }
  }, [navigation, showToast]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const scanned = route.params?.scannedQr;
    if (scanned) {
      setQrInput(String(scanned));
      navigation.setParams?.({ scannedQr: undefined });
    }
  }, [route.params?.scannedQr, navigation]);

  // J6: the scanned operation is read back from the server until the
  // customer has confirmed (cash-in) / authorized with their PIN (cash-out).
  useEffect(() => {
    if (!pending?.id || pending.state !== 'agent_bound') return undefined;
    const poll = setInterval(async () => {
      try {
        setPending((await getCashTx(pending.id)).transaction);
      } catch {
        /* offline: keep the last known state */
      }
    }, 3000);
    return () => clearInterval(poll);
  }, [pending?.id, pending?.state]);

  const handleScan = async () => {
    const qr = qrInput.trim();
    if (qr.length < 8) {
      showToast('Scanne le code du client');
      return;
    }
    setConfirming(true);
    try {
      const { transaction } = await agentScanCash(qr);
      setPending(transaction);
    } catch (err) {
      showToast(err.message ?? 'Code invalide');
    } finally {
      setConfirming(false);
    }
  };

  const customerReady = pending && ['customer_confirmed', 'customer_authorized', 'needs_review'].includes(pending.state);

  const handleConfirm = async (stepUpToken) => {
    if (!pending?.id || !customerReady) return;
    setConfirming(true);
    try {
      const result = await agentCompleteCash(pending.id, pending.bindingHash, stepUpToken);
      setLastReceipt({
        user: pending.customer,
        amount: pending.amountXof,
        reference: result.receipt?.reference ?? pending.reference,
        kind: pending.kind,
      });
      showToast(pending.kind === 'cash_out' ? 'Retrait finalisé' : 'Dépôt finalisé — client crédité');
      setPending(null);
      setQrInput('');
      await reload();
    } catch (err) {
      if (err?.code === 'step_up_required') setStepUpVisible(true);
      else showToast(err.message ?? 'Finalisation impossible — vérifie l’état, ne recommence pas l’opération');
    } finally {
      setConfirming(false);
    }
  };

  const handleDecline = async () => {
    if (!pending?.id) return;
    setConfirming(true);
    try {
      await agentDeclineCash(pending.id, pending.kind === 'cash_out' ? 'cash non remis' : 'cash non reçu');
      setPending(null);
      setQrInput('');
      await reload();
    } catch (err) {
      showToast(err.message ?? 'Refus impossible');
    } finally {
      setConfirming(false);
    }
  };

  const submitTopUpRequest = async () => {
    const amountXof = Math.round(Number(topUpAmount));
    if (!amountXof || amountXof <= 0) {
      showToast('Montant invalide');
      return;
    }
    setTopUpRequesting(true);
    try {
      await requestAgentFloatTopUp(amountXof, topUpNote.trim() || undefined);
      showToast('Demande envoyée ✓ — un admin la traite sous peu');
      setTopUpAmount('');
      setTopUpNote('');
      await reload();
    } catch (err) {
      showToast(err.message ?? 'Demande impossible');
    } finally {
      setTopUpRequesting(false);
    }
  };

  const pendingTopUpRequest = topUpRequests.find((r) => r.status === 'pending');

  if (loading) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <SafeAreaView style={styles.center}>
          <ActivityIndicator color={colors.greenDark} size="large" />
        </SafeAreaView>
      </View>
    );
  }

  const agent = agentData?.agent;

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <ScreenHeader
            onBack={() => navigation.goBack()}
            eyebrow="MODE AGENT"
            title={agent?.displayName ?? 'Point K21'}
            style={styles.header}
          />

          <View style={styles.floatCard}>
            <Text style={styles.floatLabel}>Float disponible</Text>
            <Text style={styles.floatValue}>{formatAmount(agent?.floatBalance ?? 0)} F</Text>
            <Text style={styles.floatMeta}>
              {agent?.agentCode} · limite {formatAmount(agent?.floatLimit ?? 0)} F
            </Text>
            {agent?.locationLabel ? <Text style={styles.floatMeta}>{agent.locationLabel}</Text> : null}
          </View>

          <View style={styles.topUpCard}>
            <Text style={styles.floatLabel}>Recharger mon float</Text>
            {pendingTopUpRequest ? (
              <>
                <Text style={styles.topUpPendingText}>
                  Demande en attente · {formatAmount(pendingTopUpRequest.amountXof)} F
                </Text>
                <Text style={styles.floatMeta}>Un admin la traite sous peu.</Text>
              </>
            ) : (
              <>
                <TextInput
                  value={topUpAmount}
                  onChangeText={setTopUpAmount}
                  placeholder="Montant demandé (F CFA)"
                  placeholderTextColor={colors.appCanvas.textMuted}
                  keyboardType="number-pad"
                  style={[styles.input, { marginBottom: spacing.sm }]}
                />
                <TextInput
                  value={topUpNote}
                  onChangeText={setTopUpNote}
                  placeholder="Note (optionnel)"
                  placeholderTextColor={colors.appCanvas.textMuted}
                  style={styles.input}
                />
                <GlowButton
                  label={topUpRequesting ? 'Envoi…' : 'Demander un rechargement'}
                  onPress={submitTopUpRequest}
                  disabled={topUpRequesting || !topUpAmount.trim()}
                />
              </>
            )}
          </View>

          {payoutInfo?.summary ? (
            <View style={styles.payoutCard}>
              <Text style={styles.payoutTitle}>Commissions (financées par Jokko)</Text>
              <Text style={styles.payoutValue}>{payoutInfo.summary.accrued.amountKori} ₭ à verser</Text>
              <Text style={styles.payoutMeta}>
                Déjà versé · {payoutInfo.summary.settled.amountKori} ₭ · {payoutInfo.summary.accrued.count} opérations en attente
              </Text>
              <Text style={styles.payoutHint}>{payoutInfo.note}</Text>
            </View>
          ) : null}

          {lastReceipt ? (
            <ReceiptCard
              style={{ marginBottom: spacing.xl }}
              rows={[
                { key: 'u', label: 'Client', value: lastReceipt.user?.displayName ?? 'Client' },
                { key: 'a', label: 'Montant', value: `${formatAmount(lastReceipt.amount)} F`, color: colors.greenDark },
                { key: 'r', label: 'Référence', value: lastReceipt.reference },
              ]}
            />
          ) : null}

          {pending ? (
            <View style={styles.pendingCard}>
              <Text style={styles.pendingTitle}>
                {pending.kind === 'cash_out' ? 'Retrait client' : 'Dépôt client'}
              </Text>
              <Text style={styles.pendingRow}>Client · {pending.customer?.displayName ?? 'Client'}</Text>
              <Text style={styles.pendingRow}>Montant · {formatAmount(pending.amountXof)} F CFA</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: spacing.xs }}>
                <Text style={[styles.pendingRow, { marginBottom: 0 }]}>Kori · </Text>
                <KoriAmount value={pending.amountKori} textStyle={[styles.pendingRow, { marginBottom: 0 }]} />
              </View>
              {pending.customer?.verified ? (
                <Text style={styles.verified}>✓ Identité vérifiée</Text>
              ) : (
                <Text style={styles.unverified}>Identité non vérifiée — vérifie la pièce si gros montant</Text>
              )}
              <Text style={styles.pendingRow}>{pending.nextStep}</Text>
              {customerReady ? (
                <GlowButton
                  label={confirming ? 'Finalisation…' : pending.kind === 'cash_out' ? 'J’ai remis le cash — finaliser (PIN)' : 'J’ai reçu le cash — finaliser (PIN)'}
                  onPress={() => handleConfirm()}
                  disabled={confirming}
                  style={{ marginTop: spacing.lg }}
                />
              ) : (
                <Text style={styles.unverified}>En attente de la confirmation du client dans son application — ne remets / n’encaisse rien avant.</Text>
              )}
              <PressScale onPress={handleDecline} style={styles.cancelBtn}>
                <Text style={styles.cancelText}>Refuser l’opération</Text>
              </PressScale>
            </View>
          ) : (
            <>
              <Text style={styles.scanLabel}>Scanner le QR du client</Text>
              <TextInput
                value={qrInput}
                onChangeText={setQrInput}
                placeholder="jokko://cash/…"
                placeholderTextColor={colors.appCanvas.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <GlowButton
                label={confirming ? 'Lecture…' : 'Lire le QR'}
                onPress={handleScan}
                disabled={confirming || !qrInput.trim()}
              />
              <PressScale onPress={() => navigation.navigate('QrScan', { mode: 'agent' })} style={styles.scanLink}>
                <Text style={styles.scanLinkText}>📷 Ouvrir le scanner</Text>
              </PressScale>
            </>
          )}

          {agentData?.recentFloatEntries?.length ? (
            <View style={styles.history}>
              <Text style={styles.historyTitle}>Mouvements float</Text>
              {agentData.recentFloatEntries.slice(0, 8).map((e) => (
                <View key={e.id} style={styles.historyRow}>
                  <Text style={styles.historyType}>{e.type}</Text>
                  <Text style={[styles.historyAmt, e.amountXof < 0 && { color: colors.terracotta }]}>
                    {e.amountXof > 0 ? '+' : ''}
                    {formatAmount(e.amountXof)} F
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
      <StepUpOverlay visible={stepUpVisible} onCancel={() => setStepUpVisible(false)} onVerified={(t) => { setStepUpVisible(false); handleConfirm(t); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingHorizontal: spacing.huge, paddingBottom: spacing.giant },
  header: { marginTop: spacing.lg, marginBottom: spacing.xl },
  floatCard: {
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  floatLabel: { ...type.caption, color: colors.appCanvas.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  floatValue: { fontFamily: fontFamily.displayBlack, fontSize: 32, color: colors.greenDark, marginTop: spacing.xs },
  floatMeta: { ...type.caption, color: colors.appCanvas.textMuted, marginTop: spacing.xs },
  topUpCard: {
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    gap: spacing.sm,
  },
  topUpPendingText: { ...type.body, color: colors.goldDark, fontFamily: fontFamily.bodySemiBold },
  payoutCard: {
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  payoutTitle: { ...type.caption, color: colors.appCanvas.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  payoutValue: { fontFamily: fontFamily.displayBlack, fontSize: 26, color: colors.ink, marginTop: spacing.xs },
  payoutMeta: { ...type.caption, color: colors.appCanvas.textMuted, marginTop: spacing.sm },
  payoutHint: { ...type.caption, color: colors.appCanvas.textMuted, marginTop: spacing.sm, lineHeight: 18 },
  modeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  modeChip: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    alignItems: 'center',
  },
  modeChipOn: { borderColor: colors.green, backgroundColor: 'rgba(26,240,96,0.08)' },
  modeChipText: { ...type.caption, color: colors.appCanvas.textMuted, fontFamily: fontFamily.bodyMedium },
  modeChipTextOn: { color: colors.greenDark },
  scanLabel: { ...type.body, color: colors.ink, fontFamily: fontFamily.bodySemiBold, marginBottom: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    color: colors.ink,
    fontFamily: fontFamily.bodyBold,
    fontSize: 13,
    marginBottom: spacing.lg,
    backgroundColor: colors.appCanvas.surface,
  },
  scanLink: { alignItems: 'center', marginTop: spacing.lg },
  scanLinkText: { ...type.body, color: colors.greenDark, fontFamily: fontFamily.bodyMedium },
  pendingCard: {
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.green,
  },
  pendingTitle: { fontFamily: fontFamily.displayBlack, fontSize: 22, color: colors.ink, marginBottom: spacing.md },
  pendingRow: { ...type.body, color: colors.ink, marginBottom: spacing.xs },
  verified: { ...type.caption, color: colors.greenDark, marginTop: spacing.sm },
  unverified: { ...type.caption, color: colors.terracotta, marginTop: spacing.sm },
  cancelBtn: { alignItems: 'center', marginTop: spacing.md },
  cancelText: { ...type.body, color: colors.appCanvas.textMuted },
  history: { marginTop: spacing.xxl },
  historyTitle: { ...type.caption, color: colors.appCanvas.textMuted, marginBottom: spacing.md, textTransform: 'uppercase' },
  historyRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm },
  historyType: { ...type.caption, color: colors.ink },
  historyAmt: { ...type.caption, color: colors.greenDark, fontFamily: fontFamily.bodyMedium },
});
