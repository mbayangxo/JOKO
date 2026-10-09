import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { appealModeration, getMyModeration, getToday } from '../lib/api-client';
import { useToast } from '../components/Toast';
import { navigateFromRoot } from '../lib/root-navigation';
import { colors, fontFamily, radius, spacing, type } from '../theme';

/**
 * J10 "Aujourd'hui": what needs me now, built only from my own real objects (requests to pay,
 * work offers, school fees, parcels, orders, tontine dues, contact and message requests, tickets).
 * Nothing is suggested or invented; each line opens the object's own screen, where acting happens.
 */
const ICON = {
  money_request: '💸', work_offer: '🧰', work_todo: '🧰', work_earnings: '💰', school_fee: '🎒', tontine_due: '🏦', delivery: '📦',
  order: '🛍️', connection_requests: '🤝', message_requests: '💬', ticket: '🎟️',
};

export default function TodayScreen({ navigation }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [appealText, setAppealText] = useState({});
  const showToast = useToast();
  const load = useCallback(async () => {
    try {
      setData(await getToday());
      getMyModeration().then((m) => setDecisions((m.actions ?? []).filter((a) => a.active || a.appealable || (a.appealed && !a.appealOutcome)))).catch(() => {});
      setError(null);
    } catch (e) {
      setError(/Network|fetch/i.test(e?.message ?? '') ? 'Réseau indisponible — réessaie' : e?.message ?? 'Chargement impossible');
    }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const open = (item) => { if (item.route) navigateFromRoot(navigation, item.route, item.params); };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Aujourd'hui" style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          {!data && !error ? <ActivityIndicator color={colors.green} /> : null}
          {error ? (
            <PressScale onPress={load} style={styles.card}><Text style={styles.body}>{error}</Text></PressScale>
          ) : null}
          {decisions.map((a) => (
            <View key={a.id} style={[styles.card, styles.urgent, { flexDirection: 'column', alignItems: 'stretch' }]}>
              <Text style={styles.title}>{a.kind === 'warn' ? 'Avertissement de la communauté' : `Messagerie limitée${a.until ? ` jusqu’au ${new Date(a.until).toLocaleDateString('fr-SN')}` : ''}`}</Text>
              <Text style={styles.detail}>{a.note} · tes paiements ne sont pas touchés</Text>
              {a.appealable ? (
                <>
                  <TextInput value={appealText[a.id] ?? ''} onChangeText={(t) => setAppealText((x) => ({ ...x, [a.id]: t }))} placeholder="Explique pourquoi tu fais appel" style={styles.input} multiline accessibilityLabel="Texte de l’appel" />
                  <PressScale onPress={async () => { try { await appealModeration(a.id, appealText[a.id] ?? ''); showToast('Appel envoyé — un autre membre de l’équipe K21 va trancher'); load(); } catch (e) { showToast(e.message); } }}>
                    <Text style={styles.action}>Faire appel</Text>
                  </PressScale>
                </>
              ) : a.appealed && !a.appealOutcome ? <Text style={styles.detail}>Appel en cours d’examen</Text> : null}
            </View>
          ))}
          {data?.empty && decisions.length === 0 ? <Text style={styles.empty}>Rien ne t’attend aujourd’hui.</Text> : null}
          {(data?.items ?? []).map((item) => (
            <PressScale key={`${item.type}:${item.id}`} onPress={() => open(item)} disabled={!item.route} style={[styles.card, item.priority === 1 && styles.urgent]} accessibilityLabel={`${item.title}. ${item.detail}`}>
              <Text style={styles.icon}>{ICON[item.type] ?? '•'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{item.title}</Text>
                {item.detail ? <Text style={styles.detail}>{item.detail}</Text> : null}
              </View>
              {item.route ? <Text style={styles.chev}>›</Text> : null}
            </PressScale>
          ))}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { paddingHorizontal: spacing.lg },
  scroll: { padding: spacing.lg, paddingBottom: spacing.huge },
  empty: { ...type.body, color: 'rgba(5,8,5,0.5)', textAlign: 'center', marginTop: spacing.xxl },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  urgent: { borderLeftWidth: 3, borderLeftColor: colors.terracotta },
  icon: { fontSize: 20 },
  title: { fontFamily: fontFamily.bodyBold, color: colors.ink, fontSize: 15 },
  detail: { ...type.caption, marginTop: 2 },
  body: { ...type.body },
  input: { borderWidth: 1, borderColor: 'rgba(5,8,5,0.15)', borderRadius: radius.md, padding: spacing.sm, marginTop: spacing.sm, minHeight: 60 },
  action: { fontFamily: fontFamily.bodyBold, color: colors.green, marginTop: spacing.sm },
  chev: { fontSize: 22, color: 'rgba(5,8,5,0.35)' },
});
