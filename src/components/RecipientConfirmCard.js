import { StyleSheet, Text, View } from 'react-native';
import PressScale from './PressScale';
import GlowButton from './GlowButton';
import { colors, fontFamily, radius, spacing } from '../theme';

/**
 * J14-S0: before a recipient is STORED for later payments (payroll employee, scheduled transfer), the person
 * is looked up and shown — name, handle, masked phone, verification — and only an explicit confirmation sends
 * the server-issued recipientRef that binds the immutable account. Nothing is saved from a typed handle alone.
 */
export default function RecipientConfirmCard({ profile, question, confirmLabel = 'Oui, confirmer', onConfirm, onCancel, busy = false }) {
  if (!profile) return null;
  const handle = String(profile.handle ?? '').replace(/^@?/, '@');
  return (
    <View style={styles.card} accessibilityRole="summary" testID="recipient-confirm">
      <Text style={styles.q}>{question ?? `Est-ce bien ${profile.name || handle} ?`}</Text>
      <Text style={styles.name}>{profile.name || handle}</Text>
      <Text style={styles.meta}>
        {handle}
        {profile.phone ? ` · ${profile.phone}` : ''}
        {profile.verified ? ' · Vérifiée K21' : ''}
      </Text>
      <View style={styles.row}>
        <PressScale onPress={onCancel} style={styles.cancel} accessibilityRole="button" accessibilityLabel="Ce n’est pas la bonne personne">
          <Text style={styles.cancelText}>Ce n’est pas la bonne personne</Text>
        </PressScale>
      </View>
      <GlowButton label={confirmLabel} onPress={onConfirm} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm, padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(5,8,5,0.12)', backgroundColor: 'rgba(255,255,255,0.75)' },
  q: { fontFamily: fontFamily.bodySemiBold, fontSize: 13, color: colors.ink },
  name: { fontFamily: fontFamily.bodyBold, fontSize: 16, color: colors.ink },
  meta: { fontFamily: fontFamily.bodyRegular, fontSize: 12, color: 'rgba(5,8,5,0.6)' },
  row: { flexDirection: 'row', justifyContent: 'flex-end' },
  cancel: { paddingVertical: 6 },
  cancelText: { fontFamily: fontFamily.bodyMedium, fontSize: 12, color: colors.terracottaDark, textDecorationLine: 'underline' },
});
