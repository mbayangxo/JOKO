import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import { useToast } from '../components/Toast';
import { pickProfilePhoto } from '../lib/profile-photo';
import {
  createBusiness,
  createProduct,
  deleteMarketplaceProduct,
  getMerchantCatalog,
  getMyBusinesses,
  getSellerProfile,
  registerSellerProfile,
  updateMarketplaceBusinessSettings,
  updateMarketplaceProduct,
} from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { colors, fontFamily, radius, spacing, type } from '../theme';

function ProductEditor({ product, onSave, onDelete, brandMode }) {
  const [inventory, setInventory] = useState(String(product.inventory ?? 0));
  const [price, setPrice] = useState(String(product.price ?? ''));
  const [b2bPrice, setB2bPrice] = useState(product.b2bPrice != null ? String(product.b2bPrice) : '');
  const [b2bMinQty, setB2bMinQty] = useState(String(product.b2bMinQty ?? 1));
  const [unitLabel, setUnitLabel] = useState(product.unitLabel ?? '');
  const [saleChannel, setSaleChannel] = useState(product.saleChannel ?? 'both');
  const [allowBackorder, setAllowBackorder] = useState(!!product.allowBackorder);
  const [lowStockThreshold, setLowStockThreshold] = useState(String(product.lowStockThreshold ?? 5));

  return (
    <View style={styles.productCard}>
      <Text style={styles.productTitle}>{product.title}</Text>
      <Text style={[styles.stockLabel, product.outOfStock && styles.stockOut]}>{product.label}</Text>
      <View style={styles.inlineRow}>
        <Text style={styles.miniLbl}>Prix détail (C)</Text>
        <TextInput style={styles.miniInput} keyboardType="number-pad" value={price} onChangeText={setPrice} />
      </View>
      {brandMode ? (
        <>
          <View style={styles.inlineRow}>
            <Text style={styles.miniLbl}>Prix gros (C)</Text>
            <TextInput style={styles.miniInput} keyboardType="number-pad" value={b2bPrice} onChangeText={setB2bPrice} />
          </View>
          <View style={styles.inlineRow}>
            <Text style={styles.miniLbl}>Qté min gros</Text>
            <TextInput style={styles.miniInput} keyboardType="number-pad" value={b2bMinQty} onChangeText={setB2bMinQty} />
          </View>
          <View style={styles.inlineRow}>
            <Text style={styles.miniLbl}>Unité</Text>
            <TextInput accessibilityLabel="sac, carton" style={styles.miniInput} value={unitLabel} onChangeText={setUnitLabel} placeholder="sac, carton…" />
          </View>
          <View style={styles.channelRow}>
            {['b2c', 'b2b', 'both'].map((ch) => (
              <PressScale key={ch} scaleTo={0.95} onPress={() => setSaleChannel(ch)} style={[styles.channelChip, saleChannel === ch && styles.channelChipOn]}>
                <Text style={styles.channelChipText}>{ch}</Text>
              </PressScale>
            ))}
          </View>
        </>
      ) : null}
      <View style={styles.inlineRow}>
        <Text style={styles.miniLbl}>Stock</Text>
        <TextInput style={styles.miniInput} keyboardType="number-pad" value={inventory} onChangeText={setInventory} />
      </View>
      <View style={styles.inlineRow}>
        <Text style={styles.miniLbl}>Alerte bas</Text>
        <TextInput style={styles.miniInput} keyboardType="number-pad" value={lowStockThreshold} onChangeText={setLowStockThreshold} />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.miniLbl}>Accepter sur commande si rupture</Text>
        <Switch value={allowBackorder} onValueChange={setAllowBackorder} trackColor={{ true: colors.green }} />
      </View>
      <View style={styles.cardActions}>
        <PressScale
          scaleTo={0.97}
          onPress={() =>
            onSave({
              price: parseInt(price.replace(/\D/g, ''), 10),
              inventory: parseInt(inventory.replace(/\D/g, ''), 10),
              allowBackorder,
              lowStockThreshold: parseInt(lowStockThreshold.replace(/\D/g, ''), 10),
              ...(brandMode
                ? {
                    b2bPrice: b2bPrice ? parseInt(b2bPrice.replace(/\D/g, ''), 10) : null,
                    b2bMinQty: parseInt(b2bMinQty.replace(/\D/g, ''), 10) || 1,
                    unitLabel: unitLabel.trim() || undefined,
                    saleChannel,
                  }
                : {}),
            })
          }
          style={styles.saveBtn}
        >
          <Text style={styles.saveBtnText}>Enregistrer</Text>
        </PressScale>
        <PressScale scaleTo={0.97} onPress={onDelete} style={styles.delBtn}>
          <Text style={styles.delBtnText}>Retirer</Text>
        </PressScale>
      </View>
    </View>
  );
}

export default function MerchantCatalogScreen({ navigation, route }) {
  const showToast = useToast();
  const brandMode = route.params?.brandMode === true;
  const [loading, setLoading] = useState(true);
  const [businesses, setBusinesses] = useState([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState(null);
  const [products, setProducts] = useState([]);
  const [settings, setSettings] = useState({});
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [inventory, setInventory] = useState('10');
  const [category, setCategory] = useState('grocery');
  const [b2bPrice, setB2bPrice] = useState('');
  const [b2bMinQty, setB2bMinQty] = useState('1');
  const [unitLabel, setUnitLabel] = useState('');
  const [saleChannel, setSaleChannel] = useState('both');
  const [imageUrl, setImageUrl] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const loadCatalog = useCallback(async (businessId) => {
    if (!businessId) return;
    const catalog = await getMerchantCatalog(businessId);
    setProducts(catalog.products ?? []);
    setSettings(catalog.settings ?? {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mine, seller] = await Promise.all([
        getMyBusinesses().catch(() => ({ owned: [], member: [] })),
        getSellerProfile().catch(() => ({ profile: null, businesses: [] })),
      ]);
      const owned = mine?.owned ?? seller?.businesses ?? [];
      setBusinesses(owned);
      const bizId = route.params?.businessId ?? owned[0]?.id ?? null;
      setSelectedBusinessId(bizId);
      if (bizId) await loadCatalog(bizId);
    } finally {
      setLoading(false);
    }
  }, [loadCatalog]);

  useEffect(() => {
    load();
  }, [load]);

  const ensureShop = async () => {
    if (selectedBusinessId) return selectedBusinessId;
    try {
      await registerSellerProfile({ shopName: 'Ma boutique', category: 'grocery' });
    } catch {
      /* profile may exist */
    }
    const biz = await createBusiness({
      name: 'Mon marché',
      type: 'merchant',
      category: 'grocery',
      arrondissement: 'medina',
      address: 'Dakar',
      lat: 14.6892,
      lng: -17.4421,
    });
    setBusinesses((prev) => [...prev, biz]);
    setSelectedBusinessId(biz.id);
    return biz.id;
  };

  const pickPhoto = async () => {
    const uri = await pickProfilePhoto();
    if (uri) setImageUrl(uri);
  };

  const submit = async () => {
    const priceNum = parseInt(price.replace(/\D/g, ''), 10);
    const inv = parseInt(inventory.replace(/\D/g, ''), 10);
    if (!title.trim() || !priceNum || priceNum <= 0) {
      showToast('Titre et prix requis');
      return;
    }
    setSubmitting(true);
    try {
      const businessId = await ensureShop();
      await createProduct({
        businessId,
        title: title.trim(),
        price: priceNum,
        inventory: Number.isFinite(inv) ? inv : 10,
        category,
        imageUrl: imageUrl ?? undefined,
        trackInventory: true,
        ...(brandMode
          ? {
              b2bPrice: b2bPrice ? parseInt(b2bPrice.replace(/\D/g, ''), 10) : undefined,
              b2bMinQty: parseInt(b2bMinQty.replace(/\D/g, ''), 10) || 1,
              unitLabel: unitLabel.trim() || undefined,
              saleChannel,
            }
          : {}),
      });
      showToast('Produit publié ✓');
      setTitle('');
      setPrice('');
      setImageUrl(null);
      await loadCatalog(businessId);
    } catch (err) {
      showToast(err.message ?? 'Publication impossible');
    } finally {
      setSubmitting(false);
    }
  };

  const patchSettings = async (patch) => {
    if (!selectedBusinessId) return;
    try {
      const next = await updateMarketplaceBusinessSettings(selectedBusinessId, patch);
      setSettings(next);
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    }
  };

  const saveProduct = async (productId, patch) => {
    try {
      await updateMarketplaceProduct(productId, patch);
      await loadCatalog(selectedBusinessId);
      showToast('Stock mis à jour ✓');
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    }
  };

  const removeProduct = async (productId) => {
    try {
      await deleteMarketplaceProduct(productId);
      await loadCatalog(selectedBusinessId);
      showToast('Produit retiré');
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 18 }}>←</Text>
          </PressScale>
          <Text style={styles.title}>Mon catalogue</Text>
        </View>

        <View style={styles.navRow}>
          <PressScale scaleTo={0.97} onPress={() => navigation.navigate('MerchantOrders', { businessId: selectedBusinessId, mode: 'merchant' })} style={styles.navChip}>
            <Text style={styles.navChipText}>Commandes</Text>
          </PressScale>
          <PressScale scaleTo={0.97} onPress={() => navigation.navigate('MerchantAnalytics', { businessId: selectedBusinessId })} style={styles.navChip}>
            <Text style={styles.navChipText}>Analytics</Text>
          </PressScale>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.greenDark} style={{ marginTop: 40 }} />
        ) : (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Commerce</Text>
            {businesses.length === 0 ? (
              <Text style={styles.hint}>Aucun commerce — le premier produit créera ton marché.</Text>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bizRow}>
                {businesses.map((b) => {
                  const active = b.id === selectedBusinessId;
                  return (
                    <PressScale
                      key={b.id}
                      scaleTo={0.97}
                      onPress={async () => {
                        setSelectedBusinessId(b.id);
                        await loadCatalog(b.id);
                      }}
                      style={[styles.bizChip, active && styles.bizChipOn]}
                    >
                      <Text style={[styles.bizChipText, active && styles.bizChipTextOn]}>{b.name}</Text>
                    </PressScale>
                  );
                })}
              </ScrollView>
            )}

            {selectedBusinessId ? (
              <View style={styles.settingsBox}>
                <Text style={styles.settingsTitle}>Paramètres commandes</Text>
                <View style={styles.switchRow}>
                  <Text style={styles.miniLbl}>Accepter commandes même si rupture (tout le marché)</Text>
                  <Switch
                    value={!!settings.acceptOrdersWhenOutOfStock}
                    onValueChange={(v) => patchSettings({ acceptOrdersWhenOutOfStock: v })}
                    trackColor={{ true: colors.green }}
                  />
                </View>
                <View style={styles.switchRow}>
                  <Text style={styles.miniLbl}>Suspendre les commandes</Text>
                  <Switch
                    value={!!settings.pauseOrders}
                    onValueChange={(v) => patchSettings({ pauseOrders: v })}
                    trackColor={{ true: colors.terracotta }}
                  />
                </View>
                <View style={styles.switchRow}>
                  <Text style={styles.miniLbl}>Alertes stock bas</Text>
                  <Switch
                    value={settings.lowStockAlertEnabled !== false}
                    onValueChange={(v) => patchSettings({ lowStockAlertEnabled: v })}
                    trackColor={{ true: colors.green }}
                  />
                </View>
              </View>
            ) : null}

            <Text style={[styles.label, { marginTop: spacing.md }]}>Inventaire ({products.length})</Text>
            {products.map((p) => (
              <ProductEditor
                key={p.id}
                product={p}
                brandMode={brandMode}
                onSave={(patch) => saveProduct(p.id, patch)}
                onDelete={() => removeProduct(p.id)}
              />
            ))}

            <Text style={[styles.label, { marginTop: spacing.lg }]}>Nouveau produit</Text>
            <PressScale scaleTo={0.98} onPress={pickPhoto} style={styles.photoBox}>
              {imageUrl ? (
                <Image source={{ uri: imageUrl }} style={styles.photo} />
              ) : (
                <>
                  <Text style={{ fontSize: 32 }}>📷</Text>
                  <Text style={styles.photoHint}>Photo du produit</Text>
                </>
              )}
            </PressScale>
            <TextInput accessibilityLabel="Ex. Riz brisé 1 kg" style={styles.input} value={title} onChangeText={setTitle} placeholder="Ex. Riz brisé 1 kg" placeholderTextColor={colors.appCanvas.textFaint} />
            <TextInput accessibilityLabel="Prix détail (C)" style={styles.input} value={price} onChangeText={setPrice} keyboardType="number-pad" placeholder="Prix détail (C)" placeholderTextColor={colors.appCanvas.textFaint} />
            {brandMode ? (
              <>
                <TextInput accessibilityLabel="Prix gros B2B (C)" style={styles.input} value={b2bPrice} onChangeText={setB2bPrice} keyboardType="number-pad" placeholder="Prix gros B2B (C)" placeholderTextColor={colors.appCanvas.textFaint} />
                <TextInput accessibilityLabel="Quantité min gros" style={styles.input} value={b2bMinQty} onChangeText={setB2bMinQty} keyboardType="number-pad" placeholder="Quantité min gros" placeholderTextColor={colors.appCanvas.textFaint} />
                <TextInput accessibilityLabel="Unité (sac, carton)" style={styles.input} value={unitLabel} onChangeText={setUnitLabel} placeholder="Unité (sac, carton…)" placeholderTextColor={colors.appCanvas.textFaint} />
                <View style={styles.channelRow}>
                  {['b2c', 'b2b', 'both'].map((ch) => (
                    <PressScale key={ch} scaleTo={0.95} onPress={() => setSaleChannel(ch)} style={[styles.channelChip, saleChannel === ch && styles.channelChipOn]}>
                      <Text style={styles.channelChipText}>{ch}</Text>
                    </PressScale>
                  ))}
                </View>
              </>
            ) : null}
            <TextInput accessibilityLabel="Stock initial" style={styles.input} value={inventory} onChangeText={setInventory} keyboardType="number-pad" placeholder="Stock initial" placeholderTextColor={colors.appCanvas.textFaint} />
            <PressScale scaleTo={0.98} onPress={submit} disabled={submitting} style={[styles.submit, submitting && { opacity: 0.6 }]}>
              <Text style={styles.submitText}>{submitting ? 'Publication…' : 'Publier le produit'}</Text>
            </PressScale>
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.huge, paddingVertical: spacing.md },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.appCanvas.surface, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  navRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.huge, marginBottom: spacing.sm },
  navChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: 'rgba(26,240,96,0.12)', borderWidth: 1, borderColor: colors.green },
  navChipText: { fontFamily: fontFamily.bodySemiBold, fontSize: 12, color: colors.greenDark },
  body: { paddingHorizontal: spacing.huge, paddingBottom: 80, gap: spacing.md },
  label: { ...type.caption, color: 'rgba(5,8,5,0.5)' },
  hint: { ...type.bodySmall, color: 'rgba(5,8,5,0.55)' },
  bizRow: { gap: spacing.sm },
  bizChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)' },
  bizChipOn: { backgroundColor: 'rgba(26,240,96,0.12)', borderColor: colors.green },
  bizChipText: { ...type.bodySmall, color: 'rgba(5,8,5,0.6)' },
  bizChipTextOn: { color: colors.greenDark, fontFamily: fontFamily.bodySemiBold },
  settingsBox: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.appCanvas.border, gap: spacing.sm },
  settingsTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  miniLbl: { ...type.bodySmall, color: 'rgba(5,8,5,0.65)', flex: 1 },
  productCard: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.appCanvas.border, gap: spacing.sm },
  productTitle: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  stockLabel: { ...type.caption, color: colors.greenDark },
  stockOut: { color: colors.terracotta },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  channelRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  channelChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: 'rgba(5,8,5,0.12)' },
  channelChipOn: { backgroundColor: 'rgba(26,240,96,0.12)', borderColor: colors.green },
  channelChipText: { ...type.caption, color: 'rgba(5,8,5,0.6)' },
  miniInput: { flex: 1, ...type.body, backgroundColor: colors.appCanvas.base, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.appCanvas.border, padding: spacing.sm, color: colors.ink },
  cardActions: { flexDirection: 'row', gap: spacing.sm },
  saveBtn: { flex: 1, backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  saveBtnText: { fontFamily: fontFamily.bodySemiBold, fontSize: 12, color: colors.ink },
  delBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(232,92,26,0.4)' },
  delBtnText: { fontFamily: fontFamily.bodySemiBold, fontSize: 12, color: colors.terracotta },
  photoBox: { height: 140, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', gap: spacing.sm },
  photo: { width: '100%', height: '100%' },
  photoHint: { ...type.bodySmall, color: 'rgba(5,8,5,0.5)' },
  input: { ...type.body, color: colors.ink, backgroundColor: colors.appCanvas.surface, borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', padding: spacing.md },
  submit: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.lg, alignItems: 'center', marginTop: spacing.md },
  submitText: { fontFamily: fontFamily.bodySemiBold, color: colors.ink },
});
