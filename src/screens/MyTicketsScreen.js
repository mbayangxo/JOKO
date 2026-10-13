import { useCallback, useState } from 'react';
import LoadErrorState from '../components/LoadErrorState';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import K21QrCode from '../components/K21QrCode';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { getMyTickets } from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { colors, fontFamily, radius, spacing, type } from '../theme';

function formatWhen(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function MyTicketsScreen({ navigation }) {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  const [loadFailed, setLoadFailed] = useState(false); // J13-F7
  const load = useCallback(async () => {
    try {
      const rows = await getMyTickets();
      setTickets(Array.isArray(rows) ? rows : []);
      setLoadFailed(false);
    } catch {
      setTickets([]);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Mes billets" style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          {loading ? <ActivityIndicator color={colors.green} /> : null}
          {!loading && tickets.length === 0 && loadFailed ? <LoadErrorState what="tes billets" onRetry={() => { setLoading(true); load(); }} /> : null}
          {!loading && tickets.length === 0 && !loadFailed ? (
            <Text style={styles.empty}>Tu n'as pas encore de billet.</Text>
          ) : null}
          {tickets.map((t) => (
            <View key={t.id} style={styles.card}>
              <Text style={styles.eventTitle}>{t.event?.title ?? 'Événement'}</Text>
              <Text style={styles.meta}>{formatWhen(t.event?.startsAt)} · {t.event?.venue ?? '—'}</Text>
              <Text style={styles.price}>{formatKori(t.amount)} · {t.quantity} place(s)</Text>
              {(t.passes ?? []).map((p) => (
                <View key={p.id} style={styles.passBlock}>
                  <Text style={styles.passLbl}>{p.status === 'used' ? '✓ Entré' : 'Billet'}</Text>
                  {p.status === 'valid' && p.qrUrl ? (
                    <K21QrCode value={p.qrUrl} size={140} />
                  ) : (
                    <Text style={styles.used}>Scanné à la porte</Text>
                  )}
                  <Text style={styles.code}>{p.scanCode}</Text>
                </View>
              ))}
            </View>
          ))}
          <PressScale scaleTo={0.97} onPress={() => navigation.navigate('EventCreate')} style={styles.link}>
            <Text style={styles.linkText}>+ Organiser un événement</Text>
          </PressScale>
          <PressScale scaleTo={0.97} onPress={() => navigation.navigate('EventScanner')} style={styles.link}>
            <Text style={styles.linkText}>📷 Scanner des billets (organisateur)</Text>
          </PressScale>
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
  card: { backgroundColor: 'rgba(255,255,255,0.8)', borderRadius: radius.lg, borderBottomRightRadius: radius.sm, padding: spacing.lg, marginBottom: spacing.lg },
  eventTitle: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  meta: { ...type.caption, marginTop: 4, marginBottom: spacing.sm },
  price: { fontFamily: fontFamily.bodyBold, color: colors.greenDark, marginBottom: spacing.md },
  passBlock: { alignItems: 'center', paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(5,8,5,0.08)', marginTop: spacing.sm },
  passLbl: { fontFamily: fontFamily.bodyBold, marginBottom: spacing.sm },
  code: { fontFamily: fontFamily.bodyRegular, fontSize: 11, color: 'rgba(5,8,5,0.45)', marginTop: spacing.sm },
  used: { ...type.caption, color: colors.goldDark },
  link: { padding: spacing.md, alignItems: 'center' },
  linkText: { fontFamily: fontFamily.bodyBold, color: colors.terracotta },
});
