import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import { colors, fontFamily, radius, spacing } from '../theme';

// Ñu Lekk — food bill split (standalone money flow, not Mboolo chat/group).
// Backend not wired yet; no mock participants or amounts.

export default function NuLekkScreen({ navigation }) {
  return (
    <View style={styles.root}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          <LinearGradient colors={['#ffe08a', '#ffb347', '#ff8c52']} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={styles.hero}>
            <View style={styles.heroBackRow}>
              <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.heroBack} accessibilityRole="button" accessibilityLabel="Retour">
                <Text style={{ fontSize: 14, color: '#fff' }}>←</Text>
              </PressScale>
              <Text style={styles.heroTitle}>Ñu Lekk 🍖</Text>
            </View>
            <Text style={styles.plate}>🍖</Text>
            <Text style={styles.heroQuestion}>Partage l'addition</Text>
            <Text style={styles.heroBy}>Après un repas — chacun paie sa part, le resto reçoit le total</Text>
          </LinearGradient>

          <View style={styles.body}>
            <Text style={styles.emptyTitle}>Aucun partage en cours</Text>
            <Text style={styles.emptyText}>
              Crée un split avec l'addition totale et le montant par personne. Invite tes amis par @handle ou lien —
              pas besoin d'un groupe Mboolo.
            </Text>
            <GlowButton
              label="Lancer un Ñu Lekk"
              onPress={() =>
                navigation.navigate('Info', {
                  title: 'Ñu Lekk',
                  subtitle: 'Création de split — bientôt disponible.',
                  icon: '🍖',
                })
              }
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.mboolo.bg },

  hero: { paddingHorizontal: spacing.huge, paddingTop: spacing.giant, paddingBottom: 24, overflow: 'hidden' },
  heroBackRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.xxxl },
  heroBack: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontFamily: fontFamily.displayBlack, fontSize: 14, color: '#fff' },
  plate: { fontSize: 56, textAlign: 'center', marginBottom: spacing.md },
  heroQuestion: { fontFamily: fontFamily.displayBlack, fontSize: 17, color: '#fff', textAlign: 'center', marginBottom: 4 },
  heroBy: { fontSize: 11, color: 'rgba(255,255,255,0.75)', textAlign: 'center', lineHeight: 16 },

  body: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    marginTop: -16,
    paddingHorizontal: spacing.huge,
    paddingTop: spacing.giant,
    paddingBottom: spacing.giant,
    gap: spacing.lg,
    minHeight: 280,
  },
  emptyTitle: { fontFamily: fontFamily.displayBold, fontSize: 16, color: colors.mboolo.ink, textAlign: 'center' },
  emptyText: { fontSize: 12, color: colors.mboolo.ink3, textAlign: 'center', lineHeight: 18 },
});
