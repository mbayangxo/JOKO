import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import { useToast } from '../components/Toast';
import {
  acceptSellerOrder,
  advanceSellerOrder,
  assignShipmentCourier,
  createDeliveryRoute,
  getBusinessMembers,
  getBusinessShipments,
  getMyBusinesses,
  getRouteReconciliation,
  listDeliveryRoutes,
  listSellerOrders,
} from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { PROOF, SHIPMENT_STATUS } from '../lib/logistics-ux';
import { colors, fontFamily, radius, spacing, type } from '../theme';

/**
 * J8 — the distributor's dispatch desk, on its OWN fleet (neutral: any approved
 * distributor sees exactly this, no privileged path).
 *   Commandes   accept → preparing (picking) → ready → hand-off to a tracked shipment
 *   Expéditions shipments leaving my depot; pick ready ones → one route, one driver
 *   Tournées    routes and their reconciliation (every unit accounted for)
 * Route order is MY order — Jokko does not optimise or predict times.
 */
const PO_STATUS = { submitted: 'Nouvelle', accepted: 'Acceptée — paiement attendu', confirmed: 'Payée / confirmée', preparing: 'En préparation', ready: 'Prête', fulfilment_requested: 'Expédiée (suivie)', delivered: 'Livrée', received: 'Reçue', disputed: 'Litige (écart à la réception)', completed: 'Terminée', rejected: 'Refusée', cancelled: 'Annulée' };
const DRIVER_ROLES = new Set(['fleet_driver', 'fulfillment']);

export default function DispatchScreen({ navigation }) {
  const showToast = useToast();
  const [tab, setTab] = useState('orders');
  const [loading, setLoading] = useState(true);
  const [bizId, setBizId] = useState(null);
  const [orders, setOrders] = useState([]);
  const [ships, setShips] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [selected, setSelected] = useState({});
  const [driver, setDriver] = useState(null);
  const [recon, setRecon] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const b = await getMyBusinesses();
      const id = [...(b.owned ?? []), ...(b.member ?? [])][0]?.id ?? null;
      setBizId(id);
      if (!id) return;
      const [o, s, r, m] = await Promise.all([
        listSellerOrders(id).catch(() => ({ items: [] })),
        getBusinessShipments(id, { side: 'origin' }).catch(() => ({ items: [] })),
        listDeliveryRoutes(id).catch(() => []),
        getBusinessMembers(id).catch(() => []),
      ]);
      setOrders(o.items ?? []);
      setShips(s.items ?? []);
      setRoutes(Array.isArray(r) ? r : []);
      setDrivers((Array.isArray(m) ? m : []).filter((x) => x.status === 'active' && DRIVER_ROLES.has(x.role)));
    } catch (e) {
      showToast(e.message ?? 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [showToast]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const run = async (fn, ok) => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) showToast(ok);
      await load();
      return r;
    } catch (e) {
      showToast(e.message ?? 'Action impossible');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const next = (po) => {
    if (po.status === 'submitted') return run(() => acceptSellerOrder(bizId, po.id), 'Commande acceptée (stock réservé)');
    if (po.status === 'confirmed') return run(() => advanceSellerOrder(bizId, po.id, { to: 'preparing' }), 'Préparation lancée');
    if (po.status === 'preparing') return run(() => advanceSellerOrder(bizId, po.id, { to: 'ready' }), 'Prête à partir');
    if (po.status === 'ready') return run(() => advanceSellerOrder(bizId, po.id, { to: 'fulfilment_requested', fulfilmentMode: 'seller_delivery', tracked: true }), 'Expédition créée — livraison prouvée par le marchand');
    return null;
  };
  const NEXT_LABEL = { submitted: 'Accepter', confirmed: 'Préparer (picking)', preparing: 'Marquer prête', ready: 'Expédier avec suivi' };

  const readyShips = ships.filter((s) => s.status === 'ready_for_pickup');
  const chosen = Object.keys(selected).filter((k) => selected[k]);
  const makeRoute = () => run(async () => {
    const r = await createDeliveryRoute(bizId, { serviceDate: new Date().toISOString(), driverUserId: driver, shipmentIds: chosen });
    setSelected({});
    const failed = r.stops.filter((x) => !x.assigned);
    if (failed.length) showToast(`${failed.length} arrêt(s) non attribué(s)`);
    return r;
  }, 'Tournée créée — chaque marchand reçoit et confirme séparément');
  const assignOne = (s) => run(() => assignShipmentCourier(s.id, driver), 'Livreur attribué');

  if (loading) return <SafeAreaView style={styles.root}><ActivityIndicator style={{ marginTop: 80 }} /></SafeAreaView>;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <PressScale onPress={() => (recon ? setRecon(null) : navigation.goBack())} style={styles.backBtn} accessibilityLabel="Retour"><Text style={styles.big}>‹</Text></PressScale>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{recon ? `Tournée ${recon.route.reference}` : 'Dispatch'}</Text>
          <Text style={styles.subtitle}>{recon ? (recon.closed ? 'Clôturée' : 'En cours') : 'Commandes → expéditions → tournées'}</Text>
        </View>
      </View>
      {!bizId ? <Text style={styles.empty}>Crée d’abord ton entreprise de distribution.</Text> : recon ? (
        <ScrollView contentContainerStyle={styles.list}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Partis : {recon.totals.dispatched} · Reçus : {recon.totals.received}</Text>
            <Text style={styles.meta}>Abîmés {recon.totals.damaged} · Manquants {recon.totals.missing} · Refusés {recon.totals.refused} (revenus au dépôt {recon.totals.refusedBackAtDepot}, en route {recon.totals.refusedInTransit})</Text>
            <Text style={styles.meta}>Retournés au dépôt {recon.totals.returnedToDepot} · Encore en route {recon.totals.inTransit}</Text>
            <Text style={[styles.cardTitle, recon.totals.unaccounted !== 0 && styles.warn]}>Non justifiés : {recon.totals.unaccounted}</Text>
          </View>
          {recon.stops.map((st) => (
            <PressScale key={st.shipmentId} onPress={() => navigation.navigate('Shipment', { shipmentId: st.shipmentId })} style={styles.card}>
              <Text style={styles.cardTitle}>{st.sequence}. {st.reference} — {SHIPMENT_STATUS[st.status] ?? st.status}</Text>
              <Text style={styles.meta}>{st.proof ? `Preuve : ${PROOF[st.proof] ?? st.proof}` : 'Pas encore de preuve'}{st.receiving ? ` · réception ${st.receiving} ${st.received}/${st.dispatched}` : ''}{st.refusalReturn ? ` · refus ${st.refused} → ${st.refusalReturn.backAtDepot} revenus` : ''}</Text>
            </PressScale>
          ))}
        </ScrollView>
      ) : (
        <>
          <View style={styles.tabs}>
            {[['orders', 'Commandes'], ['ships', 'Expéditions'], ['routes', 'Tournées']].map(([k, l]) => (
              <PressScale key={k} onPress={() => setTab(k)} style={[styles.tab, tab === k && styles.tabOn]}><Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{l}</Text></PressScale>
            ))}
          </View>
          <ScrollView contentContainerStyle={styles.list}>
            {tab === 'orders' ? (
              <>
                {orders.length === 0 ? <Text style={styles.empty}>Aucune commande de tes marchands.</Text> : null}
                {orders.map((po) => (
                  <View key={po.id} style={styles.card}>
                    <Text style={styles.cardTitle}>{po.reference} · {formatKori(po.totalKori)}</Text>
                    <Text style={styles.meta}>{PO_STATUS[po.status] ?? po.status} · paiement {po.paymentStatus}{po.deliveryVerified === false ? ' · livraison non vérifiée (déclarée)' : ''}</Text>
                    {NEXT_LABEL[po.status] ? <GlowButton label={busy ? '…' : NEXT_LABEL[po.status]} disabled={busy} onPress={() => next(po)} /> : null}
                    {po.status === 'accepted' && po.paymentTerm === 'due_now' ? <Text style={styles.meta}>En attente du paiement du marchand.</Text> : null}
                  </View>
                ))}
              </>
            ) : null}
            {tab === 'ships' ? (
              <>
                <Text style={styles.section}>Chauffeur</Text>
                {drivers.length === 0 ? <Text style={styles.empty}>Aucun chauffeur dans ton équipe. Ajoute un membre avec le rôle « Chauffeur / livreur de la flotte ».</Text> : null}
                <View style={styles.chips}>
                  {drivers.map((d) => (
                    <PressScale key={d.userId} onPress={() => setDriver(d.userId)} style={[styles.chip, driver === d.userId && styles.chipOn]}>
                      <Text style={[styles.chipText, driver === d.userId && styles.chipTextOn]}>{d.user?.name ?? d.user?.handle ?? 'Membre'}</Text>
                    </PressScale>
                  ))}
                </View>
                <Text style={styles.section}>Prêtes à partir ({readyShips.length})</Text>
                {readyShips.map((s) => (
                  <View key={s.id} style={styles.rowCard}>
                    <PressScale onPress={() => setSelected((x) => ({ ...x, [s.id]: !x[s.id] }))} style={[styles.check, selected[s.id] && styles.checkOn]} accessibilityLabel={`Choisir ${s.reference}`}><Text style={styles.checkText}>{selected[s.id] ? '✓' : ''}</Text></PressScale>
                    <PressScale style={{ flex: 1 }} onPress={() => navigation.navigate('Shipment', { shipmentId: s.id })}>
                      <Text style={styles.cardTitle}>{s.reference}</Text>
                      <Text style={styles.meta}>{s.destination?.area ?? '—'}</Text>
                    </PressScale>
                    <PressScale onPress={() => (driver ? assignOne(s) : showToast('Choisis un chauffeur'))} style={styles.ghostSmall}><Text style={styles.ghostText}>Attribuer</Text></PressScale>
                  </View>
                ))}
                {chosen.length ? <GlowButton label={busy ? '…' : `Créer une tournée (${chosen.length} arrêts)`} disabled={busy || !driver} onPress={makeRoute} /> : null}
                <Text style={styles.section}>En cours / terminées</Text>
                {ships.filter((s) => s.status !== 'ready_for_pickup').map((s) => (
                  <PressScale key={s.id} onPress={() => navigation.navigate('Shipment', { shipmentId: s.id })} style={styles.card}>
                    <Text style={styles.cardTitle}>{s.reference} · {s.destination?.area ?? '—'}</Text>
                    <Text style={styles.meta}>{SHIPMENT_STATUS[s.status] ?? s.status}{s.deliveryProof ? ` · ${PROOF[s.deliveryProof] ?? s.deliveryProof}` : ''}</Text>
                  </PressScale>
                ))}
              </>
            ) : null}
            {tab === 'routes' ? (
              <>
                {routes.length === 0 ? <Text style={styles.empty}>Aucune tournée. Choisis des expéditions prêtes et un chauffeur.</Text> : null}
                {routes.map((r) => (
                  <PressScale key={r.id} onPress={() => run(async () => setRecon(await getRouteReconciliation(bizId, r.id)))} style={styles.card}>
                    <Text style={styles.cardTitle}>{r.reference} · {new Date(r.serviceDate).toLocaleDateString('fr-SN')}</Text>
                    <Text style={styles.meta}>{r.stops.length} arrêts · {r.stops.filter((x) => x.status === 'delivered').length} livrés — toucher pour le rapprochement</Text>
                  </PressScale>
                ))}
              </>
            ) : null}
            <PressScale onPress={load} style={styles.ghost}><Text style={styles.ghostText}>Actualiser</Text></PressScale>
          </ScrollView>
        </>
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
  tabs: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.huge },
  tab: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.appCanvas.border, backgroundColor: colors.appCanvas.surface },
  tabOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  tabText: { ...type.caption, color: colors.ink },
  tabTextOn: { color: colors.green },
  list: { padding: spacing.huge, gap: spacing.md, paddingBottom: 120 },
  section: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink, marginTop: spacing.sm },
  empty: { ...type.body, color: 'rgba(5,8,5,0.6)', padding: spacing.sm },
  card: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.appCanvas.border, gap: spacing.xs },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.appCanvas.border },
  cardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink },
  meta: { ...type.caption, color: 'rgba(5,8,5,0.6)' },
  warn: { color: colors.terracottaDark },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.appCanvas.surface, borderWidth: 1, borderColor: colors.appCanvas.border },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { ...type.caption, color: colors.ink },
  chipTextOn: { color: colors.green },
  check: { width: 28, height: 28, borderRadius: 8, borderWidth: 1, borderColor: colors.appCanvas.border, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.appCanvas.base },
  checkOn: { backgroundColor: colors.green, borderColor: colors.greenDark },
  checkText: { fontFamily: fontFamily.bodyBold, color: colors.ink },
  ghost: { paddingVertical: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.appCanvas.border, alignItems: 'center', backgroundColor: colors.appCanvas.surface },
  ghostSmall: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.appCanvas.border },
  ghostText: { ...type.caption, color: colors.ink },
});
