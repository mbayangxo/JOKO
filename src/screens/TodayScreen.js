import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { getToday } from '../lib/api-client';
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
  const load = useCallback(async () => {
    try {
      setData(await getToday());
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
          {data?.empty ? <Text style={styles.empty}>Rien ne t’attend aujourd’hui.</Text> : null}
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
  chev: { fontSize: 22, color: 'rgba(5,8,5,0.35)' },
});
