import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import { useToast } from '../components/Toast';
import { getCourierEarnings, getCourierShipments, payoutCourierEarnings } from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { SHIPMENT_STATUS, newActionKey } from '../lib/logistics-ux';
import { colors, fontFamily, radius, spacing, type } from '../theme';

/**
 * J8 — the courier's desk: work that was ASSIGNED to me (there is no open
 * marketplace to grab from — D41), my earnings by state (accrued → held,
 * releasable, paid), and paying out my own releasable earnings once.
 * Earnings exist only from a verified delivery or a confirmed failure (D37).
 */
const EARNING = { accrued: 'En attente (24 h ou litige)', releasable: 'Disponible', paid: 'Versé', reversed: 'Annulé après litige' };

export default function CourierWorkScreen({ navigation }) {
  const showToast = useToast();
  const [tab, setTab] = useState('work');
  const [loading, setLoading] = useState(true);
  const [work, setWork] = useState([]);
  const [earn, setEarn] = useState(null);
  const [busy, setBusy] = useState(false);
  const payKey = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [w, e] = await Promise.all([getCourierShipments(), getCourierEarnings()]);
      setWork(w.items ?? []);
      setEarn(e);
    } catch (e) {
      showToast(e.message ?? 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [showToast]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const payout = async () => {
    setBusy(true);
    payKey.current = payKey.current ?? newActionKey('payout'); // same key on every retry of THIS payout
    try {
      const r = await payoutCourierEarnings(payKey.current);
      showToast(r.paidKori > 0 ? `${formatKori(r.paidKori)} versés sur ton portefeuille` : 'Rien de disponible pour l’instant');
      payKey.current = null;
      load();
    } catch (e) {
      showToast(/Network|fetch/i.test(e.message ?? '') ? 'Réseau incertain — réessaie : le versement ne sera jamais fait deux fois' : e.message ?? 'Versement impossible');
    } finally {
      setBusy(false);
    }
  };

  const offered = work.filter((w) => w.offered);
  const active = work.filter((w) => !w.offered);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <PressScale onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityLabel="Retour"><Text style={styles.big}>‹</Text></PressScale>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Mes livraisons</Text>
          <Text style={styles.subtitle}>Courses attribuées · preuve à chaque étape</Text>
        </View>
      </View>
      <View style={styles.tabs}>
        {[['work', 'Courses'], ['earn', 'Gains']].map(([k, l]) => (
          <PressScale key={k} onPress={() => setTab(k)} style={[styles.tab, tab === k && styles.tabOn]}><Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{l}</Text></PressScale>
        ))}
      </View>
      {loading ? <ActivityIndicator style={{ marginTop: 40 }} /> : tab === 'work' ? (
        <ScrollView contentContainerStyle={styles.list}>
          {offered.length ? <Text style={styles.section}>Proposées — à accepter ou refuser</Text> : null}
          {offered.map((s) => (
            <PressScale key={s.id} onPress={() => navigation.navigate('Shipment', { shipmentId: s.id })} style={[styles.card, styles.cardOffer]}>
              <Text style={styles.cardTitle}>{s.reference} · {s.destination?.area ?? '—'}</Text>
              <Text style={styles.meta}>{SHIPMENT_STATUS[s.status] ?? s.status}</Text>
            </PressScale>
          ))}
          <Text style={styles.section}>En cours</Text>
          {active.length === 0 ? <Text style={styles.empty}>Aucune course en cours. Les livraisons te sont attribuées par ton dispatch ou par K21 — il n’y a pas de courses libres à prendre.</Text> : null}
          {active.map((s) => (
            <PressScale key={s.id} onPress={() => navigation.navigate('Shipment', { shipmentId: s.id })} style={styles.card}>
              <Text style={styles.cardTitle}>{s.reference} · {s.destination?.area ?? '—'}</Text>
              <Text style={styles.meta}>{SHIPMENT_STATUS[s.status] ?? s.status}{s.handoffPending ? ' · remise à confirmer avec le code' : ''}</Text>
            </PressScale>
          ))}
          <PressScale onPress={load} style={styles.ghost}><Text style={styles.ghostText}>Actualiser</Text></PressScale>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <View style={styles.card}>
            <Text style={styles.meta}>En attente : {formatKori(earn?.accruedKori ?? 0)}</Text>
            <Text style={styles.cardTitle}>Disponible : {formatKori(earn?.releasableKori ?? 0)}</Text>
            <Text style={styles.meta}>Déjà versé : {formatKori(earn?.paidKori ?? 0)}</Text>
            <Text style={styles.meta}>Un gain naît d’une livraison prouvée par le destinataire (ou d’un échec confirmé). Il est retenu 24 h, et gelé pendant un litige.</Text>
          </View>
          <GlowButton label={busy ? '…' : 'Verser le disponible sur mon portefeuille'} disabled={busy || !(earn?.releasableKori > 0)} onPress={payout} />
          <Text style={styles.section}>Historique</Text>
          {(earn?.items ?? []).length === 0 ? <Text style={styles.empty}>Aucun gain pour l’instant.</Text> : null}
          {(earn?.items ?? []).map((e) => (
            <PressScale key={e.shipmentId} onPress={() => navigation.navigate('Shipment', { shipmentId: e.shipmentId })} style={styles.card}>
              <Text style={styles.cardTitle}>{formatKori(e.amountKori)} · {EARNING[e.status] ?? e.status}</Text>
              <Text style={styles.meta}>{e.status === 'accrued' ? `Disponible au plus tôt ${new Date(e.releasableAt).toLocaleString('fr-SN')}` : ' '}</Text>
            </PressScale>
          ))}
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
  tabs: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.huge },
  tab: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.appCanvas.border, backgroundColor: colors.appCanvas.surface },
  tabOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  tabText: { ...type.caption, color: colors.ink },
  tabTextOn: { color: colors.green },
  list: { padding: spacing.huge, gap: spacing.md, paddingBottom: 120 },
  section: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink, marginTop: spacing.sm },
  empty: { ...type.body, color: 'rgba(5,8,5,0.6)' },
  card: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.appCanvas.border, gap: spacing.xs },
  cardOffer: { borderColor: colors.greenDark },
  cardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink },
  meta: { ...type.caption, color: 'rgba(5,8,5,0.6)' },
  ghost: { paddingVertical: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.appCanvas.border, alignItems: 'center', backgroundColor: colors.appCanvas.surface },
  ghostText: { ...type.caption, color: colors.ink },
});
