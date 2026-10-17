import { StyleSheet, Text, View } from 'react-native';
import { colors, fontFamily, radius, spacing } from '../theme';
import { useLocale } from '../context/LocaleContext';
import { safetyIdFor, safetyText } from '../i18n/money-safety';
import { attributedText } from '../lib/intent-handoff';

/**
 * J12 — shows the authoritative status of a money attempt whose outcome was unknown (lost response,
 * restart, weak network). It never says "effectué" unless the server confirmed it (phase.state === 'done').
 */
const TONE = { checking: 'pending', accepted_pending: 'pending', done: 'ok', failed_safe: 'muted', safe_to_retry: 'muted', blocked: 'muted' };

export default function MoneyPhaseBanner({ phase }) {
  const { langCode } = useLocale();
  // Only for attempts that went through a check (unknown outcome); normal results keep their own UI.
  if (!phase || !(phase.state === 'checking' || phase.resumed || phase.afterCheck)) return null;
  const tone = TONE[phase.state] ?? 'muted';
  // P-J12-2: reviewed text in the user's language when one exists, otherwise the reviewed French.
  const id = safetyIdFor(phase);
  const base = (langCode && langCode !== 'fr' && id ? safetyText(id, langCode) : null) ?? phase.message ?? safetyText(id ?? 'checking', 'fr');
  // J13-F17: an EARLIER attempt's outcome always says which attempt it is about (never read as the current one).
  const text = attributedText(phase, base);
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
