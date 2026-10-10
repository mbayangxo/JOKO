import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import StepTransition from '../components/StepTransition';
import Keypad from '../components/Keypad';
import ScreenHeader from '../components/ScreenHeader';
import AmountChips from '../components/AmountChips';
import ReceiptCard from '../components/ReceiptCard';
import StepUpOverlay from '../components/StepUpOverlay';
import MoneyPhaseBanner from '../components/MoneyPhaseBanner';
import { useAppState } from '../state/AppState';
import { useSecurity } from '../context/SecurityContext';
import { usePlatformFeatures } from '../lib/platform-features';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import { useCountUp, useEntrance, usePopIn, useSuccessHaptic } from '../hooks/animations';
import { useScreenshotBlock } from '../hooks/useScreenshotBlock';
import { useToast } from '../components/Toast';
import { cashIn, cashOut, depositNational, createStripeDepositSession, getMe } from '../lib/api-client';
import { useMoneySubmit } from '../hooks/useMoneySubmit';
import KoriAmount from '../components/KoriAmount';

const QUICK_AMOUNTS = [2000, 5000, 10000, 25000];

const OPERATORS = [
  { key: 'orange_money', name: 'Orange Money', icon: '🟠' },
  { key: 'wave', name: 'Wave', icon: '💙' },
  { key: 'free_money', name: 'Free Money', icon: '🟣' },
];

function formatAmount(n) {
  return Math.round(n).toLocaleString('fr-FR').replace(/ /g, ' ');
}

function formatPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('221')) {
    return `+221 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`.trim();
  }
  return phone ?? '';
}

function ModeToggle({ mode, setMode }) {
  return (
    <View style={styles.modeToggle}>
      {[
        { key: 'in', label: 'Dépôt' },
        { key: 'out', label: 'Retrait' },
      ].map((m) => (
        <PressScale key={m.key} scaleTo={0.95} onPress={() => setMode(m.key)} style={[styles.modeBtn, mode === m.key && styles.modeBtnOn]}>
          <Text style={[styles.modeBtnText, mode === m.key && styles.modeBtnTextOn]}>{m.label}</Text>
        </PressScale>
      ))}
    </View>
  );
}

function AmountStep({
  mode,
  setMode,
  amount,
  setAmount,
  balance,
  onContinue,
  onBetaDeposit,
  onAgentDeposit,
  onAgentWithdraw,
  onCardDeposit,
  onBack,
  betaLoading,
  betaEnabled,
  agentEnabled,
  agentWithdrawEnabled,
  stripeEnabled,
  cardLoading,
}) {
  const pressDigit = (d) => setAmount((prev) => Math.min(999999, Number(`${prev === 0 ? '' : prev}${d}`)));
  const pressBackspace = () => setAmount((prev) => Math.floor(prev / 10));

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <ScreenHeader
          onBack={onBack}
          eyebrow="JULAYA · CASH"
          title={mode === 'in' ? 'Déposer de l’argent' : 'Retirer de l’argent'}
          titleStyle={styles.title}
          style={styles.headerRow}
        />
      </View>

      <View style={{ paddingHorizontal: spacing.huge, marginBottom: spacing.xxl }}>
        <ModeToggle mode={mode} setMode={setMode} />
      </View>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View style={styles.amountHero}>
          <Text style={styles.amountLbl}>{mode === 'in' ? 'Combien déposer ?' : 'Combien retirer ?'}</Text>
          <Text style={styles.amountNum}>
            {formatAmount(amount)} <Text style={styles.amountCurr}>F</Text>
          </Text>
          <AmountChips options={QUICK_AMOUNTS} value={amount} onChange={setAmount} style={styles.quickRow} />
          {mode === 'out' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, marginTop: spacing.xl }}>
              <Text style={[styles.balanceNote, { marginTop: 0 }]}>Solde disponible : </Text>
              <KoriAmount value={balance} textStyle={[styles.balanceNote, { marginTop: 0 }]} size={11} />
              <Text style={[styles.balanceNote, { marginTop: 0 }]}> · retrait en F CFA</Text>
            </View>
          ) : null}
          <View style={styles.keypadWrap}>
            <Keypad onDigit={pressDigit} onBackspace={pressBackspace} />
          </View>
        </View>

        <View style={styles.feeNote}>
          <Text style={styles.feeNoteText}>
            {mode === 'in'
              ? 'Mobile Money Sénégal — confirme sur ton téléphone si Julaya le demande.'
              : 'Retrait vers ton numéro Mobile Money · CNI vérifiée requise (Tier 2).'}
          </Text>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {mode === 'in' && betaEnabled ? (
          <GlowButton
            label={betaLoading ? 'Ajout en cours…' : `Crédit test +${formatAmount(amount)} F`}
            onPress={onBetaDeposit}
            disabled={betaLoading || amount <= 0}
            style={{ marginBottom: spacing.md }}
          />
        ) : null}
        {mode === 'in' && agentEnabled ? (
          <GlowButton
            label="Dépôt chez un agent K21 →"
            onPress={onAgentDeposit}
            disabled={amount <= 0}
            style={{ marginBottom: spacing.md }}
          />
        ) : null}
        {mode === 'in' && stripeEnabled ? (
          <GlowButton
            label={cardLoading ? 'Ouverture Stripe…' : 'Carte bancaire (diaspora) →'}
            onPress={onCardDeposit}
            disabled={amount <= 0 || cardLoading}
            style={{ marginBottom: spacing.md }}
          />
        ) : null}
        {mode === 'out' && agentWithdrawEnabled ? (
          <GlowButton
            label="Retrait chez un agent K21 →"
            onPress={onAgentWithdraw}
            disabled={amount <= 0 || Math.floor(amount / 10) > balance}
            style={{ marginBottom: spacing.md }}
          />
        ) : null}
        <GlowButton
          label={mode === 'in' ? 'Mobile Money →' : 'Choisir Mobile Money →'}
          onPress={onContinue}
          disabled={amount <= 0 || (mode === 'out' && Math.floor(amount / 10) > balance)}
        />
      </View>
    </View>
  );
}

function OperatorStep({ mode, amount, operator, setOperator, onBack, onContinue }) {
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <ScreenHeader
          onBack={onBack}
          eyebrow="MOBILE MONEY"
          title={mode === 'in' ? 'Dépôt via' : 'Retrait via'}
          titleStyle={styles.title}
          style={styles.headerRow}
        />
        <Text style={styles.subtitle}>
          {mode === 'in' ? 'Dépôt de' : 'Retrait de'} {formatAmount(amount)} F
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: spacing.giant }} showsVerticalScrollIndicator={false}>
        {OPERATORS.map((op, i) => (
          <PressScale key={op.key} scaleTo={0.98} onPress={() => setOperator(op.key)}>
            <View style={[styles.operatorRow, operator === op.key && styles.operatorRowOn]}>
              <Text style={{ fontSize: 24 }}>{op.icon}</Text>
              <Text style={styles.operatorName}>{op.name}</Text>
              {operator === op.key ? <Text style={styles.operatorCheck}>✓</Text> : null}
            </View>
          </PressScale>
        ))}
      </ScrollView>

      <View style={styles.footer}>
        <GlowButton label="Continuer →" onPress={onContinue} disabled={!operator} />
      </View>
    </View>
  );
}

function ConfirmStep({ mode, amount, operator, phone, onBack, onSubmit, loading }) {
  const op = OPERATORS.find((o) => o.key === operator);
  return (
    <View style={{ flex: 1, paddingHorizontal: spacing.huge }}>
      <ScreenHeader onBack={onBack} title="Confirmer" titleStyle={styles.title} style={{ marginTop: spacing.xxl, marginBottom: spacing.xl }} />
      <View style={styles.confirmCard}>
        <Text style={styles.confirmRow}><Text style={styles.confirmLabel}>Opération · </Text>{mode === 'in' ? 'Dépôt' : 'Retrait'}</Text>
        <Text style={styles.confirmRow}><Text style={styles.confirmLabel}>Montant · </Text>{formatAmount(amount)} F CFA</Text>
        <Text style={styles.confirmRow}><Text style={styles.confirmLabel}>Opérateur · </Text>{op?.name ?? operator}</Text>
        <Text style={styles.confirmRow}><Text style={styles.confirmLabel}>Numéro · </Text>{formatPhone(phone)}</Text>
        {mode === 'in' ? (
          <Text style={styles.confirmHint}>Tu recevras peut‑être une demande de confirmation sur ton téléphone.</Text>
        ) : null}
      </View>
      <View style={{ flex: 1 }} />
      <GlowButton label={loading ? 'Traitement…' : 'Confirmer →'} onPress={onSubmit} disabled={loading} style={{ marginBottom: spacing.xxl }} />
    </View>
  );
}

function PendingStep({ message, onDone }) {
  return (
    <View style={styles.pendingRoot}>
      <ActivityIndicator size="large" color={colors.greenDark} />
      <Text style={styles.pendingTitle}>En attente de confirmation</Text>
      <Text style={styles.pendingSub}>{message ?? 'Valide sur ton téléphone Mobile Money. Ton solde sera crédité dès confirmation.'}</Text>
      <GlowButton label="Retour à l'accueil" onPress={onDone} style={{ marginTop: spacing.xxl, width: '100%' }} />
    </View>
  );
}

function SuccessStep({ mode, amount, operator, oldBalance, newBalance, onDone, beta }) {
  useSuccessHaptic();
  const ring = usePopIn(0, 500, 0.3);
  const title = useEntrance(200, 500, 10);
  const sub = useEntrance(300, 500, 10);
  const receipt = useEntrance(400, 500, 10);
  const balanceCount = useCountUp(oldBalance, newBalance, 700);
  const op = OPERATORS.find((o) => o.key === operator);

  return (
    <View style={styles.successRoot}>
      <Animated.View style={[styles.ssRing, ring]}>
        <Text style={{ fontSize: 38, color: colors.greenDark }}>✓</Text>
      </Animated.View>
      <Animated.Text style={[styles.ssTitle, title]}>{mode === 'in' ? 'Dépôt reçu !' : 'Retrait lancé !'}</Animated.Text>
      <Animated.Text style={[styles.ssSub, sub]}>
        {beta
          ? 'Crédit test ajouté à ton wallet.'
          : mode === 'in'
            ? 'Ton solde K21 a été crédité.'
            : 'L’argent arrive sur ton Mobile Money.'}
      </Animated.Text>

      <Animated.View style={receipt}>
        <ReceiptCard
          style={{ marginBottom: spacing.giant }}
          rows={[
            { key: 'op', label: 'Opérateur', value: op?.name ?? (beta ? 'Crédit test' : '—') },
            { key: 'amount', label: 'Montant', value: `${formatAmount(amount)} F CFA`, color: colors.greenDark },
            { key: 'kori', label: mode === 'in' ? 'Crédité en Kori' : 'Débité en Kori', kori: Math.floor(amount / 10), color: colors.greenDark },
            { key: 'balance', label: 'Nouveau solde', kori: balanceCount },
          ]}
        />
      </Animated.View>

      <GlowButton label="Retour à l'accueil" onPress={onDone} />
    </View>
  );
}

export default function CashScreen({ navigation, route }) {
  useScreenshotBlock(true);
  const showToast = useToast();
  const security = useSecurity();
  const moneySubmit = useMoneySubmit('cash');
  const { feature } = usePlatformFeatures();
  const betaEnabled = feature('cash', 'betaDeposits') || process.env.EXPO_PUBLIC_ALLOW_BETA_DEPOSITS === 'true';
  const agentEnabled = feature('cash', 'agentDeposits');
  const agentWithdrawEnabled = feature('cash', 'agentWithdrawals');
  const stripeEnabled = feature('cash', 'stripeDeposits');

  const [step, setStep] = useState('amount');
  const [mode, setMode] = useState(route.params?.initialMode === 'out' ? 'out' : 'in');
  const [amount, setAmount] = useState(5000);
  const [operator, setOperator] = useState('orange_money');
  const [phone, setPhone] = useState('');
  const [pendingMessage, setPendingMessage] = useState('');
  const [oldBalance, setOldBalance] = useState(0);
  const [newBalance, setNewBalance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [cardLoading, setCardLoading] = useState(false);
  const [stepUpVisible, setStepUpVisible] = useState(false);
  const [isBetaSuccess, setIsBetaSuccess] = useState(false);
  const { balance, refreshWallet } = useAppState();

  useEffect(() => {
    getMe()
      .then((me) => setPhone(me?.phone ?? ''))
      .catch(() => {});
  }, []);

  const finish = () => {
    moneySubmit.reset();
    setStep('amount');
    setAmount(5000);
    setOperator('orange_money');
    setIsBetaSuccess(false);
    navigation.goBack();
  };

  const completeBetaDeposit = async () => {
    setLoading(true);
    setOldBalance(balance);
    try {
      await depositNational({ amount, source: 'cash_screen' });
      const wallet = await refreshWallet();
      setNewBalance(wallet.balance ?? wallet.koriBalance ?? balance);
      setIsBetaSuccess(true);
      setStep('success');
    } catch (err) {
      showToast(err.message ?? 'Crédit test indisponible');
    } finally {
      setLoading(false);
    }
  };

  const executeCash = async (stepUpToken) => {
    if (!phone?.trim()) {
      showToast('Ajoute ton numéro de téléphone dans ton profil');
      return;
    }
    // One intent key per attempt: a lost response is resolved by asking the
    // server (intent outcome), never by sending a second cash-in / cash-out.
    if (moneySubmit.busy) return;
    setLoading(true);
    setOldBalance(balance);
    try {
      const out = await moneySubmit.submit((intentKey) =>
        mode === 'in'
          ? cashIn({ amount, operator, phone, intentKey })
          : cashOut({ amount, operator, phone, stepUpToken: stepUpToken ?? security.stepUpToken, intentKey }),
        { instruction: { mode, amount, operator, phone } },
      );
      if (out.state === 'needs_pin') {
        setStepUpVisible(true);
        return;
      }
      if (out.state === 'accepted_pending') {
        setPendingMessage(out.response?.message ?? out.response?.rail?.message ?? out.message ?? null);
        setStep('pending');
        return;
      }
      if (out.state === 'done') {
        const wallet = await refreshWallet();
        setNewBalance(wallet.balance ?? wallet.koriBalance ?? balance);
        setIsBetaSuccess(false);
        setStep('success');
        return;
      }
      if (out.state === 'checking') {
        // Still unknown after polling: show pending, never invite a new attempt.
        setPendingMessage(out.message);
        setStep('pending');
        return;
      }
      showToast(out.nextStep ? `${out.message} ${out.nextStep}` : out.message ?? 'Opération impossible');
    } finally {
      setLoading(false);
    }
  };

  const handleStepUpVerified = (token) => {
    setStepUpVisible(false);
    executeCash(token);
  };

  const startCardDeposit = async () => {
    if (amount <= 0) return;
    setCardLoading(true);
    try {
      const session = await createStripeDepositSession({ amount });
      const url = session.checkoutUrl;
      if (!url) throw new Error('Lien Stripe indisponible');
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        await Linking.openURL(url);
      }
      showToast('Finalise le paiement sur Stripe — ton wallet sera crédité automatiquement.');
    } catch (err) {
      showToast(err.message ?? 'Stripe indisponible');
    } finally {
      setCardLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <MoneyPhaseBanner phase={moneySubmit.phase} />
        {step === 'amount' && (
          <StepTransition>
            <AmountStep
              mode={mode}
              setMode={setMode}
              amount={amount}
              setAmount={setAmount}
              balance={balance}
              betaLoading={loading}
              betaEnabled={betaEnabled}
              agentEnabled={agentEnabled}
              agentWithdrawEnabled={agentWithdrawEnabled}
              stripeEnabled={stripeEnabled}
              cardLoading={cardLoading}
              onBetaDeposit={completeBetaDeposit}
              onAgentDeposit={() => navigation.navigate('AgentDiscovery', { amount, mode: 'deposit' })}
              onAgentWithdraw={() => navigation.navigate('AgentDiscovery', { amount, mode: 'withdraw' })}
              onCardDeposit={startCardDeposit}
              onContinue={() => setStep('operator')}
              onBack={() => navigation.goBack()}
            />
          </StepTransition>
        )}
        {step === 'operator' && (
          <StepTransition>
            <OperatorStep
              mode={mode}
              amount={amount}
              operator={operator}
              setOperator={setOperator}
              onBack={() => setStep('amount')}
              onContinue={() => setStep('confirm')}
            />
          </StepTransition>
        )}
        {step === 'confirm' && (
          <StepTransition>
            <ConfirmStep
              mode={mode}
              amount={amount}
              operator={operator}
              phone={phone}
              loading={loading}
              onBack={() => setStep('operator')}
              onSubmit={() => executeCash()}
            />
          </StepTransition>
        )}
        {step === 'pending' && (
          <StepTransition>
            <PendingStep message={pendingMessage} onDone={finish} />
          </StepTransition>
        )}
        {step === 'success' && (
          <StepTransition>
            <SuccessStep
              mode={mode}
              amount={amount}
              operator={operator}
              oldBalance={oldBalance}
              newBalance={newBalance}
              onDone={finish}
              beta={isBetaSuccess}
            />
          </StepTransition>
        )}
      </SafeAreaView>
      <StepUpOverlay visible={stepUpVisible} onCancel={() => setStepUpVisible(false)} onVerified={handleStepUpVerified} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { paddingHorizontal: spacing.huge, paddingTop: spacing.xxl, paddingBottom: spacing.xl },
  headerRow: { marginBottom: spacing.sm },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink, letterSpacing: -0.5 },
  subtitle: { fontSize: 12, color: 'rgba(5,8,5,0.5)', marginTop: spacing.xs },
  modeToggle: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', borderRadius: radius.lg, padding: 3, gap: 3 },
  modeBtn: { flex: 1, height: 38, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  modeBtnOn: { backgroundColor: colors.green },
  modeBtnText: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: 'rgba(5,8,5,0.6)' },
  modeBtnTextOn: { color: colors.ink },
  amountHero: { alignItems: 'center', paddingHorizontal: spacing.giant, paddingTop: spacing.xl, paddingBottom: spacing.xl },
  amountLbl: { fontFamily: fontFamily.bodyBold, fontSize: 9, letterSpacing: 1.5, color: 'rgba(26,240,96,0.6)', textTransform: 'uppercase', marginBottom: spacing.lg },
  amountNum: { fontFamily: fontFamily.displayBlack, fontSize: 48, letterSpacing: -3, lineHeight: 48, color: colors.greenDark },
  amountCurr: { fontFamily: fontFamily.bodyRegular, fontSize: 16, fontWeight: '400', color: 'rgba(26,240,96,0.4)' },
  quickRow: { justifyContent: 'center', marginTop: spacing.xl },
  balanceNote: { marginTop: spacing.xl, fontSize: 11, color: 'rgba(5,8,5,0.45)', textAlign: 'center' },
  keypadWrap: { width: '100%', marginTop: spacing.xxl },
  feeNote: { marginHorizontal: spacing.huge, backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.07)', borderRadius: radius.lg, paddingHorizontal: spacing.xl, paddingVertical: spacing.lg },
  feeNoteText: { fontSize: 11, color: 'rgba(5,8,5,0.5)', lineHeight: 16 },
  footer: { paddingHorizontal: spacing.huge, paddingVertical: spacing.xxl },
  operatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginHorizontal: spacing.huge,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.07)',
  },
  operatorRowOn: { borderColor: colors.greenA30, backgroundColor: colors.greenA08 },
  operatorName: { flex: 1, fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  operatorCheck: { fontSize: 16, color: colors.greenDark, fontFamily: fontFamily.bodyBold },
  confirmCard: {
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    padding: spacing.xl,
    gap: spacing.md,
  },
  confirmRow: { fontSize: 13, color: colors.ink, lineHeight: 20 },
  confirmLabel: { color: 'rgba(5,8,5,0.45)' },
  confirmHint: { fontSize: 11, color: 'rgba(5,8,5,0.5)', marginTop: spacing.sm, lineHeight: 16 },
  pendingRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.giant, gap: spacing.lg },
  pendingTitle: { fontFamily: fontFamily.displayBold, fontSize: 18, color: colors.ink, textAlign: 'center' },
  pendingSub: { fontSize: 12, color: 'rgba(5,8,5,0.55)', textAlign: 'center', lineHeight: 18 },
  successRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl + 14 },
  ssRing: { width: 90, height: 90, borderRadius: 45, backgroundColor: colors.greenA08, borderWidth: 3, borderColor: colors.green, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xxxl },
  ssTitle: { fontFamily: fontFamily.displayBlack, fontSize: 24, letterSpacing: -0.8, color: colors.ink, marginBottom: spacing.md, textAlign: 'center' },
  ssSub: { fontSize: 12, color: 'rgba(5,8,5,0.5)', marginBottom: spacing.giant + 2, lineHeight: 20.4, textAlign: 'center' },
});
