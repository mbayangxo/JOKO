import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import LoadErrorState from '../components/LoadErrorState';
import ScreenBackground from '../components/ScreenBackground';
import FlagMicroStripe from '../components/FlagMicroStripe';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import { useLocale } from '../context/LocaleContext';
import { t } from '../i18n/translations';
import {
  getTrendingAlert,
  getTrendingAlertShareMessage,
  markTrendingAlertRead,
} from '../lib/api-client';
import { colors, fontFamily, radius, spacing } from '../theme';
import { useBlink, useEntrance, useFloatLoop } from '../hooks/animations';

const SEVERITY_TONE = {
  urgent: { gradient: [colors.terracottaLight, colors.terracotta, colors.terracottaDark], text: colors.white, sub: 'rgba(255,255,255,0.82)' },
  watch: { gradient: ['#ffe45c', colors.flagGold, colors.goldDark], text: colors.ink, sub: 'rgba(5,8,5,0.65)' },
  info: { gradient: ['#3dff87', colors.green, colors.greenDark], text: colors.ink, sub: 'rgba(5,8,5,0.65)' },
};

function formatWindow(validFrom, validUntil) {
  const fmt = (iso) =>
    new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  if (validFrom && validUntil) return `${fmt(validFrom)} → ${fmt(validUntil)}`;
  if (validFrom) return `Depuis ${fmt(validFrom)}`;
  return '';
}

function DetailSection({ label, children, delay }) {
  const entrance = useEntrance(delay, 480, 12);
  return (
    <Animated.View style={[styles.section, entrance]}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </Animated.View>
  );
}

function GuidanceBlock({ label, text, delay }) {
  const entrance = useEntrance(delay, 480, 12);
  return (
    <Animated.View style={[styles.guidanceCard, entrance]}>
      <Text style={styles.guidanceLabel}>{label}</Text>
      <Text style={styles.guidanceText}>{text}</Text>
    </Animated.View>
  );
}

function MetaBlock({ rows, delay }) {
  const entrance = useEntrance(delay, 480, 12);
  return (
    <Animated.View style={[styles.metaCard, entrance]}>
      {rows.map((row) => (
        <Text key={row.key} style={styles.metaRow}>
          <Text style={styles.metaKey}>{row.key} </Text>
          {row.value}
        </Text>
      ))}
    </Animated.View>
  );
}

export default function AlertDetailScreen({ navigation, route }) {
  const { langCode } = useLocale();
  const alertId = route.params?.alertId;
  const [alert, setAlert] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const float = useFloatLoop(0, 3, 2200);
  const blink = useBlink(850, 0.4);
  const headerEntrance = useEntrance(0, 520, 18);

  const load = useCallback(async () => {
    if (!alertId) return;
    setLoading(true);
    try {
      const data = await getTrendingAlert(alertId);
      setAlert(data);
      setLoadFailed(false);
      markTrendingAlertRead(alertId).catch(() => {});
    } catch {
      setAlert(null);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [alertId]);

  useEffect(() => {
    load();
  }, [load]);

  const share = async () => {
    if (!alertId) return;
    try {
      const { message } = await getTrendingAlertShareMessage(alertId);
      await Share.share({ message });
    } catch {
      /* cancelled */
    }
  };

  const openMboolo = () => {
    navigation.navigate('Main', { screen: 'MbooloTab' });
  };

  if (loading) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <ActivityIndicator color={colors.greenDark} style={{ marginTop: 80 }} />
      </View>
    );
  }

  if (!alert) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <SafeAreaView style={styles.safe}>
          <PressScale onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={styles.backText}>←</Text>
          </PressScale>
          {loadFailed ? (
            <LoadErrorState what="cette alerte" onRetry={load} />
          ) : (
            <Text style={styles.errorText}>{t(langCode, 'trendingAlertMissing')}</Text>
          )}
        </SafeAreaView>
      </View>
    );
  }

  const tone = SEVERITY_TONE[alert.severity] ?? SEVERITY_TONE.info;

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Animated.View style={[styles.topBar, headerEntrance]}>
          <PressScale onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={styles.backText}>←</Text>
          </PressScale>
          <Text style={styles.topTitle}>{t(langCode, 'trendingAlertDetail')}</Text>
          <View style={{ width: 40 }} />
        </Animated.View>

        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <Animated.View style={{ transform: [{ translateY: float }] }}>
            <LinearGradient colors={tone.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
              <View style={styles.heroRow}>
                <Animated.View style={[styles.liveDot, { opacity: blink }]} />
                <Text style={[styles.heroSeverity, { color: tone.text }]}>
                  {alert.severity === 'urgent' ? 'URGENT' : alert.severity === 'watch' ? 'VIGILANCE' : 'INFO'}
                </Text>
              </View>
              <Text style={[styles.heroTitle, { color: tone.text }]}>{alert.title}</Text>
              <Text style={[styles.heroRegion, { color: tone.sub }]}>{alert.regionLabel}</Text>
              <FlagMicroStripe width={52} style={{ marginTop: spacing.lg }} />
            </LinearGradient>
          </Animated.View>

          <DetailSection label={t(langCode, 'trendingAlertBody')} delay={120}>
            <Text style={styles.bodyText}>{alert.body}</Text>
          </DetailSection>

          {alert.guidance ? (
            <GuidanceBlock label={t(langCode, 'trendingAlertGuidance')} text={alert.guidance} delay={200} />
          ) : null}

          <MetaBlock
            delay={280}
            rows={[
              { key: t(langCode, 'trendingAlertSource'), value: alert.source },
              { key: t(langCode, 'trendingAlertWindow'), value: formatWindow(alert.validFrom, alert.validUntil) },
            ]}
          />

          <View style={styles.actions}>
            <GlowButton label={t(langCode, 'trendingShareSquad')} tone="orange" onPress={share} />
            <GlowButton label={t(langCode, 'trendingOpenMboolo')} tone="green" onPress={openMboolo} style={{ marginTop: spacing.lg }} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const CUT = { borderRadius: radius.xxxl, borderBottomRightRadius: 11 };

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  safe: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.huge, paddingVertical: spacing.md },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    borderBottomRightRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { fontSize: 18, color: colors.ink },
  topTitle: { fontFamily: fontFamily.displayBlack, fontSize: 13, color: colors.ink },
  body: { paddingHorizontal: spacing.huge, paddingBottom: 100 },
  hero: { ...CUT, padding: spacing.giant, marginBottom: spacing.lg, overflow: 'hidden' },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.white },
  heroSeverity: { fontFamily: fontFamily.bodyBold, fontSize: 9, letterSpacing: 1.5 },
  heroTitle: { fontFamily: fontFamily.displayBlack, fontSize: 22, lineHeight: 26, marginTop: spacing.lg, letterSpacing: -0.5 },
  heroRegion: { fontFamily: fontFamily.bodySemiBold, fontSize: 12, marginTop: spacing.sm },
  section: { marginBottom: spacing.lg },
  sectionLabel: { fontFamily: fontFamily.bodyBold, fontSize: 9, letterSpacing: 1.5, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', marginBottom: spacing.sm },
  bodyText: { fontFamily: fontFamily.bodyRegular, fontSize: 14, lineHeight: 21, color: colors.ink },
  guidanceCard: {
    backgroundColor: colors.goldA10,
    borderWidth: 1,
    borderColor: 'rgba(247,183,49,0.25)',
    ...CUT,
    padding: spacing.xxl,
    marginBottom: spacing.lg,
  },
  guidanceLabel: { fontFamily: fontFamily.bodyBold, fontSize: 9, letterSpacing: 1.5, color: colors.goldDark, textTransform: 'uppercase', marginBottom: spacing.sm },
  guidanceText: { fontFamily: fontFamily.bodySemiBold, fontSize: 13, lineHeight: 19, color: colors.ink },
  metaCard: {
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.07)',
    ...CUT,
    padding: spacing.xxl,
    marginBottom: spacing.xxxl,
    gap: spacing.sm,
  },
  metaRow: { fontFamily: fontFamily.bodyRegular, fontSize: 11.5, color: colors.ink, lineHeight: 17 },
  metaKey: { fontFamily: fontFamily.bodyBold, color: 'rgba(5,8,5,0.55)' },
  actions: { marginTop: spacing.sm },
  errorText: { fontFamily: fontFamily.bodyMedium, fontSize: 13, color: 'rgba(5,8,5,0.55)', textAlign: 'center', marginTop: 40 },
});
