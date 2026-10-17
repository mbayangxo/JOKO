import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import GlowButton from '../components/GlowButton';
import PressScale from '../components/PressScale';
import LoadErrorState from '../components/LoadErrorState';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import ConfettiBurst from '../components/ConfettiBurst';
import { useToast } from '../components/Toast';
import { createJekkalCampaign, getJekkalCampaigns } from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import { useFocusEffect } from '@react-navigation/native';

function ProgressBar({ pct }) {
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${Math.min(100, pct)}%` }]} />
    </View>
  );
}

function CampaignCard({ item, onPress }) {
  return (
    <PressScale scaleTo={0.98} onPress={() => onPress(item)} style={styles.card}>
      <Text style={styles.cardTitle}>{item.title}</Text>
      <Text style={styles.cardSub}>Pour {item.beneficiary?.name ?? item.beneficiary?.handle}</Text>
      <ProgressBar pct={item.progressPct} />
      <View style={styles.cardRow}>
        <Text style={styles.raised}>{formatKori(item.raisedAmount)}</Text>
        <Text style={styles.goal}> / {formatKori(item.goalAmount)}</Text>
      </View>
      {item.status === 'funded' ? <Text style={styles.fundedBadge}>Objectif atteint ✦</Text> : null}
    </PressScale>
  );
}

export default function JekkalScreen({ navigation }) {
  const showToast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [story, setStory] = useState('');
  const [goal, setGoal] = useState('50000');
  const [burst, setBurst] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await getJekkalCampaigns();
      setItems(Array.isArray(list) ? list : []);
      setLoadFailed(false);
    } catch {
      setItems([]);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  const submit = async () => {
    const goalAmount = Number(goal);
    if (!title.trim() || !Number.isFinite(goalAmount) || goalAmount <= 0) {
      showToast('Titre et objectif requis');
      return;
    }
    setCreating(true);
    try {
      const row = await createJekkalCampaign({ title: title.trim(), story: story.trim() || undefined, goalAmount });
      setBurst(true);
      setTimeout(() => setBurst(false), 2200);
      showToast('Collecte créée ✦');
      setTitle('');
      setStory('');
      navigation.navigate('JekkalDetail', { campaignId: row.id });
    } catch (e) {
      showToast(e.message ?? 'Erreur');
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <ConfettiBurst active={burst} />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Jëkkal" style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.hero}>Entraide{'\n'}sénégalaise.</Text>
          <Text style={styles.heroSub}>Crée une collecte ou contribue — l'argent va directement au bénéficiaire.</Text>

          <View style={styles.form}>
            <Text style={styles.lbl}>Nouvelle collecte</Text>
            <TextInput accessibilityLabel="Ex: Frais médicaux pour Awa" value={title} onChangeText={setTitle} placeholder="Ex: Frais médicaux pour Awa" style={styles.input} placeholderTextColor="rgba(5,8,5,0.35)" />
            <TextInput accessibilityLabel="Pourquoi ? (optionnel)" value={story} onChangeText={setStory} placeholder="Pourquoi ? (optionnel)" style={[styles.input, styles.inputMulti]} multiline placeholderTextColor="rgba(5,8,5,0.35)" />
            <TextInput accessibilityLabel="Objectif (C̶)" value={goal} onChangeText={setGoal} placeholder="Objectif (C̶)" keyboardType="number-pad" style={styles.input} placeholderTextColor="rgba(5,8,5,0.35)" />
            <GlowButton label={creating ? 'Création…' : 'Lancer la collecte'} onPress={submit} disabled={creating} tone="orange" />
          </View>

          <Text style={styles.sectionLbl}>Collectes actives</Text>
          {loading ? <ActivityIndicator color={colors.green} /> : null}
          {!loading && loadFailed ? <LoadErrorState what="les collectes" onRetry={load} /> : null}
          {!loading && !loadFailed && items.length === 0 ? <Text style={styles.empty}>Aucune collecte pour l'instant.</Text> : null}
          {items.map((item) => (
            <CampaignCard key={item.id} item={item} onPress={(c) => navigation.navigate('JekkalDetail', { campaignId: c.id })} />
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
  hero: { fontFamily: fontFamily.displayBlack, fontSize: 32, color: colors.terracotta, lineHeight: 36, marginBottom: spacing.sm },
  heroSub: { ...type.body, color: 'rgba(5,8,5,0.65)', marginBottom: spacing.xl },
  form: { backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: radius.lg, borderBottomRightRadius: radius.sm, padding: spacing.lg, marginBottom: spacing.xxl },
  lbl: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink, marginBottom: spacing.sm },
  input: { borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, fontFamily: fontFamily.bodyRegular, color: colors.ink, backgroundColor: 'rgba(255,255,255,0.9)' },
  inputMulti: { minHeight: 72, textAlignVertical: 'top' },
  sectionLbl: { fontFamily: fontFamily.bodyBold, fontSize: 14, marginBottom: spacing.md, color: colors.ink },
  card: { backgroundColor: 'rgba(255,255,255,0.8)', borderRadius: radius.lg, borderBottomRightRadius: radius.sm, padding: spacing.lg, marginBottom: spacing.md },
  cardTitle: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.ink },
  cardSub: { ...type.caption, marginTop: 4, marginBottom: spacing.sm },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: 'rgba(5,8,5,0.08)', overflow: 'hidden', marginBottom: spacing.sm },
  progressFill: { height: '100%', backgroundColor: colors.green, borderRadius: 4 },
  cardRow: { flexDirection: 'row', alignItems: 'baseline' },
  raised: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.greenDark },
  goal: { fontFamily: fontFamily.bodyRegular, color: 'rgba(5,8,5,0.5)' },
  fundedBadge: { marginTop: spacing.sm, fontFamily: fontFamily.bodyBold, color: colors.goldDark, fontSize: 12 },
  empty: { ...type.caption, color: 'rgba(5,8,5,0.5)' },
});
