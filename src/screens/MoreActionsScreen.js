import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import { usePlatformFeatures } from '../lib/platform-features';
import { colors, fontFamily, radius, spacing, type } from '../theme';

// "Payer & Services" — the WeChat-style hub: every K21 service in one
// organized place, grouped Money / Daily life / Community. Each tile is a
// real, working route — no placeholders.
const SECTIONS = [
  {
    key: 'money',
    label: 'Argent',
    tiles: [
      { key: 'send', icon: '💸', title: 'Yónnee', route: 'SendMoney', tint: 'rgba(26,240,96,0.14)' },
      { key: 'receive', icon: '📥', title: 'Jël', route: 'Receive', tint: 'rgba(250,216,54,0.18)' },
      { key: 'pay', icon: '🏪', title: 'Fey', route: 'PayMerchant', tint: 'rgba(232,92,26,0.14)' },
      { key: 'cash', icon: '🏧', title: 'Cash', route: 'Cash', feature: ['cash', 'available'], tint: 'rgba(26,240,96,0.14)' },
      { key: 'tontine', icon: '🏦', title: 'Natta', route: 'Tontine', tint: 'rgba(250,216,54,0.18)' },
      // J13-F4: the scheduler cron runs recurring payments, but users had no way to see or pause them.
      { key: 'scheduled', icon: '🗓️', title: 'Paiements programmés', route: 'ScheduledPayments', tint: 'rgba(26,240,96,0.14)' },
      { key: 'scan', icon: '📷', title: 'Scanner', route: 'QrScan', tint: 'rgba(232,92,26,0.14)' },
      { key: 'myqr', icon: '📲', title: 'Mon QR', route: 'MyQr', tint: 'rgba(26,240,96,0.14)' },
      { key: 'business', icon: '🏪', title: 'Mon business', route: 'BusinessMain', tint: 'rgba(250,216,54,0.18)' },
    ],
  },
  {
    key: 'daily',
    label: 'Au quotidien',
    tiles: [
      { key: 'movement', icon: '🛵', title: 'Mouvement', route: 'Movement', tint: 'rgba(26,240,96,0.14)' },
      { key: 'nulekk', icon: '🍖', title: 'Ñu Lekk', route: 'NuLekk', soon: 'nuLekk', tint: 'rgba(232,92,26,0.14)' },
      { key: 'deals', icon: '⚡', title: 'Offres flash', marketplace: 'Discover', tab: 'Eat', tint: 'rgba(250,216,54,0.18)' },
      { key: 'events', icon: '🎟️', title: 'Mes billets', route: 'MyTickets', feature: ['marketplace', 'tickets'], tint: 'rgba(232,92,26,0.14)' },
    ],
  },
  {
    key: 'community',
    label: 'Communauté',
    tiles: [
      { key: 'friends', icon: '🧑‍🤝‍🧑', title: 'Contacts', route: 'Friends', tint: 'rgba(26,240,96,0.14)' },
      { key: 'channels', icon: '📣', title: 'Chaînes', route: 'Channels', tint: 'rgba(250,216,54,0.18)' },
      // J13-F3: Jëkkal (direct gifts, P-J11-9) had no entry point at all.
      { key: 'jekkal', icon: '🤝', title: 'Jëkkal', route: 'Jekkal', tint: 'rgba(232,92,26,0.14)' },
      { key: 'charts', icon: '🎶', title: 'Wey yu 221 bëgg', route: 'Charts', tint: 'rgba(250,216,54,0.18)' },
    ],
  },
];

export default function MoreActionsScreen({ navigation }) {
  const { feature, comingSoon } = usePlatformFeatures();

  const openTile = (tile) => {
    if (tile.soon && comingSoon(tile.soon)) {
      navigation.navigate('Info', { title: tile.title, icon: tile.icon });
      return;
    }
    if (tile.marketplace) {
      navigation.navigate('Main', {
        screen: 'MarketplaceTab',
        params: { screen: tile.marketplace, params: { initialTab: tile.tab } },
      });
      return;
    }
    if (tile.feature && !feature(...tile.feature)) return;
    navigation.navigate(tile.route);
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 14, color: colors.ink }}>←</Text>
          </PressScale>
          <View>
            <Text style={styles.eyebrow}>K21</Text>
            <Text style={styles.title}>Payer & Services</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          {SECTIONS.map((section) => (
            <View key={section.key} style={styles.section}>
              <Text style={styles.sectionLabel}>{section.label}</Text>
              <View style={styles.grid}>
                {section.tiles.map((tile) => {
                  const soon = tile.soon ? comingSoon(tile.soon) : false;
                  const locked = tile.feature ? !feature(...tile.feature) && !soon : soon;
                  return (
                    <PressScale
                      key={tile.key}
                      scaleTo={locked ? 1 : 0.94}
                      onPress={locked ? undefined : () => openTile(tile)}
                      style={[styles.tile, locked && styles.tileLocked]}
                    >
                      <View style={[styles.tileIcon, { backgroundColor: locked ? 'rgba(5,8,5,0.06)' : tile.tint }]}>
                        <Text style={{ fontSize: 24, opacity: locked ? 0.45 : 1 }}>{tile.icon}</Text>
                      </View>
                      <Text style={[styles.tileTitle, locked && styles.tileTitleLocked]} numberOfLines={1}>
                        {tile.title}
                      </Text>
                      {soon ? <Text style={styles.soonHint}>Bientôt</Text> : null}
                    </PressScale>
                  );
                })}
              </View>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl, paddingHorizontal: spacing.huge, paddingTop: spacing.xxl, paddingBottom: spacing.xl },
  backBtn: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', alignItems: 'center', justifyContent: 'center' },
  eyebrow: { ...type.eyebrow, color: colors.greenDark },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 16, color: colors.ink },

  body: { paddingHorizontal: spacing.huge, paddingBottom: spacing.giant, gap: spacing.xxl },
  section: {},
  sectionLabel: { ...type.eyebrow, color: 'rgba(5,8,5,0.45)', marginBottom: spacing.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: {
    width: '22.7%',
    aspectRatio: 0.86,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    borderRadius: radius.xl,
    borderBottomRightRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: 2,
  },
  tileLocked: { opacity: 0.72 },
  tileIcon: { width: 44, height: 44, borderRadius: 14, borderBottomRightRadius: 8, alignItems: 'center', justifyContent: 'center' },
  tileTitle: { fontFamily: fontFamily.bodyBold, fontSize: 9.5, color: 'rgba(5,8,5,0.75)', textAlign: 'center' },
  tileTitleLocked: { color: 'rgba(5,8,5,0.45)' },
  soonHint: { fontSize: 7, fontFamily: fontFamily.bodyBold, color: colors.goldDark },
});
