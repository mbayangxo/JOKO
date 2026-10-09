import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import { useToast } from '../components/Toast';
import {
  acceptWorkOffer, addWorkQualification, appealWorkDispute, applyToWork, declineWorkOffer, discoverWork, endMyAssignment, getMyAssignments,
  getMyWorkApplications, getMyWorkOffers, getWorkEarnings, getWorkProfile, openWorkDispute, payoutWorkEarnings, saveWorkProfile,
  submitAttendance, submitMilestone,
} from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { newActionKey } from '../lib/logistics-ux';
import {
  APP_STATUS, ARRANGEMENT, ASSIGNMENT_STATUS, CLASSIFICATION, EARNING_STATUS, FUNDING, INELIGIBLE, MILESTONE_STATUS, OFFER_STATUS, PAY_KIND,
} from '../lib/work-ux';
import { colors, fontFamily, radius, spacing, type } from '../theme';

/**
 * J9 — the worker's desk. Discover real, funded work from verified businesses (newest first,
 * filtered only by what I choose), apply, read the exact terms before accepting, prove the work
 * (evidence, attendance codes issued by the business), see earnings by state and pay them out once.
 * I never pay to get work. My profile is mine: I choose what businesses see.
 */
const TABS = [['find', 'Trouver'], ['mine', 'Candidatures'], ['missions', 'Missions'], ['earn', 'Gains'], ['profile', 'Profil']];
const TYPES = [['', 'Tout'], ['gig', 'Missions courtes'], ['staffing', 'Renfort'], ['courier', 'Livraison'], ['rep', 'Commercial'], ['apprenticeship', 'Apprentissage'], ['coop_work', 'Coopérative'], ['pickup_point', 'Point relais']];
const csv = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export default function WorkScreen({ navigation }) {
  const showToast = useToast();
  const [tab, setTab] = useState('find');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState('');
  const [area, setArea] = useState('');
  const [opps, setOpps] = useState([]);
  const [open, setOpen] = useState(null);
  const [apps, setApps] = useState([]);
  const [offers, setOffers] = useState([]);
  const [missions, setMissions] = useState([]);
  const [earn, setEarn] = useState(null);
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState({ headline: '', skills: '', areas: '', availability: '', visibility: 'applications_only' });
  const [qual, setQual] = useState('');
  const [evidence, setEvidence] = useState({});
  const [code, setCode] = useState({});
  const [attest, setAttest] = useState({});
  const payKey = useRef(null);

  const say = (e, fallback) => showToast(/Network|fetch/i.test(e?.message ?? '') ? 'Réseau incertain — réessaie : rien ne sera fait deux fois' : e?.message ?? fallback);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, a, o, m, e, p] = await Promise.all([discoverWork({ type, area: area.trim().toLowerCase() }), getMyWorkApplications(), getMyWorkOffers(), getMyAssignments(), getWorkEarnings(), getWorkProfile()]);
      setOpps(d.items ?? []);
      setApps(a ?? []);
      setOffers(o ?? []);
      setMissions(m ?? []);
      setEarn(e);
      setProfile(p);
      if (p?.profile) setForm({ headline: p.profile.headline ?? '', skills: (p.profile.skills ?? []).join(', '), areas: (p.profile.areas ?? []).join(', '), availability: p.profile.availability ?? '', visibility: p.profile.visibility });
    } catch (e) {
      say(e, 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [type, area]); // eslint-disable-line react-hooks/exhaustive-deps
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const act = async (fn, done) => {
    setBusy(true);
    try {
      const r = await fn();
      if (done) showToast(done);
      await load();
      return r;
    } catch (e) {
      say(e, 'Action impossible');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const acceptOffer = (o) => act(async () => {
    try {
      return await acceptWorkOffer(o.id, o.termsHash, attest[o.id]);
    } catch (e) {
      if (e.code === 'age_attestation_required') {
        setAttest((x) => ({ ...x, [o.id]: false }));
        throw new Error('Confirme ton âge ci-dessous pour accepter.');
      }
      throw e;
    }
  }, 'Offre acceptée — la mission commence');

  const payout = () => act(async () => {
    payKey.current = payKey.current ?? newActionKey('work-payout');
    const r = await payoutWorkEarnings(payKey.current);
    payKey.current = null;
    showToast(r.paidKori > 0 ? `${formatKori(r.paidKori)} versés sur ton portefeuille` : 'Rien de disponible pour l’instant');
    return r;
  });

  const pay = (o) => (o.payKind === 'wage' ? `${formatKori(o.rateKori)} / mois` : o.payKind === 'commission' || o.payKind === 'fee' ? 'Selon résultat vérifié' : `${formatKori(o.rateKori)} ${PAY_KIND[o.payKind] ?? ''}`);
  const offersOpen = offers.filter((o) => o.status === 'sent');

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <PressScale onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityLabel="Retour"><Text style={styles.big}>‹</Text></PressScale>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Travail</Text>
          <Text style={styles.subtitle}>Entreprises vérifiées · paiement sécurisé · tu ne paies jamais pour travailler</Text>
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {TABS.map(([k, l]) => (
          <PressScale key={k} onPress={() => setTab(k)} style={[styles.tab, tab === k && styles.tabOn]} accessibilityLabel={l}>
            <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{l}{k === 'mine' && offersOpen.length ? ` · ${offersOpen.length}` : ''}</Text>
          </PressScale>
        ))}
      </ScrollView>
      {loading ? <ActivityIndicator style={{ marginTop: 40 }} /> : (
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          {tab === 'find' ? (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
                {TYPES.map(([k, l]) => (
                  <PressScale key={k || 'all'} onPress={() => setType(k)} style={[styles.chip, type === k && styles.tabOn]}><Text style={[styles.tabText, type === k && styles.tabTextOn]}>{l}</Text></PressScale>
                ))}
              </ScrollView>
              <TextInput value={area} onChangeText={setArea} onSubmitEditing={load} placeholder="Quartier (ex. pikine) — puis Entrée" style={styles.input} accessibilityLabel="Quartier" />
              {opps.length === 0 ? <Text style={styles.empty}>Aucune offre ouverte pour ces critères. Ici, seules des entreprises vérifiées publient, et le paiement d’une mission est bloqué avant que tu commences.</Text> : null}
              {opps.map((o) => (
                <PressScale key={o.id} onPress={() => setOpen(open === o.id ? null : o.id)} style={[styles.card, !o.eligible && styles.cardMuted]} accessibilityLabel={`Offre ${o.title}`}>
                  <Text style={styles.cardTitle}>{o.title}</Text>
                  <Text style={styles.meta}>{o.business?.name}{o.business?.verified ? ' · ✓ vérifiée' : ''} · {o.typeLabel} · {ARRANGEMENT[o.arrangement]}</Text>
                  <Text style={styles.money}>{pay(o)}{o.area ? ` · ${o.area}` : ''}</Text>
                  {!o.eligible ? <Text style={styles.warn}>{INELIGIBLE[o.ineligibleReason] ?? 'Non accessible'}</Text> : null}
                  {open === o.id ? (
                    <View style={styles.detail}>
                      <Text style={styles.body}>{o.description}</Text>
                      <Text style={styles.meta}>{FUNDING[o.funding]}</Text>
                      {o.hazardous ? <Text style={styles.warn}>Travail à risque — 18 ans minimum, identité vérifiée</Text> : null}
                      {o.hoursPerWeek ? <Text style={styles.meta}>{o.hoursPerWeek} h / semaine{o.durationWeeks ? ` · ${o.durationWeeks} semaines` : ''}</Text> : null}
                      {(o.skills ?? []).length ? <Text style={styles.meta}>Compétences : {o.skills.join(', ')}</Text> : null}
                      {o.myApplication ? <Text style={styles.meta}>Ta candidature : {APP_STATUS[o.myApplication] ?? o.myApplication}</Text>
                        : o.eligible ? <GlowButton label={busy ? '…' : 'Postuler'} disabled={busy} onPress={() => act(() => applyToWork(o.id), 'Candidature envoyée')} /> : null}
                    </View>
                  ) : null}
                </PressScale>
              ))}
            </>
          ) : null}

          {tab === 'mine' ? (
            <>
              <Text style={styles.section}>Offres reçues</Text>
              {offersOpen.length === 0 ? <Text style={styles.empty}>Aucune offre à traiter.</Text> : null}
              {offersOpen.map((o) => (
                <View key={o.id} style={[styles.card, styles.cardOffer]}>
                  <Text style={styles.cardTitle}>{o.opportunity?.title} · {o.business?.name}</Text>
                  <Text style={styles.meta}>{ARRANGEMENT[o.arrangement]} · {CLASSIFICATION[o.terms?.classification] ?? ''}</Text>
                  <Text style={styles.body}>{o.terms?.duties}</Text>
                  <Text style={styles.meta}>Début {o.terms?.startDate}{o.terms?.endDate ? ` → ${o.terms.endDate}` : ''}{o.terms?.schedule ? ` · ${o.terms.schedule}` : ''}</Text>
                  {(o.terms?.milestones ?? []).map((m) => <Text key={m.seq} style={styles.meta}>• {m.title} — {formatKori(m.amountKori)}{m.kind === 'reimbursement' ? ' (remboursement sur justificatif)' : ''}</Text>)}
                  {o.terms?.ratePerDeliveryKori ? <Text style={styles.meta}>{formatKori(o.terms.ratePerDeliveryKori)} par livraison prouvée · budget {o.terms.deliveriesBudget} livraisons</Text> : null}
                  {o.terms?.wageKori ? <Text style={styles.meta}>Salaire {formatKori(o.terms.wageKori)} / {o.terms.wagePeriod === 'week' ? 'semaine' : o.terms.wagePeriod === 'day' ? 'jour' : 'mois'} — versé par la paie de l’employeur</Text> : null}
                  {o.totalKori > 0 ? <Text style={styles.money}>Total {formatKori(o.totalKori)} · {o.fundingStatus === 'held' ? 'bloqué pour toi ✓' : 'non financé'}</Text> : null}
                  <Text style={styles.meta}>Preuve demandée : {o.terms?.evidenceRequired === 'attendance' ? 'arrivée et départ par codes de l’entreprise' : 'description / photo du travail'} · validation sous {o.terms?.acceptanceWindowHours} h, sinon validée automatiquement</Text>
                  {o.id in attest ? (
                    <PressScale onPress={() => setAttest((x) => ({ ...x, [o.id]: !x[o.id] }))} style={styles.check} accessibilityLabel="Je confirme mon âge">
                      <Text style={styles.body}>{attest[o.id] ? '☑' : '☐'} Je confirme avoir au moins {o.terms?.minAge ?? 18} ans</Text>
                    </PressScale>
                  ) : null}
                  <GlowButton label={busy ? '…' : 'Accepter ces conditions'} disabled={busy} onPress={() => acceptOffer(o)} />
                  <PressScale onPress={() => act(() => declineWorkOffer(o.id), 'Offre refusée')} style={styles.ghost}><Text style={styles.ghostText}>Refuser</Text></PressScale>
                </View>
              ))}
              <Text style={styles.section}>Mes candidatures</Text>
              {apps.length === 0 ? <Text style={styles.empty}>Aucune candidature.</Text> : null}
              {apps.map((a) => (
                <View key={a.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{a.opportunity?.title ?? '—'}</Text>
                  <Text style={styles.meta}>{a.opportunity?.business?.name} · {APP_STATUS[a.status] ?? a.status}</Text>
                  {a.status === 'invited' ? <GlowButton label="Répondre à l’invitation" disabled={busy} onPress={() => act(() => applyToWork(a.opportunity.id), 'Candidature envoyée')} /> : null}
                </View>
              ))}
            </>
          ) : null}

          {tab === 'missions' ? (
            <>
              {missions.length === 0 ? <Text style={styles.empty}>Aucune mission pour l’instant.</Text> : null}
              {missions.map((a) => (
                <View key={a.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{a.business?.name} · {a.reference}</Text>
                  <Text style={styles.meta}>{ARRANGEMENT[a.arrangement]} · {ASSIGNMENT_STATUS[a.status] ?? a.status}{a.escrowKori ? ` · ${formatKori(a.escrowKori)} encore bloqués pour toi` : ''}</Text>
                  {a.terms?.evidenceRequired === 'attendance' && a.status === 'active' ? (
                    <View style={styles.row}>
                      <TextInput value={code[a.id] ?? ''} onChangeText={(t) => setCode((x) => ({ ...x, [a.id]: t.toUpperCase() }))} placeholder="Code donné par l’entreprise" style={[styles.input, { flex: 1 }]} autoCapitalize="characters" accessibilityLabel="Code de présence" />
                      <PressScale onPress={() => act(() => submitAttendance(a.id, a.checkedInAt ? 'checkout' : 'checkin', code[a.id]), a.checkedInAt ? 'Départ enregistré' : 'Arrivée enregistrée')} style={styles.smallBtn}><Text style={styles.ghostText}>{a.checkedInAt ? (a.checkedOutAt ? '✓' : 'Départ') : 'Arrivée'}</Text></PressScale>
                    </View>
                  ) : null}
                  {a.milestones.map((m) => (
                    <View key={m.id} style={styles.milestone}>
                      <Text style={styles.body}>{m.seq}. {m.title} — {formatKori(m.amountKori)}</Text>
                      <Text style={styles.meta}>{MILESTONE_STATUS[m.status] ?? m.status}{m.acceptedBy === 'auto' ? ' (validée automatiquement)' : ''}{m.status === 'submitted' && m.acceptDeadline ? ` · validation au plus tard ${new Date(m.acceptDeadline).toLocaleString('fr-SN')}` : ''}</Text>
                      {m.status === 'pending' && a.status === 'active' ? (
                        <>
                          <TextInput value={evidence[m.id] ?? ''} onChangeText={(t) => setEvidence((x) => ({ ...x, [m.id]: t }))} placeholder={m.kind === 'reimbursement' ? 'Référence du justificatif' : 'Ce qui a été fait (preuve)'} style={styles.input} multiline accessibilityLabel="Preuve" />
                          <GlowButton label="Envoyer pour validation" disabled={busy} onPress={() => act(() => submitMilestone(a.id, m.seq, evidence[m.id] ?? '', m.kind === 'reimbursement' ? 'receipt_ref' : a.terms?.evidenceRequired === 'attendance' ? 'attendance' : 'note'), 'Envoyé — l’entreprise a le délai convenu pour valider')} />
                        </>
                      ) : null}
                      {m.status === 'submitted' ? (
                        <PressScale onPress={() => act(() => openWorkDispute(a.id, { kind: 'nonpayment', milestoneSeq: m.seq, reason: 'Travail livré, validation ou paiement refusé sans raison.' }), 'Litige ouvert — un opérateur K21 va trancher')} style={styles.ghost}><Text style={styles.ghostText}>Signaler un non-paiement</Text></PressScale>
                      ) : null}
                    </View>
                  ))}
                  {a.arrangement === 'employment' ? <Text style={styles.meta}>Salaire : {formatKori(a.terms?.wageKori ?? 0)} versé par la paie de l’employeur. En cas de retard, signale-le : l’obligation reste due.</Text> : null}
                  {a.arrangement === 'employment' && a.status === 'active' ? (
                    <PressScale onPress={() => act(() => openWorkDispute(a.id, { kind: 'nonpayment', reason: 'Salaire du mois non versé à la date prévue.' }), 'Signalement enregistré')} style={styles.ghost}><Text style={styles.ghostText}>Signaler un salaire impayé</Text></PressScale>
                  ) : null}
                  {a.status === 'active' && !a.milestones.some((m) => ['submitted', 'disputed'].includes(m.status)) ? (
                    <PressScale onPress={() => act(() => endMyAssignment(a.id, 'Je me retire avant de commencer'), 'Mission arrêtée')} style={styles.ghost}><Text style={styles.ghostText}>Me retirer</Text></PressScale>
                  ) : null}
                  {a.disputes.some((d) => d.status !== 'resolved') ? <Text style={styles.warn}>Litige en cours — paiement gelé jusqu’à la décision</Text> : null}
                  {a.disputes.filter((d) => d.appealable && d.resolution !== 'worker').map((d) => (
                    <PressScale key={d.id} onPress={() => act(() => appealWorkDispute(d.id, 'Je conteste la décision : mes preuves de travail sont jointes au dossier.'), 'Appel envoyé — un autre opérateur va revoir la décision')} style={styles.ghost} accessibilityLabel="Faire appel"><Text style={styles.ghostText}>Faire appel de la décision ({d.resolution === 'split' ? 'partage' : 'en faveur de l’entreprise'})</Text></PressScale>
                  ))}
                  {a.earnings.filter((e) => e.status === 'accrued' && e.contestableUntil).map((e) => <Text key={e.id} style={styles.meta}>{formatKori(e.amountKori)} disponible au plus tôt le {new Date(e.releasableAt).toLocaleString('fr-SN')} (fin du délai de contestation)</Text>)}
                </View>
              ))}
            </>
          ) : null}

          {tab === 'earn' ? (
            <>
              <View style={styles.card}>
                <Text style={styles.meta}>Retenu : {formatKori(earn?.totals?.onHoldKori ?? 0)}</Text>
                <Text style={styles.cardTitle}>Disponible : {formatKori(earn?.totals?.releasableKori ?? 0)}</Text>
                <Text style={styles.meta}>Déjà versé : {formatKori(earn?.totals?.paidKori ?? 0)}</Text>
                <Text style={styles.meta}>Un gain naît d’un travail validé (par l’entreprise, automatiquement après le délai, ou par décision). Il devient disponible à la fin du délai de contestation (court si l’entreprise a validé, plus long si la validation est automatique) et reste gelé pendant un litige ou un appel.</Text>
              </View>
              <GlowButton label={busy ? '…' : 'Verser le disponible sur mon portefeuille'} disabled={busy || !(earn?.totals?.releasableKori > 0)} onPress={payout} />
              {(earn?.items ?? []).map((e) => (
                <View key={e.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{formatKori(e.amountKori)} · {EARNING_STATUS[e.status] ?? e.status}</Text>
                  <Text style={styles.meta}>{CLASSIFICATION[e.classification] ?? e.classification}</Text>
                </View>
              ))}
              {(earn?.j8CourierEarnings ?? []).length ? <Text style={styles.meta}>Tes gains de livraison K21 restent dans « Mes livraisons » (jamais comptés deux fois).</Text> : null}
            </>
          ) : null}

          {tab === 'profile' ? (
            <>
              <Text style={styles.meta}>C’est toi qui décides ce que voient les entreprises. Jamais d’origine, de nationalité, de langue ou de quartier de résidence demandés.</Text>
              <TextInput value={form.headline} onChangeText={(t) => setForm((f) => ({ ...f, headline: t }))} placeholder="Titre (ex. Caissière expérimentée)" style={styles.input} accessibilityLabel="Titre" />
              <TextInput value={form.skills} onChangeText={(t) => setForm((f) => ({ ...f, skills: t }))} placeholder="Compétences, séparées par des virgules" style={styles.input} accessibilityLabel="Compétences" />
              <TextInput value={form.areas} onChangeText={(t) => setForm((f) => ({ ...f, areas: t }))} placeholder="Zones où tu veux travailler" style={styles.input} accessibilityLabel="Zones" />
              <TextInput value={form.availability} onChangeText={(t) => setForm((f) => ({ ...f, availability: t }))} placeholder="Disponibilités" style={styles.input} accessibilityLabel="Disponibilités" />
              <View style={styles.row}>
                {[['private', 'Privé'], ['applications_only', 'Mes candidatures'], ['discoverable', 'Visible']].map(([k, l]) => (
                  <PressScale key={k} onPress={() => setForm((f) => ({ ...f, visibility: k }))} style={[styles.chip, form.visibility === k && styles.tabOn]}><Text style={[styles.tabText, form.visibility === k && styles.tabTextOn]}>{l}</Text></PressScale>
                ))}
              </View>
              <GlowButton label="Enregistrer" disabled={busy} onPress={() => act(() => saveWorkProfile({ headline: form.headline, skills: csv(form.skills), areas: csv(form.areas), availability: form.availability, visibility: form.visibility }), 'Profil enregistré')} />
              <Text style={styles.section}>Qualifications</Text>
              {(profile?.qualifications ?? []).map((q) => <Text key={q.id} style={styles.meta}>• {q.title} — {q.status === 'verified' ? 'vérifiée ✓' : q.status === 'rejected' ? 'non retenue' : 'déclarée'}</Text>)}
              <TextInput value={qual} onChangeText={setQual} placeholder="Ajouter (ex. Permis A)" style={styles.input} accessibilityLabel="Qualification" />
              <GlowButton tone="ink" label="Ajouter" disabled={busy || qual.trim().length < 2} onPress={() => act(async () => { await addWorkQualification({ kind: 'skill', title: qual.trim() }); setQual(''); }, 'Ajoutée (à vérifier)')} />
            </>
          ) : null}
          <PressScale onPress={load} style={styles.ghost}><Text style={styles.ghostText}>Actualiser</Text></PressScale>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

export const workStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.huge, paddingBottom: spacing.md },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.appCanvas.surface, alignItems: 'center', justifyContent: 'center' },
  big: { fontSize: 20, color: colors.ink },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  subtitle: { ...type.caption, color: 'rgba(5,8,5,0.55)', marginTop: 2 },
  tabs: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.huge, paddingBottom: spacing.sm },
  tab: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.round, borderWidth: 1, borderColor: colors.appCanvas.border, backgroundColor: colors.appCanvas.surface },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, borderRadius: radius.round, borderWidth: 1, borderColor: colors.appCanvas.border, backgroundColor: colors.appCanvas.surface },
  tabOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  tabText: { ...type.caption, color: colors.ink },
  tabTextOn: { color: colors.green },
  list: { padding: spacing.huge, paddingTop: spacing.sm, gap: spacing.md, paddingBottom: 120 },
  section: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink, marginTop: spacing.sm },
  empty: { ...type.body, color: 'rgba(5,8,5,0.6)' },
  card: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.appCanvas.border, gap: spacing.xs },
  cardOffer: { borderColor: colors.greenDark },
  cardMuted: { opacity: 0.7 },
  cardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink },
  body: { ...type.body, color: colors.ink },
  meta: { ...type.caption, color: 'rgba(5,8,5,0.6)' },
  money: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.greenDark },
  warn: { ...type.caption, color: colors.terracottaDark },
  detail: { gap: spacing.sm, marginTop: spacing.sm },
  milestone: { borderTopWidth: 1, borderTopColor: colors.appCanvas.border, paddingTop: spacing.sm, marginTop: spacing.xs, gap: spacing.xs },
  input: { borderWidth: 1, borderColor: colors.appCanvas.border, borderRadius: radius.md, backgroundColor: colors.appCanvas.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.ink, ...type.body },
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', flexWrap: 'wrap' },
  check: { paddingVertical: spacing.xs },
  smallBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.round, borderWidth: 1, borderColor: colors.ink, backgroundColor: colors.appCanvas.surface },
  ghost: { paddingVertical: spacing.md, borderRadius: radius.round, borderWidth: 1, borderColor: colors.appCanvas.border, alignItems: 'center', backgroundColor: colors.appCanvas.surface },
  ghostText: { ...type.caption, color: colors.ink },
});
const styles = workStyles;
