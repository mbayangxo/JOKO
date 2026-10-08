import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import { useToast } from '../components/Toast';
import {
  acceptShipmentHandoff,
  cancelShipment,
  courierDeliverShipment,
  courierFailShipment,
  courierPickupShipment,
  courierReturnComplete,
  courierReturnStart,
  courierShipmentException,
  courierShipmentStep,
  dropShipmentAtPoint,
  getShipment,
  issueHandoffCode,
  issueShipmentCode,
  openShipmentDispute,
  recordShipmentReceiving,
  releaseShipmentCollection,
  respondToAssignment,
  respondToShipmentFailure,
} from '../lib/api-client';
import { CUSTODY, FAILURE_EVIDENCE, FAILURE_REASONS, PROOF, ROLE_LABEL, SHIPMENT_STATUS, isTerminal, newActionKey } from '../lib/logistics-ux';
import { colors, fontFamily, radius, spacing, type } from '../theme';

/**
 * J8 — one shipment, seen through the caller's role (the SERVER decides the role
 * and shapes the data: only an active courier sees the precise address). Every
 * button is one authorized server transition; nothing here marks anything done
 * locally. Custody codes: the counterpart issues, the other party types it in.
 * A lost response is retried with the SAME key — never a second physical handoff.
 */
const AFTER_PICKUP = ['picked_up', 'in_transit', 'delivery_arrived'];

function CodeCard({ code, expiresInSeconds, label }) {
  return (
    <View style={styles.codeCard} accessibilityLabel={`${label} ${code.split('').join(' ')}`}>
      <Text style={styles.codeMeta}>{label}</Text>
      <Text style={styles.code} selectable>{code}</Text>
      <Text style={styles.codeMeta}>Valable {Math.round(expiresInSeconds / 60)} min · usage unique · ne le donne qu’en main propre</Text>
    </View>
  );
}

function CodeEntry({ label, busy, onSubmit }) {
  const [value, setValue] = useState('');
  return (
    <View style={styles.block}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={(v) => setValue(v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="8 caractères"
        accessibilityLabel={label}
      />
      <GlowButton label={busy ? '…' : 'Valider le code'} disabled={busy || value.length !== 8} onPress={() => onSubmit(value)} />
    </View>
  );
}

function Qty({ label, value, onChange, max }) {
  return (
    <View style={styles.qtyRow}>
      <Text style={[styles.meta, { flex: 1 }]}>{label}</Text>
      <PressScale onPress={() => onChange(Math.max(0, value - 1))} style={styles.qtyBtn} accessibilityLabel={`Moins ${label}`}><Text style={styles.qtyBtnText}>−</Text></PressScale>
      <Text style={styles.qtyVal}>{value}</Text>
      <PressScale onPress={() => onChange(Math.min(max, value + 1))} style={styles.qtyBtn} accessibilityLabel={`Plus ${label}`}><Text style={styles.qtyBtnText}>+</Text></PressScale>
    </View>
  );
}

/** Per-line receiving: every dispatched unit must be accounted for (the server checks it again). */
function ReceivingForm({ lines, atDoor, busy, onSubmit }) {
  const [rows, setRows] = useState(() => Object.fromEntries(lines.map((l) => [l.productId, { received: l.units, damaged: 0, missing: 0, refused: 0 }])));
  const [note, setNote] = useState('');
  const set = (pid, k, v) => setRows((r) => ({ ...r, [pid]: { ...r[pid], [k]: v } }));
  const balanced = lines.every((l) => { const r = rows[l.productId]; return r.received + r.damaged + r.missing + r.refused === l.units; });
  return (
    <View style={styles.block}>
      <Text style={styles.section}>Réception article par article</Text>
      <Text style={styles.meta}>Compte ce qui est réellement arrivé. Ton stock n’augmente que des unités reçues en bon état ; le reste est noté pour le litige / l’avoir.</Text>
      {lines.map((l) => {
        const r = rows[l.productId];
        const left = l.units - (r.received + r.damaged + r.missing + r.refused);
        return (
          <View key={l.productId} style={styles.card}>
            <Text style={styles.cardTitle}>{l.sku ?? l.productId} — {l.units} expédiés</Text>
            <Qty label="Reçus en bon état" value={r.received} max={l.units} onChange={(v) => set(l.productId, 'received', v)} />
            <Qty label="Abîmés" value={r.damaged} max={l.units} onChange={(v) => set(l.productId, 'damaged', v)} />
            <Qty label="Manquants" value={r.missing} max={l.units} onChange={(v) => set(l.productId, 'missing', v)} />
            {atDoor ? <Qty label="Refusés (repartent avec le livreur)" value={r.refused} max={l.units} onChange={(v) => set(l.productId, 'refused', v)} /> : null}
            {left !== 0 ? <Text style={styles.warn}>{left > 0 ? `${left} unité(s) non déclarée(s)` : `${-left} de trop`}</Text> : null}
          </View>
        );
      })}
      <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="Note (facultatif)" maxLength={300} />
      <GlowButton label={busy ? '…' : 'Enregistrer la réception'} disabled={busy || !balanced} onPress={() => onSubmit(lines.map((l) => ({ productId: l.productId, ...rows[l.productId] })), note)} />
    </View>
  );
}

export default function ShipmentScreen({ route, navigation }) {
  const { shipmentId } = route.params ?? {};
  const showToast = useToast();
  const [sh, setSh] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);
  const [panel, setPanel] = useState(null);
  const [text, setText] = useState('');
  const keys = useRef({});

  const load = useCallback(async () => {
    try {
      setSh(await getShipment(shipmentId));
      setError(null);
    } catch (e) {
      setError(e.status === 404 ? 'Cette expédition n’est pas (ou plus) visible pour toi.' : e.message ?? 'Chargement impossible');
    }
  }, [shipmentId]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  /** Run one server transition; an uncertain network result is retried with the same key, never a new handoff. */
  const act = async (name, fn, { ok, keyed = false } = {}) => {
    setBusy(true);
    if (keyed && !keys.current[name]) keys.current[name] = newActionKey(name);
    try {
      const r = await fn(keys.current[name]);
      if (ok) showToast(r?.replayed ? 'Déjà enregistré ✓' : ok);
      delete keys.current[name];
      setPanel(null);
      setText('');
      await load();
      return r;
    } catch (e) {
      if (e.name === 'AbortError' || /Network|fetch/i.test(e.message ?? '')) {
        showToast('Réseau incertain — réessaie : l’action ne sera jamais enregistrée deux fois');
      } else {
        showToast(e.message ?? 'Action impossible');
      }
      return null;
    } finally {
      setBusy(false);
    }
  };
  const issue = async (purpose, label) => {
    const r = await act(`code-${purpose}`, () => issueShipmentCode(shipmentId, purpose));
    if (r?.code) setIssued({ ...r, label });
  };

  if (error) return <SafeAreaView style={styles.root}><Text style={styles.empty}>{error}</Text></SafeAreaView>;
  if (!sh) return <SafeAreaView style={styles.root}><ActivityIndicator style={{ marginTop: 80 }} /></SafeAreaView>;

  const role = sh.role;
  const s = sh.status;
  const iAmCourier = role === 'courier';
  const handoffPending = sh.courier?.handoffPending;
  const lines = sh.lines ?? [];

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <PressScale onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityLabel="Retour"><Text style={styles.qtyBtnText}>‹</Text></PressScale>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{sh.reference}</Text>
          <Text style={styles.subtitle}>{ROLE_LABEL[role] ?? role} · {sh.purpose === 'return' ? 'Retour' : 'Envoi'}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{SHIPMENT_STATUS[s] ?? s}</Text>
          <Text style={styles.meta}>Garde : {CUSTODY[sh.custody] ?? sh.custody}{sh.deliveryProof ? ` · Preuve : ${PROOF[sh.deliveryProof] ?? sh.deliveryProof}` : ''}</Text>
          <Text style={styles.meta}>Destination : {sh.destination?.area ?? '—'}{sh.destination?.precise ? ` · ${sh.destination.precise}` : ''}</Text>
          {sh.failureReason ? <Text style={styles.warn}>Échec déclaré : {FAILURE_REASONS.find((f) => f.key === sh.failureReason)?.label ?? sh.failureReason}{sh.failureEvidence ? ` · ${FAILURE_EVIDENCE[sh.failureEvidence] ?? sh.failureEvidence}` : ' · non confirmé'}</Text> : null}
          {sh.receiving ? <Text style={styles.meta}>Réception : {sh.receiving.outcome} — {sh.receiving.lines.map((l) => `${l.sku ?? ''} ${l.received}/${l.expected}`).join(', ')}</Text> : null}
          {sh.feeKori ? <Text style={styles.meta}>Frais Jokko : {sh.feeKori} ₭ (bloqués jusqu’à la preuve)</Text> : null}
        </View>

        {sh.commercial ? (
          <View style={styles.card}>
            <Text style={styles.section}>Commande {sh.commercial.reference}</Text>
            <Text style={styles.meta}>Commande : {sh.commercial.status} · Paiement : {sh.commercial.paymentStatus}{sh.commercial.paymentTerm !== 'due_now' ? ` (${sh.commercial.paymentTerm})` : ''}{sh.commercial.invoiceId ? ' · facture émise' : ''}</Text>
            <Text style={styles.meta}>La réception des marchandises et le paiement sont deux choses séparées : recevoir ne paie rien, payer ne prouve pas la réception.</Text>
          </View>
        ) : null}
        {issued ? <CodeCard {...issued} /> : null}

        {/* ── courier ── */}
        {iAmCourier && sh.courier && !sh.courier.accepted && ['assigned', 'pickup_arrived'].includes(s) ? (
          <View style={styles.block}>
            <Text style={styles.section}>Course proposée</Text>
            <GlowButton label="Accepter" disabled={busy} onPress={() => act('accept', () => respondToAssignment(shipmentId, true), { ok: 'Course acceptée' })} />
            <PressScale onPress={() => act('decline', () => respondToAssignment(shipmentId, false, 'indisponible'), { ok: 'Course refusée — retour au dispatch' }).then(() => navigation.goBack())} style={styles.ghost}><Text style={styles.ghostText}>Refuser</Text></PressScale>
          </View>
        ) : null}
        {iAmCourier && handoffPending ? <CodeEntry label="Code de remise (donné par l’ancien livreur ou le dispatch)" busy={busy} onSubmit={(c) => act('handoff', () => acceptShipmentHandoff(shipmentId, c), { ok: 'Marchandise prise en charge' })} /> : null}
        {iAmCourier && !handoffPending && s === 'assigned' ? <GlowButton label="Je suis à l’enlèvement" tone="ink" disabled={busy} onPress={() => act('arrive_pickup', () => courierShipmentStep(shipmentId, 'arrive_pickup'), { ok: 'Arrivée notée' })} /> : null}
        {iAmCourier && ['assigned', 'pickup_arrived'].includes(s) ? <CodeEntry label="Code d’enlèvement (donné par l’expéditeur)" busy={busy} onSubmit={(c) => act('pickup', (k) => courierPickupShipment(shipmentId, c, k), { ok: 'Enlèvement confirmé', keyed: true })} /> : null}
        {iAmCourier && !handoffPending && s === 'picked_up' ? <GlowButton label="Je pars" tone="ink" disabled={busy} onPress={() => act('depart', () => courierShipmentStep(shipmentId, 'depart'), { ok: 'En route' })} /> : null}
        {iAmCourier && !handoffPending && ['picked_up', 'in_transit'].includes(s) ? <GlowButton label="Je suis arrivé" tone="ink" disabled={busy} onPress={() => act('arrive_delivery', () => courierShipmentStep(shipmentId, 'arrive_delivery'), { ok: 'Arrivée notée' })} /> : null}
        {iAmCourier && !handoffPending && AFTER_PICKUP.includes(s) ? (
          <>
            <CodeEntry label="Code de livraison (donné par le destinataire)" busy={busy} onSubmit={(c) => act('deliver', (k) => courierDeliverShipment(shipmentId, c, k), { ok: 'Livraison prouvée ✓', keyed: true })} />
            <Text style={styles.meta}>Sans code du destinataire, ce n’est pas une livraison : signale un échec ou une exception.</Text>
            <View style={styles.row}>
              <PressScale onPress={() => setPanel('fail')} style={styles.ghost}><Text style={styles.ghostText}>Échec de livraison</Text></PressScale>
              <PressScale onPress={() => setPanel('exception')} style={styles.ghost}><Text style={styles.ghostText}>Exception</Text></PressScale>
            </View>
          </>
        ) : null}
        {panel === 'fail' ? (
          <View style={styles.block}>
            <Text style={styles.label}>Raison (ta déclaration — elle devra être confirmée)</Text>
            {FAILURE_REASONS.map((f) => (
              <PressScale key={f.key} onPress={() => act('fail', () => courierFailShipment(shipmentId, f.key), { ok: 'Échec noté — garde la marchandise et rapporte-la' })} style={styles.card}>
                <Text style={styles.cardTitle}>{f.label}</Text>
              </PressScale>
            ))}
          </View>
        ) : null}
        {panel === 'exception' ? (
          <View style={styles.block}>
            <Text style={styles.label}>Explique (un opérateur K21 décidera — tu n’es pas payé sur ta seule parole)</Text>
            <TextInput style={styles.input} value={text} onChangeText={setText} multiline maxLength={300} />
            <GlowButton label="Envoyer" disabled={busy || text.trim().length < 10} onPress={() => act('exception', () => courierShipmentException(shipmentId, text.trim()), { ok: 'Exception envoyée' })} />
          </View>
        ) : null}
        {iAmCourier && !handoffPending && s === 'delivery_failed' ? <GlowButton label="Je rapporte la marchandise" disabled={busy} onPress={() => act('return_start', () => courierReturnStart(shipmentId), { ok: 'Retour en route' })} /> : null}
        {iAmCourier && !handoffPending && s === 'return_in_transit' ? <CodeEntry label="Code de retour (donné par l’expéditeur)" busy={busy} onSubmit={(c) => act('return_complete', (k) => courierReturnComplete(shipmentId, c, k), { ok: 'Retour confirmé', keyed: true })} /> : null}
        {role === 'previous_courier' ? <GlowButton label="Donner le code de remise au nouveau livreur" disabled={busy} onPress={async () => { const r = await act('handoff-code', () => issueHandoffCode(shipmentId)); if (r?.code) setIssued({ ...r, label: 'Code de remise' }); }} /> : null}

        {/* ── source / dispatcher ── */}
        {['source', 'dispatcher'].includes(role) && ['assigned', 'pickup_arrived'].includes(s) ? <GlowButton label="Donner le code d’enlèvement au livreur" disabled={busy} onPress={() => issue('pickup', 'Code d’enlèvement')} /> : null}
        {['source', 'dispatcher'].includes(role) && s === 'return_in_transit' ? <GlowButton label="Donner le code de retour" disabled={busy} onPress={() => issue('return_delivery', 'Code de retour')} /> : null}
        {role === 'source' && ['requested', 'accepted', 'ready_for_pickup', 'assigned', 'pickup_arrived'].includes(s) ? (
          panel === 'cancel' ? (
            <View style={styles.block}>
              <TextInput style={styles.input} value={text} onChangeText={setText} placeholder="Motif d’annulation" maxLength={300} />
              <GlowButton tone="orange" label="Annuler l’expédition" disabled={busy || text.trim().length < 3} onPress={() => act('cancel', () => cancelShipment(shipmentId, text.trim()), { ok: 'Expédition annulée' })} />
            </View>
          ) : <PressScale onPress={() => setPanel('cancel')} style={styles.ghost}><Text style={styles.ghostText}>Annuler (avant enlèvement)</Text></PressScale>
        ) : null}

        {/* ── receiver ── */}
        {role === 'receiver' && AFTER_PICKUP.includes(s) ? <GlowButton label="Donner mon code de livraison" disabled={busy} onPress={() => issue('delivery', 'Code de livraison — à donner au livreur devant toi')} /> : null}
        {role === 'receiver' && ['ready_for_pickup', 'at_pickup_point'].includes(s) && sh.fulfilmentOwner === 'CUSTOMER_PICKUP' ? <GlowButton label="Mon code de retrait" disabled={busy} onPress={() => issue('collection', 'Code de retrait — à donner au comptoir')} /> : null}
        {role === 'receiver' && lines.length > 0 && !sh.receiving && (s === 'delivery_arrived' || s === 'delivered') && (sh.source?.system !== 'jokko_order') ? (
          <ReceivingForm lines={lines} atDoor={s === 'delivery_arrived'} busy={busy} onSubmit={(rows, note) => act('receiving', (k) => recordShipmentReceiving(shipmentId, rows, note, k), { ok: 'Réception enregistrée', keyed: true })} />
        ) : null}
        {['receiver', 'source'].includes(role) && ['delivery_failed', 'return_in_transit'].includes(s) && sh.failureSide === (role === 'receiver' ? 'receiver' : 'source') && !sh.failureEvidence ? (
          <View style={styles.block}>
            <Text style={styles.section}>Le livreur déclare : {FAILURE_REASONS.find((f) => f.key === sh.failureReason)?.label}</Text>
            <Text style={styles.meta}>C’est exact ? Ta réponse sert de preuve (aucune compensation sans confirmation).</Text>
            <View style={styles.row}>
              <GlowButton style={{ flex: 1 }} label="Oui, c’est exact" disabled={busy} onPress={() => act('fail-yes', () => respondToShipmentFailure(shipmentId, true), { ok: 'Merci — confirmé' })} />
              <GlowButton style={{ flex: 1 }} tone="orange" label="Non, je conteste" disabled={busy} onPress={() => act('fail-no', () => respondToShipmentFailure(shipmentId, false), { ok: 'Contesté — un opérateur K21 tranche' })} />
            </View>
          </View>
        ) : null}

        {/* ── pickup point ── */}
        {role === 'pickup_point' && s === 'ready_for_pickup' ? <GlowButton label="J’ai reçu le colis au point" disabled={busy} onPress={() => act('drop', () => dropShipmentAtPoint(shipmentId), { ok: 'Colis au point' })} /> : null}
        {(role === 'pickup_point' || (role === 'source' && sh.fulfilmentOwner === 'CUSTOMER_PICKUP')) && ['ready_for_pickup', 'at_pickup_point'].includes(s) ? <CodeEntry label="Code de retrait du client" busy={busy} onSubmit={(c) => act('release', () => releaseShipmentCollection(shipmentId, c), { ok: 'Remis au client ✓' })} /> : null}

        {/* ── disputes (parties) ── */}
        {['source', 'receiver', 'courier'].includes(role) && ['delivered', 'returned', 'delivery_failed'].includes(s) ? (
          panel === 'dispute' ? (
            <View style={styles.block}>
              <Text style={styles.label}>Ce qui ne va pas (un opérateur K21 tranche ; l’historique reste intact)</Text>
              <TextInput style={styles.input} value={text} onChangeText={setText} multiline maxLength={500} />
              <GlowButton tone="orange" label="Ouvrir un litige" disabled={busy || text.trim().length < 10} onPress={() => act('dispute', () => openShipmentDispute(shipmentId, text.trim()), { ok: 'Litige ouvert' })} />
            </View>
          ) : <PressScale onPress={() => setPanel('dispute')} style={styles.ghost}><Text style={styles.ghostText}>Signaler un problème</Text></PressScale>
        ) : null}

        {lines.length ? (
          <View style={styles.block}>
            <Text style={styles.section}>Contenu</Text>
            {lines.map((l) => <Text key={l.productId} style={styles.meta}>{l.sku ?? l.productId} × {l.units}</Text>)}
          </View>
        ) : null}
        <View style={styles.block}>
          <Text style={styles.section}>Historique</Text>
          {(sh.history ?? []).map((h, i) => (
            <Text key={`${h.at}-${i}`} style={styles.meta}>{new Date(h.at).toLocaleString('fr-SN')} · {SHIPMENT_STATUS[h.to] ?? h.to}{h.evidence ? ` · ${PROOF[h.evidence] ?? h.evidence}` : ''}</Text>
          ))}
          <Text style={styles.meta}>Pas de suivi GPS : l’état change uniquement quand une étape est prouvée.</Text>
        </View>
        {isTerminal(s) ? null : <PressScale onPress={load} style={styles.ghost}><Text style={styles.ghostText}>Actualiser</Text></PressScale>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.huge },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.appCanvas.surface, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.ink },
  subtitle: { ...type.caption, color: 'rgba(5,8,5,0.55)', marginTop: 2 },
  list: { padding: spacing.huge, gap: spacing.md, paddingBottom: 120 },
  empty: { ...type.body, color: 'rgba(5,8,5,0.6)', padding: spacing.huge },
  section: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink },
  label: { ...type.caption, color: colors.ink },
  block: { gap: spacing.sm },
  card: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.appCanvas.border, gap: spacing.sm },
  cardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink },
  meta: { ...type.caption, color: 'rgba(5,8,5,0.6)' },
  warn: { ...type.caption, color: colors.terracottaDark },
  row: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  input: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.appCanvas.border, padding: spacing.md, fontFamily: fontFamily.bodyBold, fontSize: 16, color: colors.ink, letterSpacing: 2 },
  codeCard: { backgroundColor: colors.ink, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm, alignItems: 'center' },
  code: { fontFamily: fontFamily.displayBlack, fontSize: 30, letterSpacing: 6, color: colors.green },
  codeMeta: { ...type.caption, color: 'rgba(255,255,255,0.75)', textAlign: 'center' },
  ghost: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.appCanvas.border, alignItems: 'center', backgroundColor: colors.appCanvas.surface },
  ghostText: { ...type.caption, color: colors.ink },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  qtyBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.appCanvas.base, alignItems: 'center', justifyContent: 'center' },
  qtyBtnText: { fontSize: 20, color: colors.ink },
  qtyVal: { fontFamily: fontFamily.bodyBold, minWidth: 28, textAlign: 'center', fontSize: 16 },
});
