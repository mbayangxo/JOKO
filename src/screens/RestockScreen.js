import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import StepUpOverlay from '../components/StepUpOverlay';
import { useToast } from '../components/Toast';
import {
  getMyBusinesses,
  getReorderSuggestions,
  getRestockSuppliers,
  getSupplierCatalog,
  listRestockOrders,
  payRestockOrder,
  quoteRestock,
  receiveRestockOrder,
  submitRestockOrder,
} from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { colors, fontFamily, radius, spacing, type } from '../theme';

/**
 * J7.11 — phone-first restock: pick a connected supplier, adjust quantities
 * (MOQ / step enforced by the steppers and again by the server), see the
 * SERVER quote, choose a term the supplier granted, submit. Suggestions are
 * pre-filled quantities with their evidence — never an automatic order.
 * Small payloads, one screen, no images.
 */
const STATUS = {
  submitted: 'Envoyée — en attente du fournisseur',
  accepted: 'Acceptée — à payer',
  confirmed: 'Confirmée',
  preparing: 'En préparation',
  ready: 'Prête',
  fulfilment_requested: 'En route / à retirer',
  delivered: 'Livrée — confirme la réception',
  received: 'Reçue',
  completed: 'Terminée',
  rejected: 'Refusée',
  cancelled: 'Annulée',
  disputed: 'Litige ouvert',
};
const TERM = { due_now: 'Payer maintenant', net7: 'À 7 jours', net15: 'À 15 jours', net30: 'À 30 jours', net60: 'À 60 jours', net90: 'À 90 jours' };
const newKey = () => `rs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function Stepper({ item, packs, onChange }) {
  const dec = () => onChange(packs <= item.moqPacks ? 0 : packs - item.stepPacks);
  const inc = () => onChange(packs === 0 ? item.moqPacks : packs + item.stepPacks);
  return (
    <View style={styles.qtyRow}>
      <PressScale scaleTo={0.9} onPress={dec} style={styles.qtyBtn} accessibilityLabel={`Moins ${item.title}`}>
        <Text style={styles.qtyBtnText}>−</Text>
      </PressScale>
      <Text style={styles.qtyVal}>{packs}</Text>
      <PressScale scaleTo={0.9} onPress={inc} style={styles.qtyBtn} accessibilityLabel={`Plus ${item.title}`}>
        <Text style={styles.qtyBtnText}>+</Text>
      </PressScale>
    </View>
  );
}

export default function RestockScreen({ navigation }) {
  const showToast = useToast();
  const [loading, setLoading] = useState(true);
  const [bizId, setBizId] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [supplier, setSupplier] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [cart, setCart] = useState({});
  const [quote, setQuote] = useState(null);
  const [term, setTerm] = useState('due_now');
  const [busy, setBusy] = useState(false);
  const [payTarget, setPayTarget] = useState(null);
  const submitKey = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const mine = await getMyBusinesses();
      const id = [...(mine.owned ?? []), ...(mine.member ?? [])][0]?.id ?? null;
      setBizId(id);
      if (id) {
        const [s, o] = await Promise.all([getRestockSuppliers(id), listRestockOrders(id)]);
        setSuppliers(s.suppliers ?? []);
        setOrders(o.items ?? []);
      }
    } catch (e) {
      showToast(e.message ?? 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [showToast]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openSupplier = async (s) => {
    setSupplier(s);
    setQuote(null);
    setCart({});
    try {
      const [c, r] = await Promise.all([getSupplierCatalog(bizId, s.supplierBusinessId), getReorderSuggestions(bizId, s.supplierBusinessId)]);
      setCatalog(c.items ?? []);
      setSuggestions(r.suggestions ?? []);
    } catch (e) {
      showToast(e.message ?? 'Catalogue indisponible');
    }
  };

  const lines = Object.entries(cart).filter(([, p]) => p > 0).map(([listingId, packs]) => ({ listingId, packs }));
  const setPacks = (id, p) => {
    setCart((c) => ({ ...c, [id]: Math.max(0, p) }));
    setQuote(null);
  };
  const applySuggestions = () => {
    const next = { ...cart };
    for (const s of suggestions) next[s.listingId] = s.suggestedPacks;
    setCart(next);
    setQuote(null);
  };

  const getQuote = async () => {
    if (!lines.length) return showToast('Ajoute au moins un article');
    setBusy(true);
    try {
      const q = await quoteRestock(bizId, { sellerBusinessId: supplier.supplierBusinessId, lines });
      setQuote(q);
      setTerm(q.terms.includes(term) ? term : 'due_now');
      submitKey.current = newKey(); // one key for every retry of THIS order
    } catch (e) {
      showToast(e.message ?? 'Devis impossible');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const po = await submitRestockOrder(bizId, { sellerBusinessId: supplier.supplierBusinessId, lines, paymentTerm: term, expectedTotalKori: quote.totalKori }, { idempotencyKey: submitKey.current });
      showToast(`Commande ${po.reference} envoyée`);
      setSupplier(null);
      setQuote(null);
      setCart({});
      load();
    } catch (e) {
      if (e.code === 'price_changed') {
        setQuote(null);
        showToast('Le prix a changé — revois le devis');
      } else {
        showToast(e.message ?? 'Commande impossible');
      }
    } finally {
      setBusy(false);
    }
  };

  const pay = async (po, stepUpToken) => {
    try {
      await payRestockOrder(bizId, po.id, po.totalKori, { stepUpToken, idempotencyKey: `pay-${po.id}` });
      showToast('Paiement envoyé ✓');
      load();
    } catch (e) {
      if (e.code === 'step_up_required') return setPayTarget(po);
      showToast(e.message ?? 'Paiement impossible');
    }
  };
  const receive = async (po) => {
    try {
      await receiveRestockOrder(bizId, po.id, 'receive');
      showToast('Réception confirmée');
      load();
    } catch (e) {
      showToast(e.message ?? 'Action impossible');
    }
  };

  if (loading) {
    return <SafeAreaView style={styles.root}><ActivityIndicator style={{ marginTop: 80 }} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <PressScale onPress={() => (supplier ? setSupplier(null) : navigation.goBack())} style={styles.backBtn} accessibilityLabel="Retour">
          <Text style={styles.qtyBtnText}>‹</Text>
        </PressScale>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{supplier ? supplier.name : 'Réapprovisionner'}</Text>
          <Text style={styles.subtitle}>{supplier ? `Crédit disponible ${formatKori(supplier.availableCreditKori)}` : 'Tes fournisseurs connectés'}</Text>
        </View>
      </View>

      {!bizId ? (
        <Text style={styles.empty}>Crée d’abord ton commerce pour commander en gros.</Text>
      ) : !supplier ? (
        <ScrollView contentContainerStyle={styles.list}>
          {suppliers.length === 0 ? <Text style={styles.empty}>Aucun fournisseur connecté. Un distributeur peut t’inviter ; tu acceptes depuis ton commerce.</Text> : null}
          {suppliers.map((s) => (
            <PressScale key={s.supplierBusinessId} onPress={() => (s.accepting ? openSupplier(s) : showToast('Ce fournisseur ne prend pas de commande pour le moment'))} style={styles.card}>
              <Text style={styles.cardTitle}>{s.name}{s.verified ? ' ✓' : ''}</Text>
              <Text style={styles.meta}>{s.terms.map((t) => TERM[t] ?? t).join(' · ')}{s.openOrders ? ` · ${s.openOrders} en cours` : ''}</Text>
            </PressScale>
          ))}
          {orders.length ? <Text style={styles.section}>Mes commandes</Text> : null}
          {orders.map((po) => (
            <View key={po.id} style={styles.card}>
              <Text style={styles.cardTitle}>{po.reference} · {formatKori(po.totalKori)}</Text>
              <Text style={styles.meta}>{STATUS[po.status] ?? po.status} · {TERM[po.paymentTerm] ?? po.paymentTerm}</Text>
              {po.status === 'accepted' && po.paymentTerm === 'due_now' ? <GlowButton label={`Payer ${formatKori(po.totalKori)}`} onPress={() => pay(po)} /> : null}
              {po.status === 'delivered' ? <GlowButton label="J’ai reçu la marchandise" onPress={() => receive(po)} /> : null}
            </View>
          ))}
        </ScrollView>
      ) : (
        <>
          <ScrollView contentContainerStyle={styles.list}>
            {suggestions.length ? (
              <PressScale onPress={applySuggestions} style={styles.hint}>
                <Text style={styles.hintText}>Suggestion d’après tes achats passés ({suggestions.length}) — toucher pour pré-remplir. Vérifie ton stock.</Text>
              </PressScale>
            ) : null}
            {catalog.map((it) => (
              <View key={it.listingId} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{it.title}</Text>
                  <Text style={styles.meta}>
                    {formatKori(it.priceKori)} / {it.unit === 'case' ? 'carton' : it.unit === 'pack' ? 'paquet' : 'unité'} de {it.unitsPerPack}
                    {it.moqPacks > 1 ? ` · min ${it.moqPacks}` : ''}{it.availability === 'out_of_stock' ? ' · rupture' : ''}
                  </Text>
                </View>
                {it.availability === 'out_of_stock' ? null : <Stepper item={it} packs={cart[it.listingId] ?? 0} onChange={(p) => setPacks(it.listingId, p)} />}
              </View>
            ))}
          </ScrollView>
          <View style={styles.footer}>
            {quote ? (
              <>
                <Text style={styles.total}>Total {formatKori(quote.totalKori)}</Text>
                <View style={styles.chips}>
                  {quote.terms.map((t) => (
                    <PressScale key={t} onPress={() => setTerm(t)} style={[styles.chip, term === t && styles.chipOn]}>
                      <Text style={[styles.chipText, term === t && styles.chipTextOn]}>{TERM[t] ?? t}</Text>
                    </PressScale>
                  ))}
                </View>
                <GlowButton label={busy ? '…' : 'Envoyer la commande'} onPress={submit} disabled={busy} />
                <Text style={styles.meta}>{term === 'due_now' ? 'Tu paies quand le fournisseur accepte.' : 'Facture à la livraison, selon les conditions du fournisseur.'}</Text>
              </>
            ) : (
              <GlowButton label={busy ? '…' : `Voir le prix (${lines.length})`} onPress={getQuote} disabled={busy || !lines.length} />
            )}
          </View>
        </>
      )}

      <StepUpOverlay
        visible={Boolean(payTarget)}
        onCancel={() => setPayTarget(null)}
        onVerified={(token) => {
          const po = payTarget;
          setPayTarget(null);
          pay(po, token);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.huge },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.appCanvas.surface, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  subtitle: { ...type.caption, color: 'rgba(5,8,5,0.55)', marginTop: 2 },
  list: { padding: spacing.huge, gap: spacing.md, paddingBottom: 160 },
  empty: { ...type.body, color: 'rgba(5,8,5,0.6)', padding: spacing.huge },
  section: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink, marginTop: spacing.lg },
  card: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.appCanvas.border, gap: spacing.sm },
  cardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink },
  meta: { ...type.caption, color: 'rgba(5,8,5,0.55)' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.appCanvas.border },
  hint: { padding: spacing.md, borderRadius: radius.md, backgroundColor: 'rgba(46,125,50,0.08)' },
  hintText: { ...type.caption, color: colors.greenDark },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  qtyBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.appCanvas.base, alignItems: 'center', justifyContent: 'center' },
  qtyBtnText: { fontSize: 20, color: colors.ink },
  qtyVal: { fontFamily: fontFamily.bodyBold, minWidth: 28, textAlign: 'center', fontSize: 16 },
  footer: { padding: spacing.huge, borderTopWidth: 1, borderTopColor: colors.appCanvas.border, backgroundColor: colors.appCanvas.surface, gap: spacing.sm },
  total: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.appCanvas.base, borderWidth: 1, borderColor: colors.appCanvas.border },
  chipOn: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: { ...type.caption, color: colors.ink },
  chipTextOn: { color: '#fff' },
});
