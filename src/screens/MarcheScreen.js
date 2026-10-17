import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import { useAppState } from '../state/AppState';
import { coordsFromArrondissement } from '../lib/dakar-coords';
import { marketplaceSearch, marketplaceShopsNearby } from '../lib/api-client';
import { useEntrance } from '../hooks/animations';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import LowDataImage from '../components/LowDataImage';

const QUICK_SEARCHES = ['riz', 'huile', 'oignon', 'tomate', 'pain', 'lait'];

function ProductThumb({ uri, title }) {
  if (uri) {
    return <LowDataImage uri={uri} style={styles.thumbImg} accessibilityLabel={title} />;
  }
  return (
    <View style={styles.thumbPlaceholder}>
      <Text style={styles.thumbEmoji}>🛒</Text>
    </View>
  );
}

function ShopCard({ shop, onPress, delay = 0 }) {
  const entrance = useEntrance(delay, 300, 12);
  return (
    <Animated.View style={entrance}>
      <PressScale scaleTo={0.98} onPress={onPress} style={styles.shopCard}>
        {shop.imageUrl ? (
          <LowDataImage uri={shop.imageUrl} style={styles.shopHero} />
        ) : (
          <View style={[styles.shopHero, styles.shopHeroPlaceholder]}>
            <Text style={{ fontSize: 28 }}>🏪</Text>
          </View>
        )}
        <View style={styles.shopBody}>
          <Text style={styles.shopName} numberOfLines={1}>{shop.name}</Text>
          <Text style={styles.shopMeta}>
            {[shop.arrondissement, shop.distanceLabel].filter(Boolean).join(' · ')}
            {shop.matchCount ? ` · ${shop.matchCount} article${shop.matchCount > 1 ? 's' : ''}` : ''}
          </Text>
          {shop.products?.slice(0, 2).map((p) => (
            <Text key={p.id} style={styles.shopProductLine} numberOfLines={1}>
              {p.title} — {p.effectivePrice?.toLocaleString('fr-FR')} ₭
            </Text>
          ))}
        </View>
      </PressScale>
    </Animated.View>
  );
}

export default function MarcheScreen({ navigation }) {
  const { profile } = useAppState();
  const coords = useMemo(
    () => coordsFromArrondissement(profile?.arrondissement?.key),
    [profile?.arrondissement?.key],
  );

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [loading, setLoading] = useState(false);
  const [shops, setShops] = useState([]);
  const [results, setResults] = useState([]);
  const [nearby, setNearby] = useState([]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  const loadNearby = useCallback(async () => {
    try {
      const data = await marketplaceShopsNearby({
        lat: coords.lat,
        lng: coords.lng,
        category: 'grocery',
      });
      setNearby(Array.isArray(data?.shops) ? data.shops : []);
    } catch {
      setNearby([]);
    }
  }, [coords.lat, coords.lng]);

  const runSearch = useCallback(async () => {
    if (debounced.length < 2) {
      setShops([]);
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const data = await marketplaceSearch({
        q: debounced,
        lat: coords.lat,
        lng: coords.lng,
        category: 'grocery',
      });
      setShops(Array.isArray(data?.shops) ? data.shops : []);
      setResults(Array.isArray(data?.results) ? data.results : []);
    } catch {
      setShops([]);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [debounced, coords.lat, coords.lng]);

  useFocusEffect(
    useCallback(() => {
      loadNearby();
    }, [loadNearby]),
  );

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  const openShop = (shopId) => navigation.navigate('ShopDetail', { businessId: shopId });
  const headerEntrance = useEntrance(0, 350, 12);

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <Animated.View style={[styles.header, headerEntrance]}>
          <PressScale scaleTo={0.9} onPress={() => navigation.navigate('Marketplace')} style={styles.hubLink}>
            <Text style={styles.hubLinkText}>Hub</Text>
          </PressScale>
          <Text style={styles.eyebrow}>Marché</Text>
          <Text style={styles.title}>Qu’est-ce que tu cherches ?</Text>
          <Text style={styles.subtitle}>
            Tape un produit — on te montre les marchés les plus proches qui l’ont.
          </Text>
          <View style={styles.searchRow}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput accessibilityLabel="Ex. riz, huile, lait"
              style={styles.searchInput}
              placeholder="Ex. riz, huile, lait…"
              placeholderTextColor={colors.appCanvas.textFaint}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {QUICK_SEARCHES.map((term) => (
              <PressScale key={term} scaleTo={0.96} onPress={() => setQuery(term)} style={styles.chip}>
                <Text style={styles.chipText}>{term}</Text>
              </PressScale>
            ))}
          </ScrollView>
        </Animated.View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {loading ? (
            <ActivityIndicator color={colors.greenDark} style={{ marginTop: spacing.xl }} />
          ) : null}

          {debounced.length >= 2 && !loading && shops.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>📭</Text>
              <Text style={styles.emptyTitle}>Aucun marché trouvé</Text>
              <Text style={styles.emptySub}>Essaie un autre mot ou vérifie plus tard.</Text>
            </View>
          ) : null}

          {shops.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Résultats pour « {debounced} »</Text>
              {shops.map((shop, i) => (
                <ShopCard key={shop.id} shop={shop} onPress={() => openShop(shop.id)} delay={Math.min(i, 8) * 35} />
              ))}
            </View>
          ) : null}

          {debounced.length < 2 && nearby.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Marchés près de toi</Text>
              {nearby.map((shop, i) => (
                <ShopCard key={shop.id} shop={shop} onPress={() => openShop(shop.id)} delay={Math.min(i, 8) * 35} />
              ))}
            </View>
          ) : null}

          {debounced.length < 2 && results.length === 0 && nearby.length === 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Vendeur ?</Text>
              <PressScale
                scaleTo={0.98}
                onPress={() => navigation.navigate('MerchantCatalog')}
                style={styles.merchantCta}
              >
                <Text style={styles.merchantCtaTitle}>Gérer mon catalogue</Text>
                <Text style={styles.merchantCtaSub}>Ajoute des photos et des prix à tes produits</Text>
              </PressScale>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { paddingHorizontal: spacing.huge, paddingTop: spacing.lg, gap: spacing.sm },
  hubLink: { alignSelf: 'flex-end', paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
  hubLinkText: { ...type.bodySmall, color: colors.greenDark, fontFamily: fontFamily.bodySemiBold },
  eyebrow: { ...type.eyebrow, color: colors.greenDark },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 22, color: colors.ink, letterSpacing: -0.5 },
  subtitle: { ...type.bodySmall, color: 'rgba(5,8,5,0.55)', lineHeight: 18 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  searchIcon: { fontSize: 16, marginRight: spacing.sm },
  searchInput: { flex: 1, ...type.body, color: colors.ink, paddingVertical: spacing.md },
  chips: { gap: spacing.sm, paddingVertical: spacing.sm },
  chip: {
    backgroundColor: 'rgba(26,240,96,0.12)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: 'rgba(26,240,96,0.25)',
  },
  chipText: { ...type.bodySmall, color: colors.greenDark, fontFamily: fontFamily.bodySemiBold },
  body: { paddingHorizontal: spacing.huge, paddingBottom: 100, gap: spacing.xl },
  section: { gap: spacing.md },
  sectionLabel: { ...type.eyebrow, color: 'rgba(5,8,5,0.45)' },
  shopCard: {
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.06)',
  },
  shopHero: { width: '100%', height: 96 },
  shopHeroPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(5,8,5,0.04)' },
  shopBody: { padding: spacing.md, gap: spacing.xs },
  shopName: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.ink },
  shopMeta: { ...type.bodySmall, color: 'rgba(5,8,5,0.5)' },
  shopProductLine: { ...type.bodySmall, color: colors.greenDark },
  thumbImg: { width: 56, height: 56, borderRadius: radius.md },
  thumbPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: 'rgba(5,8,5,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbEmoji: { fontSize: 22 },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm },
  emptyEmoji: { fontSize: 36 },
  emptyTitle: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.ink },
  emptySub: { ...type.bodySmall, color: 'rgba(5,8,5,0.5)', textAlign: 'center' },
  merchantCta: {
    backgroundColor: 'rgba(232,92,26,0.1)',
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(232,92,26,0.2)',
    gap: spacing.xs,
  },
  merchantCtaTitle: { fontFamily: fontFamily.bodySemiBold, color: colors.terracottaDark },
  merchantCtaSub: { ...type.bodySmall, color: 'rgba(5,8,5,0.55)' },
});
