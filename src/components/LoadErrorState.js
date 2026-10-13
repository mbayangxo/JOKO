import { StyleSheet, Text, View } from 'react-native';
import PressScale from './PressScale';
import { colors, fontFamily, radius, spacing } from '../theme';

/**
 * J13-F7: shown when a list could not be LOADED — never the "nothing here yet" empty state, which would
 * tell the user they have no operations / notifications / tickets when the network simply failed.
 */
export default function LoadErrorState({ onRetry, what = 'ces informations' }) {
  return (
    <View style={styles.box} accessibilityRole="alert" testID="load-error">
      <Text style={styles.title}>Impossible de charger {what}</Text>
      <Text style={styles.body}>Vérifie ta connexion. Rien n’a été modifié.</Text>
      {onRetry ? (
        <PressScale onPress={onRetry} style={styles.btn} accessibilityRole="button" accessibilityLabel="Réessayer">
          <Text style={styles.btnText}>Réessayer</Text>
        </PressScale>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', padding: spacing.xl, gap: spacing.sm },
  title: { fontFamily: fontFamily.bodySemiBold, fontSize: 14, color: colors.ink, textAlign: 'center' },
  body: { fontFamily: fontFamily.bodyRegular, fontSize: 12.5, color: 'rgba(5,8,5,0.6)', textAlign: 'center' },
  btn: { marginTop: spacing.sm, paddingVertical: 8, paddingHorizontal: 18, borderRadius: radius.md, backgroundColor: 'rgba(0,133,63,0.12)' },
  btnText: { fontFamily: fontFamily.bodySemiBold, fontSize: 13, color: colors.ink },
});
