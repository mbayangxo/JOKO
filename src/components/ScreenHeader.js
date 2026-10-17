import { StyleSheet, Text, View } from 'react-native';
import PressScale from './PressScale';
import { colors, fontFamily, radius, spacing, type } from '../theme';

// Shared back-button + title row reused at the top of every money flow
// (Send, Pay Merchant, Cash, Receive, Tontine) — was reimplemented with
// slightly different sizes per screen; this is the one source of truth.
export default function ScreenHeader({ onBack, title, eyebrow, style, titleStyle, backBg }) {
  return (
    <View style={[styles.row, style]}>
      <PressScale scaleTo={0.9} onPress={onBack} style={[styles.backBtn, backBg && { backgroundColor: backBg }]} accessibilityRole="button" accessibilityLabel="Retour">
        <Text style={styles.backIcon}>←</Text>
      </PressScale>
      {(title || eyebrow) && (
        <View style={{ flex: 1 }}>
          {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
          {title ? <Text style={[styles.title, titleStyle]}>{title}</Text> : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl },
  backBtn: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', alignItems: 'center', justifyContent: 'center' },
  backIcon: { fontSize: 14, color: colors.ink },
  eyebrow: { ...type.eyebrow, color: colors.greenDark, marginBottom: 2 },
  title: { fontFamily: fontFamily.displayBold, fontSize: 14, color: colors.ink },
});
