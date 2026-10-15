import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { listPartnerDebits } from '../lib/api-client';
import { KIND_LABEL, STATUS_LABEL, countdownLabel, formatKori, secondsLeft } from '../lib/partner-debit-view';
import { colors, fontFamily, radius, spacing } from '../theme';

/** J15-D2 — partner debit requests of one business: pending ones first (with their 15-minute countdown), then history. */
export default function PartnerDebitsScreen({ navigation, route }) {
  const { businessId } = route.params ?? {};
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    try {
      setRows((await listPartnerDebits(businessId)).instructions ?? []);
      setError(null);
    } catch (e) {
      setError(e.status === 403 && e.code === 'disabled' ? 'Les demandes de paiement des partenaires ne sont pas activées.' : e.status === 404 ? 'Réservé aux responsables financiers du commerce.' : e.message ?? 'Chargement impossible');
    }
  }, [businessId]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const pending = (rows ?? []).filter((r) => r.status === 'requested');
  const past = (rows ?? []).filter((r) => r.status !== 'requested');
  const item = (r) => {
    const sec = r.status === 'requested' ? secondsLeft({ expiresAt: r.expiresAt }, now) : 0;
    return (
      <PressScale key={r.id} onPress={() => navigation.navigate('PartnerDebitDetail', { businessId, id: r.id })} style={[st.card, r.status === 'requested' && st.pending]} accessibilityRole="button"
        accessibilityLabel={`${KIND_LABEL[r.kind] ?? r.kind} de ${r.partner}, ${formatKori(r.totalKori)}, ${r.lineCount} bénéficiaires, ${STATUS_LABEL[r.status]}${r.status === 'requested' ? `, ${countdownLabel(sec)}` : ''}`} testID={`pd-row-${r.id}`}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={st.title}>{KIND_LABEL[r.kind] ?? r.kind} · {r.partner}</Text>
          <Text style={st.small}>{r.lineCount} bénéficiaire{r.lineCount > 1 ? 's' : ''} · {STATUS_LABEL[r.status] ?? r.status}</Text>
          {r.status === 'requested' ? <Text style={[st.small, sec < 120 && st.warn]}>{countdownLabel(sec)}</Text> : null}
        </View>
        <Text style={st.amount}>{formatKori(r.totalKori)}</Text>
      </PressScale>
    );
  };
  return (
    <View style={st.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Demandes des partenaires" />
        <ScrollView contentContainerStyle={st.pad}>
          {error ? <Text style={st.body} accessibilityRole="alert">{error}</Text> : null}
          {!rows && !error ? <ActivityIndicator accessibilityLabel="Chargement" /> : null}
          {rows ? (
            <>
              <Text style={st.eyebrow}>À approuver ({pending.length})</Text>
              {pending.length ? pending.map(item) : <Text style={st.body}>Aucune demande en attente. Un partenaire ne peut jamais débiter le commerce sans ton approbation.</Text>}
              {past.length ? <Text style={st.eyebrow}>Historique</Text> : null}
              {past.map(item)}
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  pad: { padding: spacing.xxxl, gap: spacing.xl, paddingBottom: 48 },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.whiteA06, borderRadius: radius.xl, padding: spacing.xxxl, minHeight: 64, borderWidth: 1, borderColor: colors.whiteA10 },
  pending: { borderColor: colors.gold },
  eyebrow: { fontFamily: fontFamily.bodyBold, fontSize: 12, letterSpacing: 1, color: colors.whiteA55, textTransform: 'uppercase' },
  title: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.white },
  body: { fontFamily: fontFamily.bodyRegular, fontSize: 15, color: colors.whiteA85, lineHeight: 21 },
  small: { fontFamily: fontFamily.bodyMedium, fontSize: 13, color: colors.whiteA55 },
  warn: { color: colors.gold },
  amount: { fontFamily: fontFamily.displayBlack, fontSize: 17, color: colors.white },
});
