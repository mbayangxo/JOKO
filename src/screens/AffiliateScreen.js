import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import GlowButton from '../components/GlowButton';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { useToast } from '../components/Toast';
import {
  createAffiliateLink,
  getAffiliateMe,
  registerAffiliate,
} from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { colors, fontFamily, radius, spacing, type } from '../theme';

export default function AffiliateScreen({ navigation }) {
  const showToast = useToast();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [businessId, setBusinessId] = useState('');
  const [productId, setProductId] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getAffiliateMe();
      setProfile(data.registered === false ? null : data);
    } catch {
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  const join = async () => {
    setRegistering(true);
    try {
      const row = await registerAffiliate();
      setProfile(row);
      showToast('Tu es affilié K21 ✦');
    } catch (e) {
      showToast(e.message ?? 'Erreur');
    } finally {
      setRegistering(false);
    }
  };

  const createLink = async () => {
    if (!businessId.trim() && !productId.trim()) {
      showToast('ID commerce ou produit requis');
      return;
    }
    setCreating(true);
    try {
      const link = await createAffiliateLink({
        businessId: businessId.trim() || undefined,
        productId: productId.trim() || undefined,
      });
      await Share.share({ message: `Découvre sur K21 — ${link.shopUrl}` });
      await load();
      showToast('Lien créé ✦');
    } catch (e) {
      showToast(e.message ?? 'Erreur');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <ActivityIndicator color={colors.green} style={{ marginTop: 80 }} />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <ScreenHeader onBack={() => navigation.goBack()} title="Affilié K21" />
          <View style={styles.heroBlock}>
            <Text style={styles.hero}>Gagne sur{'\n'}chaque vente.</Text>
            <Text style={styles.heroSub}>
              Comme TikTok Shop — partage un lien, un message Mboolo ou une page marchande. Quand quelqu'un commande (livraison ou retrait), tu touches ta commission.
            </Text>
            <GlowButton label={registering ? 'Inscription…' : 'Devenir affilié'} onPress={join} disabled={registering} tone="gold" />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  const stats = profile.stats ?? {};

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Affilié K21" style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.code}>@{profile.affiliateCode}</Text>
          <Text style={styles.pct}>{profile.commissionPct ?? '5.0'}% par vente</Text>

          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Text style={styles.statNum}>{formatKori(stats.totalEarned ?? profile.totalEarned ?? 0)}</Text>
              <Text style={styles.statLbl}>Total gagné</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statNum}>{formatKori(stats.monthEarned ?? 0)}</Text>
              <Text style={styles.statLbl}>Ce mois</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statNum}>{stats.monthOrders ?? 0}</Text>
              <Text style={styles.statLbl}>Commandes</Text>
            </View>
          </View>

          <View style={styles.form}>
            <Text style={styles.lbl}>Créer un lien de promo</Text>
            <TextInput accessibilityLabel="ID commerce (depuis la boutique)" value={businessId} onChangeText={setBusinessId} placeholder="ID commerce (depuis la boutique)" style={styles.input} placeholderTextColor="rgba(5,8,5,0.35)" />
            <TextInput accessibilityLabel="ID produit (optionnel)" value={productId} onChangeText={setProductId} placeholder="ID produit (optionnel)" style={styles.input} placeholderTextColor="rgba(5,8,5,0.35)" />
            <GlowButton label={creating ? 'Création…' : 'Créer & partager le lien'} onPress={createLink} disabled={creating} tone="orange" />
          </View>

          <Text style={styles.section}>Mes liens</Text>
          {(profile.links ?? []).map((link) => (
            <PressScale
              key={link.id}
              scaleTo={0.98}
              onPress={() => Share.share({ message: link.shopUrl })}
              style={styles.linkCard}
            >
              <Text style={styles.linkTitle}>{link.label ?? link.business?.name ?? link.product?.title ?? link.linkCode}</Text>
              <Text style={styles.linkMeta}>{link.clickCount} clics · {link.orderCount} ventes</Text>
              <Text style={styles.linkUrl} numberOfLines={1}>{link.shopUrl}</Text>
            </PressScale>
          ))}

          <Text style={styles.section}>Dernières commissions</Text>
          {(profile.commissions ?? []).map((c) => (
            <View key={c.id} style={styles.commRow}>
              <Text style={styles.commAmt}>{formatKori(c.amount)}</Text>
              <Text style={styles.commSrc}>{c.source} · {new Date(c.createdAt).toLocaleDateString('fr-FR')}</Text>
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
  heroBlock: { padding: spacing.xl, flex: 1, justifyContent: 'center' },
  hero: { fontFamily: fontFamily.displayBlack, fontSize: 34, color: colors.goldDark, lineHeight: 38, marginBottom: spacing.md },
  heroSub: { ...type.body, color: 'rgba(5,8,5,0.65)', marginBottom: spacing.xxl },
  scroll: { padding: spacing.lg, paddingBottom: spacing.huge },
  code: { fontFamily: fontFamily.displayBlack, fontSize: 24, color: colors.ink },
  pct: { ...type.body, color: colors.greenDark, marginBottom: spacing.lg },
  statsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xl },
  stat: { flex: 1, backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  statNum: { fontFamily: fontFamily.displayBlack, fontSize: 16, color: colors.greenDark },
  statLbl: { fontSize: 10, fontFamily: fontFamily.bodyRegular, color: 'rgba(5,8,5,0.5)', marginTop: 4 },
  form: { backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.xl },
  lbl: { fontFamily: fontFamily.bodyBold, marginBottom: spacing.sm },
  input: { borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, fontFamily: fontFamily.bodyRegular, color: colors.ink },
  section: { fontFamily: fontFamily.bodyBold, fontSize: 14, marginBottom: spacing.md },
  linkCard: { backgroundColor: 'rgba(255,255,255,0.8)', borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.sm },
  linkTitle: { fontFamily: fontFamily.bodyBold, color: colors.ink },
  linkMeta: { ...type.caption, marginTop: 4 },
  linkUrl: { ...type.caption, color: colors.terracotta, marginTop: 4 },
  commRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(5,8,5,0.08)' },
  commAmt: { fontFamily: fontFamily.bodyBold, color: colors.greenDark },
  commSrc: { ...type.caption },
});
