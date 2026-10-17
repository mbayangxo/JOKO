import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import StepUpOverlay from '../components/StepUpOverlay';
import { useToast } from '../components/Toast';
import { useAppState } from '../state/AppState';
import { approvePartnerDebit, getPartnerDebit, rejectPartnerDebit } from '../lib/api-client';
import {
  BLOCKER_TEXT, KIND_LABEL, STATUS_LABEL, approvalState, countdownLabel, explainDecision, formatKori, secondsLeft, sortedRecipients,
} from '../lib/partner-debit-view';
import { colors, fontFamily, radius, spacing } from '../theme';

/**
 * J15-D2 — S4 approval screen. A partner REQUESTED a debit of this business's wallet; nothing moves unless an
 * authorized financial approver approves exactly these details here, with a fresh PIN. Every recipient and
 * amount is listed; fees, total, balance, expiry and status come from the server. A lost reply is resolved by
 * re-reading the request (server truth), never by approving again blindly.
 */
export default function PartnerDebitDetailScreen({ navigation, route }) {
  const { businessId, id } = route.params ?? {};
  const { profile } = useAppState();
  const showToast = useToast();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [confirmed, setConfirmed] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [filter, setFilter] = useState('');
  const shownHash = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await getPartnerDebit(businessId, id);
      // Details are immutable: if what the server returns ever differs from what was shown, start over.
      if (shownHash.current && shownHash.current !== r.detailsHash) setConfirmed(false);
      shownHash.current = r.detailsHash;
      setD(r);
      setFetchedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e.status === 404 ? 'Demande introuvable ou tu n’as pas les droits financiers sur ce commerce.' : e.message ?? 'Chargement impossible');
    }
  }, [businessId, id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const sec = secondsLeft(d, now, fetchedAt);
  const state = approvalState(d, { sec, confirmed, meUserHandle: profile?.handle });
  const recipients = useMemo(() => {
    const q = filter.trim().toLowerCase().replace(/^@/, '');
    return sortedRecipients(d).filter((r) => !q || `${r.name ?? ''} ${r.handle ?? ''}`.toLowerCase().includes(q));
  }, [d, filter]);

  const approve = async (stepUpToken) => {
    if (busy || !d) return;
    setBusy(true);
    try {
      const out = await approvePartnerDebit(businessId, id, { detailsHash: d.detailsHash, stepUpToken });
      showToast(out.status === 'executed' ? `Payé : ${formatKori(d.totalDebitKori)} débités du commerce` : STATUS_LABEL[out.status] ?? 'Demande traitée');
    } catch (e) {
      if (e.code === 'step_up_required' || e.code === 'pin_required') {
        setBusy(false);
        return setStepUp(true);
      }
      if (!e.status) {
        // Unknown outcome (connection lost): the server decides — re-read, never resend blindly.
        setChecking(true);
        showToast('Connexion perdue — vérification du statut…');
      } else {
        showToast(e.message ?? 'Approbation impossible — rien n’a été débité');
      }
    }
    await load();
    setChecking(false);
    setBusy(false);
  };

  const reject = async () => {
    if (reason.trim().length < 3) return showToast('Indique un motif (3 caractères au moins)');
    setBusy(true);
    try {
      await rejectPartnerDebit(businessId, id, reason.trim());
      showToast('Demande refusée — rien n’a été débité');
      setRejecting(false);
    } catch (e) {
      showToast(e.message ?? 'Refus impossible');
    }
    await load();
    setBusy(false);
  };

  if (!d) {
    return (
      <View style={s.root}><ScreenBackground /><SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Demande de paiement" />
        <View style={s.pad}>{error ? <Text style={s.body} accessibilityRole="alert">{error}</Text> : <ActivityIndicator accessibilityLabel="Chargement" />}</View>
      </SafeAreaView></View>
    );
  }
  const decided = d.status !== 'requested';
  const explanation = explainDecision(d);
  return (
    <View style={s.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Demande de paiement" />
        <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
          <View style={[s.chip, decided ? (d.status === 'executed' ? s.chipOk : s.chipOff) : s.chipWait]} accessibilityRole="text" accessibilityLabel={`Statut : ${STATUS_LABEL[d.status]}`}>
            <Text style={s.chipText}>{STATUS_LABEL[d.status] ?? d.status}</Text>
          </View>
          {checking ? <Text style={s.body} accessibilityLiveRegion="polite">Vérification du statut auprès de K21…</Text> : null}
          {explanation ? <Text style={s.body} accessibilityRole="alert">{explanation}</Text> : null}

          <View style={s.card}>
            <Text style={s.eyebrow}>Demandé par le partenaire</Text>
            <Text style={s.title} testID="pd-partner">{d.partner}</Text>
            <Text style={s.body}>{KIND_LABEL[d.kind] ?? d.kind} · réf. partenaire {d.externalRef}</Text>
            {d.memo ? <Text style={s.body}>« {d.memo} »</Text> : null}
            <Text style={s.small}>Demande reçue le {new Date(d.createdAt).toLocaleString('fr-SN')} · détails non modifiables</Text>
          </View>

          <View style={s.card} accessible accessibilityLabel={`Total à débiter ${formatKori(d.totalDebitKori)}, dont frais ${formatKori(d.feesKori)}. Solde du commerce ${formatKori(d.balanceKori)}.`}>
            <Row label={`Montant (${d.lineCount} bénéficiaire${d.lineCount > 1 ? 's' : ''})`} value={formatKori(d.totalKori)} />
            <Row label="Frais K21" value={formatKori(d.feesKori)} />
            <Row label="Total débité du commerce" value={formatKori(d.totalDebitKori)} strong testID="pd-total" />
            <Row label="Solde du commerce" value={formatKori(d.balanceKori)} />
            {!d.sufficientFunds && !decided ? <Text style={s.warn} accessibilityRole="alert">Solde insuffisant pour ce paiement.</Text> : null}
          </View>

          {!decided ? (
            <Text style={[s.countdown, sec < 120 && s.warn]} testID="pd-expiry" accessibilityLiveRegion={sec % 60 === 0 ? 'polite' : 'none'}>{countdownLabel(sec)}</Text>
          ) : null}

          <View style={s.card}>
            <Text style={s.eyebrow}>Bénéficiaires ({d.recipients.length})</Text>
            {d.recipients.length > 6 ? (
              <TextInput value={filter} onChangeText={setFilter} placeholder="Rechercher un nom ou @pseudo" placeholderTextColor={colors.whiteA40} style={s.input} accessibilityLabel="Rechercher parmi les bénéficiaires" autoCapitalize="none" />
            ) : null}
            {recipients.map((r) => (
              <View key={r.line} style={s.recipient} accessible accessibilityLabel={`${r.name ?? 'Sans nom'}, @${r.handle}, ${formatKori(r.amountKori)}${r.handleChanged ? ', attention : pseudo différent de celui envoyé par le partenaire' : ''}`}>
                <View style={{ flex: 1 }}>
                  <Text style={s.body}>{r.name ?? 'Sans nom'}{r.employee ? ' · salarié' : ''}</Text>
                  <Text style={s.small}>@{r.handle}{r.reference ? ` · ${r.reference}` : ''}</Text>
                  {r.handleChanged ? <Text style={s.warn}>Le partenaire a envoyé @{r.handleSentByPartner} : le compte payé est celui vérifié à la demande.</Text> : null}
                </View>
                <Text style={s.amount}>{formatKori(r.amountKori)}</Text>
              </View>
            ))}
          </View>

          {!decided ? (
            <>
              {state.blocker && state.blocker !== 'confirm_required' ? <Text style={s.warn} accessibilityRole="alert">{BLOCKER_TEXT[state.blocker]}</Text> : null}
              {sec > 0 && state.blocker !== 'self' && d.sufficientFunds ? (
                <PressScale onPress={() => setConfirmed((c) => !c)} style={s.check} accessibilityRole="checkbox" accessibilityState={{ checked: confirmed }} testID="pd-confirm">
                  <Text style={s.checkBox}>{confirmed ? '☑' : '☐'}</Text>
                  <Text style={[s.body, { flex: 1 }]}>J’ai vérifié les {d.recipients.length} bénéficiaires et le total de {formatKori(d.totalDebitKori)}.</Text>
                </PressScale>
              ) : null}
              <PressScale onPress={() => state.canApprove && approve()} disabled={!state.canApprove || busy} style={[s.primary, (!state.canApprove || busy) && s.disabled]} accessibilityRole="button" accessibilityState={{ disabled: !state.canApprove || busy }} testID="pd-approve">
                <Text style={s.primaryText}>{busy ? 'Traitement…' : `Approuver et payer ${formatKori(d.totalDebitKori)}`}</Text>
              </PressScale>
              <Text style={s.small}>Ton code PIN sera demandé. Rien n’est débité avant ton approbation.</Text>
              {state.canReject ? (
                rejecting ? (
                  <View style={s.card}>
                    <TextInput value={reason} onChangeText={setReason} placeholder="Motif du refus" placeholderTextColor={colors.whiteA40} style={s.input} accessibilityLabel="Motif du refus" testID="pd-reason" />
                    <PressScale onPress={reject} disabled={busy} style={s.secondary} accessibilityRole="button" testID="pd-reject-confirm"><Text style={s.secondaryText}>Confirmer le refus</Text></PressScale>
                  </View>
                ) : (
                  <PressScale onPress={() => setRejecting(true)} style={s.secondary} accessibilityRole="button" testID="pd-reject"><Text style={s.secondaryText}>Refuser la demande</Text></PressScale>
                )
              ) : null}
            </>
          ) : null}
        </ScrollView>
        <StepUpOverlay visible={stepUp} onCancel={() => setStepUp(false)} onVerified={(token) => { setStepUp(false); approve(token); }} />
      </SafeAreaView>
    </View>
  );
}

function Row({ label, value, strong, testID }) {
  return (
    <View style={s.row}>
      <Text style={[s.body, { flex: 1 }]}>{label}</Text>
      <Text style={strong ? s.total : s.amount} testID={testID}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  pad: { padding: spacing.xxxl, gap: spacing.xl, paddingBottom: 48 },
  card: { backgroundColor: colors.whiteA06, borderRadius: radius.xl, padding: spacing.xxxl, gap: spacing.md, borderWidth: 1, borderColor: colors.whiteA10 },
  eyebrow: { fontFamily: fontFamily.bodyBold, fontSize: 12, letterSpacing: 1, color: colors.whiteA55, textTransform: 'uppercase' },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.white },
  body: { fontFamily: fontFamily.bodyRegular, fontSize: 15, color: colors.whiteA85, lineHeight: 21 },
  small: { fontFamily: fontFamily.bodyMedium, fontSize: 13, color: colors.whiteA55, lineHeight: 18 },
  warn: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.gold, lineHeight: 20 },
  amount: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.white },
  total: { fontFamily: fontFamily.displayBlack, fontSize: 22, color: colors.green },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 32 },
  countdown: { fontFamily: fontFamily.bodyBold, fontSize: 16, color: colors.white, textAlign: 'center' },
  recipient: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.whiteA08, minHeight: 48 },
  input: { borderWidth: 1, borderColor: colors.whiteA20, borderRadius: radius.lg, padding: spacing.xl, color: colors.white, fontSize: 15, minHeight: 48 },
  check: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center', minHeight: 48, padding: spacing.md },
  checkBox: { fontSize: 24, color: colors.green },
  primary: { backgroundColor: colors.green, borderRadius: radius.round, minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxxl },
  primaryText: { fontFamily: fontFamily.displayBlack, fontSize: 16, color: colors.ink },
  disabled: { opacity: 0.4 },
  secondary: { borderWidth: 1, borderColor: colors.whiteA35, borderRadius: radius.round, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.white },
  chip: { alignSelf: 'flex-start', borderRadius: radius.round, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm },
  chipWait: { backgroundColor: colors.goldA09 ?? colors.whiteA10, borderWidth: 1, borderColor: colors.gold },
  chipOk: { backgroundColor: colors.greenA15, borderWidth: 1, borderColor: colors.green },
  chipOff: { backgroundColor: colors.whiteA08, borderWidth: 1, borderColor: colors.whiteA35 },
  chipText: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.white },
});
