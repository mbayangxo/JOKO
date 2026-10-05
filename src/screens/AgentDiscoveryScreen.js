import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import GlowButton from '../components/GlowButton';
import { useAppState } from '../state/AppState';
import { coordsFromArrondissement } from '../lib/dakar-coords';
import { getAgentsNearby } from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

function openLabel(point) {
  if (point.openNow == null) return 'Horaires non communiqués';
  return point.openNow ? 'Ouvert (horaires déclarés)' : 'Fermé (horaires déclarés)';
}

/** J6.14: a public service point — no phone, no float, no live availability claim. */
function AgentCard({ agent: point, mode, onSelect }) {
  return (
    <PressScale scaleTo={0.98} onPress={() => onSelect(point)} style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.iconWrap}>
          <Text style={{ fontSize: 22 }}>🏪</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{point.name}</Text>
          <Text style={styles.loc}>{point.publicAddress}{point.area ? ` · ${point.area}` : ''}</Text>
        </View>
        {point.distanceLabel ? <Text style={styles.dist}>{point.distanceLabel}</Text> : null}
      </View>
      <Text style={styles.code}>
        {[point.services?.cashIn ? 'Dépôt' : null, point.services?.cashOut ? 'Retrait' : null, point.largeCashOut ? 'Gros retraits' : null].filter(Boolean).join(' · ')}
        {' · '}{openLabel(point)}
      </Text>
      <Text style={styles.hint}>
        {mode === 'withdraw' ? 'Appuie pour préparer ton retrait — tu confirmeras le point dans l’application' : 'Appuie pour préparer ton dépôt'}
      </Text>
    </PressScale>
  );
}

export default function AgentDiscoveryScreen({ navigation, route }) {
  const prefilledAmount = route.params?.amount;
  const mode = route.params?.mode === 'withdraw' ? 'withdraw' : 'deposit';
  const { profile } = useAppState();
  const coords = useMemo(
    () => coordsFromArrondissement(profile?.arrondissement?.key),
    [profile?.arrondissement?.key],
  );
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await getAgentsNearby({
        lat: coords.lat,
        lng: coords.lng,
        mode,
        amount: prefilledAmount,
      });
      setAgents(Array.isArray(data.servicePoints) ? data.servicePoints : []);
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, [coords.lat, coords.lng, mode, prefilledAmount]);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  const selectAgent = () => {
    if (mode === 'withdraw') {
      navigation.navigate('AgentWithdrawQr', { amount: prefilledAmount ?? 5000 });
      return;
    }
    navigation.navigate('AgentDepositQr', { amount: prefilledAmount ?? 5000 });
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title={mode === 'withdraw' ? 'Agents retrait' : 'Agents K21'} style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.hero}>
            {mode === 'withdraw' ? 'Retrait cash\nprès de toi.' : 'Points de dépôt\nprès de toi.'}
          </Text>
          <Text style={styles.sub}>
            {mode === 'withdraw'
              ? prefilledAmount > 500000
                ? 'Montant élevé — agents business K21 (BAG) uniquement.'
                : 'Choisis un point, montre ton code, confirme le point dans l’application, reçois le cash.'
              : 'Marchés, boutiques, kiosques — recharge en cash sans Orange ni Free. L\'agent scanne ton QR.'}
          </Text>

          {loading ? <ActivityIndicator color={colors.green} style={{ marginVertical: spacing.xl }} /> : null}
          {!loading && agents.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>Aucun point de service actif dans ta zone pour l'instant.</Text>
              <GlowButton
                label="Devenir agent K21"
                tone="gold"
                onPress={() => navigation.navigate('AgentApply')}
                style={{ marginTop: spacing.lg }}
              />
            </View>
          ) : null}

          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} mode={mode} onSelect={selectAgent} />
          ))}

          <PressScale scaleTo={0.97} onPress={() => navigation.navigate('AgentApply')} style={styles.link}>
            <Text style={styles.linkText}>+ Devenir agent / marchand partenaire</Text>
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
  hero: { fontFamily: fontFamily.displayBlack, fontSize: 30, color: colors.greenDark, lineHeight: 34, marginBottom: spacing.sm },
  sub: { ...type.body, color: 'rgba(5,8,5,0.65)', marginBottom: spacing.xl },
  card: {
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.sm,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(26,240,96,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontFamily: fontFamily.bodyBold, fontSize: 16, color: colors.ink },
  loc: { ...type.caption, marginTop: 2 },
  dist: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.terracotta },
  code: { fontFamily: fontFamily.bodySemiBold, fontSize: 11, color: colors.greenDark },
  hint: { ...type.caption, marginTop: 4, color: 'rgba(5,8,5,0.45)' },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { ...type.body, textAlign: 'center', color: 'rgba(5,8,5,0.55)' },
  link: { padding: spacing.lg, alignItems: 'center' },
  linkText: { fontFamily: fontFamily.bodyBold, color: colors.terracotta },
});
