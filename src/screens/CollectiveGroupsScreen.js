import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { useToast } from '../components/Toast';
import { createCollectiveGroup, getCollectiveGroups, respondCollectiveInvite } from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

/**
 * J11 "Groupes d'épargne": my rotating tontines and goal savings groups. Joining never commits anyone:
 * every member approves the exact rules before anything starts, and every payment is made by the member.
 */
const KIND = { rotating: 'Tontine tournante', goal: 'Épargne objectif' };
const FREQ = { weekly: 'chaque semaine', biweekly: 'toutes les 2 semaines', monthly: 'chaque mois' };
const STATUS = { proposed: 'En préparation', awaiting_acceptance: 'Règles à approuver', active: 'En cours', completed: 'Terminé', cancelled: 'Annulé', settlement_pending: 'Fin votée : règlement K21 en cours' };

export default function CollectiveGroupsScreen({ navigation }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const showToast = useToast();
  const load = useCallback(async () => {
    try {
      setData(await getCollectiveGroups());
      setError(null);
    } catch (e) {
      setError(e?.code === 'collective_not_enabled' || e?.status === 503 ? 'Les groupes d’épargne ne sont pas encore ouverts.' : e?.message ?? 'Chargement impossible');
    }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const create = async () => {
    try {
      const body = { kind: form.kind, name: form.name.trim(), contributionKori: Number(form.amount), frequency: form.frequency };
      if (form.kind === 'goal') Object.assign(body, { cycleCount: Number(form.cycles || 6), withdrawPolicy: form.lock ? 'end' : 'anytime' });
      const g = await createCollectiveGroup(body);
      setForm(null);
      navigation.navigate('CollectiveGroup', { id: g.id });
    } catch (e) {
      showToast(e.message ?? 'Création impossible');
    }
  };
  const respond = async (g, accept) => {
    try {
      await respondCollectiveInvite(g.id, accept);
      showToast(accept ? 'Tu as rejoint le groupe. Tu approuveras les règles avant toute cotisation.' : 'Invitation refusée');
      load();
    } catch (e) {
      showToast(e.message);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Groupes d’épargne" style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.note}>Chaque membre approuve les règles avant le départ. Personne ne prélève ton argent : tu cotises toi-même. L’organisateur n’a aucun pouvoir sur l’argent. Pas de garantie, pas d’intérêt.</Text>
          {!data && !error ? <ActivityIndicator color={colors.green} /> : null}
          {error ? <Text style={styles.empty}>{error}</Text> : null}
          {(data?.groups ?? []).map((g) => (
            <PressScale key={g.id} onPress={() => g.myStatus !== 'invited' && navigation.navigate('CollectiveGroup', { id: g.id })} style={[styles.card, (g.needsMyApproval || g.due) && styles.urgent]} accessibilityLabel={`${g.name}. ${STATUS[g.status]}`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{g.name}</Text>
                <Text style={styles.detail}>{KIND[g.kind]} · {g.contributionKori} ₭ {FREQ[g.frequency]} · {STATUS[g.status]}{g.frozen ? ' · gelé (vérification K21)' : ''}</Text>
                {g.needsMyApproval ? <Text style={styles.alert}>Règles à approuver</Text> : null}
                {g.due ? <Text style={styles.alert}>{g.due.dueKori} ₭ à cotiser (cycle {g.due.cycle}){g.due.status === 'missed' ? ' · en retard' : ''}</Text> : null}
                {g.myStatus === 'invited' ? (
                  <View style={styles.row}>
                    <PressScale onPress={() => respond(g, true)}><Text style={styles.action}>Rejoindre</Text></PressScale>
                    <PressScale onPress={() => respond(g, false)}><Text style={styles.muted}>Refuser</Text></PressScale>
                  </View>
                ) : null}
              </View>
              {g.myStatus !== 'invited' ? <Text style={styles.chev}>›</Text> : null}
            </PressScale>
          ))}
          {data && !data.groups.length ? <Text style={styles.empty}>Aucun groupe pour l’instant.</Text> : null}
          {data && !form ? (
            <PressScale onPress={() => setForm({ kind: 'rotating', name: '', amount: '1000', frequency: 'monthly', cycles: '6', lock: true })} style={styles.card} accessibilityLabel="Créer un groupe">
              <Text style={styles.title}>＋ Créer un groupe</Text>
            </PressScale>
          ) : null}
          {form ? (
            <View style={[styles.card, styles.column]}>
              <View style={styles.row}>
                {Object.entries(KIND).map(([k, label]) => (
                  <PressScale key={k} onPress={() => setForm({ ...form, kind: k })} style={[styles.chip, form.kind === k && styles.chipOn]}><Text>{label}</Text></PressScale>
                ))}
              </View>
              <TextInput value={form.name} onChangeText={(name) => setForm({ ...form, name })} placeholder="Nom du groupe" style={styles.input} accessibilityLabel="Nom du groupe" />
              <TextInput value={form.amount} onChangeText={(amount) => setForm({ ...form, amount })} placeholder="Cotisation (₭)" keyboardType="numeric" style={styles.input} accessibilityLabel="Cotisation en Kori" />
              <View style={styles.row}>
                {Object.entries(FREQ).map(([k, label]) => (
                  <PressScale key={k} onPress={() => setForm({ ...form, frequency: k })} style={[styles.chip, form.frequency === k && styles.chipOn]}><Text>{label}</Text></PressScale>
                ))}
              </View>
              {form.kind === 'goal' ? (
                <>
                  <TextInput value={form.cycles} onChangeText={(cycles) => setForm({ ...form, cycles })} placeholder="Nombre de versements" keyboardType="numeric" style={styles.input} accessibilityLabel="Nombre de versements" />
                  <PressScale onPress={() => setForm({ ...form, lock: !form.lock })}><Text style={styles.detail}>{form.lock ? '☑' : '☐'} Épargne bloquée jusqu’à la fin</Text></PressScale>
                </>
              ) : <Text style={styles.detail}>L’ordre de passage sera tiré au sort et visible par tous avant le départ.</Text>}
              <View style={styles.row}>
                <PressScale onPress={create}><Text style={styles.action}>Créer</Text></PressScale>
                <PressScale onPress={() => setForm(null)}><Text style={styles.muted}>Annuler</Text></PressScale>
              </View>
            </View>
          ) : null}
          <PressScale onPress={() => navigation.navigate('CoopCapital')} style={styles.card} accessibilityLabel="Mon registre coopérative">
            <Text style={styles.icon}>🌾</Text>
            <View style={{ flex: 1 }}><Text style={styles.title}>Mon registre coopérative</Text><Text style={styles.detail}>Parts, prêts et dons enregistrés à ton nom (registre seulement)</Text></View>
            <Text style={styles.chev}>›</Text>
          </PressScale>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { paddingHorizontal: spacing.lg },
  scroll: { padding: spacing.lg, paddingBottom: spacing.huge },
  note: { ...type.caption, marginBottom: spacing.md },
  empty: { ...type.body, color: 'rgba(5,8,5,0.5)', textAlign: 'center', marginVertical: spacing.xl },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  column: { flexDirection: 'column', alignItems: 'stretch' },
  urgent: { borderLeftWidth: 3, borderLeftColor: colors.terracotta },
  icon: { fontSize: 20 },
  title: { fontFamily: fontFamily.bodyBold, color: colors.ink, fontSize: 15 },
  detail: { ...type.caption, marginTop: 2 },
  alert: { ...type.caption, color: colors.terracotta, marginTop: 4, fontFamily: fontFamily.bodyBold },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm, alignItems: 'center' },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(5,8,5,0.15)' },
  chipOn: { borderColor: colors.green, backgroundColor: 'rgba(0,133,63,0.08)' },
  input: { borderWidth: 1, borderColor: 'rgba(5,8,5,0.15)', borderRadius: radius.md, padding: spacing.sm, marginTop: spacing.sm },
  action: { fontFamily: fontFamily.bodyBold, color: colors.green },
  muted: { ...type.caption },
  chev: { fontSize: 22, color: 'rgba(5,8,5,0.35)' },
});
