import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../components/ScreenHeader';
import GlowButton from '../components/GlowButton';
import ScreenBackground from '../components/ScreenBackground';
import K21QrCode from '../components/K21QrCode';
import { useToast } from '../components/Toast';
import { useAppState } from '../state/AppState';
import { enrollStudentPass } from '../lib/api-client';
import { buildStudentPassUrl } from '../lib/k21-qr';
import { colors, fontFamily, radius, spacing } from '../theme';

function formatExpiry(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', { month: '2-digit', year: 'numeric' });
}

export default function StudentPassScreen({ navigation }) {
  const { profile, setProfile } = useAppState();
  const { showToast } = useToast();
  const pass = profile.studentPass;
  const [schoolName, setSchoolName] = useState(pass?.schoolName ?? '');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const trimmed = schoolName.trim();
    if (trimmed.length < 2) {
      showToast('Indique ton établissement');
      return;
    }
    setLoading(true);
    try {
      const updated = await enrollStudentPass(trimmed);
      setProfile({ studentPass: updated });
      if (updated.status === 'active') {
        showToast('K21 Pass Étudiant activé ✓');
      } else if (updated.status === 'pending') {
        showToast('Demande enregistrée — vérifie ta CNI pour activer le pass');
      } else {
        showToast('Pass enregistré');
      }
    } catch (err) {
      showToast(err.message ?? 'Activation impossible');
    } finally {
      setLoading(false);
    }
  };

  const passUrl = pass?.status === 'active' && profile.handle ? buildStudentPassUrl(profile.handle) : pass?.passQrUrl ?? null;
  const tier = profile.verification?.tier ?? 1;

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <ScreenHeader onBack={() => navigation.goBack()} title="K21 Pass Étudiant" style={styles.header} />

          <Text style={styles.lead}>
            Carte numérique pour -15% chez les marchands partenaires. Active-la avec ton établissement scolaire ou universitaire.
          </Text>

          {pass?.status === 'active' ? (
            <View style={styles.activeCard}>
              <View style={styles.activeTop}>
                <Text style={{ fontSize: 22 }}>🎓</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.activeTitle}>{pass.schoolName}</Text>
                  <Text style={styles.activeSub}>Pass actif · expire {formatExpiry(pass.expiresAt)}</Text>
                </View>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>ACTIF</Text>
                </View>
              </View>
              {passUrl ? (
                <View style={styles.qrBlock}>
                  <Text style={styles.qrLabel}>Scanner en caisse pour la réduction étudiant</Text>
                  <K21QrCode value={passUrl} size={160} />
                  <Text style={styles.qrUrl}>{passUrl}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {pass?.status === 'pending' ? (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>En attente de vérification</Text>
              <Text style={styles.noticeText}>
                {pass.schoolName ? `${pass.schoolName} · ` : ''}
                {tier >= 2
                  ? 'Ton pass sera activé sous peu.'
                  : 'Vérifie ta CNI dans Compte & Sécurité pour activer le pass.'}
              </Text>
            </View>
          ) : null}

          {pass?.status === 'expired' ? (
            <View style={[styles.notice, styles.noticeWarn]}>
              <Text style={styles.noticeTitle}>Pass expiré</Text>
              <Text style={styles.noticeText}>Renouvelle ton inscription ci-dessous.</Text>
            </View>
          ) : null}

          {pass?.status !== 'active' ? (
            <View style={styles.form}>
              <Text style={styles.label}>Établissement</Text>
              <TextInput accessibilityLabel="Ex: UCAD, ESP, Lycée Blaise Diagne"
                style={styles.input}
                placeholder="Ex: UCAD, ESP, Lycée Blaise Diagne…"
                placeholderTextColor={'rgba(5,8,5,0.4)'}
                value={schoolName}
                onChangeText={setSchoolName}
                editable={!loading}
              />
              <GlowButton
                label={pass?.status === 'pending' ? 'Mettre à jour' : 'Activer mon Pass Étudiant'}
                onPress={submit}
                disabled={loading}
              />
              {loading ? <ActivityIndicator color={colors.green} style={{ marginTop: spacing.md }} /> : null}
              {tier < 2 ? (
                <Text style={styles.hint}>
                  Tier 1 : ta demande reste en attente jusqu&apos;à la vérification CNI (Tier 2).
                </Text>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  scroll: { paddingHorizontal: spacing.xxxl, paddingBottom: spacing.giant },
  header: { marginBottom: spacing.lg },
  lead: { fontSize: 12, color: 'rgba(5,8,5,0.5)', lineHeight: 18, marginBottom: spacing.xxl },
  activeCard: {
    backgroundColor: 'rgba(26,240,96,0.1)',
    borderWidth: 1.5,
    borderColor: colors.greenA20,
    borderRadius: radius.xxl,
    overflow: 'hidden',
    marginBottom: spacing.xxl,
  },
  activeTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
  },
  activeTitle: { fontFamily: fontFamily.displayBlack, fontSize: 14, color: colors.green },
  activeSub: { fontSize: 10, color: 'rgba(5,8,5,0.5)', marginTop: 2 },
  badge: { backgroundColor: colors.green, borderRadius: radius.round, paddingHorizontal: spacing.lg, paddingVertical: 3 },
  badgeText: { fontSize: 8, fontWeight: '900', color: colors.ink },
  qrBlock: { alignItems: 'center', padding: spacing.xl, gap: spacing.md, backgroundColor: 'rgba(255,255,255,0.72)' },
  qrLabel: { fontSize: 11, color: 'rgba(5,8,5,0.55)', textAlign: 'center' },
  qrUrl: { fontSize: 9, color: 'rgba(5,8,5,0.4)', textAlign: 'center' },
  notice: {
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.xxl,
  },
  noticeWarn: { borderColor: 'rgba(232,92,26,0.25)', backgroundColor: 'rgba(232,92,26,0.08)' },
  noticeTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink, marginBottom: spacing.xs },
  noticeText: { fontSize: 11, color: 'rgba(5,8,5,0.5)', lineHeight: 16 },
  form: { gap: spacing.md },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 1, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase' },
  input: {
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    fontSize: 14,
    color: colors.ink,
    marginBottom: spacing.sm,
  },
  hint: { fontSize: 10, color: 'rgba(5,8,5,0.45)', lineHeight: 15, marginTop: spacing.sm },
});
