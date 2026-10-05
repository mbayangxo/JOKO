import { useRef, useState, useCallback } from 'react';
import { Animated, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import StepTransition from '../components/StepTransition';
import ScreenHeader from '../components/ScreenHeader';
import AmountChips from '../components/AmountChips';
import { useAppState } from '../state/AppState';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import { useBlink, useEntrance, usePopIn, useSuccessHaptic } from '../hooks/animations';
import { useToast } from '../components/Toast';
import { transferRequest, getTransferRequests, acceptTransferRequest, denyTransferRequest, cancelTransferRequest } from '../lib/api-client';
import { requestCreateProblem, requestRow } from '../lib/money-ux';
import { useMoneySubmit } from '../hooks/useMoneySubmit';
import StepUpOverlay from '../components/StepUpOverlay';
import { useSecurity } from '../context/SecurityContext';
import { formatKori } from '../lib/kori.js';
import KoriAmount from '../components/KoriAmount';

const QUICK_AMOUNTS = [100, 200, 500, 1000];

function AmountCursor() {
  const blink = useBlink(1000, 0);
  return <Animated.View style={[styles.ahCursor, { opacity: blink }]} />;
}

function RequestStep({ amount, setAmount, reason, setReason, handle, setHandle, loading, onSend, onBack, problem }) {
  const inputRef = useRef(null);
  const [focused, setFocused] = useState(false);
  const popIn = usePopIn(0, 400, 0.8);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <ScreenHeader onBack={onBack} title="Demander" style={styles.topRow} />

          <View style={styles.amountHero}>
            <Text style={styles.ahLbl}>Combien demander ?</Text>
            <PressScale scaleTo={0.98} onPress={() => inputRef.current?.focus()}>
              <Animated.View style={[popIn, styles.ahRow]}>
                <KoriAmount value={amount} textStyle={styles.ahNum} />
                {!focused && <AmountCursor />}
              </Animated.View>
            </PressScale>
            <TextInput
              ref={inputRef}
              value={String(amount)}
              onChangeText={(t) => setAmount(Math.min(999999, Number(t.replace(/[^0-9]/g, '')) || 0))}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              keyboardType="number-pad"
              style={styles.hiddenInput}
            />
          </View>

          <AmountChips
            options={QUICK_AMOUNTS}
            value={amount}
            onChange={setAmount}
            accentBg={colors.goldA10}
            accentBorder="rgba(250,216,54,0.4)"
            accentText={colors.flagGold}
            style={styles.quickRow}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.lbl}>À qui demander ? (@handle K21)</Text>
          <TextInput
            style={styles.handleField}
            placeholder="@handle"
            placeholderTextColor={'rgba(5,8,5,0.45)'}
            autoCapitalize="none"
            value={handle}
            onChangeText={setHandle}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.lbl}>Pour quoi ? (optionnel)</Text>
          <TextInput
            style={styles.reasonField}
            placeholder="Pour le taxi, pour manger..."
            placeholderTextColor={'rgba(5,8,5,0.45)'}
            value={reason}
            onChangeText={setReason}
          />
          <Text style={styles.reasonHint}>Le contexte enlève la gêne de demander de l'argent.</Text>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {problem ? (
          <View style={styles.problemBox}>
            <Text style={styles.problemText}>{problem.message}</Text>
            {problem.nextStep ? <Text style={styles.problemText}>{problem.nextStep}</Text> : null}
          </View>
        ) : null}
        <GlowButton
          label={loading ? 'Envoi…' : `Demander ${formatKori(amount)} →`}
          onPress={onSend}
          disabled={!handle.trim() || amount <= 0 || loading}
        />
      </View>
    </View>
  );
}

function RequestCard({ req, row, onAccept, onDeny, onCancel, busy }) {
  const who = row.incoming ? req.requester?.name || req.requester?.handle : req.payer?.name || req.payer?.handle;
  return (
    <View style={[styles.inboxCard, !row.canPay && !row.canCancel && styles.inboxCardMuted]}>
      <Text style={styles.inboxTitle}>
        {row.incoming ? `${who} demande ${formatKori(req.amount)}` : `Tu as demandé ${formatKori(req.amount)} à ${who}`}
      </Text>
      {req.note ? <Text style={styles.inboxNote}>{req.note}</Text> : null}
      <Text style={styles.inboxStatus}>
        {row.statusLabel}
        {row.expiryLabel ? ` · ${row.expiryLabel}` : ''}
      </Text>
      {row.canPay ? (
        <View style={styles.inboxActions}>
          <PressScale scaleTo={0.95} onPress={() => !busy && onDeny(req.id)} style={styles.denyBtn}>
            <Text style={styles.denyText}>Refuser</Text>
          </PressScale>
          <PressScale scaleTo={0.95} onPress={() => !busy && onAccept(req.id)} style={styles.acceptBtn}>
            <Text style={styles.acceptText}>{busy ? 'Vérification…' : 'Payer'}</Text>
          </PressScale>
        </View>
      ) : null}
      {row.canCancel ? (
        <View style={styles.inboxActions}>
          <PressScale scaleTo={0.95} onPress={() => onCancel(req.id)} style={styles.denyBtn}>
            <Text style={styles.denyText}>Annuler la demande</Text>
          </PressScale>
        </View>
      ) : null}
    </View>
  );
}

function InboxStep({ requests, me, loading, busyId, onAccept, onDeny, onCancel, onBack }) {
  const rows = requests.map((req) => ({ req, row: requestRow(req, { me }) }));
  const toPay = rows.filter((r) => r.row.canPay);
  const mine = rows.filter((r) => !r.row.incoming).slice(0, 20);
  const pastIncoming = rows.filter((r) => r.row.incoming && !r.row.canPay).slice(0, 10);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.huge }}>
        <ScreenHeader onBack={onBack} title="Demandes" style={styles.topRow} />
        {loading ? <Text style={styles.reasonHint}>Chargement…</Text> : null}
        <Text style={styles.inboxSection}>À payer</Text>
        {!loading && toPay.length === 0 ? <Text style={styles.reasonHint}>Aucune demande en attente.</Text> : null}
        {toPay.map(({ req, row }) => (
          <RequestCard key={req.id} req={req} row={row} busy={busyId === req.id} onAccept={onAccept} onDeny={onDeny} onCancel={onCancel} />
        ))}
        {mine.length ? <Text style={styles.inboxSection}>Mes demandes</Text> : null}
        {mine.map(({ req, row }) => (
          <RequestCard key={req.id} req={req} row={row} onAccept={onAccept} onDeny={onDeny} onCancel={onCancel} />
        ))}
        {pastIncoming.length ? <Text style={styles.inboxSection}>Déjà traitées</Text> : null}
        {pastIncoming.map(({ req, row }) => (
          <RequestCard key={req.id} req={req} row={row} onAccept={onAccept} onDeny={onDeny} onCancel={onCancel} />
        ))}
      </ScrollView>
    </View>
  );
}

function SentStep({ amount, reason, handle, name, onDone }) {
  useSuccessHaptic();
  const ring = usePopIn(0, 500, 0.3);
  const title = useEntrance(200, 500, 10);
  const previewEntrance = useEntrance(400, 500, 10);
  const displayHandle = handle.startsWith('@') ? handle : `@${handle}`;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.sentRoot} showsVerticalScrollIndicator={false}>
      <Animated.View style={[styles.ssRing, ring]}>
        <Text style={{ fontSize: 32 }}>📥</Text>
      </Animated.View>
      <Animated.Text style={[styles.ssTitle, title]}>Demande envoyée !</Animated.Text>
      <Animated.Text style={[styles.ssSub, title]}>
        {displayHandle} peut payer en un tap.{'\n'}Tu seras notifié dès que c'est fait.
      </Animated.Text>

      <Animated.View style={[styles.previewCard, previewEntrance]}>
        <Text style={styles.previewLabel}>Aperçu — ce que la personne voit</Text>
        <View style={styles.previewNotif}>
          <View style={styles.previewAva}>
            <Text style={{ fontSize: 18 }}>🧑🏾</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.previewText}>
              <Text style={{ fontFamily: fontFamily.bodyBold }}>{name}</Text> te demande {formatKori(amount)}
            </Text>
            {reason ? <Text style={styles.previewReason}>{reason}</Text> : null}
          </View>
        </View>
        <View style={styles.previewPayBtn}>
          <Text style={styles.previewPayText}>Payer en un tap →</Text>
        </View>
      </Animated.View>

      <View style={{ width: '100%', marginTop: spacing.giant }}>
        <GlowButton label="Retour à l'accueil" onPress={onDone} />
      </View>
    </ScrollView>
  );
}

export default function ReceiveScreen({ navigation }) {
  const showToast = useToast();
  const [mode, setMode] = useState('request');
  const [step, setStep] = useState('request');
  const [amount, setAmount] = useState(2000);
  const [reason, setReason] = useState('');
  const [handle, setHandle] = useState('');
  const [loading, setLoading] = useState(false);
  const [inbox, setInbox] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [problem, setProblem] = useState(null);
  const [stepUpFor, setStepUpFor] = useState(null);
  const { profile, refreshWallet } = useAppState();
  const security = useSecurity();
  const moneySubmit = useMoneySubmit();

  const loadInbox = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getTransferRequests('all');
      setInbox(Array.isArray(list) ? list : []);
    } catch (err) {
      showToast(err.message ?? 'Impossible de charger');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useFocusEffect(
    useCallback(() => {
      if (mode === 'inbox') loadInbox();
    }, [mode, loadInbox]),
  );

  // A request is never debit authority: paying it is the payer's own money
  // action — one intent key per attempt, PIN when required, and a lost
  // response resolves through the intent instead of a second payment.
  const acceptRequest = async (id, stepUpToken) => {
    if (moneySubmit.busy) return;
    setBusyId(id);
    try {
      const out = await moneySubmit.submit((intentKey) =>
        acceptTransferRequest(id, { stepUpToken: stepUpToken ?? security.stepUpToken, intentKey }),
      );
      if (out.state === 'needs_pin') {
        setStepUpFor(id);
        return;
      }
      if (out.state === 'done' || out.state === 'accepted_pending') {
        await refreshWallet();
        showToast('Paiement envoyé ✓');
      } else {
        showToast(out.nextStep ? `${out.message} ${out.nextStep}` : out.message ?? 'Paiement impossible');
      }
      if (out.state !== 'checking') moneySubmit.reset();
      loadInbox();
    } finally {
      setBusyId(null);
    }
  };

  const cancelRequest = async (id) => {
    try {
      await cancelTransferRequest(id);
      showToast('Demande annulée');
      loadInbox();
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    }
  };

  const denyRequest = async (id) => {
    setLoading(true);
    try {
      await denyTransferRequest(id);
      showToast('Demande refusée');
      loadInbox();
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    } finally {
      setLoading(false);
    }
  };

  const finish = () => {
    setStep('request');
    setAmount(2000);
    setReason('');
    setHandle('');
    navigation.goBack();
  };

  const sendRequest = async () => {
    setLoading(true);
    try {
      await transferRequest({ recipientHandle: handle, amount, note: reason.trim() || undefined });
      setProblem(null);
      setStep('sent');
    } catch (err) {
      // Limit / unavailable are shown as a notice on the form, not a passing toast.
      setProblem(requestCreateProblem(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.modeRow}>
          <PressScale scaleTo={0.96} onPress={() => { setMode('request'); setStep('request'); }} style={[styles.modePill, mode === 'request' && styles.modePillOn]}>
            <Text style={[styles.modeText, mode === 'request' && styles.modeTextOn]}>Demander</Text>
          </PressScale>
          <PressScale scaleTo={0.96} onPress={() => setMode('inbox')} style={[styles.modePill, mode === 'inbox' && styles.modePillOn]}>
            <Text style={[styles.modeText, mode === 'inbox' && styles.modeTextOn]}>Reçues</Text>
          </PressScale>
        </View>
        {mode === 'inbox' ? (
          <InboxStep requests={inbox} me={profile.handle} loading={loading} busyId={busyId} onAccept={acceptRequest} onDeny={denyRequest} onCancel={cancelRequest} onBack={() => navigation.goBack()} />
        ) : null}
        {mode === 'request' && step === 'request' && (
          <StepTransition>
            <RequestStep
              amount={amount}
              setAmount={setAmount}
              reason={reason}
              setReason={setReason}
              handle={handle}
              setHandle={setHandle}
              loading={loading}
              onSend={sendRequest}
              onBack={() => navigation.goBack()}
              problem={problem}
            />
          </StepTransition>
        )}
        {mode === 'request' && step === 'sent' && (
          <StepTransition>
            <SentStep amount={amount} reason={reason} handle={handle} name={profile.name.split(' ')[0]} onDone={finish} />
          </StepTransition>
        )}
      </SafeAreaView>
      <StepUpOverlay
        visible={Boolean(stepUpFor)}
        onCancel={() => setStepUpFor(null)}
        onVerified={(token) => {
          const id = stepUpFor;
          setStepUpFor(null);
          acceptRequest(id, token);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  hero: { paddingHorizontal: spacing.huge },
  topRow: { paddingTop: spacing.md },
  amountHero: { alignItems: 'center', paddingVertical: spacing.giant },
  ahLbl: { fontSize: 11, fontWeight: '700', letterSpacing: 1.5, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', marginBottom: spacing.md },
  ahRow: { flexDirection: 'row', alignItems: 'center' },
  ahNum: { fontFamily: fontFamily.displayBlack, fontSize: 44, letterSpacing: -2, color: colors.goldDark },
  ahCurr: { fontSize: 18, color: 'rgba(5,8,5,0.5)' },
  ahCursor: { width: 2, height: 36, backgroundColor: colors.flagGold, marginLeft: 4 },
  hiddenInput: { position: 'absolute', opacity: 0, height: 0, width: 0 },
  quickRow: { marginTop: spacing.xxl },
  section: { paddingHorizontal: spacing.huge, marginBottom: spacing.xxl },
  lbl: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', marginBottom: spacing.md },
  handleField: { height: 48, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', paddingHorizontal: spacing.xl, fontSize: 14, color: colors.ink },
  reasonField: { height: 48, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', paddingHorizontal: spacing.xl, fontSize: 13, color: colors.ink },
  reasonHint: { ...type.bodySmall, color: 'rgba(5,8,5,0.45)', marginTop: spacing.sm },
  footer: { padding: spacing.huge, paddingBottom: spacing.xxl },
  sentRoot: { padding: spacing.huge, alignItems: 'center', flexGrow: 1 },
  ssRing: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.goldA10, borderWidth: 2, borderColor: 'rgba(250,216,54,0.3)', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xl },
  ssTitle: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink, marginBottom: spacing.sm, textAlign: 'center' },
  ssSub: { fontSize: 12, color: 'rgba(5,8,5,0.5)', textAlign: 'center', lineHeight: 18, marginBottom: spacing.giant },
  previewCard: { width: '100%', backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.09)', borderRadius: radius.xxl, padding: spacing.xxl },
  previewLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', marginBottom: spacing.lg },
  previewNotif: { flexDirection: 'row', gap: spacing.lg, marginBottom: spacing.lg },
  previewAva: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center' },
  previewText: { fontSize: 12, color: 'rgba(5,8,5,0.7)', lineHeight: 18 },
  previewReason: { fontSize: 11, color: 'rgba(5,8,5,0.5)', marginTop: 4 },
  previewPayBtn: { backgroundColor: colors.green, borderRadius: radius.lg, paddingVertical: spacing.lg, alignItems: 'center' },
  previewPayText: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  modeRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.huge, paddingTop: spacing.md },
  modePill: { flex: 1, height: 36, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.7)', alignItems: 'center', justifyContent: 'center' },
  modePillOn: { backgroundColor: colors.goldA20 },
  modeText: { fontSize: 11, fontWeight: '700', color: 'rgba(5,8,5,0.5)' },
  modeTextOn: { color: colors.goldDark },
  inboxCardMuted: { opacity: 0.6 },
  inboxStatus: { fontSize: 11, color: 'rgba(5,8,5,0.55)', marginTop: 4 },
  inboxSection: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: 'rgba(5,8,5,0.45)', marginTop: spacing.lg, marginBottom: spacing.sm, textTransform: 'uppercase' },
  problemBox: { backgroundColor: 'rgba(200,80,40,0.08)', borderRadius: radius.lg, padding: spacing.lg, marginTop: spacing.md },
  problemText: { fontSize: 12, color: colors.terracottaDark },
  inboxCard: { backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', padding: spacing.lg, marginBottom: spacing.md },
  inboxTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  inboxNote: { fontSize: 11, color: 'rgba(5,8,5,0.5)', marginTop: spacing.xs },
  inboxActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  denyBtn: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.7)', alignItems: 'center' },
  denyText: { fontSize: 12, fontWeight: '700', color: 'rgba(5,8,5,0.55)' },
  acceptBtn: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.lg, backgroundColor: colors.greenA12, alignItems: 'center' },
  acceptText: { fontSize: 12, fontWeight: '700', color: colors.greenDark },
});
