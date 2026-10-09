import { useCallback, useState } from 'react';
import { ActivityIndicator, Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRoute } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import { colors, fontFamily, radius, spacing } from '../theme';
import { useEntrance, useScalePulse } from '../hooks/animations';
import { getCommunitySettings, getNotificationsFeed, markAllNotificationsRead, markNotificationRead, saveCommunitySettings } from '../lib/api-client';

/** J10 categories (money and security can never be muted). */
const CATEGORY_LABELS = { money: 'Argent', orders: 'Commandes', deliveries: 'Livraisons', work: 'Travail', community: 'Communauté', school: 'École', security: 'Sécurité' };

const ACCENT_COLORS = { g: colors.green, o: colors.terracotta, r: colors.terracotta, y: colors.flagGold };

function inferKind(notification) {
  if (String(notification.kind ?? '').startsWith('shipment_')) return 'delivery';
  if (String(notification.kind ?? '').startsWith('work_')) return 'work';
  if (notification.kind === 'alert') return 'alert';
  if (notification.kind === 'friend') return 'friend';
  if (notification.kind === 'call') return 'call';
  if (notification.kind === 'gift_receive') return 'gift';
  if (notification.kind === 'affiliate') return 'affiliate';
  if (notification.kind === 'money_request') return 'money';
  const t = `${notification.title} ${notification.body}`
    .toLowerCase()
    .replace(/[''`´]/g, "'");
  if (t.includes("demande d'ami") || t.includes('ajouter sur k21')) return 'friend';
  if (t.includes('appel entrant') || t.includes('appel vidéo') || t.includes('t’appelle sur mboolo')) return 'call';
  if (t.includes('demande')) return 'money';
  if (t.includes('mboolo') || t.includes('message')) return 'mboolo';
  if (t.includes('événement') || t.includes('event') || t.includes('concert')) return 'event';
  if (t.includes('tontine')) return 'tontine';
  if (t.includes('ngor') || t.includes('kersa') || t.includes('wakhna')) return 'ngor';
  return 'generic';
}

function mapNotification(n) {
  const kind = inferKind(n);
  const icons = { delivery: '📦', work: '🧰', money: '💸', gift: '🎁', jekkal: '🤝', affiliate: '🛍️', mboolo: '💬', event: '🎉', tontine: '🏦', ngor: '✦', alert: '🌊', friend: '🧑‍🤝‍🧑', call: '📞', generic: '🔔' };
  const accents = { delivery: 'g', work: 'o', money: 'g', gift: 'g', jekkal: 'o', mboolo: 'r', event: 'o', tontine: 'y', ngor: 'g', alert: 'o', friend: 'g', call: 'o', generic: 'g' };
  const time = new Date(n.createdAt).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return {
    id: n.id,
    key: n.id,
    kind,
    title: n.title,
    unread: !n.read,
    accent: accents[kind],
    icon: icons[kind],
    iconBg: colors.greenA10,
    text: n.body || n.title,
    time,
    action: kind === 'delivery' || kind === 'work' ? 'Voir' : kind === 'money' ? '✓' : kind === 'gift' ? 'Ouvrir' : kind === 'jekkal' ? 'Voir' : kind === 'friend' ? 'Voir' : kind === 'call' ? 'Rejoindre' : kind === 'mboolo' ? 'Répondre' : kind === 'event' || kind === 'alert' ? 'Voir' : null,
    actionStyle: kind === 'money' ? 'g' : 'o',
    refId: n.refId ?? null,
    read: n.read,
  };
}

function NotifItem({ item, delay, onAction }) {
  const entrance = useEntrance(delay, 300, 8);
  const glow = useScalePulse(item.celebrate ? 2000 : 100000, item.celebrate ? 1.01 : 1);

  return (
    <Animated.View style={[styles.item, entrance, item.celebrate && styles.itemCelebrate]}>
      {item.unread && item.accent && <View style={[styles.accentBar, { backgroundColor: ACCENT_COLORS[item.accent] }]} />}
      <View style={[styles.iconWrap, { backgroundColor: item.iconBg }]}>
        <Text style={{ fontSize: 17 }}>{item.icon}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.text}>{item.text}</Text>
        <Text style={styles.time}>{item.time}</Text>
      </View>
      {item.action && (
        <PressScale
          scaleTo={0.9}
          onPress={() => onAction(item)}
          style={[styles.actionBtn, item.actionStyle === 'g' ? styles.actionBtnG : styles.actionBtnO]}
        >
          <Text style={[styles.actionText, item.actionStyle === 'g' && { color: colors.ink }]}>{item.action}</Text>
        </PressScale>
      )}
    </Animated.View>
  );
}

export default function NotificationsScreen({ navigation }) {
  const route = useRoute();
  const isTabRoot = route.name === 'NotificationsTab';
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState(null);
  const [muted, setMuted] = useState([]);

  const load = useCallback(async () => {
    try {
      const feed = await getNotificationsFeed({ category });
      setItems((feed?.items ?? []).map(mapNotification));
      getCommunitySettings().then((st) => setMuted(st.mutedCategories ?? [])).catch(() => {});
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [category]);

  const markAll = async () => {
    try {
      await markAllNotificationsRead(category ?? undefined);
      setItems((prev) => prev.map((n) => ({ ...n, unread: false, read: true })));
    } catch {
      /* ignore */
    }
  };
  const toggleMute = async (c) => {
    const next = muted.includes(c) ? muted.filter((x) => x !== c) : [...muted, c];
    try {
      const st = await saveCommunitySettings({ mutedCategories: next });
      setMuted(st.mutedCategories ?? []);
    } catch {
      /* ignore */
    }
  };

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load]),
  );

  const handleAction = async (item) => {
    try {
      if (!item.read) await markNotificationRead(item.id);
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, unread: false } : n)));
    } catch {
      /* ignore mark read errors */
    }

    switch (item.kind) {
      case 'delivery':
        if (item.refId) navigation.navigate('Shipment', { shipmentId: item.refId });
        break;
      case 'work':
        navigation.navigate('Work');
        break;
      case 'mboolo':
        navigation.navigate('Main', { screen: 'MbooloTab' });
        break;
      case 'event':
        navigation.navigate('Main', {
          screen: 'MarketplaceTab',
          params: { screen: 'Discover', params: { initialTab: 'Culture' } },
        });
        break;
      case 'alert':
        if (item.refId) {
          navigation.navigate('Main', {
            screen: 'MarketplaceTab',
            params: { screen: 'AlertDetail', params: { alertId: item.refId } },
          });
        } else {
          navigation.navigate('Main', {
            screen: 'MarketplaceTab',
            params: { screen: 'Trending', params: { initialTab: 'alerts' } },
          });
        }
        break;
      case 'money':
        navigation.navigate('Receive', { mode: 'inbox', requestId: item.refId ?? undefined });
        break;
      case 'gift':
        navigation.navigate('GiftReveal', { reference: item.refId });
        break;
      case 'jekkal':
        if (item.refId) navigation.navigate('JekkalDetail', { campaignId: item.refId });
        else navigation.navigate('Jekkal');
        break;
      case 'affiliate':
        navigation.navigate('Affiliate');
        break;
      case 'friend':
        navigation.navigate('Friends');
        break;
      case 'call':
        if (item.refId) {
          navigation.navigate('Call', {
            threadId: item.refId,
            title: 'Mboolo',
            video: /vidéo|video/i.test(`${item.title ?? ''} ${item.text ?? ''}`),
            ring: false,
          });
        } else {
          navigation.navigate('Main', { screen: 'MbooloTab' });
        }
        break;
      case 'tontine':
        navigation.navigate('Tontine');
        break;
      case 'ngor':
      case 'kersa':
      case 'wakhna':
        navigation.navigate('Main', { screen: 'MoiTab' });
        break;
      default:
        navigation.navigate('Main', { screen: 'HomeTab' });
        break;
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          {!isTabRoot ? (
            <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn}>
              <Text style={{ fontSize: 14, color: colors.ink }}>←</Text>
            </PressScale>
          ) : (
            <View style={styles.backBtnPlaceholder} />
          )}
          <Text style={styles.title}>Notifications</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{items.filter((n) => n.unread).length || items.length}</Text>
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <PressScale onPress={() => setCategory(null)} style={[styles.chip, !category && styles.chipOn]}><Text style={styles.chipText}>Tout</Text></PressScale>
          {Object.entries(CATEGORY_LABELS).map(([c, label]) => (
            <PressScale key={c} onPress={() => setCategory(c)} style={[styles.chip, category === c && styles.chipOn]} accessibilityLabel={`Filtre ${label}`}>
              <Text style={styles.chipText}>{label}{muted.includes(c) ? ' 🔕' : ''}</Text>
            </PressScale>
          ))}
        </ScrollView>
        <View style={styles.toolsRow}>
          <PressScale onPress={markAll} accessibilityLabel="Tout marquer lu"><Text style={styles.toolText}>Tout marquer lu</Text></PressScale>
          {category && category !== 'money' && category !== 'security' ? (
            <PressScale onPress={() => toggleMute(category)} accessibilityLabel="Couper ou réactiver cette catégorie">
              <Text style={styles.toolText}>{muted.includes(category) ? 'Réactiver' : 'Couper'} « {CATEGORY_LABELS[category]} »</Text>
            </PressScale>
          ) : null}
        </View>

        {loading && (
          <View style={{ padding: spacing.giant, alignItems: 'center' }}>
            <ActivityIndicator color={colors.green} />
          </View>
        )}

        {!loading && items.length === 0 && (
          <Text style={styles.empty}>Aucune notification pour l'instant.</Text>
        )}

        <ScrollView contentContainerStyle={[styles.list, isTabRoot && styles.listTab]} showsVerticalScrollIndicator={false}>
          {items.map((n, i) => (
            <NotifItem key={n.key} item={n} delay={i * 40} onAction={handleAction} />
          ))}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.sm },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.round, borderWidth: 1, borderColor: colors.ink },
  chipOn: { backgroundColor: colors.greenA10 },
  chipText: { fontFamily: fontFamily.bodySemiBold, fontSize: 12, color: colors.ink },
  toolsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  toolText: { fontFamily: fontFamily.bodySemiBold, fontSize: 12, color: colors.green },
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl, paddingHorizontal: spacing.huge, paddingTop: spacing.xxl, paddingBottom: spacing.xl, backgroundColor: colors.greenA08, borderBottomWidth: 1, borderBottomColor: colors.greenA10 },
  backBtn: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', alignItems: 'center', justifyContent: 'center' },
  backBtnPlaceholder: { width: 36, height: 36 },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 16, color: colors.ink, flex: 1 },
  countBadge: { backgroundColor: colors.terracotta, borderRadius: radius.round, paddingHorizontal: spacing.lg, paddingVertical: 3 },
  countText: { fontSize: 10, fontWeight: '700', color: colors.ink },
  empty: { textAlign: 'center', color: 'rgba(5,8,5,0.5)', fontSize: 12, padding: spacing.giant },
  list: { padding: spacing.xxl, gap: spacing.sm },
  listTab: { paddingBottom: 88 },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, borderRadius: radius.xl, padding: spacing.xl, position: 'relative', overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.6)' },
  itemCelebrate: { backgroundColor: 'rgba(250,216,54,0.08)', borderWidth: 1.5, borderColor: 'rgba(250,216,54,0.2)' },
  accentBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  iconWrap: { width: 38, height: 38, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: 11, lineHeight: 16.5, color: 'rgba(5,8,5,0.7)' },
  time: { fontSize: 10, color: 'rgba(5,8,5,0.5)', marginTop: 2 },
  actionBtn: { height: 26, paddingHorizontal: spacing.lg, borderRadius: radius.round, alignItems: 'center', justifyContent: 'center' },
  actionBtnG: { backgroundColor: colors.green },
  actionBtnO: { backgroundColor: colors.terracottaA10, borderWidth: 1, borderColor: colors.terracottaA20 },
  actionText: { fontSize: 9, fontWeight: '700', color: colors.terracotta },
});
