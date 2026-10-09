import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import ConfettiBurst from '../components/ConfettiBurst';
import GlowButton from '../components/GlowButton';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { useToast } from '../components/Toast';
import { contributeJekkal, getJekkalCampaign, respondJekkalBeneficiary } from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { colors, fontFamily, radius, spacing, type } from '../theme';

export default function JekkalDetailScreen({ navigation, route }) {
  const { campaignId } = route.params ?? {};
  const showToast = useToast();
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('5000');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [burst, setBurst] = useState(false);

  const load = useCallback(async () => {
    if (!campaignId) return;
    try {
      const row = await getJekkalCampaign(campaignId);
      setCampaign(row);
    } catch {
      setCampaign(null);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  const donate = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      showToast('Montant invalide');
      return;
    }
    setSubmitting(true);
    try {
      const result = await contributeJekkal(campaignId, { amount: n, message: message.trim() || undefined });
      setCampaign(result.campaign);
      setBurst(true);
      setTimeout(() => setBurst(false), 2600);
      showToast('Merci pour ton don ✦');
    } catch (e) {
      showToast(e.message ?? 'Erreur');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <ActivityIndicator style={{ flex: 1 }} color={colors.green} />
      </View>
    );
  }

  if (!campaign) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <SafeAreaView style={{ flex: 1 }}>
          <ScreenHeader onBack={() => navigation.goBack()} title="Jëkkal" />
          <Text style={styles.empty}>Collecte introuvable</Text>
        </SafeAreaView>
      </View>
    );
  }

  const pct = campaign.progressPct ?? 0;

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <ConfettiBurst active={burst} />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Jëkkal" style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.title}>{campaign.title}</Text>
          <Text style={styles.beneficiary}>Pour {campaign.beneficiary?.name ?? campaign.beneficiary?.handle}</Text>
          <Text style={styles.story}>{campaign.disclosure}</Text>
          {campaign.awaitingBeneficiary ? (
            <View>
              <Text style={styles.beneficiary}>En attente de l’accord du bénéficiaire : aucun don n’est possible avant.</Text>
              <GlowButton title="J’accepte cette collecte à mon nom" onPress={async () => { try { await respondJekkalBeneficiary(campaign.id, true); load(); } catch (e) { showToast(e.message); } }} />
            </View>
          ) : null}
          {campaign.story ? <Text style={styles.story}>{campaign.story}</Text> : null}

          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${pct}%` }]} />
          </View>
          <Text style={styles.amounts}>
            {formatKori(campaign.raisedAmount)} <Text style={styles.goal}>sur {formatKori(campaign.goalAmount)}</Text>
          </Text>
          {campaign.status === 'funded' ? <Text style={styles.funded}>Objectif atteint 🎉</Text> : null}

          {campaign.status === 'active' ? (
            <View style={styles.form}>
              <TextInput value={amount} onChangeText={setAmount} keyboardType="number-pad" style={styles.input} placeholder="Montant" placeholderTextColor="rgba(5,8,5,0.35)" />
              <TextInput value={message} onChangeText={setMessage} style={styles.input} placeholder="Message (optionnel)" placeholderTextColor="rgba(5,8,5,0.35)" />
              <GlowButton label={submitting ? 'Envoi…' : 'Contribuer'} onPress={donate} disabled={submitting} />
            </View>
          ) : null}

          <Text style={styles.section}>Derniers dons</Text>
          {(campaign.contributions ?? []).map((c) => (
            <View key={c.id} style={styles.donRow}>
              <Text style={styles.donWho}>{c.anonymous ? 'Anonyme' : c.donor?.name ?? c.donor?.handle ?? '—'}</Text>
              <Text style={styles.donAmt}>{formatKori(c.amount)}</Text>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { paddingHorizontal: spacing.lg },
  scroll: { padding: spacing.lg, paddingBottom: spacing.huge },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 28, color: colors.ink, marginBottom: spacing.xs },
  beneficiary: { ...type.body, color: colors.terracotta, marginBottom: spacing.md },
  story: { ...type.body, color: 'rgba(5,8,5,0.7)', marginBottom: spacing.lg },
  progressTrack: { height: 10, borderRadius: 5, backgroundColor: 'rgba(5,8,5,0.08)', overflow: 'hidden', marginBottom: spacing.sm },
  progressFill: { height: '100%', backgroundColor: colors.green },
  amounts: { fontFamily: fontFamily.displayBlack, fontSize: 24, color: colors.greenDark, marginBottom: spacing.lg },
  goal: { fontFamily: fontFamily.bodyRegular, fontSize: 16, color: 'rgba(5,8,5,0.5)' },
  funded: { fontFamily: fontFamily.bodyBold, color: colors.goldDark, marginBottom: spacing.lg },
  form: { backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.xl },
  input: { borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, fontFamily: fontFamily.bodyRegular, color: colors.ink },
  section: { fontFamily: fontFamily.bodyBold, marginBottom: spacing.sm },
  donRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(5,8,5,0.08)' },
  donWho: { fontFamily: fontFamily.bodyRegular, color: colors.ink },
  donAmt: { fontFamily: fontFamily.bodyBold, color: colors.greenDark },
  empty: { textAlign: 'center', marginTop: spacing.xxl, color: 'rgba(5,8,5,0.5)' },
});
