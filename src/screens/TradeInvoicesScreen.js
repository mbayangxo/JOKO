import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import LoadErrorState from '../components/LoadErrorState';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import StepUpOverlay from '../components/StepUpOverlay';
import { useToast } from '../components/Toast';
import { useAppState } from '../state/AppState';
import { useSecurity } from '../context/SecurityContext';
import { getMyTradeInvoices, payTradeInvoice, disputeTradeInvoice, getMyBusinesses, getBusinessWallet } from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { colors, fontFamily, radius, spacing, type } from '../theme';

export default function TradeInvoicesScreen({ navigation }) {
  const showToast = useToast();
  const security = useSecurity();
  const { refreshWallet } = useAppState();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [payingId, setPayingId] = useState(null);
  const [stepUpVisible, setStepUpVisible] = useState(false);
  const [pendingInvoiceId, setPendingInvoiceId] = useState(null);
  const [paymentSource, setPaymentSource] = useState('personal');
  const [buyerBusinessId, setBuyerBusinessId] = useState(null);
  const [myBusinesses, setMyBusinesses] = useState([]);
  const [kebuBalance, setKebuBalance] = useState(null);
  const [disputeTarget, setDisputeTarget] = useState(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputing, setDisputing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getMyBusinesses()
        .then((res) => {
          const list = [...(res.owned ?? []), ...(res.member ?? [])];
          setMyBusinesses(list);
          if (list.length === 1) setBuyerBusinessId(list[0].id);
        })
        .catch(() => setMyBusinesses([]));
    }, []),
  );

  useEffect(() => {
    if (paymentSource !== 'kebu' || !buyerBusinessId) {
      setKebuBalance(null);
      return;
    }
    getBusinessWallet(buyerBusinessId)
      .then((w) => setKebuBalance(w.wallet?.balance ?? w.balance ?? 0))
      .catch(() => setKebuBalance(null));
  }, [paymentSource, buyerBusinessId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getMyTradeInvoices('open');
      setInvoices(res.invoices ?? []);
      setLoadFailed(false);
    } catch {
      // J13-F7: never "Aucune facture ouverte" when the list simply did not load — a debt would look settled.
      setInvoices([]);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const pay = async (invoiceId, stepUpToken) => {
    if (paymentSource === 'kebu' && !buyerBusinessId) {
      showToast('Choisis le commerce KEBU payeur');
      return;
    }
    setPayingId(invoiceId);
    try {
      await payTradeInvoice(invoiceId, {
        stepUpToken: stepUpToken ?? security.stepUpToken,
        paymentSource,
        buyerBusinessId: paymentSource === 'kebu' ? buyerBusinessId : undefined,
      });
      await refreshWallet();
      showToast('Facture payée ✓');
      setPendingInvoiceId(null);
      await load();
    } catch (err) {
      if (err.code === 'step_up_required') {
        setPendingInvoiceId(invoiceId);
        setStepUpVisible(true);
        return;
      }
      showToast(err.message ?? 'Paiement impossible');
    } finally {
      setPayingId(null);
    }
  };

  const submitDispute = async () => {
    if (!disputeTarget || disputeReason.trim().length < 3) {
      showToast('Décris le problème (3 caractères min.)');
      return;
    }
    setDisputing(true);
    try {
      await disputeTradeInvoice(disputeTarget.id, disputeReason.trim());
      showToast('Facture contestée — le fournisseur a été prévenu');
      setDisputeTarget(null);
      setDisputeReason('');
      await load();
    } catch (err) {
      showToast(err.message ?? 'Contestation impossible');
    } finally {
      setDisputing(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 16 }}>←</Text>
          </PressScale>
          <Text style={styles.title}>Factures B2B</Text>
        </View>
        {loading ? (
          <ActivityIndicator color={colors.green} style={{ marginTop: 40 }} />
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            {invoices.length > 0 ? (
              <View style={styles.summaryCard}>
                <Text style={styles.summaryTitle}>Solde ouvert</Text>
                <Text style={styles.summaryAmount}>
                  {formatKori(invoices.reduce((s, i) => s + (i.amountDue ?? i.amountKori - i.amountPaid), 0))}
                </Text>
                <Text style={styles.summarySub}>{invoices.length} facture(s) à payer</Text>
                {myBusinesses.length > 0 ? (
                  <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
                    <Text style={styles.summarySub}>Payer avec :</Text>
                    <View style={styles.payRow}>
                      <PressScale
                        scaleTo={0.97}
                        onPress={() => setPaymentSource('personal')}
                        style={[styles.payChip, paymentSource === 'personal' && styles.payChipOn]}
                      >
                        <Text style={[styles.payChipText, paymentSource === 'personal' && styles.payChipTextOn]}>
                          Mon C
                        </Text>
                      </PressScale>
                      <PressScale
                        scaleTo={0.97}
                        onPress={() => setPaymentSource('kebu')}
                        style={[styles.payChip, paymentSource === 'kebu' && styles.payChipOn]}
                      >
                        <Text style={[styles.payChipText, paymentSource === 'kebu' && styles.payChipTextOn]}>
                          KEBU
                        </Text>
                      </PressScale>
                    </View>
                    {paymentSource === 'kebu'
                      ? myBusinesses.map((b) => (
                          <PressScale
                            key={b.id}
                            scaleTo={0.98}
                            onPress={() => setBuyerBusinessId(b.id)}
                            style={[styles.bizChip, buyerBusinessId === b.id && styles.bizChipOn]}
                          >
                            <Text style={styles.bizChipText}>{b.name}</Text>
                          </PressScale>
                        ))
                      : null}
                    {paymentSource === 'kebu' && kebuBalance != null ? (
                      <Text style={styles.summarySub}>Solde KEBU : {formatKori(kebuBalance)}</Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : loadFailed ? (
              <LoadErrorState what="tes factures" onRetry={load} />
            ) : (
              <Text style={styles.empty}>Aucune facture ouverte.</Text>
            )}
            {invoices.map((inv) => (
              <View key={inv.id} style={styles.card}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={styles.ref}>{inv.reference}</Text>
                  {inv.status === 'overdue' ? (
                    <View style={styles.overduePill}>
                      <Text style={styles.overduePillText}>En retard</Text>
                    </View>
                  ) : inv.status === 'disputed' ? (
                    <View style={styles.disputedPill}>
                      <Text style={styles.disputedPillText}>Contestée</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.supplier}>{inv.supplier?.name ?? 'Fournisseur'}</Text>
                <Text style={styles.amount}>{inv.dueFormatted ?? formatKori(inv.amountDue ?? inv.amountKori)}</Text>
                <Text style={styles.due}>Échéance {new Date(inv.dueAt).toLocaleDateString('fr-FR')}</Text>
                {inv.status === 'disputed' ? (
                  <Text style={styles.disputeNote}>
                    En attente de réponse du fournisseur — « {inv.disputeReason} »
                  </Text>
                ) : (
                  <>
                    <GlowButton
                      label={payingId === inv.id ? 'Paiement…' : paymentSource === 'kebu' ? 'Payer en KEBU' : 'Payer en C'}
                      onPress={() => pay(inv.id)}
                      disabled={payingId != null}
                    />
                    <PressScale
                      scaleTo={0.97}
                      onPress={() => {
                        setDisputeTarget(inv);
                        setDisputeReason('');
                      }}
                      style={{ alignSelf: 'center', marginTop: spacing.xs }}
                    >
                      <Text style={styles.disputeLink}>Cette facture me semble incorrecte</Text>
                    </PressScale>
                  </>
                )}
              </View>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
      <StepUpOverlay
        visible={stepUpVisible}
        onCancel={() => {
          setStepUpVisible(false);
          setPendingInvoiceId(null);
        }}
        onVerified={(token) => {
          setStepUpVisible(false);
          if (pendingInvoiceId) pay(pendingInvoiceId, token);
        }}
      />
      <Modal visible={Boolean(disputeTarget)} animationType="slide" transparent onRequestClose={() => setDisputeTarget(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Contester {disputeTarget?.reference}</Text>
            <Text style={styles.modalHint}>
              Le fournisseur sera prévenu et la facture ne pourra pas être payée tant qu'il n'a pas répondu.
            </Text>
            <TextInput accessibilityLabel="Qu'est-ce qui ne va pas ?"
              style={styles.modalInput}
              placeholder="Qu'est-ce qui ne va pas ?"
              placeholderTextColor="rgba(5,8,5,0.4)"
              value={disputeReason}
              onChangeText={setDisputeReason}
              multiline
            />
            <GlowButton
              label={disputing ? 'Envoi…' : 'Contester cette facture'}
              onPress={submitDispute}
              disabled={disputing}
            />
            <PressScale scaleTo={0.96} onPress={() => setDisputeTarget(null)} style={{ alignSelf: 'center', marginTop: spacing.sm }}>
              <Text style={{ color: 'rgba(5,8,5,0.5)', fontSize: 12 }}>Annuler</Text>
            </PressScale>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.huge },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.appCanvas.surface, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  empty: { ...type.body, textAlign: 'center', marginTop: 48, color: 'rgba(5,8,5,0.5)' },
  list: { padding: spacing.huge, gap: spacing.md, paddingBottom: 80 },
  summaryCard: {
    backgroundColor: 'rgba(232,92,26,0.08)',
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(232,92,26,0.2)',
    marginBottom: spacing.sm,
  },
  summaryTitle: { ...type.caption, color: 'rgba(5,8,5,0.55)' },
  summaryAmount: { fontFamily: fontFamily.displayBlack, fontSize: 22, color: colors.terracottaDark, marginTop: 4 },
  summarySub: { ...type.caption, color: 'rgba(5,8,5,0.5)', marginTop: 4 },
  card: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm, borderWidth: 1, borderColor: colors.appCanvas.border },
  ref: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  supplier: { ...type.bodySmall, color: 'rgba(5,8,5,0.6)' },
  amount: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.greenDark },
  due: { ...type.caption, color: 'rgba(5,8,5,0.5)' },
  overduePill: {
    backgroundColor: 'rgba(232,92,26,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(232,92,26,0.3)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  overduePillText: { ...type.caption, fontFamily: fontFamily.bodyBold, color: colors.terracottaDark },
  disputedPill: {
    backgroundColor: 'rgba(232,92,26,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(232,92,26,0.3)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  disputedPillText: { ...type.caption, fontFamily: fontFamily.bodyBold, color: colors.terracottaDark },
  disputeNote: { ...type.caption, color: colors.terracottaDark, fontStyle: 'italic' },
  disputeLink: { ...type.caption, color: 'rgba(5,8,5,0.45)', textDecorationLine: 'underline' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: colors.appCanvas.base,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.huge,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    gap: spacing.md,
  },
  modalTitle: { fontFamily: fontFamily.displayBold, fontSize: 16, color: colors.ink },
  modalHint: { ...type.caption, color: 'rgba(5,8,5,0.55)', lineHeight: 16 },
  modalInput: {
    minHeight: 70,
    borderWidth: 2,
    borderColor: colors.appCanvas.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    fontSize: 13,
    color: colors.ink,
    backgroundColor: '#fff',
    textAlignVertical: 'top',
  },
  payRow: { flexDirection: 'row', gap: spacing.sm },
  payChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(232,92,26,0.25)',
  },
  payChipOn: { backgroundColor: colors.green, borderColor: colors.green },
  payChipText: { ...type.caption, color: colors.ink },
  payChipTextOn: { color: '#fff' },
  bizChip: {
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(232,92,26,0.2)',
  },
  bizChipOn: { borderColor: colors.green, backgroundColor: 'rgba(46,125,50,0.08)' },
  bizChipText: { ...type.caption, color: colors.ink },
});
