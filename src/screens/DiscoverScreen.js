import { useCallback, useEffect, useState } from 'react';
import { Animated, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import { useToast } from '../components/Toast';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import { useEntrance, useBlink, useScalePulse } from '../hooks/animations';
import { getProducts, getBusinesses, getCultureFeed, submitBusinessReview, getFlashDeals } from '../lib/api-client';
import { useLocale } from '../context/LocaleContext';

// Discover hub: Culture, Eat, Gigs, flash deals. Event tickets live in separate K21 Events app.

const TABS = ['Tout', 'Culture', 'Eat', 'Gigs'];

const CATEGORY_ICONS = {
  restaurant: '🍖',
  deal: '🍖',
  food: '🍚',
  gig: '💼',
  event: '🌙',
  default: '✦',
};

function productIcon(category) {
  return CATEGORY_ICONS[category] ?? CATEGORY_ICONS.default;
}

function businessIcon(category) {
  if (category === 'restaurant') return '🍖';
  if (category === 'boutique') return '🛍️';
  return '🏬';
}

function buildDiscoverGrid({ deals, restaurants, gigs }) {
  const tiles = [];
  const deal = deals[0];
  if (deal) {
    tiles.push({
      key: `deal-${deal.id}`,
      bg: ['rgba(26,240,96,0.16)'],
      icon: productIcon(deal.category),
      cat: 'Flash deal',
      catColor: colors.greenDark,
      title: deal.title,
      meta: `${deal.price.toLocaleString('fr-FR')} F · K21`,
      tab: 'Eat',
    });
  }
  const biz = restaurants[0];
  if (biz) {
    tiles.push({
      key: `biz-${biz.id}`,
      bg: ['rgba(232,92,26,0.14)'],
      icon: businessIcon(biz.category),
      cat: 'Marchand',
      catColor: colors.terracottaDark,
      title: biz.name,
      meta: biz.arrondissement ?? 'Dakar',
      tab: 'Eat',
    });
  }
  const gig = gigs[0];
  if (gig) {
    tiles.push({
      key: `gig-${gig.id}`,
      bg: ['rgba(247,183,49,0.18)'],
      icon: '💼',
      cat: 'Gig',
      catColor: colors.flagGold,
      title: gig.title,
      meta: `${gig.price.toLocaleString('fr-FR')} F`,
      tab: 'Gigs',
    });
  }
  return tiles;
}


function Pill({ label, active, onPress }) {
  return (
    <PressScale scaleTo={0.94} onPress={onPress} style={[styles.pill, active && styles.pillOn]}>
      <Text style={[styles.pillText, active && styles.pillTextOn]}>{label}</Text>
    </PressScale>
  );
}

function GridTile({ item, delay, onPress }) {
  const entrance = useEntrance(delay, 350, 8);
  const liveDot = useBlink(1000, 0.3);
  return (
    <PressScale scaleTo={0.96} onPress={onPress} style={[styles.dgItem, item.wide && styles.dgItemWide, entrance, { backgroundColor: item.bg[0] }]}>
      <Text style={styles.dgBg}>{item.icon}</Text>
      <View style={styles.dgOverlay} />
      {item.live && <Animated.View style={[styles.dgLiveDot, { opacity: liveDot }]} />}
      <View style={styles.dgBody}>
        <Text style={[styles.dgCat, { color: item.catColor }]}>{item.cat}</Text>
        <Text style={styles.dgTitle} numberOfLines={2}>{item.title}</Text>
        <Text style={styles.dgMeta}>{item.meta}</Text>
      </View>
    </PressScale>
  );
}

function AllTab({ query, onOpenTab, gridItems, loading }) {
  const filtered = gridItems.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <View style={styles.discGrid}>
      {loading && <Text style={styles.noResults}>Chargement…</Text>}
      {!loading && filtered.length === 0 && (
        <Text style={styles.noResults}>
          {query.trim() ? `Rien pour "${query}"` : 'Rien publié pour l’instant — deals, restaurants et gigs de Dakar apparaîtront ici.'}
        </Text>
      )}
      {filtered.map((item, i) => (
        <GridTile key={item.key} item={item} delay={i * 50} onPress={() => onOpenTab(item.tab ?? 'Tout')} />
      ))}
    </View>
  );
}

function FlashCard({ item, delay }) {
  const entrance = useEntrance(delay, 350, 10);
  const discPulse = useScalePulse(1500, 1.08);
  return (
    <Animated.View style={[styles.flashCard, entrance]}>
      <View style={[styles.fcImg, { backgroundColor: item.bg[0] }]}>
        <Text style={{ fontSize: 34 }}>{item.icon}</Text>
        <Animated.View style={[styles.fcDiscount, { transform: [{ scale: discPulse }] }]}>
          <Text style={styles.fcDiscountText}>{item.discount}</Text>
        </Animated.View>
      </View>
      <View style={styles.fcBody}>
        <Text style={styles.fcName}>{item.name}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Text style={styles.fcNew}>{item.price}</Text>
          <Text style={styles.fcOld}>{item.old}</Text>
        </View>
        {item.merchant ? <Text style={styles.fcMerchant} numberOfLines={1}>{item.merchant}</Text> : null}
      <Text style={styles.fcTime}>⏱ {item.time}</Text>
      </View>
    </Animated.View>
  );
}

function RestaurantCard({ item, delay, onRate }) {
  const entrance = useEntrance(delay, 350, 10);
  const [rating, setRating] = useState(0);
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState(false);

  const rate = async (value) => {
    setRating(value);
    try {
      await onRate(item, value);
      setSent(true);
      setOpen(false);
    } catch {
      setRating(0);
    }
  };

  return (
    <Animated.View style={[styles.rgItem, entrance]}>
      <View style={[styles.rgImg, { backgroundColor: item.bg[0] }]}>
        <Text style={{ fontSize: 30 }}>{item.icon}</Text>
      </View>
      <View style={styles.rgBody}>
        <Text style={styles.rgName}>{item.name}</Text>
        <Text style={styles.rgMeta}>{item.meta}</Text>
        {sent ? (
          <Text style={styles.rgRating}>✓ Merci pour ton avis</Text>
        ) : open ? (
          <View style={styles.rgStarsRow}>
            {[1, 2, 3, 4, 5].map((v) => (
              <PressScale key={v} scaleTo={0.85} onPress={() => rate(v)}>
                <Text style={{ fontSize: 16, opacity: v <= rating ? 1 : 0.35 }}>⭐</Text>
              </PressScale>
            ))}
          </View>
        ) : item.ratingAvg != null ? (
          <PressScale scaleTo={0.95} onPress={() => setOpen(true)}>
            <Text style={styles.rgRating}>⭐ {item.ratingAvg} ({item.ratingCount}) · Noter</Text>
          </PressScale>
        ) : (
          <PressScale scaleTo={0.95} onPress={() => setOpen(true)}>
            <Text style={styles.rgRatingEmpty}>Laisse le premier avis →</Text>
          </PressScale>
        )}
      </View>
    </Animated.View>
  );
}

function flashCountdown(expiresAt, now) {
  const ms = new Date(expiresAt) - now;
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m restantes` : `${m} min restantes`;
}

function EatTab() {
  const showToast = useToast();
  const [deals, setDeals] = useState([]);
  const [restaurants, setRestaurants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  // Real countdowns tick — and expired deals drop off without a refresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const rateBusiness = async (item, rating) => {
    try {
      await submitBusinessReview(item.key, { rating });
      showToast(`Avis envoyé : ${rating}★ pour ${item.name} ✓`);
    } catch (err) {
      showToast(err.message ?? 'Avis impossible');
      throw err;
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([getFlashDeals().catch(() => []), getBusinesses('restaurant').catch(() => [])])
      .then(([dealList, bizList]) => {
        if (cancelled) return;
        setDeals(
          (Array.isArray(dealList) ? dealList : [])
            .filter((p) => p.flashPrice != null && p.flashExpiresAt)
            .map((p) => ({
              key: p.id,
              bg: ['rgba(232,92,26,0.14)'],
              icon: productIcon(p.category),
              discount: `-${Math.round((1 - p.flashPrice / p.price) * 100)}%`,
              name: p.title,
              merchant: p.business?.name ?? p.seller?.shopName ?? null,
              price: `${p.flashPrice.toLocaleString('fr-FR')} F`,
              old: `${p.price.toLocaleString('fr-FR')} F`,
              expiresAt: p.flashExpiresAt,
            })),
        );
        setRestaurants(
          (Array.isArray(bizList) ? bizList : []).map((b) => ({
            key: b.id,
            bg: ['rgba(232,92,26,0.14)'],
            icon: businessIcon(b.category),
            name: b.name,
            meta: `${b.category ?? 'Commerce'} · ${b.address ?? b.arrondissement ?? 'Dakar'}`,
            ratingAvg: b.rating?.average ?? null,
            ratingCount: b.rating?.count ?? 0,
          })),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View>
      <View style={styles.flashLabelRow}>
        <Text style={styles.flTitle}>⚡ OFFRES K21</Text>
      </View>
      {loading && <Text style={[styles.noResults, { paddingHorizontal: spacing.huge }]}>Chargement…</Text>}
      {!loading && deals.length === 0 && (
        <Text style={[styles.noResults, { paddingHorizontal: spacing.huge, paddingBottom: spacing.lg }]}>
          Aucune offre flash en ce moment — les commerçants en publient depuis leur espace K21 Business.
        </Text>
      )}
      {deals.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.flashCarousel}>
          {deals
            .map((item) => ({ ...item, time: flashCountdown(item.expiresAt, now) }))
            .filter((item) => item.time)
            .map((item, i) => (
              <FlashCard key={item.key} item={item} delay={i * 50} />
            ))}
        </ScrollView>
      )}

      <View style={styles.restSection}>
        <Text style={styles.restLabel}>Restaurants & commerces</Text>
        {!loading && restaurants.length === 0 && (
          <Text style={[styles.noResults, { textAlign: 'left', paddingVertical: spacing.lg }]}>
            Aucun commerce inscrit pour l’instant.
          </Text>
        )}
        <View style={styles.restGrid}>
          {restaurants.map((item, i) => (
            <RestaurantCard key={item.key} item={item} delay={i * 60} onRate={rateBusiness} />
          ))}
        </View>
      </View>
    </View>
  );
}

function ListRow({ icon, title, meta, tag, tagColor, delay }) {
  const entrance = useEntrance(delay, 350, 8);
  return (
    <Animated.View style={[styles.listRow, entrance]}>
      <View style={styles.listIcon}>
        <Text style={{ fontSize: 20 }}>{icon}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.listTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.listMeta}>{meta}</Text>
      </View>
      {tag && (
        <View style={[styles.listTag, { backgroundColor: `${tagColor}20`, borderColor: `${tagColor}40` }]}>
          <Text style={[styles.listTagText, { color: tagColor }]}>{tag}</Text>
        </View>
      )}
    </Animated.View>
  );
}

function CultureTab({ navigation }) {
  const { country } = useLocale();
  const [items, setItems] = useState([]);
  const [note, setNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    getCultureFeed(country?.code ?? 'SN')
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data?.items) && data.items.length) {
          setItems(data.items);
          setNote(data.message ?? '');
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [country?.code]);

  return (
    <View style={{ paddingHorizontal: spacing.huge, paddingTop: spacing.lg, gap: spacing.sm }}>
      <PressScale scaleTo={0.98} onPress={() => navigation.navigate('Charts')} style={styles.chartsCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.chartsCardEyebrow}>K21 CHARTS · WEY YU 221 BËGG</Text>
          <Text style={styles.chartsCardTitle}>Vote pour ta chanson de la semaine</Text>
          <Text style={styles.chartsCardMeta}>Le classement de la communauté + tendances YouTube Sénégal</Text>
        </View>
        <Text style={styles.chartsCardArrow}>🎶</Text>
      </PressScale>

      <Text style={styles.sectionLabel}>Sport & Culture · {country?.nameEn ?? country?.name ?? 'Local'}</Text>
      {note ? (
        <Text style={[styles.noResults, { textAlign: 'left', paddingVertical: 0, marginBottom: spacing.sm }]}>{note}</Text>
      ) : (
        <Text style={[styles.noResults, { textAlign: 'left', paddingVertical: 0, marginBottom: spacing.sm }]}>
          Aperçu local — sport, culture et musique K21 Charts.
        </Text>
      )}
      {items.length === 0 ? (
        <Text style={[styles.noResults, { textAlign: 'left', paddingVertical: spacing.lg }]}>
          Le programme sport & culture arrive — reviens bientôt.
        </Text>
      ) : null}
      {items.map((item, i) => (
        <ListRow
          key={item.key}
          icon={item.icon}
          title={item.title}
          meta={item.meta}
          tag={item.tag}
          tagColor={item.tag === 'Sport' ? colors.green : colors.terracotta}
          delay={i * 60}
        />
      ))}
    </View>
  );
}

function GigsTab() {
  const [gigs, setGigs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getProducts('gig')
      .then((list) => {
        if (cancelled) return;
        setGigs(
          (Array.isArray(list) ? list : []).map((g) => ({
            key: g.id,
            icon: '💼',
            title: g.title,
            meta: g.description ?? 'Dakar · Flexible',
            pay: `${g.price.toLocaleString('fr-FR')} F`,
          })),
        );
      })
      .catch(() => setGigs([]))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={{ paddingHorizontal: spacing.huge, paddingTop: spacing.lg, gap: spacing.sm }}>
      <Text style={styles.sectionLabel}>Gigs & Hustle</Text>
      {loading && <Text style={styles.noResults}>Chargement…</Text>}
      {!loading && gigs.length === 0 && (
        <Text style={[styles.noResults, { textAlign: 'left' }]}>
          Aucun gig publié — les vendeurs peuvent poster des offres via l’API.
        </Text>
      )}
      {gigs.map((item, i) => (
        <ListRow key={item.key} icon={item.icon} title={item.title} meta={item.meta} tag={item.pay} tagColor={colors.green} delay={i * 60} />
      ))}
    </View>
  );
}

export default function DiscoverScreen({ navigation, route }) {
  const initialTabParam = route.params?.initialTab;
  const initialTab = initialTabParam === 'Events' ? 'Tout' : (initialTabParam ?? 'Tout');
  const [tab, setTab] = useState(initialTab);
  const [query, setQuery] = useState('');
  const [gridItems, setGridItems] = useState([]);
  const [gridLoading, setGridLoading] = useState(true);

  const loadGrid = useCallback(async () => {
    setGridLoading(true);
    try {
      const [deals, restaurants, gigs] = await Promise.all([
        getProducts('deal').catch(() => []),
        getBusinesses('restaurant').catch(() => []),
        getProducts('gig').catch(() => []),
      ]);
      setGridItems(
        buildDiscoverGrid({
          deals: Array.isArray(deals) ? deals : [],
          restaurants: Array.isArray(restaurants) ? restaurants : [],
          gigs: Array.isArray(gigs) ? gigs : [],
        }),
      );
    } catch {
      setGridItems([]);
    } finally {
      setGridLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGrid();
  }, [loadGrid]);

  useEffect(() => {
    if (route.params?.initialTab) {
      setTab(route.params.initialTab === 'Events' ? 'Tout' : route.params.initialTab);
    }
  }, [route.params?.initialTab]);

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.hero}>
          <View style={styles.searchRow}>
            <Text style={{ fontSize: 12 }}>🔍</Text>
            <TextInput accessibilityLabel="Chercher..."
              style={styles.searchInput}
              placeholder="Chercher..."
              placeholderTextColor={'rgba(5,8,5,0.4)'}
              value={query}
              onChangeText={setQuery}
            />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillsRow}>
            {TABS.map((label) => (
              <Pill key={label} label={label} active={tab === label} onPress={() => setTab(label)} />
            ))}
          </ScrollView>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: spacing.giant }} showsVerticalScrollIndicator={false}>
          {tab === 'Tout' && <AllTab query={query} onOpenTab={setTab} gridItems={gridItems} loading={gridLoading} />}
          {tab === 'Culture' && <CultureTab navigation={navigation} />}
          {tab === 'Eat' && <EatTab />}
          {tab === 'Gigs' && <GigsTab />}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },

  hero: { paddingHorizontal: 15, paddingTop: spacing.xl },
  searchRow: { height: 36, maxWidth: 180, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.09)', borderRadius: radius.round, paddingHorizontal: spacing.xl, marginBottom: spacing.xl },
  searchText: { fontSize: 11, color: 'rgba(5,8,5,0.45)' },
  searchInput: { flex: 1, fontSize: 11, color: colors.ink },
  noResults: { width: '100%', textAlign: 'center', fontSize: 12, color: 'rgba(5,8,5,0.45)', paddingVertical: spacing.giant },
  pillsRow: { gap: 7, paddingBottom: spacing.xl },

  pill: { height: 32, paddingHorizontal: spacing.xxl, borderRadius: radius.round, backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: colors.ink },
  pillText: { fontFamily: fontFamily.bodyBold, fontSize: 10, color: 'rgba(5,8,5,0.55)' },
  pillTextOn: { color: colors.green },

  discGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: spacing.xxl, paddingTop: spacing.lg, gap: spacing.md },
  dgItem: { width: '48.5%', aspectRatio: 1, borderRadius: radius.xxl, overflow: 'hidden', justifyContent: 'flex-end', position: 'relative' },
  dgItemWide: { width: '100%', aspectRatio: 2 },
  dgBg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, fontSize: 44, textAlign: 'center', textAlignVertical: 'center' },
  dgOverlay: { position: 'absolute', inset: 0, backgroundColor: 'transparent' },
  dgLiveDot: { position: 'absolute', top: 8, right: 8, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.terracotta, borderWidth: 2, borderColor: 'rgba(255,255,255,0.6)' },
  dgBody: { padding: 9 },
  dgCat: { fontSize: 7, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2, opacity: 0.9 },
  dgTitle: { fontSize: 11, fontWeight: '700', color: colors.ink, lineHeight: 14 },
  dgMeta: { fontSize: 8, color: 'rgba(5,8,5,0.7)', marginTop: 2 },

  flashLabelRow: { paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg, marginBottom: spacing.md },
  flTitle: { fontSize: 8, fontWeight: '700', letterSpacing: 1.5, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase' },
  flTimer: { backgroundColor: colors.terracottaA10, borderWidth: 1, borderColor: 'rgba(232,92,26,0.3)', borderRadius: radius.round, paddingHorizontal: spacing.lg, paddingVertical: 3 },
  flTimerText: { fontSize: 9, fontWeight: '700', color: colors.terracotta },
  flashCarousel: { gap: 9, paddingHorizontal: 15, paddingBottom: spacing.xl },
  flashCard: { width: 130, borderRadius: radius.xxxl - 3, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.09)' },
  fcImg: { height: 72, alignItems: 'center', justifyContent: 'center' },
  fcDiscount: { position: 'absolute', top: 6, left: 6, backgroundColor: colors.terracotta, borderRadius: 7, paddingHorizontal: spacing.md, paddingVertical: 2 },
  fcDiscountText: { fontFamily: fontFamily.displayBlack, fontSize: 9, color: colors.ink },
  fcBody: { padding: 9 },
  fcName: { fontSize: 10, fontWeight: '700', color: colors.ink, marginBottom: 2 },
  fcNew: { fontSize: 11, fontWeight: '700', color: colors.greenDark },
  fcOld: { fontSize: 9, color: 'rgba(5,8,5,0.45)', textDecorationLine: 'line-through' },
  fcTime: { fontSize: 8, color: colors.terracotta, marginTop: 3, fontWeight: '600' },
  fcMerchant: { fontSize: 8, color: 'rgba(5,8,5,0.5)', marginTop: 1 },

  restSection: { paddingHorizontal: 15, paddingTop: spacing.lg },
  restLabel: { fontSize: 8, fontWeight: '700', letterSpacing: 1.5, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', marginBottom: spacing.lg },
  restGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  rgItem: { width: '48.5%', backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', borderRadius: radius.xl, overflow: 'hidden' },
  rgImg: { height: 58, alignItems: 'center', justifyContent: 'center' },
  rgBody: { padding: 9 },
  chartsCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, backgroundColor: 'rgba(250,216,54,0.16)', borderWidth: 1.5, borderColor: 'rgba(232,146,10,0.3)', borderRadius: radius.xxl, borderBottomRightRadius: 10, padding: spacing.xxl, marginBottom: spacing.md },
  chartsCardEyebrow: { fontSize: 8, fontWeight: '700', letterSpacing: 1.2, color: colors.goldDark, textTransform: 'uppercase', marginBottom: 3 },
  chartsCardTitle: { fontFamily: fontFamily.displayBold, fontSize: 13, color: colors.ink, marginBottom: 3 },
  chartsCardMeta: { fontSize: 10, color: 'rgba(5,8,5,0.55)' },
  chartsCardArrow: { fontSize: 26 },
  rgName: { fontSize: 11, fontWeight: '700', color: colors.ink, marginBottom: 2 },
  rgMeta: { fontSize: 9, color: 'rgba(5,8,5,0.5)' },
  rgRating: { color: colors.goldDark, fontSize: 9, fontWeight: '700', marginTop: 2 },
  rgRatingEmpty: { color: colors.greenDark, fontSize: 9, fontWeight: '700', marginTop: 2 },
  rgStarsRow: { flexDirection: 'row', gap: 2, marginTop: 2 },

  ehcCard: { marginHorizontal: 14, marginTop: spacing.lg, marginBottom: spacing.lg, borderRadius: radius.xxxl + 2, overflow: 'hidden', height: 140, position: 'relative', backgroundColor: 'rgba(255,255,255,0.85)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)' },
  ehcBg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, fontSize: 72, textAlign: 'center', textAlignVertical: 'center' },
  ehcOverlay: { position: 'absolute', inset: 0, backgroundColor: 'rgba(249,253,244,0.78)' },
  ehcLive: { position: 'absolute', top: 10, left: 10, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.terracotta, borderRadius: radius.round, paddingHorizontal: spacing.md, paddingVertical: 3 },
  ldDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.white },
  ehcLiveText: { fontSize: 8, fontWeight: '700', color: colors.white },
  ehcBody: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: spacing.xl },
  ehcCat: { fontSize: 7, fontWeight: '700', color: colors.greenDark, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  ehcTitle: { fontSize: 13, fontWeight: '700', color: colors.ink, lineHeight: 17, marginBottom: 4 },
  ehcMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  ehcMeta: { fontSize: 9, color: 'rgba(5,8,5,0.7)' },
  ehcPrice: { backgroundColor: colors.green, borderRadius: radius.round, paddingHorizontal: spacing.md, paddingVertical: 2 },
  ehcPriceText: { fontSize: 9, fontWeight: '700', color: colors.ink },

  eventList: { paddingHorizontal: 14, paddingBottom: spacing.xxxl, gap: spacing.md },
  evItem: { flexDirection: 'row', gap: spacing.lg, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', borderRadius: radius.xl, padding: spacing.xl },
  evDateBox: { width: 40, backgroundColor: colors.greenA08, borderWidth: 1, borderColor: colors.greenA18, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md },
  evdDay: { fontFamily: fontFamily.displayBlack, fontSize: 16, color: colors.greenDark, lineHeight: 16 },
  evdMon: { fontSize: 7, fontWeight: '700', color: 'rgba(26,240,96,0.6)', textTransform: 'uppercase' },
  evTitle: { fontSize: 12, fontWeight: '700', color: colors.ink },
  evMeta: { fontSize: 9, color: 'rgba(5,8,5,0.5)', marginTop: 2 },
  evPrice: { fontSize: 10, fontWeight: '700', color: colors.goldDark, marginTop: 3 },
  evGoing: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.greenA10, borderWidth: 1.5, borderColor: colors.greenA25, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  evGoingOn: { backgroundColor: colors.green },

  sectionLabel: { ...type.eyebrow, color: 'rgba(5,8,5,0.45)', marginBottom: spacing.sm },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.07)', borderRadius: radius.lg, padding: spacing.xl },
  listIcon: { width: 40, height: 40, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.7)', alignItems: 'center', justifyContent: 'center' },
  listTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  listMeta: { fontSize: 10, color: 'rgba(5,8,5,0.5)', marginTop: 2 },
  listTag: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 4 },
  listTagText: { fontSize: 9, fontWeight: '700' },
});
