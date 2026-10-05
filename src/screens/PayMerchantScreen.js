import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import StepTransition from '../components/StepTransition';
import Keypad from '../components/Keypad';
import ScreenHeader from '../components/ScreenHeader';
import AmountChips from '../components/AmountChips';
import ReceiptCard from '../components/ReceiptCard';
import ReceiptShareButtons from '../components/ReceiptShareButtons';
import UndoTransferBar from '../components/UndoTransferBar';
import { useAppState } from '../state/AppState';
import { colors, fontFamily, radius, spacing } from '../theme';
import { useCountUp, useEntrance, usePopIn, useSuccessHaptic } from '../hooks/animations';
import { useScreenshotBlock } from '../hooks/useScreenshotBlock';
import { useToast } from '../components/Toast';
import StepUpOverlay from '../components/StepUpOverlay';
import { useSecurity } from '../context/SecurityContext';
import { merchantPay, getBusinesses, getMerchantPublic, viewMerchantCharge, payMerchantCharge } from '../lib/api-client';
import { useMoneySubmit } from '../hooks/useMoneySubmit';
import { formatKori, KORI_SYMBOL } from '../lib/kori.js';
import KoriAmount from '../components/KoriAmount';

// design/k21-four-flows.html, FLOW 4 — MERCHANT QR PAYMENT (Screens M1-M3):
// Scan QR (merchant card + scanner + amount) -> Confirm payment -> Payment done.

const QUICK_AMOUNTS = [
  { key: '50', value: 50, label: `${KORI_SYMBOL} 50` },
  { key: '100', value: 100, label: `${KORI_SYMBOL} 100` },
  { key: '250', value: 250, label: `${KORI_SYMBOL} 250` },
  { key: '500', value: 500, label: `${KORI_SYMBOL} 500` },
];

const DEFAULT_MERCHANT = {
  name: 'Scanne un QR marchand',
  arr: 'Ou choisis ci-dessous',
  emoji: '🏪',
  businessId: null,
};

function formatAmount(n) {
  return n.toLocaleString('fr-FR').replace(/ /g, ' ');
}

function useScanLine(frameSize, periodMs = 2000) {
  const val = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(val, { toValue: 1, duration: periodMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(val, { toValue: 0, duration: periodMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [val, periodMs]);
  return val.interpolate({ inputRange: [0, 1], outputRange: [frameSize * 0.25, frameSize * 0.7] });
}

const FRAME_SIZE = 200;

function ScanStep({ merchant, merchants, onSelectMerchant, amount, setAmount, onBack, onContinue, onScan }) {
  const scanY = useScanLine(FRAME_SIZE);
  const entrance = useEntrance(0, 350, 10);
  const historyEntrance = useEntrance(150, 350, 10);
  const { transactions } = useAppState();
  const history = transactions.filter((tx) => tx.type === 'pay_merchant' || tx.title?.includes(merchant.name)).slice(0, 3);
  const pressDigit = (d) => setAmount((prev) => Math.min(999999, Number(`${prev === 0 ? '' : prev}${d}`)));
  const pressBackspace = () => setAmount((prev) => Math.floor(prev / 10));

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <LinearGradient
          colors={['rgba(26,240,96,0.18)', 'rgba(250,216,54,0.12)', 'rgba(232,92,26,0.1)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.payHero}
        >
          <ScreenHeader onBack={onBack} title="Payer un marchand" titleStyle={styles.payHeroTitle} style={styles.payHeroTop} />

          <Animated.View style={[styles.merchantCard, entrance]}>
            <View style={styles.merchantIcon}>
              <Text style={{ fontSize: 22 }}>{merchant.emoji}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.merchantName}>{merchant.name}</Text>
              <Text style={styles.merchantArr}>📍 {merchant.arr}</Text>
            </View>
            {merchant.verified ? (
              <View style={styles.verifiedPill}>
                <Text style={styles.verifiedPillText}>✓ K21</Text>
              </View>
            ) : null}
          </Animated.View>
          {merchants.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: spacing.md, maxHeight: 44 }}>
              {merchants.map((m) => (
                <PressScale
                  key={m.id}
                  scaleTo={0.96}
                  onPress={() => onSelectMerchant(m)}
                  style={[styles.merchantChip, merchant.businessId === m.id && styles.merchantChipOn]}
                >
                  <Text style={[styles.merchantChipText, merchant.businessId === m.id && styles.merchantChipTextOn]}>{m.name}</Text>
                </PressScale>
              ))}
            </ScrollView>
          ) : null}
        </LinearGradient>

        <PressScale scaleTo={0.98} onPress={onScan} style={styles.scannerArea}>
          <Text style={styles.scannerBackdrop}>🏪</Text>
          <View style={styles.viewfinder}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerBR]} />
            <Animated.View style={[styles.scanLine, { top: scanY }]} />
          </View>
          <Text style={styles.scannerLabel}>Appuie pour scanner le QR du marchand</Text>
        </PressScale>

        <View style={styles.amountSection}>
          <Text style={styles.amountSectionLabel}>Montant à payer</Text>
          <View style={styles.amountDisplay}>
            <KoriAmount value={amount} textStyle={styles.amountNum} style={{ flex: 1 }} />
          </View>
          <AmountChips options={QUICK_AMOUNTS} value={amount} onChange={setAmount} style={styles.quickRow} />

          <View style={styles.keypadWrap}>
            <Keypad onDigit={pressDigit} onBackspace={pressBackspace} />
          </View>
        </View>

        <Animated.View style={[styles.historySection, historyEntrance]}>
          <Text style={styles.historyLabel}>Historique avec ce marchand</Text>
          {history.length === 0 ? (
            <View style={styles.historyEmpty}>
              <Text style={{ fontSize: 16 }}>🆕</Text>
              <Text style={styles.historyEmptyText}>Ton premier paiement chez {merchant.name}</Text>
            </View>
          ) : (
            <View style={{ gap: spacing.sm }}>
              {history.map((tx) => (
                <View key={tx.key} style={styles.historyRow}>
                  <View style={styles.historyIcon}>
                    <Text style={{ fontSize: 14 }}>{tx.icon}</Text>
                  </View>
                  <Text style={styles.historySub}>{tx.subtitle}</Text>
                  <KoriAmount value={Math.abs(tx.amount)} textStyle={styles.historyAmount} />
                </View>
              ))}
            </View>
          )}
        </Animated.View>
      </ScrollView>

      <View style={styles.footer}>
        <GlowButton label="Continuer →" onPress={onContinue} disabled={amount <= 0} />
      </View>
    </View>
  );
}

function ConfirmStep({ merchant, amount, balance, onPay, onCancel, submitting }) {
  const entrance = useEntrance(0, 350, 10);
  const verifyLabel = merchant.verified ? 'Marchand vérifié K21' : 'Marchand K21';

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View style={styles.confirmHero}>
          <Animated.View style={[{ alignItems: 'center' }, entrance]}>
            <View style={styles.confirmAva}>
              <Text style={{ fontSize: 28 }}>{merchant.emoji}</Text>
            </View>
            <Text style={styles.confirmMerchantName}>{merchant.name}</Text>
            <Text style={styles.confirmMerchantArr}>📍 {merchant.arr} · {verifyLabel}</Text>
            <KoriAmount value={amount} textStyle={styles.confirmAmount} style={{ justifyContent: 'center' }} />
            <View style={styles.freePill}>
              <Text style={styles.freePillText}>✦ Zéro frais sur ce paiement</Text>
            </View>
          </Animated.View>
        </View>

        <View style={styles.confirmBody}>
          <View style={styles.confirmRow}>
            <Text style={styles.confirmRowLabel}>Marchand</Text>
            <Text style={styles.confirmRowVal}>{merchant.name}</Text>
          </View>
          <View style={styles.confirmRow}>
            <Text style={styles.confirmRowLabel}>Montant</Text>
            <KoriAmount value={amount} textStyle={[styles.confirmRowVal, { color: colors.greenDark }]} />
          </View>
          <View style={styles.confirmRow}>
            <Text style={styles.confirmRowLabel}>Frais</Text>
            <Text style={[styles.confirmRowVal, { color: colors.greenDark }]}>0 F ✦</Text>
          </View>
          <View style={[styles.confirmRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.confirmRowLabel}>Ton solde après</Text>
            <KoriAmount value={balance - amount} textStyle={styles.confirmRowBal} />
          </View>
        </View>
      </ScrollView>

      <View style={styles.confirmActions}>
        <View style={styles.warnBox}>
          <Text style={{ fontSize: 13 }}>🔒</Text>
          <Text style={styles.warnText}>Paiement sécurisé K21. Marchand vérifié. Transaction irréversible une fois confirmée.</Text>
        </View>
        <GlowButton label={submitting ? 'Paiement…' : `Confirmer · Payer ${formatKori(amount)} →`} onPress={onPay} disabled={submitting} />
        <PressScale scaleTo={0.96} onPress={onCancel} disabled={submitting} style={styles.cancelBtn}>
          <Text style={styles.cancelBtnText}>Annuler</Text>
        </PressScale>
      </View>
    </View>
  );
}

function SuccessStep({ merchant, amount, oldBalance, newBalance, reference, onDone, onMarkedUndone, onShareMbolo, undone }) {
  useSuccessHaptic();
  const ring = usePopIn(0, 500, 0.4);
  const title = useEntrance(200, 500, 10);
  const sub = useEntrance(300, 500, 10);
  const receipt = useEntrance(400, 500, 10);
  const bonus = useEntrance(500, 500, 10);
  const balanceCount = useCountUp(oldBalance, newBalance, 700);

  return (
    <View style={styles.successRoot}>
      <Animated.View style={[styles.ssRing, ring]}>
        <Text style={{ fontSize: 38, color: colors.greenDark }}>{undone ? '↩' : '✓'}</Text>
      </Animated.View>
      <Animated.Text style={[styles.ssTitle, title]}>{undone ? 'Annulé' : 'Payé !'}</Animated.Text>
      <Animated.Text style={[styles.ssSub, sub]}>
        {undone ? 'Paiement annulé — argent récupéré.' : `${merchant.name} a reçu\nton paiement instantanément.`}
      </Animated.Text>

      {!undone && <UndoTransferBar reference={reference} amount={amount} onUndone={onMarkedUndone} />}

      <Animated.View style={receipt}>
        <ReceiptCard
          style={{ marginBottom: spacing.lg }}
          rows={[
            { key: 'merchant', label: 'Marchand', value: merchant.name },
            { key: 'amount', label: 'Montant', kori: amount, color: colors.greenDark },
            { key: 'fee', label: 'Frais', value: '₭0 ✦', color: colors.greenDark },
            { key: 'balance', label: 'Nouveau solde', kori: balanceCount },
            { key: 'ref', label: 'Référence', value: reference, small: true },
          ]}
        />
        {!undone && (
          <ReceiptShareButtons
            type="merchant"
            amount={amount}
            counterparty={merchant.name}
            reference={reference}
            onShareMbolo={onShareMbolo}
          />
        )}
      </Animated.View>

      {!undone && (
        <Animated.View style={[styles.wakhnaBonus, bonus]}>
          <Text style={{ fontSize: 16 }}>✦</Text>
          <Text style={styles.wakhnaBonusText}>
            <Text style={{ fontFamily: fontFamily.bodyBold, color: colors.greenDark }}>+5 Ngor</Text> pour ce paiement marchand
          </Text>
        </Animated.View>
      )}

      <GlowButton label="Retour à l'accueil" onPress={onDone} />
    </View>
  );
}

export default function PayMerchantScreen({ navigation, route }) {
  useScreenshotBlock(true);
  const showToast = useToast();
  const security = useSecurity();
  const [step, setStep] = useState('scan');
  const [amount, setAmount] = useState(2500);
  const [oldBalance, setOldBalance] = useState(0);
  const [newBalance, setNewBalance] = useState(0);
  const [reference, setReference] = useState('');
  const [undone, setUndone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stepUpVisible, setStepUpVisible] = useState(false);
  const [merchants, setMerchants] = useState([]);
  const [merchant, setMerchant] = useState(DEFAULT_MERCHANT);
  // J4: an amount-bearing QR is an opaque charge code; amount comes from the server.
  const [charge, setCharge] = useState(null);
  const moneySubmit = useMoneySubmit();
  const { balance, refreshWallet, setPendingMboloShare } = useAppState();

  const applyMerchant = (m, params = route.params) => {
    setMerchant({
      name: params?.merchantName ?? m.name,
      arr: params?.merchantArr ?? m.arrondissement ?? m.category ?? 'K21',
      emoji: m.type === 'cooperative' ? '🌾' : '🏪',
      businessId: m.id,
      verified: params?.merchantVerified ?? m.verified ?? false,
    });
  };

  useEffect(() => {
    const code = route.params?.chargeCode;
    if (!code) return;
    viewMerchantCharge(code)
      .then((c) => {
        if (c.status !== 'open') {
          showToast(c.status === 'paid' ? 'Cette demande de paiement est déjà réglée' : 'Cette demande de paiement n’est plus valable');
          return;
        }
        setCharge(c);
        setAmount(c.amountKori);
        // The charge pays by code; businessId only marks the merchant as chosen.
        setMerchant({ name: c.merchant?.name ?? 'Marchand', arr: c.label ?? 'K21', emoji: '🏪', businessId: `charge:${c.code}`, verified: false });
      })
      .catch((err) => showToast(err.message ?? 'Demande de paiement introuvable'));
  }, [route.params?.chargeCode]);

  useEffect(() => {
    const presetId = route.params?.merchantId;
    if (presetId) {
      getMerchantPublic(presetId)
        .then((m) => applyMerchant(m))
        .catch(() => {
          showToast('Marchand introuvable');
        });
    }
    getBusinesses()
      .then((list) => {
        const items = Array.isArray(list) ? list : [];
        setMerchants(items);
      })
      .catch(() => {});
  }, [route.params?.merchantId, route.params?.merchantName, route.params?.merchantVerified, route.params?.merchantArr]);

  const selectMerchant = (m) => {
    setCharge(null);
    setMerchant({
      name: m.name,
      arr: m.arrondissement ?? m.category ?? 'K21',
      emoji: m.type === 'cooperative' ? '🌾' : '🏪',
      businessId: m.id,
      verified: Boolean(m.verified),
    });
  };

  const executePay = async (stepUpToken) => {
    if (!merchant.businessId) {
      showToast('Aucun marchand K21 — scanne un QR ou choisis dans la liste');
      return;
    }
    if (moneySubmit.busy) return;
    setSubmitting(true);
    setOldBalance(balance);
    try {
      const token = stepUpToken ?? security.stepUpToken;
      const out = await moneySubmit.submit((intentKey) =>
        charge
          ? payMerchantCharge(charge.code, { expectedAmountKori: charge.amountKori, stepUpToken: token, intentKey })
          : merchantPay(merchant.businessId, { amount, stepUpToken: token, intentKey }),
      );
      if (out.state === 'needs_pin') {
        setStepUpVisible(true);
        return;
      }
      if (out.state === 'done' || out.state === 'accepted_pending') {
        setReference(out.response?.reference ?? out.response?.receiptReference ?? out.references?.[0] ?? '');
        setUndone(false);
        const wallet = await refreshWallet();
        setNewBalance(wallet.balance ?? wallet.koriBalance ?? balance - amount);
        setStep('success');
        if (out.state === 'accepted_pending') showToast(out.message);
        return;
      }
      showToast(out.nextStep ? `${out.message} ${out.nextStep}` : out.message ?? 'Paiement impossible');
    } finally {
      setSubmitting(false);
    }
  };

  const pay = () => executePay();

  const handleStepUpVerified = (token) => {
    setStepUpVisible(false);
    executePay(token);
  };

  const handleUndone = async () => {
    setUndone(true);
    const wallet = await refreshWallet();
    setNewBalance(wallet.balance ?? wallet.koriBalance ?? oldBalance);
  };

  const shareMbolo = (text) => {
    setPendingMboloShare(text);
    navigation.navigate('Main', { screen: 'MbooloTab' });
  };

  const finish = () => {
    moneySubmit.reset();
    setCharge(null);
    setStep('scan');
    setAmount(2500);
    navigation.goBack();
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {step === 'scan' && (
          <StepTransition>
            <ScanStep
              merchant={merchant}
              merchants={merchants}
              onSelectMerchant={selectMerchant}
              amount={amount}
              // A charge's amount is fixed by the server: the keypad cannot change it.
              setAmount={charge ? () => {} : setAmount}
              onBack={() => navigation.goBack()}
              onContinue={() => {
                if (!merchant.businessId) {
                  showToast('Scanne un QR marchand ou choisis-en un dans la liste');
                  return;
                }
                setStep('confirm');
              }}
              onScan={() => navigation.navigate('QrScan', { mode: 'merchant' })}
            />
          </StepTransition>
        )}
        {step === 'confirm' && (
          <StepTransition>
            <ConfirmStep merchant={merchant} amount={amount} balance={balance} onPay={pay} onCancel={() => setStep('scan')} submitting={submitting} />
          </StepTransition>
        )}
        {step === 'success' && (
          <StepTransition>
            <SuccessStep
              merchant={merchant}
              amount={amount}
              oldBalance={oldBalance}
              newBalance={newBalance}
              reference={reference}
              onDone={finish}
              onMarkedUndone={handleUndone}
              onShareMbolo={shareMbolo}
              undone={undone}
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

  // Scan step
  payHero: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.xl, position: 'relative', overflow: 'hidden' },
  payHeroTop: { gap: spacing.md, marginBottom: spacing.lg },
  payHeroTitle: { fontFamily: fontFamily.displayBold, fontSize: 13, color: colors.ink },
  merchantCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', borderRadius: radius.xl, padding: spacing.lg },
  merchantIcon: { width: 48, height: 48, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center' },
  merchantName: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink, marginBottom: 2 },
  merchantArr: { fontSize: 10, color: 'rgba(5,8,5,0.5)' },
  verifiedPill: { backgroundColor: colors.greenA15, borderWidth: 1, borderColor: colors.greenA30, borderRadius: 6, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  verifiedPillText: { fontSize: 8, fontWeight: '700', color: colors.greenDark },
  merchantChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.round, backgroundColor: 'rgba(255,255,255,0.75)', marginRight: spacing.sm },
  merchantChipOn: { backgroundColor: colors.greenA15, borderColor: colors.greenA30 },
  merchantChipText: { fontSize: 10, color: 'rgba(5,8,5,0.55)' },
  merchantChipTextOn: { color: colors.greenDark, fontWeight: '700' },

  scannerArea: { marginHorizontal: spacing.xl, marginTop: spacing.lg, borderRadius: radius.xxl, overflow: 'hidden', backgroundColor: '#111', height: 220, alignItems: 'center', justifyContent: 'center' },
  scannerBackdrop: { position: 'absolute', fontSize: 140, opacity: 0.05 },
  viewfinder: { position: 'absolute', top: 18, left: 18, right: 18, bottom: 18 },
  corner: { position: 'absolute', width: 24, height: 24, borderColor: colors.green },
  cornerTL: { top: -2, left: -2, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 3 },
  cornerBR: { bottom: -2, right: -2, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 3 },
  scanLine: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: colors.green, shadowColor: colors.green, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 8, elevation: 4 },
  scannerLabel: { position: 'absolute', bottom: 12, fontSize: 10, color: 'rgba(255,255,255,0.75)' },

  amountSection: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.md },

  historySection: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxl },
  historyLabel: { fontFamily: fontFamily.bodyBold, fontSize: 9, letterSpacing: 1.5, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', marginBottom: spacing.sm },
  historyEmpty: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.07)', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  historyEmptyText: { flex: 1, fontSize: 11, color: 'rgba(5,8,5,0.45)' },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.07)', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  historyIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.terracottaA08, alignItems: 'center', justifyContent: 'center' },
  historySub: { flex: 1, fontSize: 11, color: 'rgba(5,8,5,0.45)' },
  historyAmount: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.ink },
  amountSectionLabel: { fontFamily: fontFamily.bodyBold, fontSize: 9, letterSpacing: 1.5, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', marginBottom: spacing.sm },
  amountDisplay: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.1)', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginBottom: spacing.md },
  amountNum: { fontFamily: fontFamily.displayBlack, fontSize: 34, fontWeight: '900', letterSpacing: -1.5, color: colors.ink, flex: 1 },
  amountCurr: { fontSize: 13, color: 'rgba(5,8,5,0.45)' },
  keypadWrap: { marginTop: spacing.lg },
  quickRow: { gap: spacing.sm, flexWrap: 'wrap' },

  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxl },

  // Confirm step
  confirmHero: { paddingHorizontal: spacing.giant, paddingTop: spacing.xxl, paddingBottom: spacing.xl, backgroundColor: colors.greenA08, borderBottomWidth: 1, borderBottomColor: colors.greenA15, position: 'relative', overflow: 'hidden' },
  confirmAva: { width: 64, height: 64, borderRadius: radius.xxl, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 2, borderColor: colors.greenA25, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  confirmMerchantName: { fontFamily: fontFamily.displayBlack, fontSize: 14, fontWeight: '900', color: colors.ink, textAlign: 'center' },
  confirmMerchantArr: { fontSize: 11, color: 'rgba(5,8,5,0.45)', marginTop: 2 },
  confirmAmount: { fontFamily: fontFamily.displayBlack, fontSize: 48, fontWeight: '900', letterSpacing: -2.5, color: colors.greenDark, lineHeight: 52, marginTop: spacing.lg },
  confirmCurr: { fontFamily: fontFamily.bodyRegular, fontSize: 16, fontWeight: '400', color: 'rgba(26,240,96,0.5)' },
  freePill: { backgroundColor: colors.greenA10, borderWidth: 1, borderColor: colors.greenA20, borderRadius: radius.round, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs, marginTop: spacing.md },
  freePillText: { fontSize: 10, fontWeight: '700', color: colors.greenDark },

  confirmBody: { paddingHorizontal: spacing.giant, paddingVertical: spacing.xl, gap: 0 },
  confirmRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: 'rgba(5,8,5,0.07)' },
  confirmRowLabel: { fontSize: 11, color: 'rgba(5,8,5,0.45)' },
  confirmRowVal: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.ink },
  confirmRowBal: { fontSize: 11, color: 'rgba(5,8,5,0.45)' },

  confirmActions: { paddingHorizontal: spacing.giant, paddingTop: spacing.md, paddingBottom: spacing.xxl, gap: spacing.sm },
  warnBox: { flexDirection: 'row', gap: spacing.sm, backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.xs },
  warnText: { flex: 1, fontSize: 10, color: 'rgba(5,8,5,0.45)', lineHeight: 15 },
  cancelBtn: { height: 42, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', alignItems: 'center', justifyContent: 'center' },
  cancelBtnText: { fontSize: 12, color: 'rgba(5,8,5,0.5)' },

  // Success step
  successRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.giant },
  ssRing: { width: 88, height: 88, borderRadius: 44, backgroundColor: colors.greenA10, borderWidth: 3, borderColor: colors.green, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xxl, shadowColor: colors.green, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.2, shadowRadius: 50, elevation: 8 },
  ssTitle: { fontFamily: fontFamily.displayBlack, fontSize: 22, fontWeight: '900', letterSpacing: -0.8, color: colors.ink, marginBottom: spacing.sm, textAlign: 'center' },
  ssSub: { fontSize: 12, color: 'rgba(5,8,5,0.5)', marginBottom: spacing.xxl, lineHeight: 19.2, textAlign: 'center' },
  wakhnaBonus: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.greenA06, borderWidth: 1, borderColor: 'rgba(26,240,96,0.18)', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, marginBottom: spacing.lg },
  wakhnaBonusText: { flex: 1, fontSize: 11, color: 'rgba(5,8,5,0.5)' },
  shareBtn: { width: '100%', height: 44, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  shareBtnText: { fontSize: 12, fontWeight: '600', color: 'rgba(5,8,5,0.6)' },
});
