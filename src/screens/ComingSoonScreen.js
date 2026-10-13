import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenBackground from '../components/ScreenBackground';
import PressScale from '../components/PressScale';
import { colors, fontFamily, radius, spacing } from '../theme';

// Placeholder for screens/tabs not yet built in this phase (or explicitly
// out of Phase 1 scope, e.g. K21 Charts, Défis, Ataya Rooms) — keeps every
// nav destination reachable instead of leaving a dead button.
export default function ComingSoonScreen({ route, navigation }) {
  const {
    title = 'Bientôt disponible',
    subtitle = 'Cet écran arrive dans une prochaine phase.',
    icon = '✦',
    showBack = true,
  } = route?.params ?? {};

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {showBack && (
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 14, color: colors.ink }}>←</Text>
          </PressScale>
        )}
        <View style={styles.content}>
          <View style={styles.iconDisc}>
            <Text style={styles.icon}>{icon}</Text>
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
          <View style={styles.flagStripe}>
            <View style={[styles.flagSeg, { backgroundColor: colors.green }]} />
            <View style={[styles.flagSeg, { backgroundColor: colors.flagGold }]} />
            <View style={[styles.flagSeg, { backgroundColor: colors.terracotta }]} />
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  backBtn: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', alignItems: 'center', justifyContent: 'center', marginLeft: spacing.huge, marginTop: spacing.xl },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.giant },
  iconDisc: {
    width: 84, height: 84, borderRadius: 42, backgroundColor: 'rgba(26,240,96,0.14)',
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xl,
  },
  icon: { fontSize: 34 },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 19, color: colors.ink, marginBottom: spacing.sm, textAlign: 'center' },
  subtitle: { fontSize: 12.5, color: 'rgba(5,8,5,0.55)', textAlign: 'center', lineHeight: 19 },
  flagStripe: { flexDirection: 'row', height: 3, borderRadius: 2, overflow: 'hidden', width: 56, marginTop: spacing.xl },
  flagSeg: { flex: 1 },
});
