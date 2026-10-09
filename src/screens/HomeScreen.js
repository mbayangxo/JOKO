import { Animated, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useState } from 'react';
import { getUnreadNotifications } from '../lib/api-client';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import ScreenBackground from '../components/ScreenBackground';
import PressScale from '../components/PressScale';
import KoriAmount from '../components/KoriAmount';
import { useAppState } from '../state/AppState';
import { useScreenshotBlock } from '../hooks/useScreenshotBlock';
import { usePlatformFeatures } from '../lib/platform-features';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import { navigateFromRoot } from '../lib/root-navigation';
import { useFloatLoop, useBlink, useEntrance, useGlowPulse } from '../hooks/animations';

// Home is the money screen — nothing else. Real people live in Mboolo
// (first tab now); shopping lives in Marché; anything that needs a second
// look (spending breakdown, Natta, full history) lives one tap away in
// Wallet — not thrown in your face here.
const PRIMARY_ACTIONS = [
  { icon: '💸', label: 'Yónnee', gradient: ['#2dff7d', '#0fbc48'], glow: colors.green, route: 'SendMoney' },
  { icon: '📥', label: 'Jël', gradient: ['#ffe45c', '#e8920a'], glow: colors.flagGold, route: 'Receive' },
  { icon: '🏪', label: 'Fey', gradient: ['#ff8c52', '#c44010'], glow: colors.terracotta, route: 'PayMerchant' },
];

const SECONDARY_ACTIONS = [
  { icon: '🏧', label: 'Cash', gradient: ['#baf7d0', '#22d968'], glow: colors.green, route: 'Cash', feature: ['cash', 'available'] },
  { icon: '🏦', label: 'Natta', gradient: ['#fdf3cd', '#eeda96'], glow: colors.flagGold, route: 'Tontine', feature: ['wallet', 'tontine'] },
  { icon: '📷', label: 'Scan', gradient: ['#ffd4c4', '#e85c1a'], glow: colors.terracotta, route: 'QrScan' },
  { icon: '➕', label: 'Plus', gradient: ['#d4f5e2', '#1a9e52'], glow: colors.green, route: 'MoreActions' },
];

function ActionButton({ icon, label, gradient, glow, delay, onPress, compact }) {
  const float = useFloatLoop(delay);
  const handlePress = () => {
    if (typeof onPress === 'function') onPress();
  };
  return (
    <PressScale scaleTo={0.88} onPress={handlePress} style={[styles.haItem, compact && styles.haItemCompact]}>
      <View style={[styles.haBtn, compact && styles.haBtnCompact, { shadowColor: glow }]}>
        <LinearGradient colors={gradient} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
        <View style={styles.haSheen} />
        <Animated.View style={{ transform: [{ translateY: float }] }}>
          <Text style={[styles.haIcon, compact && styles.haIconCompact]}>{icon}</Text>
        </Animated.View>
      </View>
      <Text style={[styles.haLabel, compact && styles.haLabelCompact]} numberOfLines={1}>{label}</Text>
    </PressScale>
  );
}

export default function HomeScreen({ navigation }) {
  useScreenshotBlock(true);
  const open = (route, params) => navigateFromRoot(navigation, route, params);
  const { feature } = usePlatformFeatures();
  const notifBlink = useBlink();
  const balanceEntrance = useEntrance(0, 1000, 12);
  const balanceGlow = useGlowPulse(3400, 0.4);
  const walletPulse = useGlowPulse(2800, 1);
  const { profile, balance, refreshWallet } = useAppState();
  const firstName = profile.name.split(' ')[0];

  // J10: the bell only signals something real (unread, not muted) — no permanent attention dot.
  const [unread, setUnread] = useState(0);
  useFocusEffect(
    useCallback(() => {
      refreshWallet().catch(() => {});
      getUnreadNotifications().then((u) => setUnread(u?.total ?? 0)).catch(() => setUnread(0));
    }, [refreshWallet]),
  );

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.hero}>
          <View style={styles.heroTopRow}>
            <View>
              <Text style={styles.locationLabel}>📍 {profile.arrondissement.name} · Dakar</Text>
              <Text style={styles.greeting}>
                Salut <Text style={styles.greetingBold}>{firstName}</Text> 👋🏿
              </Text>
            </View>
            <PressScale scaleTo={0.9} onPress={() => open('Main', { screen: 'NotificationsTab' })} style={styles.notifBtn}>
              <Text style={{ fontSize: 16 }}>🔔</Text>
              {unread > 0 ? <Animated.View style={[styles.notifDot, { opacity: notifBlink }]} accessibilityLabel={`${unread} notification${unread > 1 ? 's' : ''} non lue${unread > 1 ? 's' : ''}`} /> : null}
            </PressScale>
          </View>

          <View style={styles.balanceDisplay}>
            <Animated.View style={[styles.balanceGlow, { opacity: balanceGlow }]}>
              <Svg width="100%" height="100%" viewBox="0 0 100 100">
                <Defs>
                  <RadialGradient id="balGlow" cx="50%" cy="50%" r="50%">
                    <Stop offset="0%" stopColor={colors.green} stopOpacity={0.5} />
                    <Stop offset="100%" stopColor={colors.green} stopOpacity={0} />
                  </RadialGradient>
                </Defs>
                <Rect width="100" height="100" fill="url(#balGlow)" />
              </Svg>
            </Animated.View>
            <Text style={styles.balanceEye}>👁 Solde</Text>
            <Animated.View style={balanceEntrance}>
              <KoriAmount value={balance} textStyle={styles.balanceAmount} style={{ justifyContent: 'center' }} />
            </Animated.View>
            <View style={styles.zeroFeesPill}>
              <Text style={styles.zeroFeesText}>✦ Zéro frais sur tous tes envois</Text>
            </View>
          </View>

          <View style={styles.homeActions}>
            {PRIMARY_ACTIONS.map((a, i) => (
              <ActionButton key={a.label} {...a} delay={i * 300} onPress={() => open(a.route)} />
            ))}
          </View>
          <View style={styles.homeActionsSecondary}>
            {SECONDARY_ACTIONS.filter((a) => !a.feature || feature(...a.feature)).map((a, i) => (
              <ActionButton
                key={a.label}
                {...a}
                compact
                delay={i * 300 + 900}
                onPress={() => open(a.route)}
              />
            ))}
          </View>

          <PressScale scaleTo={0.97} onPress={() => open('Wallet')} style={styles.walletCard}>
            <Animated.View style={[styles.walletIcon, { opacity: Animated.add(0.75, Animated.multiply(walletPulse, 0.25)) }]}>
              <Text style={{ fontSize: 22 }}>💼</Text>
            </Animated.View>
            <View style={{ flex: 1 }}>
              <Text style={styles.walletTitle}>Mon portefeuille</Text>
              <Text style={styles.walletSub}>Dépenses, Natta, historique — quand tu veux voir plus</Text>
            </View>
            <Text style={styles.walletArrow}>→</Text>
          </PressScale>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },

  hero: { flex: 1, paddingHorizontal: spacing.huge, paddingTop: spacing.giant },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.huge },
  locationLabel: { ...type.tiny, fontSize: 9, letterSpacing: 1, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', marginBottom: 3 },
  greeting: { fontFamily: fontFamily.displayBold, fontSize: 17, letterSpacing: -0.4, color: 'rgba(5,8,5,0.55)' },
  greetingBold: { color: colors.ink, fontFamily: fontFamily.displayBlack },
  notifBtn: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: 'rgba(5,8,5,0.05)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', alignItems: 'center', justifyContent: 'center' },
  notifDot: { position: 'absolute', top: 8, right: 9, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.orange, borderWidth: 1.5, borderColor: colors.appCanvas.base },

  balanceDisplay: { alignItems: 'center', marginBottom: spacing.giant, marginTop: spacing.giant },
  balanceGlow: {
    position: 'absolute', top: -20, width: 220, height: 100, borderRadius: 100,
    backgroundColor: colors.green, alignSelf: 'center',
  },
  balanceEye: { ...type.bodySmall, color: 'rgba(5,8,5,0.45)', marginBottom: spacing.sm },
  balanceAmount: { ...type.balanceAmount, color: colors.ink, textAlign: 'center', textShadowColor: 'rgba(26,240,96,0.3)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 18 },
  zeroFeesPill: { marginTop: spacing.md, alignSelf: 'center', backgroundColor: 'rgba(247,183,49,0.14)', borderWidth: 1, borderColor: 'rgba(232,146,10,0.3)', borderRadius: radius.round, paddingHorizontal: spacing.xl, paddingVertical: spacing.xs },
  zeroFeesText: { fontFamily: fontFamily.bodyBold, fontSize: 10, color: colors.goldDark },

  homeActions: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.xl, paddingHorizontal: spacing.md },
  homeActionsSecondary: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.giant, paddingHorizontal: spacing.md },
  haItem: { alignItems: 'center', gap: spacing.xs, flex: 1, maxWidth: 80, minHeight: 66 },
  haItemCompact: { maxWidth: 66, minHeight: 60 },
  haBtn: {
    width: 52, height: 52, borderRadius: 26, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
    shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 14, elevation: 7,
  },
  haBtnCompact: { width: 44, height: 44, borderRadius: 22 },
  haSheen: { position: 'absolute', top: 3, left: 12, right: 12, height: 10, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.28)' },
  haIcon: { fontSize: 21 },
  haIconCompact: { fontSize: 18 },
  haLabel: { ...type.actionLabel, color: 'rgba(5,8,5,0.65)', textAlign: 'center' },
  haLabelCompact: { fontSize: 9, lineHeight: 11 },

  walletCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    borderRadius: radius.xl,
    borderBottomRightRadius: 10,
    padding: spacing.lg,
  },
  walletIcon: {
    width: 44, height: 44, borderRadius: 14, borderBottomRightRadius: 8,
    backgroundColor: 'rgba(26,240,96,0.12)', alignItems: 'center', justifyContent: 'center',
  },
  walletTitle: { fontFamily: fontFamily.displayBold, fontSize: 13.5, color: colors.ink },
  walletSub: { fontSize: 10.5, color: 'rgba(5,8,5,0.5)', marginTop: 2 },
  walletArrow: { fontSize: 16, color: colors.greenDark },
});
