import { StyleSheet, Text, View } from 'react-native';
import { colors, fontFamily, radius, spacing } from '../theme';

/**
 * J12 — shows the authoritative status of a money attempt whose outcome was unknown (lost response,
 * restart, weak network). It never says "effectué" unless the server confirmed it (phase.state === 'done').
 */
const TONE = { checking: 'pending', accepted_pending: 'pending', done: 'ok', failed_safe: 'muted', safe_to_retry: 'muted', blocked: 'muted' };

export default function MoneyPhaseBanner({ phase }) {
  // Only for attempts that went through a check (unknown outcome); normal results keep their own UI.
  if (!phase || !(phase.state === 'checking' || phase.resumed || phase.afterCheck)) return null;
  const tone = TONE[phase.state] ?? 'muted';
  const text =
    phase.message ??
    (phase.state === 'checking' ? 'Vérification du paiement en cours… Ne le renouvelle pas.' : 'Consulte ton historique.');
  return (
    <View style={[styles.wrap, styles[tone]]} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="money-phase-banner">
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: spacing.lg, marginTop: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1 },
  pending: { backgroundColor: 'rgba(245, 180, 40, 0.12)', borderColor: 'rgba(245, 180, 40, 0.5)' },
  ok: { backgroundColor: 'rgba(60, 190, 110, 0.12)', borderColor: 'rgba(60, 190, 110, 0.5)' },
  muted: { backgroundColor: 'rgba(128, 128, 128, 0.10)', borderColor: 'rgba(128, 128, 128, 0.4)' },
  text: { color: colors.ink, fontFamily: fontFamily.bodyMedium, fontSize: 15, lineHeight: 21 },
});
