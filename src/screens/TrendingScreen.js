import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import LoadErrorState from '../components/LoadErrorState';
import ScreenBackground from '../components/ScreenBackground';
import FlagMicroStripe from '../components/FlagMicroStripe';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import { useLocale } from '../context/LocaleContext';
import { t } from '../i18n/translations';
import { getTrendingFeed, getTrendingAlertShareMessage } from '../lib/api-client';
import { colors, fontFamily, radius, spacing } from '../theme';
import { useBlink, useEntrance, useRipple, useScalePulse } from '../hooks/animations';

const TABS = ['all', 'alerts', 'news', 'causes'];

const SEVERITY_TONE = {
  urgent: {
    gradient: [colors.terracottaLight, colors.terracotta, colors.terracottaDark],
    labelColor: colors.white,
    textColor: colors.white,
    metaColor: 'rgba(255,255,255,0.82)',
    badge: colors.white,
    badgeText: colors.terracottaDark,
  },
  watch: {
    gradient: ['#ffe45c', colors.flagGold, colors.goldDark],
    labelColor: colors.ink,
    textColor: colors.ink,
    metaColor: 'rgba(5,8,5,0.65)',
    badge: colors.ink,
    badgeText: colors.flagGold,
  },
  info: {
    gradient: ['#3dff87', colors.green, colors.greenDark],
    labelColor: colors.ink,
    textColor: colors.ink,
    metaColor: 'rgba(5,8,5,0.65)',
    badge: colors.greenDark,
    badgeText: colors.white,
  },
};

const ALERT_TYPE_LABEL = {
  flood: 'Inondation',
  drought: 'Sécheresse',
  climate: 'Climat',
  storm: 'Tempête',
};

function TabPill({ label, active, onPress, delay }) {
  const entrance = useEntrance(delay, 400, 10);
  return (
    <Animated.View style={entrance}>
      <PressScale onPress={onPress} style={[styles.pill, active && styles.pillOn]}>
        <Text style={[styles.pillText, active && styles.pillTextOn]}>{label}</Text>
      </PressScale>
    </Animated.View>
  );
}

function AlertHeroCard({ alert, delay, onPress, onShare }) {
  const tone = SEVERITY_TONE[alert.severity] ?? SEVERITY_TONE.info;
  const entrance = useEntrance(delay, 550, 16);
  const blink = useBlink(900, 0.35);
  const ripple = useRipple(2400, 1.12);

  return (
    <Animated.View style={[styles.heroWrap, entrance]}>
      <PressScale onPress={onPress} scaleTo={0.98} style={styles.heroPress}>
        <LinearGradient colors={tone.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.heroCard}>
          {!alert.read && (
            <Animated.View style={[styles.liveRipple, { opacity: ripple.opacity, transform: [{ scale: ripple.scale }] }]} />
          )}
          <View style={styles.heroTop}>
            <View style={[styles.typeBadge, { backgroundColor: tone.badge }]}>
              <Text style={[styles.typeBadgeText, { color: tone.badgeText }]}>
                {ALERT_TYPE_LABEL[alert.alertType] ?? 'Alerte'}
              </Text>
            </View>
            <Animated.View style={[styles.liveDot, { opacity: blink }]} />
            <Text style={[styles.severityLabel, { color: tone.labelColor }]}>
              {alert.severity === 'urgent' ? 'URGENT' : alert.severity === 'watch' ? 'VIGILANCE' : 'INFO'}
            </Text>
          </View>
          <Text style={[styles.heroTitle, { color: tone.textColor }]}>{alert.title}</Text>
          <Text style={[styles.heroMeta, { color: tone.metaColor }]} numberOfLines={2}>
            {alert.body}
          </Text>
          <View style={styles.heroFoot}>
            <Text style={[styles.heroRegion, { color: tone.metaColor }]}>{alert.regionLabel}</Text>
            <Text style={[styles.heroTime, { color: tone.metaColor }]}>{alert.timeLabel}</Text>
          </View>
          <View style={styles.heroActions}>
            <PressScale onPress={onPress} style={[styles.heroBtn, { backgroundColor: 'rgba(255,255,255,0.22)' }]}>
              <Text style={[styles.heroBtnText, { color: tone.textColor }]}>Détails</Text>
            </PressScale>
            <PressScale onPress={onShare} style={[styles.heroBtn, { backgroundColor: 'rgba(5,8,5,0.12)' }]}>
              <Text style={[styles.heroBtnText, { color: tone.textColor }]}>Partager</Text>
            </PressScale>
          </View>
        </LinearGradient>
      </PressScale>
    </Animated.View>
  );
}

function AlertRow({ alert, delay, onPress }) {
  const tone = SEVERITY_TONE[alert.severity] ?? SEVERITY_TONE.info;
  const entrance = useEntrance(delay, 420, 10);
  const pulse = useScalePulse(alert.severity === 'urgent' ? 1800 : 60000, 1.02);

  return (
    <Animated.View style={entrance}>
      <PressScale onPress={onPress} style={styles.rowCard}>
        <Animated.View style={[styles.rowAccent, { backgroundColor: tone.gradient[1] }, alert.severity === 'urgent' && { transform: [{ scale: pulse }] }]} />
        <View style={styles.rowBody}>
          <Text style={styles.rowEyebrow}>{ALERT_TYPE_LABEL[alert.alertType] ?? 'Alerte'} · {alert.regionLabel}</Text>
          <Text style={styles.rowTitle} numberOfLines={2}>{alert.title}</Text>
          <Text style={styles.rowMeta}>{alert.timeLabel} · {alert.source}</Text>
        </View>
        {!alert.read && <View style={styles.unreadDot} />}
      </PressScale>
    </Animated.View>
  );
}

function ArticleRow({ article, delay, rank }) {
  const entrance = useEntrance(delay, 420, 10);
  const isCause = article.category === 'cause';
  const pct = article.signatureTarget
    ? Math.min(100, Math.round((article.signatureCount / article.signatureTarget) * 100))
    : null;

  return (
    <Animated.View style={entrance}>
      <PressScale style={styles.rowCard}>
        <View style={[styles.rankBox, isCause ? styles.rankCause : styles.rankNews]}>
          <Text style={styles.rankNum}>{rank ?? '·'}</Text>
        </View>
        <View style={styles.rowBody}>
          <Text style={styles.rowEyebrow}>{article.source} · {article.timeLabel}</Text>
          <Text style={styles.rowTitle} numberOfLines={2}>{article.title}</Text>
          <Text style={styles.rowMeta} numberOfLines={2}>{article.excerpt}</Text>
          {isCause && pct != null && (
            <View style={styles.causeBarTrack}>
              <View style={[styles.causeBarFill, { width: `${pct}%` }]} />
              <Text style={styles.causeBarText}>
                {article.signatureCount.toLocaleString('fr-FR')} / {article.signatureTarget.toLocaleString('fr-FR')}
              </Text>
            </View>
          )}
        </View>
      </PressScale>
    </Animated.View>
  );
}

function EmptyZone({ message, delay }) {
  const entrance = useEntrance(delay, 450, 12);
  const float = useScalePulse(4400, 1.03);
  return (
    <Animated.View style={[styles.emptyCard, entrance, { transform: [{ scale: float }] }]}>
      <Text style={styles.emptyTitle}>RAS dans ta zone</Text>
      <Text style={styles.emptyBody}>{message}</Text>
      <FlagMicroStripe width={48} style={{ marginTop: spacing.lg }} />
    </Animated.View>
  );
}

export default function TrendingScreen({ navigation, route }) {
  const { langCode, region, country } = useLocale();
  const initialTab = route.params?.initialTab ?? 'all';
  const [tab, setTab] = useState(initialTab);
  const [query, setQuery] = useState('');
  const [feed, setFeed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const titleEntrance = useEntrance(0, 500, 14);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getTrendingFeed(tab, query);
      setFeed(data);
      setLoadFailed(false);
    } catch {
      setFeed(null);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [tab, query]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (route.params?.initialTab) setTab(route.params.initialTab);
  }, [route.params?.initialTab]);

  const openAlert = (alertId) => {
    navigation.navigate('AlertDetail', { alertId });
  };

  const shareAlert = async (alertId) => {
    try {
      const { message } = await getTrendingAlertShareMessage(alertId);
      await Share.share({ message });
    } catch {
      /* user cancelled */
    }
  };

  const regionLabel = feed?.region?.regionName ?? region?.name ?? country?.name ?? 'Sénégal';
  const tabLabel = (key) => t(langCode, `trendingTab_${key}`);

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <Animated.View style={[styles.header, titleEntrance]}>
          <Text style={styles.eyebrow}>{t(langCode, 'trendingEyebrow')}</Text>
          <Text style={styles.titleLine1}>{t(langCode, 'trendingTitle1')}</Text>
          <Text style={styles.titleLine2}>{t(langCode, 'trendingTitle2')}</Text>
          <FlagMicroStripe style={{ marginTop: spacing.md, marginBottom: spacing.sm }} />
          <Text style={styles.regionLine}>{regionLabel} · {country?.name ?? 'Sénégal'}</Text>
        </Animated.View>

        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            placeholder={t(langCode, 'trendingSearch')}
            placeholderTextColor="rgba(5,8,5,0.4)"
            value={query}
            onChangeText={setQuery}
          />
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillsRow}>
          {TABS.map((key, i) => (
            <TabPill key={key} label={tabLabel(key)} active={tab === key} onPress={() => setTab(key)} delay={80 + i * 50} />
          ))}
        </ScrollView>

        {loading && !feed ? (
          <ActivityIndicator color={colors.greenDark} style={{ marginTop: spacing.giant }} />
        ) : loadFailed && !feed ? (
          <LoadErrorState what="le fil d’actualité" onRetry={load} />
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollBody} showsVerticalScrollIndicator={false}>
            {feed?.featuredAlert && tab !== 'news' && tab !== 'causes' && (
              <AlertHeroCard
                alert={feed.featuredAlert}
                delay={120}
                onPress={() => openAlert(feed.featuredAlert.id)}
                onShare={() => shareAlert(feed.featuredAlert.id)}
              />
            )}

            {feed?.message && tab !== 'news' && tab !== 'causes' && (
              <Text style={styles.statusNote}>{feed.message}</Text>
            )}

            {(tab === 'all' || tab === 'alerts') &&
              (feed?.alerts?.length ? (
                feed.alerts.map((a, i) => (
                  <AlertRow key={a.id} alert={a} delay={180 + i * 55} onPress={() => openAlert(a.id)} />
                ))
              ) : (
                <EmptyZone message={t(langCode, 'trendingNoAlerts')} delay={200} />
              ))}

            {(tab === 'all' || tab === 'news') &&
              feed?.articles
                ?.filter((a) => a.category === 'news')
                .map((a, i) => <ArticleRow key={a.id} article={a} rank={i + 1} delay={220 + i * 50} />)}

            {(tab === 'all' || tab === 'causes') &&
              feed?.articles
                ?.filter((a) => a.category === 'cause')
                .map((a, i) => <ArticleRow key={a.id} article={a} rank={i + 1} delay={260 + i * 50} />)}

            <View style={styles.explorerBlock}>
              <Text style={styles.explorerLabel}>{t(langCode, 'trendingExplorerLabel')}</Text>
              <Text style={styles.explorerSub}>{t(langCode, 'trendingExplorerSub')}</Text>
              <GlowButton
                label={t(langCode, 'trendingExplorerBtn')}
                tone="gold"
                onPress={() => navigation.navigate('Discover', { initialTab: 'Eat' })}
                style={{ marginTop: spacing.lg }}
              />
            </View>

            <Text style={styles.disclaimer}>{t(langCode, 'trendingDisclaimer')}</Text>
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}

const CUT = { borderRadius: radius.xxxl, borderBottomRightRadius: 11 };

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { paddingHorizontal: spacing.huge, paddingTop: spacing.xl },
  eyebrow: { fontFamily: fontFamily.bodyBold, fontSize: 9, letterSpacing: 2, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase' },
  titleLine1: { fontFamily: fontFamily.displayBlack, fontSize: 28, letterSpacing: -1, color: colors.ink, lineHeight: 30, marginTop: 4 },
  titleLine2: { fontFamily: fontFamily.displayBlack, fontSize: 28, letterSpacing: -1, color: colors.greenDark, lineHeight: 30, marginLeft: 18 },
  regionLine: { fontFamily: fontFamily.bodySemiBold, fontSize: 11, color: 'rgba(5,8,5,0.5)' },
  searchRow: { paddingHorizontal: spacing.huge, marginTop: spacing.lg, marginBottom: spacing.md },
  searchInput: {
    height: 40,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderWidth: 1.5,
    borderColor: 'rgba(5,8,5,0.09)',
    ...CUT,
    paddingHorizontal: spacing.xl,
    fontFamily: fontFamily.bodyMedium,
    fontSize: 12,
    color: colors.ink,
  },
  pillsRow: { gap: 8, paddingHorizontal: spacing.huge, paddingBottom: spacing.lg },
  pill: {
    height: 34,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.round,
    backgroundColor: 'rgba(255,255,255,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillOn: { backgroundColor: colors.ink },
  pillText: { fontFamily: fontFamily.bodyBold, fontSize: 10.5, color: 'rgba(5,8,5,0.55)' },
  pillTextOn: { color: colors.green },
  scrollBody: { paddingHorizontal: spacing.huge, paddingBottom: 100, gap: spacing.md },
  heroWrap: { marginBottom: spacing.sm },
  heroPress: { ...CUT, overflow: 'hidden' },
  heroCard: { padding: spacing.xxl, minHeight: 168, overflow: 'hidden' },
  liveRipple: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  typeBadge: { borderRadius: radius.round, paddingHorizontal: spacing.md, paddingVertical: 3 },
  typeBadgeText: { fontFamily: fontFamily.bodyBold, fontSize: 8, letterSpacing: 0.5, textTransform: 'uppercase' },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.white },
  severityLabel: { fontFamily: fontFamily.bodyBold, fontSize: 8, letterSpacing: 1.5, marginLeft: 'auto' },
  heroTitle: { fontFamily: fontFamily.displayBlack, fontSize: 17, lineHeight: 21, marginBottom: spacing.sm },
  heroMeta: { fontFamily: fontFamily.bodyRegular, fontSize: 11.5, lineHeight: 16 },
  heroFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.lg },
  heroRegion: { fontFamily: fontFamily.bodyBold, fontSize: 10 },
  heroTime: { fontFamily: fontFamily.bodyMedium, fontSize: 10 },
  heroActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  heroBtn: { flex: 1, height: 36, borderRadius: radius.lg, borderBottomRightRadius: 9, alignItems: 'center', justifyContent: 'center' },
  heroBtnText: { fontFamily: fontFamily.bodyBold, fontSize: 10.5 },
  statusNote: { fontFamily: fontFamily.bodyMedium, fontSize: 11, color: 'rgba(5,8,5,0.5)', marginBottom: spacing.sm },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: 'rgba(255,255,255,0.68)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    ...CUT,
    overflow: 'hidden',
  },
  rowAccent: { width: 4 },
  rowBody: { flex: 1, padding: spacing.xl },
  rowEyebrow: { fontFamily: fontFamily.bodyBold, fontSize: 9, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', letterSpacing: 0.5 },
  rowTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink, marginTop: 3, lineHeight: 17 },
  rowMeta: { fontFamily: fontFamily.bodyRegular, fontSize: 10.5, color: 'rgba(5,8,5,0.52)', marginTop: 4, lineHeight: 14 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.terracotta, alignSelf: 'center', marginRight: spacing.lg },
  rankBox: {
    width: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomRightRadius: 11,
  },
  rankNews: { backgroundColor: colors.greenA12 },
  rankCause: { backgroundColor: colors.goldA10 },
  rankNum: { fontFamily: fontFamily.displayBlack, fontSize: 14, color: colors.greenDark },
  causeBarTrack: {
    height: 18,
    backgroundColor: 'rgba(5,8,5,0.06)',
    borderRadius: radius.round,
    marginTop: spacing.md,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  causeBarFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.flagGold },
  causeBarText: { fontFamily: fontFamily.bodyBold, fontSize: 8.5, color: colors.ink, textAlign: 'center' },
  emptyCard: {
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.07)',
    ...CUT,
    padding: spacing.giant,
    alignItems: 'flex-start',
  },
  emptyTitle: { fontFamily: fontFamily.displayBlack, fontSize: 15, color: colors.ink },
  emptyBody: { fontFamily: fontFamily.bodyRegular, fontSize: 11.5, color: 'rgba(5,8,5,0.55)', marginTop: spacing.sm, lineHeight: 16 },
  explorerBlock: {
    marginTop: spacing.xxxl,
    padding: spacing.xxl,
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.07)',
    ...CUT,
  },
  explorerLabel: { fontFamily: fontFamily.bodyBold, fontSize: 9, letterSpacing: 1.5, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase' },
  explorerSub: { fontFamily: fontFamily.bodyRegular, fontSize: 11.5, color: 'rgba(5,8,5,0.55)', marginTop: spacing.sm, lineHeight: 16 },
  disclaimer: {
    fontFamily: fontFamily.bodyRegular,
    fontSize: 10.5,
    lineHeight: 15,
    color: 'rgba(5,8,5,0.45)',
    marginTop: spacing.xxxl,
    paddingBottom: spacing.lg,
  },
});
