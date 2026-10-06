import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
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
import GlowButton from '../components/GlowButton';
import StepUpOverlay from '../components/StepUpOverlay';
import { useToast } from '../components/Toast';
import { useSecurity } from '../context/SecurityContext';
import { useAppState } from '../state/AppState';
import { coordsFromArrondissement } from '../lib/dakar-coords';
import {
  getBuyerPortalSuppliers,
  getBuyerPortalCatalog,
  getMyBusinesses,
  getBusinessWallet,
  placeMarketplaceOrder,
} from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { colors, fontFamily, radius, spacing, type } from '../theme';

function ProductRow({ product, qty, onChangeQty }) {
  const wholesale = product.b2bPrice != null && qty >= (product.b2bMinQty ?? 1);
  const unitPrice = wholesale ? product.b2bPrice : product.price;
  const maxQty = Math.max(product.inventory ?? 0, 500);

  return (
    <View style={styles.productRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.productTitle}>{product.title}</Text>
        <Text style={styles.productPrice}>
          {formatKori(unitPrice)}
          {wholesale ? ' · gros' : product.b2bPrice != null ? ` · gros dès ${product.b2bMinQty ?? 1}` : ''}
        </Text>
        {product.unitLabel ? <Text style={styles.productMeta}>{product.unitLabel}</Text> : null}
      </View>
      <View style={styles.qtyRow}>
        <PressScale scaleTo={0.9} onPress={() => onChangeQty(Math.max(0, qty - 1))} style={styles.qtyBtn}>
          <Text style={styles.qtyBtnText}>−</Text>
        </PressScale>
        <Text style={styles.qtyVal}>{qty}</Text>
        <PressScale scaleTo={0.9} onPress={() => onChangeQty(Math.min(maxQty, qty + 1))} style={styles.qtyBtn}>
          <Text style={styles.qtyBtnText}>+</Text>
        </PressScale>
      </View>
    </View>
  );
}

export default function B2BOrderPortalScreen({ navigation }) {
  const showToast = useToast();
  const security = useSecurity();
  const { profile } = useAppState();
  const coords = useMemo(
    () => coordsFromArrondissement(profile?.arrondissement?.key),
    [profile?.arrondissement?.key],
  );

  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState([]);
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [cart, setCart] = useState({});
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [fulfillment, setFulfillment] = useState('delivery');
  const [dropoffArea, setDropoffArea] = useState(profile?.arrondissement?.name ?? 'Dakar');
  const [dropoffAddress, setDropoffAddress] = useState('');
  const [paymentTerm, setPaymentTerm] = useState('immediate');
  const [paymentSource, setPaymentSource] = useState('personal');
  const [buyerBusinessId, setBuyerBusinessId] = useState(null);
  const [myBusinesses, setMyBusinesses] = useState([]);
  const [kebuBalance, setKebuBalance] = useState(null);
  const [preferredDeliveryDate, setPreferredDeliveryDate] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [stepUpVisible, setStepUpVisible] = useState(false);

  const tradeSummary = catalog?.tradeSummary ?? null;

  const loadSuppliers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getBuyerPortalSuppliers();
      setSuppliers(res.suppliers ?? []);
    } catch (err) {
      showToast(err.message ?? 'Erreur');
      setSuppliers([]);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useFocusEffect(
    useCallback(() => {
      loadSuppliers();
    }, [loadSuppliers]),
  );

  useEffect(() => {
    getMyBusinesses()
      .then((res) => {
        const list = [...(res.owned ?? []), ...(res.member ?? [])];
        setMyBusinesses(list);
        if (list.length === 1) setBuyerBusinessId(list[0].id);
      })
      .catch(() => setMyBusinesses([]));
  }, []);

  useEffect(() => {
    if (paymentSource !== 'kebu' || !buyerBusinessId) {
      setKebuBalance(null);
      return;
    }
    getBusinessWallet(buyerBusinessId)
      .then((w) => setKebuBalance(w.wallet?.balance ?? w.balance ?? 0))
      .catch(() => setKebuBalance(null));
  }, [paymentSource, buyerBusinessId]);

  const openSupplier = async (supplier) => {
    setSelectedSupplier(supplier);
    setCatalogLoading(true);
    setCart({});
    setPaymentTerm(supplier.paymentTerm === 'cod' ? 'immediate' : supplier.paymentTerm ?? 'net30');
    try {
      const data = await getBuyerPortalCatalog(supplier.supplierBusinessId);
      setCatalog(data);
      const defaultTerm = data.tradeSummary?.defaultPaymentTerm ?? 'net30';
      setPaymentTerm(defaultTerm === 'cod' ? 'immediate' : defaultTerm);
    } catch (err) {
      showToast(err.message ?? 'Catalogue indisponible');
      setSelectedSupplier(null);
      setCatalog(null);
    } finally {
      setCatalogLoading(false);
    }
  };

  const deliveryDateOptions = useMemo(() => {
    const opts = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 0; i < 14; i += 1) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      opts.push({
        key: d.toISOString().slice(0, 10),
        label:
          i === 0
            ? 'Aujourd’hui'
            : i === 1
              ? 'Demain'
              : d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }),
      });
    }
    return opts;
  }, []);

  const cartItems = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, qty]) => qty > 0)
        .map(([productId, quantity]) => ({ productId, quantity })),
    [cart],
  );

  const totalKori = useMemo(() => {
    const products = catalog?.products ?? [];
    return cartItems.reduce((sum, item) => {
      const p = products.find((x) => x.id === item.productId);
      if (!p) return sum;
      const unit =
        p.b2bPrice != null && item.quantity >= (p.b2bMinQty ?? 1) ? p.b2bPrice : p.price;
      return sum + unit * item.quantity;
    }, 0);
  }, [cartItems, catalog?.products]);

  const payNow = paymentTerm === 'immediate';
  const isCod = paymentTerm === 'cod';
  const isCredit = !payNow && !isCod;
  const confirmLabel =
    paymentSource === 'kebu' && payNow
      ? 'Payer en KEBU'
      : payNow
        ? 'Payer en C'
        : isCod
          ? 'Commander — payer à la livraison'
          : 'Commander à crédit';

  const submitOrder = async (stepUpToken) => {
    if (!selectedSupplier || !cartItems.length) {
      showToast('Ajoute au moins un produit');
      return;
    }
    if (fulfillment === 'delivery' && !dropoffAddress.trim()) {
      showToast('Indique ton adresse de livraison');
      return;
    }
    if (paymentSource === 'kebu' && !buyerBusinessId) {
      showToast('Choisis le commerce KEBU payeur');
      return;
    }
    setSubmitting(true);
    try {
      const deliveryDate =
        fulfillment === 'delivery' ? preferredDeliveryDate ?? deliveryDateOptions[1]?.key : undefined;
      const result = await placeMarketplaceOrder(
        {
          businessId: selectedSupplier.supplierBusinessId,
          items: cartItems,
          fulfillmentType: fulfillment,
          channel: 'b2b',
          paymentTerm,
          paymentSource,
          buyerBusinessId: paymentSource === 'kebu' ? buyerBusinessId : undefined,
          preferredDeliveryDate: deliveryDate,
          dropoff:
            fulfillment === 'delivery'
              ? {
                  area: dropoffArea.trim() || 'Dakar',
                  address: dropoffAddress.trim(),
                  lat: coords.lat,
                  lng: coords.lng,
                }
              : undefined,
        },
        { stepUpToken: stepUpToken ?? security.stepUpToken },
      );
      setCheckoutOpen(false);
      setCart({});
      setSelectedSupplier(null);
      setCatalog(null);
      const msg = result.invoice
        ? `Commande OK — facture ${result.invoice.reference}`
        : paymentTerm === 'cod'
          ? 'Commande OK — paiement à la livraison'
          : 'Commande B2B confirmée ✓';
      showToast(msg);
      loadSuppliers();
    } catch (err) {
      if (err.code === 'step_up_required') {
        setStepUpVisible(true);
        return;
      }
      if (err.code === 'b2b_use_purchase_orders') {
        // D31: new wholesale orders are purchase orders (supplier acceptance, terms, receiving).
        setCheckoutOpen(false);
        navigation.navigate('Restock');
        return;
      }
      showToast(err.message ?? 'Commande impossible');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale
            scaleTo={0.9}
            onPress={() => {
              if (selectedSupplier) {
                setSelectedSupplier(null);
                setCatalog(null);
                setCart({});
              } else {
                navigation.goBack();
              }
            }}
            style={styles.backBtn}
          >
            <Text style={{ fontSize: 16 }}>←</Text>
          </PressScale>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>
              {selectedSupplier ? selectedSupplier.name : 'Portail commandes B2B'}
            </Text>
            {selectedSupplier?.kebuId ? (
              <Text style={styles.subtitle}>KEBU {selectedSupplier.kebuId}</Text>
            ) : (
              <Text style={styles.subtitle}>Tes fournisseurs · crédit · KEBU</Text>
            )}
          </View>
        </View>

        {loading || catalogLoading ? (
          <ActivityIndicator color={colors.green} style={{ marginTop: 40 }} />
        ) : !selectedSupplier ? (
          <ScrollView contentContainerStyle={styles.list}>
            {suppliers.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>Aucun fournisseur B2B</Text>
                <Text style={styles.emptySub}>
                  Demande à ton fournisseur de t’ajouter comme client B2B dans Distribution K21, ou commande
                  depuis une boutique pro.
                </Text>
                <GlowButton label="Parcourir le marché" onPress={() => navigation.navigate('Marche')} />
              </View>
            ) : (
              suppliers.map((s) => (
                <PressScale key={s.supplierBusinessId} scaleTo={0.98} style={styles.supplierCard} onPress={() => openSupplier(s)}>
                  <Text style={styles.supplierName}>{s.name}</Text>
                  <Text style={styles.supplierMeta}>
                    {s.kebuId ? `KEBU ${s.kebuId}` : 'Fournisseur'} · {s.paymentTerm ?? 'net30'}
                    {s.codEnabled ? ' · COD' : ''}
                  </Text>
                  {s.creditLimitFormatted ? (
                    <Text style={styles.supplierMeta}>Crédit {s.creditLimitFormatted}</Text>
                  ) : null}
                </PressScale>
              ))
            )}
          </ScrollView>
        ) : (
          <>
            {tradeSummary?.totalOwed > 0 ? (
              <Text style={styles.creditBanner}>
                Solde ouvert : {tradeSummary.totalOwedFormatted} · {tradeSummary.supplierName}
              </Text>
            ) : null}
            <ScrollView contentContainerStyle={styles.list}>
              {(catalog?.products ?? []).map((p) => (
                <ProductRow
                  key={p.id}
                  product={p}
                  qty={cart[p.id] ?? 0}
                  onChangeQty={(qty) =>
                    setCart((prev) => {
                      const next = { ...prev };
                      if (qty <= 0) delete next[p.id];
                      else next[p.id] = qty;
                      return next;
                    })
                  }
                />
              ))}
            </ScrollView>
            {cartItems.length > 0 ? (
              <View style={styles.footer}>
                <Text style={styles.footerTotal}>{formatKori(totalKori)} · {cartItems.length} ligne(s)</Text>
                <GlowButton label="Passer commande" onPress={() => setCheckoutOpen(true)} />
              </View>
            ) : null}
          </>
        )}
      </SafeAreaView>

      <Modal visible={checkoutOpen} animationType="slide" transparent onRequestClose={() => setCheckoutOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheet}>
            <ScrollView contentContainerStyle={{ gap: spacing.md }}>
              <Text style={styles.sheetTitle}>Commande B2B</Text>

              <View style={styles.termGrid}>
                {['delivery', 'pickup'].map((mode) => (
                  <PressScale
                    key={mode}
                    scaleTo={0.97}
                    onPress={() => setFulfillment(mode)}
                    style={[styles.chip, fulfillment === mode && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, fulfillment === mode && styles.chipTextOn]}>
                      {mode === 'delivery' ? '🛵 Livraison' : '🏪 Retrait'}
                    </Text>
                  </PressScale>
                ))}
              </View>

              <Text style={styles.sheetLabel}>Paiement</Text>
              <View style={styles.termGrid}>
                {[
                  { key: 'immediate', label: 'Comptant' },
                  { key: 'cod', label: 'À la livraison' },
                  { key: 'net15', label: 'Net 15j' },
                  { key: 'net30', label: 'Net 30j' },
                  { key: 'monthly', label: 'Mensuel' },
                ]
                  .filter(
                    (t) =>
                      t.key === 'immediate' ||
                      t.key === 'cod' ||
                      tradeSummary?.allowedPaymentTerms?.includes(t.key),
                  )
                  .map((term) => (
                    <PressScale
                      key={term.key}
                      scaleTo={0.97}
                      onPress={() => setPaymentTerm(term.key)}
                      style={[styles.chip, paymentTerm === term.key && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, paymentTerm === term.key && styles.chipTextOn]}>
                        {term.label}
                      </Text>
                    </PressScale>
                  ))}
              </View>

              {(payNow || isCod) && myBusinesses.length > 0 ? (
                <View style={{ gap: spacing.sm }}>
                  <Text style={styles.sheetLabel}>Source de paiement</Text>
                  <View style={styles.termGrid}>
                    <PressScale
                      scaleTo={0.97}
                      onPress={() => setPaymentSource('personal')}
                      style={[styles.chip, paymentSource === 'personal' && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, paymentSource === 'personal' && styles.chipTextOn]}>
                        Mon C
                      </Text>
                    </PressScale>
                    <PressScale
                      scaleTo={0.97}
                      onPress={() => setPaymentSource('kebu')}
                      style={[styles.chip, paymentSource === 'kebu' && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, paymentSource === 'kebu' && styles.chipTextOn]}>
                        KEBU entreprise
                      </Text>
                    </PressScale>
                  </View>
                  {paymentSource === 'kebu' ? (
                    <>
                      {myBusinesses.map((b) => (
                        <PressScale
                          key={b.id}
                          scaleTo={0.98}
                          onPress={() => setBuyerBusinessId(b.id)}
                          style={[styles.bizRow, buyerBusinessId === b.id && styles.bizRowOn]}
                        >
                          <Text style={styles.bizName}>{b.name}</Text>
                          <Text style={styles.bizMeta}>{b.kebuId ?? b.id.slice(0, 8)}</Text>
                        </PressScale>
                      ))}
                      {kebuBalance != null ? (
                        <Text style={styles.sheetHint}>Solde KEBU : {formatKori(kebuBalance)}</Text>
                      ) : null}
                    </>
                  ) : null}
                </View>
              ) : null}

              {fulfillment === 'delivery' ? (
                <>
                  <Text style={styles.sheetLabel}>Date de livraison</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dateRow}>
                    {deliveryDateOptions.map((opt) => {
                      const active = (preferredDeliveryDate ?? deliveryDateOptions[1]?.key) === opt.key;
                      return (
                        <PressScale
                          key={opt.key}
                          scaleTo={0.96}
                          onPress={() => setPreferredDeliveryDate(opt.key)}
                          style={[styles.dateChip, active && styles.dateChipOn]}
                        >
                          <Text style={[styles.dateChipText, active && styles.dateChipTextOn]}>{opt.label}</Text>
                        </PressScale>
                      );
                    })}
                  </ScrollView>
                  <TextInput
                    style={styles.input}
                    value={dropoffArea}
                    onChangeText={setDropoffArea}
                    placeholder="Quartier"
                    placeholderTextColor="rgba(5,8,5,0.4)"
                  />
                  <TextInput
                    style={[styles.input, { minHeight: 72 }]}
                    value={dropoffAddress}
                    onChangeText={setDropoffAddress}
                    placeholder="Adresse de livraison"
                    placeholderTextColor="rgba(5,8,5,0.4)"
                    multiline
                  />
                </>
              ) : null}

              {isCredit ? (
                <Text style={styles.sheetHint}>Une facture ouverte sera créée — paie depuis Factures B2B.</Text>
              ) : null}

              <Text style={styles.sheetTotal}>Total : {formatKori(totalKori)}</Text>
              <GlowButton
                label={submitting ? '…' : confirmLabel}
                onPress={() => submitOrder()}
                disabled={submitting}
              />
              <PressScale scaleTo={0.98} onPress={() => setCheckoutOpen(false)}>
                <Text style={styles.cancelText}>Annuler</Text>
              </PressScale>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <StepUpOverlay
        visible={stepUpVisible}
        onCancel={() => setStepUpVisible(false)}
        onVerified={(token) => {
          setStepUpVisible(false);
          submitOrder(token);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.huge },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.appCanvas.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  subtitle: { ...type.caption, color: 'rgba(5,8,5,0.55)', marginTop: 2 },
  list: { padding: spacing.huge, gap: spacing.md, paddingBottom: 120 },
  supplierCard: {
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  supplierName: { fontFamily: fontFamily.bodyBold, fontSize: 16, color: colors.ink },
  supplierMeta: { ...type.caption, color: 'rgba(5,8,5,0.55)', marginTop: 4 },
  emptyCard: { gap: spacing.md, padding: spacing.lg },
  emptyTitle: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.ink },
  emptySub: { ...type.body, color: 'rgba(5,8,5,0.6)' },
  creditBanner: {
    marginHorizontal: spacing.huge,
    padding: spacing.md,
    backgroundColor: 'rgba(232,92,26,0.1)',
    borderRadius: radius.md,
    ...type.caption,
    color: colors.terracottaDark,
  },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  productTitle: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  productPrice: { ...type.bodySmall, color: colors.greenDark, marginTop: 2 },
  productMeta: { ...type.caption, color: 'rgba(5,8,5,0.5)' },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  qtyBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.appCanvas.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyBtnText: { fontSize: 18, color: colors.ink },
  qtyVal: { fontFamily: fontFamily.bodyBold, minWidth: 24, textAlign: 'center' },
  footer: {
    padding: spacing.huge,
    borderTopWidth: 1,
    borderTopColor: colors.appCanvas.border,
    backgroundColor: colors.appCanvas.surface,
    gap: spacing.sm,
  },
  footerTotal: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.ink },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '88%',
    backgroundColor: colors.appCanvas.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.huge,
  },
  sheetTitle: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.ink },
  sheetLabel: { ...type.caption, color: 'rgba(5,8,5,0.55)', marginTop: spacing.sm },
  sheetHint: { ...type.caption, color: 'rgba(5,8,5,0.55)' },
  sheetTotal: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.greenDark },
  termGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.appCanvas.base,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  chipOn: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: { ...type.caption, color: colors.ink },
  chipTextOn: { color: '#fff' },
  dateRow: { gap: spacing.sm, paddingVertical: spacing.sm },
  dateChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.appCanvas.base,
  },
  dateChipOn: { backgroundColor: colors.green },
  dateChipText: { ...type.caption, color: colors.ink },
  dateChipTextOn: { color: '#fff' },
  input: {
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    borderRadius: radius.md,
    padding: spacing.md,
    fontFamily: fontFamily.bodyRegular,
    color: colors.ink,
  },
  bizRow: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  bizRowOn: { borderColor: colors.green, backgroundColor: 'rgba(46,125,50,0.08)' },
  bizName: { fontFamily: fontFamily.bodyBold, color: colors.ink },
  bizMeta: { ...type.caption, color: 'rgba(5,8,5,0.5)' },
  cancelText: { textAlign: 'center', ...type.body, color: 'rgba(5,8,5,0.5)', marginTop: spacing.sm },
});
