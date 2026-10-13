import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import StoryAvatar from '../components/StoryAvatar';
import { useToast } from '../components/Toast';
import { useAppState } from '../state/AppState';
import { coordsFromArrondissement } from '../lib/dakar-coords';
import { getMarketplaceShop, placeMarketplaceOrder, setBusinessCommunityStatus } from '../lib/api-client';
import { getSeenStatusKeys, markStatusSeen } from '../lib/status-seen-storage';
import { useEntrance, usePopIn } from '../hooks/animations';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import LowDataImage from '../components/LowDataImage';

function statusKey(businessId, c) {
  return `${businessId}:${c.userId}:${c.updatedAt}`;
}

function ProductRow({ product, qty, onChangeQty, onShare, delay = 0 }) {
  const entrance = useEntrance(delay, 300, 10);
  return (
    <Animated.View style={[styles.productRow, entrance]}>
      {product.imageUrl ? (
        <LowDataImage uri={product.imageUrl} style={styles.productImg} />
      ) : (
        <View style={[styles.productImg, styles.productImgPh]}>
          <Text style={{ fontSize: 22 }}>🛒</Text>
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.productTitle} numberOfLines={2}>{product.title}</Text>
        <Text style={styles.productPrice}>{product.effectivePrice?.toLocaleString('fr-FR')} ₭</Text>
        {product.inventory <= 3 ? (
          <Text style={styles.stockLow}>Plus que {product.inventory}</Text>
        ) : null}
      </View>
      {onShare ? (
        <PressScale scaleTo={0.9} onPress={onShare} style={styles.productShareBtn}>
          <Text style={{ fontSize: 14 }}>💬</Text>
        </PressScale>
      ) : null}
      <View style={styles.qtyRow}>
        <PressScale scaleTo={0.9} onPress={() => onChangeQty(Math.max(0, qty - 1))} style={styles.qtyBtn}>
          <Text style={styles.qtyBtnText}>−</Text>
        </PressScale>
        <Text style={styles.qtyVal}>{qty}</Text>
        <PressScale
          scaleTo={0.9}
          onPress={() => onChangeQty(Math.min(product.inventory, qty + 1))}
          style={styles.qtyBtn}
        >
          <Text style={styles.qtyBtnText}>+</Text>
        </PressScale>
      </View>
    </Animated.View>
  );
}

export default function ShopDetailScreen({ navigation, route }) {
  const businessId = route.params?.businessId;
  const showToast = useToast();
  const { profile } = useAppState();
  const coords = useMemo(
    () => coordsFromArrondissement(profile?.arrondissement?.key),
    [profile?.arrondissement?.key],
  );

  const [loading, setLoading] = useState(true);
  const [shop, setShop] = useState(null);
  const [products, setProducts] = useState([]);
  const [communityStatuses, setCommunityStatuses] = useState([]);
  const [communityDraft, setCommunityDraft] = useState('');
  const [communitySaving, setCommunitySaving] = useState(false);
  const [seenKeys, setSeenKeys] = useState(new Set());
  const [viewerIndex, setViewerIndex] = useState(null);
  const headerEntrance = useEntrance(0, 350, 12);
  const communityEntrance = useEntrance(70, 350, 12);
  const storyPopIn = usePopIn(120, 400, 0.6);
  const [cart, setCart] = useState({});
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [fulfillment, setFulfillment] = useState('delivery');
  const [dropoffArea, setDropoffArea] = useState(profile?.arrondissement?.name ?? 'Dakar');
  const [dropoffAddress, setDropoffAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      const data = await getMarketplaceShop(businessId, { lat: coords.lat, lng: coords.lng });
      setShop(data.shop);
      setProducts(Array.isArray(data.products) ? data.products : []);
      setCommunityStatuses(Array.isArray(data.communityStatuses) ? data.communityStatuses : []);
      setCommunityDraft(data.shop?.viewerStatusText ?? '');
    } catch (err) {
      showToast(err.message ?? 'Commerce introuvable');
      navigation.goBack();
    } finally {
      setLoading(false);
    }
  }, [businessId, coords.lat, coords.lng, navigation, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    getSeenStatusKeys().then((keys) => setSeenKeys(new Set(keys)));
  }, []);

  useEffect(() => {
    if (viewerIndex == null) return;
    const active = communityStatuses[viewerIndex];
    if (!active) return;
    const key = statusKey(businessId, active);
    if (seenKeys.has(key)) return;
    markStatusSeen(key).then((next) => setSeenKeys(new Set(next)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerIndex]);

  const advanceStory = (delta) => {
    setViewerIndex((i) => {
      if (i == null) return i;
      const next = i + delta;
      if (next < 0) return i;
      if (next >= communityStatuses.length) return null;
      return next;
    });
  };

  const publishCommunityStatus = async (textOverride) => {
    const text = textOverride ?? communityDraft;
    setCommunitySaving(true);
    try {
      await setBusinessCommunityStatus(businessId, text);
      setCommunityDraft(text.trim());
      await load();
      showToast(text.trim() ? 'Statut publié ✓' : 'Statut effacé');
    } catch (err) {
      showToast(err.message ?? 'Publication impossible');
    } finally {
      setCommunitySaving(false);
    }
  };

  const cartItems = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, qty]) => qty > 0)
        .map(([productId, quantity]) => ({ productId, quantity })),
    [cart],
  );

  const totalKori = useMemo(() => {
    return cartItems.reduce((sum, item) => {
      const p = products.find((x) => x.id === item.productId);
      return sum + (p?.effectivePrice ?? 0) * item.quantity;
    }, 0);
  }, [cartItems, products]);

  const setQty = (productId, qty) => {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[productId];
      else next[productId] = qty;
      return next;
    });
  };

  const submitOrder = async () => {
    if (!cartItems.length) {
      showToast('Ajoute au moins un produit');
      return;
    }
    if (fulfillment === 'delivery' && !dropoffAddress.trim()) {
      showToast('Indique ton adresse de livraison');
      return;
    }
    setSubmitting(true);
    try {
      const result = await placeMarketplaceOrder({
        businessId,
        items: cartItems,
        fulfillmentType: fulfillment,
        dropoff:
          fulfillment === 'delivery'
            ? {
                area: dropoffArea.trim() || 'Dakar',
                address: dropoffAddress.trim(),
                lat: coords.lat,
                lng: coords.lng,
              }
            : undefined,
      });
      setCheckoutOpen(false);
      setCart({});
      const msg =
        fulfillment === 'pickup'
          ? `Commande OK — à retirer chez ${shop?.name}`
          : result.delivery
            ? `Commande OK — livraison ~${result.delivery.deliveryFeeNational?.toLocaleString('fr-FR')} F`
            : 'Commande confirmée ✓';
      showToast(msg);
    } catch (err) {
      showToast(err.message ?? 'Paiement impossible');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <ActivityIndicator color={colors.greenDark} style={{ marginTop: 80 }} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <Animated.View style={[styles.header, headerEntrance]}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={{ fontSize: 18 }}>←</Text>
          </PressScale>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>{shop?.name}</Text>
            <Text style={styles.meta}>
              {[shop?.arrondissement, shop?.distanceLabel, shop?.address].filter(Boolean).join(' · ')}
            </Text>
            {shop?.statusText ? (
              <View style={styles.statusPill}>
                <Text style={styles.statusPillText} numberOfLines={2}>✦ {shop.statusText}</Text>
              </View>
            ) : null}
          </View>
        </Animated.View>

        {(communityStatuses.length > 0 || shop?.viewerCanPostStatus) ? (
          <Animated.View style={[styles.communitySection, communityEntrance]}>
            <Text style={styles.communityLabel}>
              {shop?.type === 'school' ? '🎓 Statuts étudiants' : '✦ Statuts de l’équipe'}
            </Text>
            {communityStatuses.length > 0 ? (
              <PressScale scaleTo={0.94} onPress={() => setViewerIndex(0)} style={styles.storyEntry}>
                <Animated.View style={storyPopIn}>
                  <StoryAvatar
                    photoUrl={shop?.imageUrl}
                    emoji={shop?.type === 'school' ? '🎓' : '🏪'}
                    initial={shop?.name?.[0]?.toUpperCase() ?? '?'}
                    size={60}
                    spin={false}
                    seen={communityStatuses.every((c) => seenKeys.has(statusKey(businessId, c)))}
                  />
                </Animated.View>
                <Text style={styles.storyEntryLabel} numberOfLines={1}>
                  {communityStatuses.length} statut{communityStatuses.length > 1 ? 's' : ''}
                </Text>
              </PressScale>
            ) : null}
            {shop?.viewerCanPostStatus ? (
              <>
                <View style={styles.communityComposer}>
                  <TextInput
                    style={styles.communityInput}
                    value={communityDraft}
                    onChangeText={setCommunityDraft}
                    placeholder={shop?.type === 'school' ? 'Ton statut ici (ex : en cours, inscriptions ouvertes...)' : 'Ton statut ici'}
                    placeholderTextColor={colors.appCanvas.textFaint}
                    maxLength={80}
                  />
                  <PressScale
                    scaleTo={0.95}
                    onPress={() => publishCommunityStatus()}
                    disabled={communitySaving}
                    style={[styles.communityPublishBtn, communitySaving && { opacity: 0.6 }]}
                  >
                    <Text style={styles.communityPublishText}>{communitySaving ? '…' : 'Publier'}</Text>
                  </PressScale>
                </View>
                {communityDraft ? (
                  <PressScale scaleTo={0.95} onPress={() => publishCommunityStatus('')} disabled={communitySaving}>
                    <Text style={styles.communityClear}>Effacer mon statut</Text>
                  </PressScale>
                ) : null}
              </>
            ) : null}
          </Animated.View>
        ) : null}

        <ScrollView contentContainerStyle={styles.body}>
          {products.map((p, i) => (
            <ProductRow
              key={p.id}
              product={p}
              qty={cart[p.id] ?? 0}
              onChangeQty={(q) => setQty(p.id, q)}
              onShare={() => navigation.navigate('MbooloSharePicker', { refType: 'product', refId: p.id, title: p.title })}
              delay={Math.min(i, 8) * 30}
            />
          ))}
        </ScrollView>

        {cartItems.length > 0 ? (
          <View style={styles.footer}>
            <Text style={styles.footerTotal}>{totalKori.toLocaleString('fr-FR')} ₭</Text>
            <PressScale scaleTo={0.98} onPress={() => setCheckoutOpen(true)} style={styles.checkoutBtn}>
              <Text style={styles.checkoutBtnText}>Commander</Text>
            </PressScale>
          </View>
        ) : null}
      </SafeAreaView>

      <Modal visible={checkoutOpen} animationType="slide" transparent onRequestClose={() => setCheckoutOpen(false)}>
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheetCard}>
            <Text style={styles.sheetTitle}>Comment récupérer ?</Text>
            <View style={styles.fulfillmentRow}>
              {['delivery', 'pickup'].map((mode) => {
                const active = fulfillment === mode;
                return (
                  <PressScale
                    key={mode}
                    scaleTo={0.97}
                    onPress={() => setFulfillment(mode)}
                    style={[styles.fulfillmentBtn, active && styles.fulfillmentBtnOn]}
                  >
                    <Text style={[styles.fulfillmentText, active && styles.fulfillmentTextOn]}>
                      {mode === 'delivery' ? '🛵 Livraison' : '🏪 Retrait sur place'}
                    </Text>
                  </PressScale>
                );
              })}
            </View>

            {fulfillment === 'delivery' ? (
              <View style={{ gap: spacing.sm }}>
                <Text style={styles.sheetLabel}>Quartier</Text>
                <TextInput
                  style={styles.sheetInput}
                  value={dropoffArea}
                  onChangeText={setDropoffArea}
                  placeholder="Ex. Médina"
                  placeholderTextColor={colors.appCanvas.textFaint}
                />
                <Text style={styles.sheetLabel}>Adresse</Text>
                <TextInput
                  style={[styles.sheetInput, { minHeight: 72 }]}
                  value={dropoffAddress}
                  onChangeText={setDropoffAddress}
                  placeholder="Rue, repère, téléphone…"
                  placeholderTextColor={colors.appCanvas.textFaint}
                  multiline
                />
                <Text style={styles.sheetHint}>
                  Un livreur K21 verra la course dans Mouvement. Frais de livraison payés à l’acceptation.
                </Text>
              </View>
            ) : (
              <Text style={styles.sheetHint}>
                Paie maintenant en ₭. Retire ta commande directement chez {shop?.name}.
              </Text>
            )}

            <Text style={styles.sheetTotal}>Total produits : {totalKori.toLocaleString('fr-FR')} ₭</Text>

            <View style={styles.sheetActions}>
              <PressScale scaleTo={0.97} onPress={() => setCheckoutOpen(false)} style={styles.sheetCancel}>
                <Text style={styles.sheetCancelText}>Annuler</Text>
              </PressScale>
              <PressScale
                scaleTo={0.97}
                onPress={submitOrder}
                disabled={submitting}
                style={[styles.sheetConfirm, submitting && { opacity: 0.6 }]}
              >
                <Text style={styles.sheetConfirmText}>{submitting ? '…' : 'Payer en ₭'}</Text>
              </PressScale>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={viewerIndex != null}
        animationType="fade"
        transparent
        onRequestClose={() => setViewerIndex(null)}
      >
        {viewerIndex != null && communityStatuses[viewerIndex] ? (
          <View style={styles.storyBackdrop}>
            <View style={styles.storyTapZones}>
              <PressScale scaleTo={1} onPress={() => advanceStory(-1)} style={{ flex: 1 }} />
              <PressScale scaleTo={1} onPress={() => advanceStory(1)} style={{ flex: 1 }} />
            </View>

            <SafeAreaView style={{ flex: 1 }} pointerEvents="box-none">
              <View style={styles.storyProgressRow} pointerEvents="none">
                {communityStatuses.map((_, i) => (
                  <View key={i} style={styles.storyProgressTrack}>
                    <View style={[styles.storyProgressFill, i <= viewerIndex && styles.storyProgressFillOn]} />
                  </View>
                ))}
              </View>

              <View style={styles.storyHeader} pointerEvents="box-none">
                <StoryAvatar
                  photoUrl={communityStatuses[viewerIndex].avatarUrl}
                  emoji={communityStatuses[viewerIndex].avatarEmoji}
                  initial={communityStatuses[viewerIndex].name?.[0]?.toUpperCase() ?? '?'}
                  size={40}
                  ring={false}
                />
                <Text style={styles.storyHeaderName} numberOfLines={1}>{communityStatuses[viewerIndex].name}</Text>
                <PressScale scaleTo={0.9} onPress={() => setViewerIndex(null)} style={styles.storyClose}>
                  <Text style={{ fontSize: 16, color: colors.ink }}>✕</Text>
                </PressScale>
              </View>

              <View style={styles.storyCardWrap} pointerEvents="none">
                <View style={styles.storyCard}>
                  <Text style={styles.storyText}>{communityStatuses[viewerIndex].text}</Text>
                </View>
              </View>
            </SafeAreaView>
          </View>
        ) : null}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.huge,
    paddingVertical: spacing.md,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.appCanvas.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.ink },
  meta: { ...type.bodySmall, color: 'rgba(5,8,5,0.5)' },
  statusPill: {
    marginTop: spacing.sm, alignSelf: 'flex-start',
    backgroundColor: 'rgba(250,216,54,0.16)', borderWidth: 1, borderColor: 'rgba(232,146,10,0.3)',
    borderRadius: radius.round, paddingHorizontal: spacing.lg, paddingVertical: 3,
  },
  statusPillText: { fontFamily: fontFamily.bodyBold, fontSize: 10.5, color: colors.goldDark },
  communitySection: {
    paddingHorizontal: spacing.huge,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  communityLabel: { ...type.caption, fontFamily: fontFamily.bodySemiBold, color: 'rgba(5,8,5,0.55)' },
  storyEntry: { alignItems: 'center', width: 76, gap: spacing.xs, marginBottom: spacing.sm },
  storyEntryLabel: { fontSize: 10, fontFamily: fontFamily.bodyBold, color: colors.ink },
  communityComposer: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  communityInput: {
    flex: 1,
    ...type.bodySmall,
    color: colors.ink,
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  communityPublishBtn: {
    backgroundColor: colors.gold,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  communityPublishText: { fontFamily: fontFamily.bodySemiBold, fontSize: 12, color: colors.ink },
  communityClear: { ...type.caption, color: colors.terracottaDark, alignSelf: 'flex-start' },
  body: { paddingHorizontal: spacing.huge, paddingBottom: 120, gap: spacing.md },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.06)',
  },
  productImg: { width: 64, height: 64, borderRadius: radius.md },
  productImgPh: { backgroundColor: 'rgba(5,8,5,0.05)', alignItems: 'center', justifyContent: 'center' },
  productTitle: { fontFamily: fontFamily.bodySemiBold, color: colors.ink },
  productPrice: { ...type.bodySmall, color: colors.greenDark, marginTop: 2 },
  stockLow: { ...type.caption, color: colors.terracottaDark },
  productShareBtn: { width: 28, height: 28, borderRadius: radius.md, backgroundColor: 'rgba(5,8,5,0.05)', alignItems: 'center', justifyContent: 'center', marginRight: spacing.sm },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  qtyBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(5,8,5,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyBtnText: { fontSize: 18, color: colors.ink },
  qtyVal: { minWidth: 20, textAlign: 'center', fontFamily: fontFamily.bodySemiBold },
  footer: {
    position: 'absolute',
    left: spacing.huge,
    right: spacing.huge,
    bottom: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
  },
  footerTotal: { flex: 1, fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.ink },
  checkoutBtn: {
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  checkoutBtnText: { fontFamily: fontFamily.bodySemiBold, color: colors.ink },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheetCard: {
    backgroundColor: colors.appCanvas.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.huge,
    gap: spacing.md,
    paddingBottom: spacing.giant,
  },
  sheetTitle: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.ink },
  fulfillmentRow: { flexDirection: 'row', gap: spacing.sm },
  fulfillmentBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
    alignItems: 'center',
  },
  fulfillmentBtnOn: { backgroundColor: 'rgba(26,240,96,0.12)', borderColor: colors.green },
  fulfillmentText: { ...type.bodySmall, color: 'rgba(5,8,5,0.6)' },
  fulfillmentTextOn: { color: colors.greenDark, fontFamily: fontFamily.bodySemiBold },
  sheetLabel: { ...type.caption, color: 'rgba(5,8,5,0.5)' },
  sheetInput: {
    ...type.body,
    color: colors.ink,
    backgroundColor: colors.appCanvas.base,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    padding: spacing.md,
  },
  sheetHint: { ...type.bodySmall, color: 'rgba(5,8,5,0.55)', lineHeight: 18 },
  sheetTotal: { fontFamily: fontFamily.bodySemiBold, color: colors.ink },
  sheetActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  sheetCancel: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
  },
  sheetCancelText: { ...type.body, color: colors.ink },
  sheetConfirm: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    backgroundColor: colors.green,
  },
  sheetConfirmText: { fontFamily: fontFamily.bodySemiBold, color: colors.ink },

  storyBackdrop: { flex: 1, backgroundColor: colors.appCanvas.base },
  storyTapZones: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  storyProgressRow: { flexDirection: 'row', gap: spacing.xs, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  storyProgressTrack: { flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(5,8,5,0.1)', overflow: 'hidden' },
  storyProgressFill: { width: 0, height: '100%', backgroundColor: 'rgba(5,8,5,0.15)' },
  storyProgressFillOn: { width: '100%', backgroundColor: colors.green },
  storyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  storyHeaderName: { flex: 1, fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  storyClose: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: colors.appCanvas.surfaceStrong,
    alignItems: 'center', justifyContent: 'center',
  },
  storyCardWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.huge },
  storyCard: {
    width: '100%',
    backgroundColor: colors.appCanvas.surfaceStrong,
    borderRadius: radius.xxl,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    padding: spacing.giant,
    shadowColor: colors.green,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 6,
  },
  storyText: {
    fontFamily: fontFamily.displayBlack,
    fontSize: 20,
    lineHeight: 28,
    color: colors.ink,
    textAlign: 'center',
  },
});
