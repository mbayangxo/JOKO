import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import GlowButton from '../components/GlowButton';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { useToast } from '../components/Toast';
import { applyAgent, getAgentApplication } from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

export default function AgentApplyScreen({ navigation }) {
  const showToast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [locationLabel, setLocationLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [application, setApplication] = useState(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      getAgentApplication()
        .then((data) => setApplication(data.application ?? null))
        .catch(() => setApplication(null))
        .finally(() => setLoading(false));
    }, []),
  );

  const submit = async () => {
    if (!displayName.trim()) {
      showToast('Nom du point requis');
      return;
    }
    setSubmitting(true);
    try {
      const result = await applyAgent({
        displayName: displayName.trim(),
        locationLabel: locationLabel.trim() || undefined,
      });
      showToast(result.message ?? 'Demande envoyée ✦');
      const refreshed = await getAgentApplication();
      setApplication(refreshed.application ?? null);
      if (result.agent?.status === 'active') navigation.navigate('AgentHome');
    } catch (e) {
      showToast(e.message ?? 'Erreur');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Devenir agent" />
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.hero}>Recharge les gens{'\n'}dans ton quartier.</Text>
          <Text style={styles.sub}>
            K21 te donne du float. Tu touches une prime mensuelle + un % sur le volume que tu traites.
          </Text>
          {loading ? <ActivityIndicator color={colors.green} style={{ marginVertical: spacing.lg }} /> : null}
          {application ? (
            <View style={styles.statusCard}>
              <Text style={styles.statusTitle}>{application.displayName} · {application.agentCode}</Text>
              <Text style={styles.statusMeta}>{application.message}</Text>
              <Text style={styles.statusMeta}>Statut · {application.status} · Float {application.floatBalance ?? 0} F</Text>
              {application.canOperate ? (
                <GlowButton label="Ouvrir mode agent" onPress={() => navigation.navigate('AgentHome')} style={{ marginTop: spacing.md }} />
              ) : null}
            </View>
          ) : null}
          {!application || application.status === 'rejected' ? (
            <>
          <TextInput accessibilityLabel="Nom du point (ex: Boutique Awa)"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Nom du point (ex: Boutique Awa)"
            style={styles.input}
            placeholderTextColor="rgba(5,8,5,0.35)"
          />
          <TextInput accessibilityLabel="Adresse / quartier"
            value={locationLabel}
            onChangeText={setLocationLabel}
            placeholder="Adresse / quartier"
            style={styles.input}
            placeholderTextColor="rgba(5,8,5,0.35)"
          />
          <GlowButton label={submitting ? 'Envoi…' : 'Envoyer la demande'} onPress={submit} disabled={submitting} />
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  scroll: { padding: spacing.lg },
  hero: { fontFamily: fontFamily.displayBlack, fontSize: 28, color: colors.goldDark, marginBottom: spacing.sm },
  sub: { ...type.body, color: 'rgba(5,8,5,0.65)', marginBottom: spacing.xl },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    fontFamily: fontFamily.bodyRegular,
    color: colors.ink,
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  statusCard: {
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
  },
  statusTitle: { fontFamily: fontFamily.bodyBold, color: colors.ink },
  statusMeta: { ...type.caption, color: 'rgba(5,8,5,0.55)', marginTop: spacing.xs },
});
