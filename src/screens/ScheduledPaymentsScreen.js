import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import RecipientConfirmCard from '../components/RecipientConfirmCard';
import { useToast } from '../components/Toast';
import {
  createPaymentFund,
  createScheduledPayment,
  fundPaymentPot,
  withdrawPaymentFund,
  getPaymentFunds,
  getScheduledPayments,
  toggleScheduledPayment,
  lookupUser,
} from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

const WEEKDAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

const GOAL_TEMPLATES = [
  { key: 'food', icon: '🍚', name: 'Nourriture', category: 'food' },
  { key: 'grocery', icon: '🛒', name: 'Courses', category: 'grocery' },
  { key: 'school', icon: '🎒', name: 'Frais scolaires', category: 'school' },
  { key: 'rent', icon: '🏠', name: 'Loyer', category: 'rent' },
  { key: 'other', icon: '✦', name: 'Autre', category: 'other' },
];

function ProgressBar({ pct }) {
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${Math.min(100, pct ?? 0)}%` }]} />
    </View>
  );
}

function FundCard({ fund, selected, onSelect }) {
  return (
    <PressScale
      scaleTo={0.98}
      onPress={() => onSelect(fund.id)}
      style={[styles.fundCard, selected && styles.fundCardOn]}
    >
      <View style={styles.fundTop}>
        <Text style={styles.fundName}>{fund.name}</Text>
        <Text style={styles.fundBal}>{fund.balanceFormatted}</Text>
      </View>
      {fund.targetKori ? (
        <>
          <ProgressBar pct={fund.progressPct} />
          <Text style={styles.fundMeta}>
            {fund.progressPct ?? 0}% · objectif {fund.targetFormatted}
            {fund.remainingKori > 0 ? ` · reste ${fund.remainingFormatted}` : ' · atteint 🎉'}
          </Text>
        </>
      ) : (
        <Text style={styles.fundMeta}>Pas d'objectif fixé</Text>
      )}
    </PressScale>
  );
}

export default function ScheduledPaymentsScreen({ navigation }) {
  const showToast = useToast();
  const [loading, setLoading] = useState(true);
  const [funds, setFunds] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [selectedFundId, setSelectedFundId] = useState(null);
  const [selectedTemplate, setSelectedTemplate] = useState(GOAL_TEMPLATES[0]);
  const [customName, setCustomName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [fundAmount, setFundAmount] = useState('');
  const [saveAmount, setSaveAmount] = useState('500');
  const [scheduleType, setScheduleType] = useState('weekly');
  const [scheduleDay, setScheduleDay] = useState(5);
  const [recipient, setRecipient] = useState('');
  const [pendingRecipient, setPendingRecipient] = useState(null); // J14-S0: verified person awaiting confirmation
  const [sendAmount, setSendAmount] = useState('1000');
  const [showSendForm, setShowSendForm] = useState(false);

  const goalName = customName.trim() || selectedTemplate.name;

  const saveSchedules = useMemo(() => schedules.filter((s) => s.kind === 'save'), [schedules]);
  const sendSchedules = useMemo(() => schedules.filter((s) => s.kind !== 'save'), [schedules]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [f, s] = await Promise.all([getPaymentFunds(), getScheduledPayments()]);
      const nextFunds = f.funds ?? [];
      setFunds(nextFunds);
      setSchedules(s.schedules ?? []);
      if (!selectedFundId && nextFunds[0]?.id) setSelectedFundId(nextFunds[0].id);
    } finally {
      setLoading(false);
    }
  }, [selectedFundId]);

  useEffect(() => {
    load();
  }, [load]);

  const createGoal = async () => {
    if (!goalName) return;
    try {
      const targetKori = parseInt(targetAmount.replace(/\D/g, ''), 10) || undefined;
      const created = await createPaymentFund({
        name: goalName,
        targetKori,
        category: selectedTemplate.category,
      });
      setCustomName('');
      setTargetAmount('');
      setSelectedFundId(created.id);
      await load();
      showToast('Objectif créé ✓');
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    }
  };

  const addToFund = async () => {
    const amt = parseInt(fundAmount.replace(/\D/g, ''), 10);
    if (!selectedFundId || !amt) return;
    try {
      await fundPaymentPot(selectedFundId, amt);
      setFundAmount('');
      await load();
      showToast('Épargné ✓');
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    }
  };

  const withdrawFromFund = async () => {
    const amt = parseInt(fundAmount.replace(/\D/g, ''), 10);
    if (!selectedFundId || !amt) return;
    try {
      await withdrawPaymentFund(selectedFundId, amt);
      setFundAmount('');
      await load();
      showToast('Retiré vers ton wallet ✓');
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    }
  };

  const createAutoSave = async () => {
    const amt = parseInt(saveAmount.replace(/\D/g, ''), 10);
    if (!selectedFundId || !amt) return;
    try {
      await createScheduledPayment({
        kind: 'save',
        fundId: selectedFundId,
        amountKori: amt,
        scheduleType,
        scheduleDay,
        note: goalName,
      });
      await load();
      showToast('Épargne auto programmée ✓');
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    }
  };

  // J14-S0: every future run pays the account chosen HERE — look it up and confirm who it is first.
  const checkRecipient = async () => {
    const amt = parseInt(sendAmount.replace(/\D/g, ''), 10);
    if (!recipient.trim() || !amt) return;
    try {
      setPendingRecipient(await lookupUser(recipient.trim().replace(/^@/, ''), { mode: 'handle' }));
    } catch (err) {
      setPendingRecipient(null);
      showToast(err.message ?? 'Personne introuvable');
    }
  };

  const createSendSchedule = async () => {
    const amt = parseInt(sendAmount.replace(/\D/g, ''), 10);
    if (!pendingRecipient?.recipientRef || !amt) return;
    try {
      await createScheduledPayment({
        kind: 'send',
        recipientHandle: String(pendingRecipient.handle).replace(/^@/, ''),
        recipientRef: pendingRecipient.recipientRef,
        amountKori: amt,
        scheduleType,
        scheduleDay,
        fundId: selectedFundId ?? undefined,
      });
      setPendingRecipient(null);
      await load();
      showToast('Envoi planifié ✓');
    } catch (err) {
      if (err.category === 'recipient_changed' || err.category === 'confirmation_required') setPendingRecipient(null);
      showToast(err.message ?? 'Erreur');
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 18 }}>←</Text>
          </PressScale>
          <Text style={styles.title}>Épargne & planifiés</Text>
        </View>
        {loading ? (
          <ActivityIndicator color={colors.greenDark} style={{ marginTop: 40 }} />
        ) : (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.hero}>Mets de côté pour{'\n'}ce qui compte.</Text>
            <Text style={styles.hint}>
              Nourriture, courses, école — crée ton objectif et programme une épargne automatique chaque semaine ou mois.
            </Text>

            <Text style={styles.sectionTitle}>Choisis un objectif</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.templateRow}>
              {GOAL_TEMPLATES.map((t) => (
                <PressScale
                  key={t.key}
                  scaleTo={0.96}
                  onPress={() => {
                    setSelectedTemplate(t);
                    setCustomName('');
                  }}
                  style={[styles.templateChip, selectedTemplate.key === t.key && styles.templateChipOn]}
                >
                  <Text style={styles.templateIcon}>{t.icon}</Text>
                  <Text style={[styles.templateText, selectedTemplate.key === t.key && styles.templateTextOn]}>
                    {t.name}
                  </Text>
                </PressScale>
              ))}
            </ScrollView>

            <View style={styles.rowInputs}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder={`Nom (ex. ${selectedTemplate.name})`}
                value={customName}
                onChangeText={setCustomName}
              />
            </View>
            <View style={styles.rowInputs}>
              <TextInput accessibilityLabel="Objectif en C (optionnel)"
                style={[styles.input, { flex: 1 }]}
                placeholder="Objectif en C (optionnel)"
                keyboardType="number-pad"
                value={targetAmount}
                onChangeText={setTargetAmount}
              />
              <PressScale scaleTo={0.97} onPress={createGoal} style={styles.smallBtn}>
                <Text style={styles.smallBtnText}>Créer</Text>
              </PressScale>
            </View>

            {funds.length > 0 ? (
              <>
                <Text style={[styles.sectionTitle, { marginTop: spacing.lg }]}>Mes objectifs</Text>
                {funds.map((f) => (
                  <FundCard
                    key={f.id}
                    fund={f}
                    selected={selectedFundId === f.id}
                    onSelect={setSelectedFundId}
                  />
                ))}

                {selectedFundId ? (
                  <View style={styles.block}>
                    <Text style={styles.sectionTitle}>Ajouter maintenant</Text>
                    <View style={styles.rowInputs}>
                      <TextInput accessibilityLabel="Montant (C)"
                        style={[styles.input, { flex: 1 }]}
                        placeholder="Montant (C)"
                        keyboardType="number-pad"
                        value={fundAmount}
                        onChangeText={setFundAmount}
                      />
                      <PressScale scaleTo={0.97} onPress={addToFund} style={styles.smallBtn}>
                        <Text style={styles.smallBtnText}>Épargner</Text>
                      </PressScale>
                      <PressScale scaleTo={0.97} onPress={withdrawFromFund} style={[styles.smallBtn, styles.smallBtnAlt]}>
                        <Text style={styles.smallBtnText}>Retirer</Text>
                      </PressScale>
                    </View>
                  </View>
                ) : null}

                <Text style={[styles.sectionTitle, { marginTop: spacing.lg }]}>Épargne automatique</Text>
                <Text style={styles.hint}>Prélèvement depuis ton wallet vers l'objectif sélectionné.</Text>
                <TextInput accessibilityLabel="Montant par versement (C)"
                  style={styles.input}
                  placeholder="Montant par versement (C)"
                  keyboardType="number-pad"
                  value={saveAmount}
                  onChangeText={setSaveAmount}
                />
                <View style={styles.pillRow}>
                  {['weekly', 'monthly'].map((t) => (
                    <PressScale
                      key={t}
                      scaleTo={0.96}
                      onPress={() => setScheduleType(t)}
                      style={[styles.pill, scheduleType === t && styles.pillOn]}
                    >
                      <Text style={[styles.pillText, scheduleType === t && styles.pillTextOn]}>
                        {t === 'weekly' ? 'Chaque semaine' : 'Chaque mois'}
                      </Text>
                    </PressScale>
                  ))}
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayRow}>
                  {(scheduleType === 'weekly'
                    ? WEEKDAYS.map((_, i) => i)
                    : [...Array(28)].map((_, i) => i + 1)
                  ).map((d) => (
                    <PressScale
                      key={d}
                      scaleTo={0.95}
                      onPress={() => setScheduleDay(d)}
                      style={[styles.dayChip, scheduleDay === d && styles.dayChipOn]}
                    >
                      <Text style={[styles.dayChipText, scheduleDay === d && styles.dayChipTextOn]}>
                        {scheduleType === 'weekly' ? WEEKDAYS[d] : d}
                      </Text>
                    </PressScale>
                  ))}
                </ScrollView>
                <GlowButton label="Programmer l'épargne auto" onPress={createAutoSave} disabled={!selectedFundId} />
              </>
            ) : null}

            {saveSchedules.length > 0 ? (
              <>
                <Text style={[styles.sectionTitle, { marginTop: spacing.xl }]}>Épargnes programmées</Text>
                {saveSchedules.map((s) => (
                  <View key={s.id} style={styles.scheduleCard}>
                    <Text style={styles.rowTitle}>
                      {s.fund?.name ?? 'Objectif'} · {s.amountFormatted}
                    </Text>
                    <Text style={styles.hint}>
                      {s.scheduleType === 'weekly' ? WEEKDAYS[s.scheduleDay] : `Jour ${s.scheduleDay}`} · prochain{' '}
                      {new Date(s.nextRunAt).toLocaleDateString('fr-FR')}
                    </Text>
                    <PressScale
                      scaleTo={0.97}
                      onPress={() => toggleScheduledPayment(s.id, !s.active).then(load)}
                      style={styles.toggleBtn}
                    >
                      <Text style={styles.toggleText}>{s.active ? 'Pause' : 'Réactiver'}</Text>
                    </PressScale>
                  </View>
                ))}
              </>
            ) : null}

            <PressScale scaleTo={0.98} onPress={() => setShowSendForm((v) => !v)} style={styles.linkRow}>
              <Text style={styles.linkText}>{showSendForm ? '− Masquer envois planifiés' : '+ Envoyer à quelqu\'un régulièrement'}</Text>
            </PressScale>

            {showSendForm ? (
              <View style={styles.block}>
                <TextInput accessibilityLabel="@handle destinataire"
                  style={styles.input}
                  placeholder="@handle destinataire"
                  autoCapitalize="none"
                  value={recipient}
                  onChangeText={setRecipient}
                />
                <TextInput accessibilityLabel="Montant (C)"
                  style={styles.input}
                  placeholder="Montant (C)"
                  keyboardType="number-pad"
                  value={sendAmount}
                  onChangeText={setSendAmount}
                />
                {pendingRecipient ? (
                  <RecipientConfirmCard
                    profile={pendingRecipient}
                    question={`Programmer un envoi à ${pendingRecipient.name || pendingRecipient.handle} ?`}
                    confirmLabel="Oui, programmer l'envoi"
                    onConfirm={createSendSchedule}
                    onCancel={() => setPendingRecipient(null)}
                  />
                ) : (
                  <GlowButton label="Vérifier le destinataire" onPress={checkRecipient} tone="gold" />
                )}
                {sendSchedules.map((s) => (
                  <View key={s.id} style={styles.scheduleCard}>
                    <Text style={styles.rowTitle}>
                      @{s.recipientHandle} · {s.amountFormatted}
                    </Text>
                    <Text style={styles.hint}>
                      {s.scheduleType === 'weekly' ? WEEKDAYS[s.scheduleDay] : `Jour ${s.scheduleDay}`} ·{' '}
                      {s.fund?.name ?? 'Portefeuille'}
                    </Text>
                    <PressScale
                      scaleTo={0.97}
                      onPress={() => toggleScheduledPayment(s.id, !s.active).then(load)}
                      style={styles.toggleBtn}
                    >
                      <Text style={styles.toggleText}>{s.active ? 'Pause' : 'Réactiver'}</Text>
                    </PressScale>
                  </View>
                ))}
              </View>
            ) : null}
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.huge,
    paddingVertical: spacing.md,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.appCanvas.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  body: { padding: spacing.huge, gap: spacing.md, paddingBottom: 80 },
  hero: {
    fontFamily: fontFamily.displayBlack,
    fontSize: 28,
    color: colors.greenDark,
    lineHeight: 32,
    marginBottom: spacing.xs,
  },
  sectionTitle: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  hint: { ...type.bodySmall, color: 'rgba(5,8,5,0.5)' },
  templateRow: { gap: spacing.sm, paddingVertical: spacing.sm },
  templateChip: {
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    minWidth: 88,
  },
  templateChipOn: { backgroundColor: 'rgba(26,240,96,0.12)', borderColor: colors.green },
  templateIcon: { fontSize: 22, marginBottom: 4 },
  templateText: { ...type.bodySmall, color: 'rgba(5,8,5,0.6)' },
  templateTextOn: { color: colors.greenDark, fontFamily: fontFamily.bodySemiBold },
  fundCard: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    gap: spacing.sm,
  },
  fundCardOn: { borderColor: colors.green, backgroundColor: 'rgba(26,240,96,0.08)' },
  fundTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fundName: { fontFamily: fontFamily.bodySemiBold, color: colors.ink },
  fundBal: { fontFamily: fontFamily.displayBlack, color: colors.greenDark },
  fundMeta: { ...type.caption, color: 'rgba(5,8,5,0.5)' },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(5,8,5,0.08)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.green, borderRadius: 4 },
  block: { gap: spacing.md },
  rowInputs: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    ...type.body,
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    padding: spacing.md,
    color: colors.ink,
  },
  smallBtn: {
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  smallBtnText: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.ink },
  smallBtnAlt: { backgroundColor: colors.goldA20 },
  pillRow: { flexDirection: 'row', gap: spacing.sm },
  pill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  pillOn: { backgroundColor: 'rgba(26,240,96,0.12)', borderColor: colors.green },
  pillText: { ...type.bodySmall, color: 'rgba(5,8,5,0.6)' },
  pillTextOn: { color: colors.greenDark, fontFamily: fontFamily.bodySemiBold },
  dayRow: { gap: spacing.xs },
  dayChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  dayChipOn: { backgroundColor: colors.green, borderColor: colors.green },
  dayChipText: { fontSize: 11, color: 'rgba(5,8,5,0.6)' },
  dayChipTextOn: { color: colors.ink, fontFamily: fontFamily.bodyBold },
  scheduleCard: {
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    gap: 4,
  },
  rowTitle: { fontFamily: fontFamily.bodySemiBold, color: colors.ink },
  toggleBtn: { alignSelf: 'flex-start', marginTop: spacing.xs },
  toggleText: { ...type.bodySmall, color: colors.terracotta, fontFamily: fontFamily.bodyBold },
  linkRow: { paddingVertical: spacing.md, alignItems: 'center' },
  linkText: { fontFamily: fontFamily.bodyBold, color: colors.terracotta },
});
