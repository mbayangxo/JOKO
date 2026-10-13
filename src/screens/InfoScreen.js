import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenBackground from '../components/ScreenBackground';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import { colors, fontFamily, radius, spacing } from '../theme';

/** Static info / help pages — not a money flow, not a stub for broken APIs. */
export default function InfoScreen({ route, navigation }) {
  const {
    title = 'Information',
    subtitle = '',
    body = '',
    icon = 'ℹ️',
    showBack = true,
    actionLabel,
    onActionRoute,
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
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {body ? <Text style={styles.body}>{body}</Text> : null}
          {actionLabel && onActionRoute ? (
            <GlowButton label={actionLabel} onPress={() => navigation.navigate(onActionRoute)} style={{ marginTop: spacing.xl }} />
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.huge,
    marginTop: spacing.xl,
  },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.giant },
  iconDisc: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: 'rgba(26,240,96,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  icon: { fontSize: 34 },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 19, color: colors.ink, marginBottom: spacing.sm, textAlign: 'center' },
  subtitle: { fontSize: 12.5, color: 'rgba(5,8,5,0.55)', textAlign: 'center', lineHeight: 19 },
  body: { fontSize: 12, color: 'rgba(5,8,5,0.65)', textAlign: 'center', lineHeight: 18, marginTop: spacing.lg },
});
