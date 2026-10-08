import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import StepUpOverlay from '../components/StepUpOverlay';
import { useToast } from '../components/Toast';
import {
  acceptBizMilestone, approveBizWorkRule, createBizOffer, createBizOpportunity, decideBizApplication, endBizAssignment, fundBizWorkRule,
  getMyBusinesses, issueBizAttendanceCode, listBizApplicants, listBizAssignments, listBizOpportunities, listBizWorkRules, openBizWorkDispute,
  proposeBizWorkRule,
} from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import { newActionKey } from '../lib/logistics-ux';
import { APP_STATUS, ARRANGEMENT, ASSIGNMENT_STATUS, FUNDING, MILESTONE_STATUS } from '../lib/work-ux';
import { workStyles as styles } from './WorkScreen';

/**
 * J9 — the business side of work. Post real work (verified businesses only), review applicants by
 * what the work needs (no contact, age, origin or photo), make an offer with explicit terms —
 * a paid mission is FUNDED when the offer is sent — verify the work (attendance codes, evidence),
 * accept or dispute within the agreed window, and run commission / fee rules under dual control.
 */
const TABS = [['post', 'Publier'], ['applicants', 'Candidats'], ['assignments', 'Missions'], ['rules', 'Commissions']];
const KINDS = [
  ['gig', 'contract', 'fixed', 'Mission courte'],
  ['staffing', 'contract', 'fixed', 'Renfort (mission)'],
  ['staffing', 'employment', 'wage', 'Emploi salarié'],
  ['courier', 'contract', 'per_unit', 'Livreur (par livraison)'],
  ['rep', 'contract', 'commission', 'Commercial (commission)'],
  ['apprenticeship', 'apprenticeship', 'stipend', 'Apprentissage'],
  ['coop_work', 'coop_member', 'fixed', 'Travail coopératif'],
];

export default function BusinessWorkScreen({ navigation }) {
  const showToast = useToast();
  const [tab, setTab] = useState('post');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [bizId, setBizId] = useState(null);
  const [opps, setOpps] = useState([]);
  const [applicants, setApplicants] = useState({});
  const [assignments, setAssignments] = useState([]);
  const [rules, setRules] = useState([]);
  const [kind, setKind] = useState(0);
  const [post, setPost] = useState({ title: '', description: '', area: '', skills: '', rate: '', units: '1' });
  const [offer, setOffer] = useState({});
  const [codes, setCodes] = useState({});
  const [stepUpFor, setStepUpFor] = useState(null);
  const offerKey = useRef({});

  const say = (e, fallback) => showToast(/Network|fetch/i.test(e?.message ?? '') ? 'Réseau incertain — réessaie : rien ne sera fait deux fois' : e?.message ?? fallback);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const b = await getMyBusinesses();
      const id = [...(b.owned ?? []), ...(b.member ?? [])][0]?.id ?? null;
      setBizId(id);
      if (!id) return;
      const [o, a, r] = await Promise.all([listBizOpportunities(id).catch(() => []), listBizAssignments(id).catch(() => []), listBizWorkRules(id).catch(() => [])]);
      setOpps(Array.isArray(o) ? o : []);
      setAssignments(Array.isArray(a) ? a : []);
      setRules(Array.isArray(r) ? r : []);
    } catch (e) {
      say(e, 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const act = async (fn, done) => {
    setBusy(true);
    try {
      const r = await fn();
      if (done) showToast(done);
      await load();
      return r;
    } catch (e) {
      if (e.code === 'step_up_required') throw e;
      say(e, 'Action impossible');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const publish = () => act(async () => {
    const [type, arrangement, payKind] = KINDS[kind];
    const o = await createBizOpportunity(bizId, {
      type, arrangement, payKind, title: post.title.trim(), description: post.description.trim(), area: post.area.trim().toLowerCase() || undefined,
      skills: post.skills.split(',').map((x) => x.trim()).filter(Boolean), rateKori: Number(post.rate) || 0, units: Math.max(1, Number(post.units) || 1),
      ...(arrangement === 'apprenticeship' ? { durationWeeks: 12, minAge: 16 } : {}),
    });
    showToast(o.status === 'under_review' ? 'Annonce en vérification : elle semble demander de l’argent aux travailleurs' : 'Annonce publiée');
    setPost({ title: '', description: '', area: '', skills: '', rate: '', units: '1' });
  });

  const loadApplicants = async (oppId) => {
    try {
      const list = await listBizApplicants(bizId, oppId);
      setApplicants((x) => ({ ...x, [oppId]: list }));
    } catch (e) {
      say(e, 'Chargement impossible');
    }
  };

  const sendOffer = async (opp, app, stepUpToken) => {
    const f = offer[app.id] ?? {};
    offerKey.current[app.id] = offerKey.current[app.id] ?? newActionKey('work-offer');
    setBusy(true);
    try {
      await createBizOffer(bizId, {
        applicationId: app.id, startDate: f.startDate || new Date(Date.now() + 86400000).toISOString().slice(0, 10), duties: f.duties || opp.description,
        ...(opp.funding === 'payroll' ? { rateKori: opp.rateKori, wagePeriod: 'month' } : {}),
        ...(opp.type === 'courier' ? { rateKori: opp.rateKori, units: opp.units } : {}),
        ...(opp.arrangement === 'apprenticeship' ? { learningPlan: f.learningPlan || '' } : {}),
        ...(f.attendance ? { evidenceRequired: 'attendance' } : {}),
      }, { stepUpToken, idempotencyKey: offerKey.current[app.id] });
      delete offerKey.current[app.id];
      showToast(opp.funding === 'prepaid' ? 'Offre envoyée — le montant est bloqué pour le travailleur' : 'Offre envoyée');
      await loadApplicants(opp.id);
      await load();
    } catch (e) {
      if (e.code === 'step_up_required') setStepUpFor({ opp, app });
      else say(e, 'Offre impossible');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <PressScale onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityLabel="Retour"><Text style={styles.big}>‹</Text></PressScale>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Recruter & missions</Text>
          <Text style={styles.subtitle}>Conditions explicites · paiement bloqué avant le début · preuve du travail</Text>
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {TABS.map(([k, l]) => (
          <PressScale key={k} onPress={() => setTab(k)} style={[styles.tab, tab === k && styles.tabOn]} accessibilityLabel={l}><Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{l}</Text></PressScale>
        ))}
      </ScrollView>
      {loading ? <ActivityIndicator style={{ marginTop: 40 }} /> : !bizId ? <Text style={[styles.empty, { padding: 24 }]}>Aucune entreprise.</Text> : (
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          {tab === 'post' ? (
            <>
              <View style={styles.row}>
                {KINDS.map((k, i) => (
                  <PressScale key={k[3]} onPress={() => setKind(i)} style={[styles.chip, kind === i && styles.tabOn]}><Text style={[styles.tabText, kind === i && styles.tabTextOn]}>{k[3]}</Text></PressScale>
                ))}
              </View>
              <Text style={styles.meta}>{ARRANGEMENT[KINDS[kind][1]]} — {FUNDING[KINDS[kind][1] === 'employment' ? 'payroll' : KINDS[kind][2] === 'commission' ? 'outcome' : 'prepaid']}</Text>
              <TextInput value={post.title} onChangeText={(t) => setPost((p) => ({ ...p, title: t }))} placeholder="Intitulé" style={styles.input} accessibilityLabel="Intitulé" />
              <TextInput value={post.description} onChangeText={(t) => setPost((p) => ({ ...p, description: t }))} placeholder="Description du travail (20 caractères min.)" style={styles.input} multiline accessibilityLabel="Description" />
              <TextInput value={post.area} onChangeText={(t) => setPost((p) => ({ ...p, area: t }))} placeholder="Quartier" style={styles.input} accessibilityLabel="Quartier" />
              <TextInput value={post.skills} onChangeText={(t) => setPost((p) => ({ ...p, skills: t }))} placeholder="Compétences utiles (virgules)" style={styles.input} accessibilityLabel="Compétences" />
              {KINDS[kind][2] !== 'commission' ? <TextInput value={post.rate} onChangeText={(t) => setPost((p) => ({ ...p, rate: t.replace(/[^0-9]/g, '') }))} keyboardType="numeric" placeholder={KINDS[kind][2] === 'wage' ? 'Salaire mensuel (₭)' : KINDS[kind][2] === 'per_unit' ? 'Tarif par livraison (₭)' : 'Rémunération (₭)'} style={styles.input} accessibilityLabel="Rémunération" /> : null}
              {KINDS[kind][2] === 'per_unit' ? <TextInput value={post.units} onChangeText={(t) => setPost((p) => ({ ...p, units: t.replace(/[^0-9]/g, '') }))} keyboardType="numeric" placeholder="Nombre de livraisons (budget)" style={styles.input} accessibilityLabel="Nombre de livraisons" /> : null}
              <Text style={styles.meta}>Interdit : demander de l’argent aux travailleurs, filtrer par origine, nationalité, langue ou quartier de résidence. Un temps plein durable est un emploi salarié.</Text>
              <GlowButton label={busy ? '…' : 'Publier'} disabled={busy || post.title.trim().length < 4 || post.description.trim().length < 20} onPress={publish} />
              <Text style={styles.section}>Mes annonces</Text>
              {opps.length === 0 ? <Text style={styles.empty}>Aucune annonce.</Text> : null}
              {opps.map((o) => (
                <View key={o.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{o.title}</Text>
                  <Text style={styles.meta}>{o.typeLabel} · {ARRANGEMENT[o.arrangement]} · {o.status === 'under_review' ? 'en vérification' : o.status}</Text>
                  <Text style={styles.meta}>Candidatures : {Object.entries(o.applications ?? {}).map(([k, v]) => `${APP_STATUS[k] ?? k} ${v}`).join(' · ') || '0'}</Text>
                </View>
              ))}
            </>
          ) : null}

          {tab === 'applicants' ? (
            <>
              {opps.filter((o) => o.status === 'open').map((o) => (
                <View key={o.id} style={styles.card}>
                  <PressScale onPress={() => loadApplicants(o.id)} accessibilityLabel={`Candidats ${o.title}`}><Text style={styles.cardTitle}>{o.title} ›</Text></PressScale>
                  {(applicants[o.id] ?? []).map((a) => (
                    <View key={a.id} style={styles.milestone}>
                      <Text style={styles.body}>{a.worker.name ?? a.worker.handle} {a.worker.headline ? `· ${a.worker.headline}` : ''}</Text>
                      <Text style={styles.meta}>{APP_STATUS[a.status] ?? a.status} · {a.worker.completedAssignments} mission(s) terminée(s){a.worker.rating ? ` · ${a.worker.rating}/5 (${a.worker.ratingCount})` : ''}</Text>
                      {a.worker.verifiedQualifications.length ? <Text style={styles.meta}>Vérifié : {a.worker.verifiedQualifications.map((q) => q.title).join(', ')}</Text> : null}
                      {(a.worker.skills ?? []).length ? <Text style={styles.meta}>Compétences : {a.worker.skills.join(', ')}</Text> : null}
                      {['submitted', 'shortlisted'].includes(a.status) ? (
                        <>
                          <TextInput value={offer[a.id]?.duties ?? ''} onChangeText={(t) => setOffer((x) => ({ ...x, [a.id]: { ...x[a.id], duties: t } }))} placeholder="Tâches précises (sinon : la description)" style={styles.input} multiline accessibilityLabel="Tâches" />
                          <TextInput value={offer[a.id]?.startDate ?? ''} onChangeText={(t) => setOffer((x) => ({ ...x, [a.id]: { ...x[a.id], startDate: t } }))} placeholder="Date de début (AAAA-MM-JJ)" style={styles.input} accessibilityLabel="Date de début" />
                          {o.arrangement === 'apprenticeship' ? <TextInput value={offer[a.id]?.learningPlan ?? ''} onChangeText={(t) => setOffer((x) => ({ ...x, [a.id]: { ...x[a.id], learningPlan: t } }))} placeholder="Programme d’apprentissage" style={styles.input} multiline accessibilityLabel="Programme" /> : null}
                          {o.type === 'staffing' && o.arrangement === 'contract' ? (
                            <PressScale onPress={() => setOffer((x) => ({ ...x, [a.id]: { ...x[a.id], attendance: !x[a.id]?.attendance } }))} style={styles.check}><Text style={styles.body}>{offer[a.id]?.attendance ? '☑' : '☐'} Présence par codes (arrivée / départ)</Text></PressScale>
                          ) : null}
                          <GlowButton label={busy ? '…' : o.funding === 'prepaid' ? `Faire une offre — bloquer ${formatKori(o.rateKori * o.units)}` : 'Faire une offre'} disabled={busy} onPress={() => sendOffer(o, a)} />
                          <View style={styles.row}>
                            {a.status === 'submitted' ? <PressScale onPress={() => act(() => decideBizApplication(bizId, a.id, 'shortlist')).then(() => loadApplicants(o.id))} style={styles.smallBtn}><Text style={styles.ghostText}>Présélectionner</Text></PressScale> : null}
                            <PressScale onPress={() => act(() => decideBizApplication(bizId, a.id, 'decline')).then(() => loadApplicants(o.id))} style={styles.smallBtn}><Text style={styles.ghostText}>Ne pas retenir</Text></PressScale>
                          </View>
                        </>
                      ) : null}
                    </View>
                  ))}
                </View>
              ))}
            </>
          ) : null}

          {tab === 'assignments' ? (
            <>
              {assignments.length === 0 ? <Text style={styles.empty}>Aucune mission.</Text> : null}
              {assignments.map((a) => (
                <View key={a.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{a.worker?.name ?? a.worker?.handle} · {a.reference}</Text>
                  <Text style={styles.meta}>{ARRANGEMENT[a.arrangement]} · {ASSIGNMENT_STATUS[a.status] ?? a.status}{a.escrowKori ? ` · ${formatKori(a.escrowKori)} bloqués` : ''}</Text>
                  {a.terms?.evidenceRequired === 'attendance' && a.status === 'active' ? (
                    <View style={styles.row}>
                      {!a.checkedInAt ? <PressScale onPress={async () => { const r = await act(() => issueBizAttendanceCode(bizId, a.id, 'checkin')); if (r) setCodes((x) => ({ ...x, [a.id]: r.code })); }} style={styles.smallBtn}><Text style={styles.ghostText}>Code d’arrivée</Text></PressScale> : null}
                      {a.checkedInAt && !a.checkedOutAt ? <PressScale onPress={async () => { const r = await act(() => issueBizAttendanceCode(bizId, a.id, 'checkout')); if (r) setCodes((x) => ({ ...x, [a.id]: r.code })); }} style={styles.smallBtn}><Text style={styles.ghostText}>Code de départ</Text></PressScale> : null}
                      {codes[a.id] ? <Text style={styles.money} accessibilityLabel="Code à montrer">{codes[a.id]}</Text> : null}
                    </View>
                  ) : null}
                  {a.milestones.map((m) => (
                    <View key={m.id} style={styles.milestone}>
                      <Text style={styles.body}>{m.seq}. {m.title} — {formatKori(m.amountKori)}</Text>
                      <Text style={styles.meta}>{MILESTONE_STATUS[m.status] ?? m.status}{m.status === 'submitted' && m.acceptDeadline ? ` · validée automatiquement le ${new Date(m.acceptDeadline).toLocaleString('fr-SN')} sans réponse` : ''}</Text>
                      {m.status === 'submitted' ? (
                        <View style={styles.row}>
                          <GlowButton label="Valider et payer" disabled={busy} onPress={() => act(() => acceptBizMilestone(bizId, a.id, m.seq), 'Validé — paiement après le délai de retenue')} />
                          <PressScale onPress={() => act(() => openBizWorkDispute(bizId, a.id, { kind: 'false_completion', milestoneSeq: m.seq, reason: 'Le travail déclaré n’a pas été réalisé comme convenu.' }), 'Litige ouvert — un opérateur K21 tranchera')} style={styles.smallBtn}><Text style={styles.ghostText}>Contester</Text></PressScale>
                        </View>
                      ) : null}
                    </View>
                  ))}
                  {a.status === 'active' ? <PressScale onPress={() => act(() => endBizAssignment(bizId, a.id, 'Fin de la mission par l’entreprise'), 'Mission terminée')} style={styles.ghost}><Text style={styles.ghostText}>Terminer (le non-gagné revient à l’entreprise)</Text></PressScale> : null}
                </View>
              ))}
            </>
          ) : null}

          {tab === 'rules' ? (
            <>
              <Text style={styles.meta}>Une commission n’est versée que sur un résultat vérifié (1ʳᵉ commande reçue ET payée d’une boutique présentée), une seule fois, depuis un budget prépayé. Une autre personne habilitée doit approuver la règle.</Text>
              <GlowButton tone="ink" label="Proposer : commission 1ʳᵉ commande (1 000 ₭)" disabled={busy} onPress={() => act(() => proposeBizWorkRule(bizId, { kind: 'rep_first_received_order', amountKori: 1000 }), 'Règle proposée — à approuver par une autre personne')} />
              {rules.map((r) => (
                <View key={r.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{r.kind === 'rep_first_received_order' ? 'Commission commerciale' : 'Frais point relais'} · {formatKori(r.amountKori)}</Text>
                  <Text style={styles.meta}>{r.status} · budget {formatKori(r.budgetKori)}</Text>
                  {r.status === 'proposed' ? <PressScale onPress={() => act(() => approveBizWorkRule(bizId, r.id), 'Règle approuvée')} style={styles.smallBtn}><Text style={styles.ghostText}>Approuver</Text></PressScale> : null}
                  {['proposed', 'active'].includes(r.status) ? <PressScale onPress={() => fundBizWorkRule(bizId, r.id, 5000, { idempotencyKey: newActionKey('rule-fund') }).then(() => { showToast('Budget alimenté'); load(); }).catch((e) => (e.code === 'step_up_required' ? setStepUpFor({ rule: r }) : say(e, 'Impossible')))} style={styles.smallBtn}><Text style={styles.ghostText}>Alimenter 5 000 ₭</Text></PressScale> : null}
                </View>
              ))}
            </>
          ) : null}
          <PressScale onPress={load} style={styles.ghost}><Text style={styles.ghostText}>Actualiser</Text></PressScale>
        </ScrollView>
      )}
      <StepUpOverlay
        visible={Boolean(stepUpFor)}
        onCancel={() => setStepUpFor(null)}
        onVerified={(token) => {
          const s = stepUpFor;
          setStepUpFor(null);
          if (s?.app) sendOffer(s.opp, s.app, token);
          if (s?.rule) fundBizWorkRule(bizId, s.rule.id, 5000, { stepUpToken: token, idempotencyKey: newActionKey('rule-fund') }).then(() => { showToast('Budget alimenté'); load(); }).catch((e) => say(e, 'Impossible'));
        }}
      />
    </SafeAreaView>
  );
}
