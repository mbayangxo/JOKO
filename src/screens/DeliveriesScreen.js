import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import { useToast } from '../components/Toast';
import { getBusinessCatalog, getBusinessShipments, getMyBusinesses, getMyShipments, getProductMappings, resolveUnmatchedReceipt } from '../lib/api-client';
import { SHIPMENT_STATUS } from '../lib/logistics-ux';
import { colors, fontFamily, radius, spacing, type } from '../theme';

/**
 * J8 — what is coming to me.
 *   Personal: my deliveries / pickups (status only, area-level; my code is issued on the shipment).
 *   Business: incoming supplier shipments to receive line by line, and goods received
 *   but not yet matched to MY catalogue (D40) — they are in no stock until I choose
 *   which of my own products they are.
 */
export default function DeliveriesScreen({ navigation }) {
  const showToast = useToast();
  const [loading, setLoading] = useState(true);
  const [mine, setMine] = useState([]);
  const [bizId, setBizId] = useState(null);
  const [incoming, setIncoming] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [mapping, setMapping] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const my = await getMyShipments();
      setMine(my.items ?? []);
      const b = await getMyBusinesses();
      const id = [...(b.owned ?? []), ...(b.member ?? [])][0]?.id ?? null;
      setBizId(id);
      if (id) {
        const [inc, maps] = await Promise.all([
          getBusinessShipments(id, { side: 'destination' }).catch(() => ({ items: [] })),
          getProductMappings(id).catch(() => ({ unmatched: [] })),
        ]);
        setIncoming(inc.items ?? []);
        setUnmatched(maps.unmatched ?? []);
      }
    } catch (e) {
      showToast(e.message ?? 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [showToast]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const startMapping = async (receipt) => {
    setMapping(receipt);
    try {
      const c = await getBusinessCatalog(bizId);
      setCatalog((Array.isArray(c) ? c : c.items ?? []).filter((p) => p.kind !== 'service' && p.trackInventory !== false));
    } catch (e) {
      showToast(e.message ?? 'Catalogue indisponible');
    }
  };
  const map = async (product) => {
    try {
      await resolveUnmatchedReceipt(bizId, mapping.id, product.id);
      showToast(`${mapping.units} unité(s) ajoutées à « ${product.title} »`);
      setMapping(null);
      load();
    } catch (e) {
      showToast(e.message ?? 'Association impossible');
    }
  };

  if (loading) return <SafeAreaView style={styles.root}><ActivityIndicator style={{ marginTop: 80 }} /></SafeAreaView>;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <PressScale onPress={() => (mapping ? setMapping(null) : navigation.goBack())} style={styles.backBtn} accessibilityLabel="Retour"><Text style={styles.big}>‹</Text></PressScale>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{mapping ? 'Associer au catalogue' : 'Mes réceptions'}</Text>
          <Text style={styles.subtitle}>{mapping ? `${mapping.sku ?? 'Article fournisseur'} × ${mapping.units}` : 'Livraisons et marchandises à recevoir'}</Text>
        </View>
      </View>
      {mapping ? (
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.meta}>Choisis TON produit. Le stock de ce produit augmente de {mapping.units}, une seule fois, et K21 s’en souviendra pour les prochaines livraisons.</Text>
          {catalog.length === 0 ? <Text style={styles.empty}>Aucun produit suivi en stock dans ton catalogue. Crée-le d’abord dans ton commerce.</Text> : null}
          {catalog.map((p) => (
            <PressScale key={p.id} onPress={() => map(p)} style={styles.card}>
              <Text style={styles.cardTitle}>{p.title}</Text>
              <Text style={styles.meta}>Stock actuel : {p.inventory ?? '—'}{p.sku ? ` · ${p.sku}` : ''}</Text>
            </PressScale>
          ))}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.section}>Pour moi</Text>
          {mine.length === 0 ? <Text style={styles.empty}>Aucune livraison à ton nom.</Text> : null}
          {mine.map((s) => (
            <PressScale key={s.id} onPress={() => navigation.navigate('Shipment', { shipmentId: s.id })} style={styles.card}>
              <Text style={styles.cardTitle}>{s.reference}</Text>
              <Text style={styles.meta}>{SHIPMENT_STATUS[s.status] ?? s.status}</Text>
            </PressScale>
          ))}
          {bizId ? (
            <>
              <Text style={styles.section}>Pour mon commerce</Text>
              {incoming.length === 0 ? <Text style={styles.empty}>Aucune livraison fournisseur en cours.</Text> : null}
              {incoming.map((s) => (
                <PressScale key={s.id} onPress={() => navigation.navigate('Shipment', { shipmentId: s.id })} style={styles.card}>
                  <Text style={styles.cardTitle}>{s.reference}</Text>
                  <Text style={styles.meta}>{SHIPMENT_STATUS[s.status] ?? s.status}{s.status === 'delivery_arrived' ? ' · compte et déclare la réception' : ''}</Text>
                </PressScale>
              ))}
              {unmatched.length ? <Text style={styles.section}>Reçu — à associer à mon catalogue</Text> : null}
              {unmatched.map((u) => (
                <PressScale key={u.id} onPress={() => startMapping(u)} style={[styles.card, styles.cardWarn]}>
                  <Text style={styles.cardTitle}>{u.sku ?? 'Article fournisseur'} × {u.units}</Text>
                  <Text style={styles.meta}>Reçu ({u.shipmentRef}) — pas encore dans ton stock. Toucher pour choisir ton produit.</Text>
                </PressScale>
              ))}
            </>
          ) : null}
          <PressScale onPress={load} style={styles.ghost}><Text style={styles.ghostText}>Actualiser</Text></PressScale>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.huge },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.appCanvas.surface, alignItems: 'center', justifyContent: 'center' },
  big: { fontSize: 20, color: colors.ink },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  subtitle: { ...type.caption, color: 'rgba(5,8,5,0.55)', marginTop: 2 },
  list: { padding: spacing.huge, gap: spacing.md, paddingBottom: 120 },
  section: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink, marginTop: spacing.sm },
  empty: { ...type.body, color: 'rgba(5,8,5,0.6)' },
  card: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.appCanvas.border, gap: spacing.xs },
  cardWarn: { borderColor: colors.goldDark },
  cardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink },
  meta: { ...type.caption, color: 'rgba(5,8,5,0.6)' },
  ghost: { paddingVertical: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.appCanvas.border, alignItems: 'center', backgroundColor: colors.appCanvas.surface },
  ghostText: { ...type.caption, color: colors.ink },
});
