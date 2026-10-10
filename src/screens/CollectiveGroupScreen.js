import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import StepUpOverlay from '../components/StepUpOverlay';
import { useToast } from '../components/Toast';
import {
  acceptCollectiveRules, castCollectiveBallot, contributeCollective, declineCollectiveRules, getCollectiveGroup, inviteToCollective,
  openCollectiveDispute, openCollectiveVote, proposeCollectiveRules, withdrawCollective,
} from '../lib/api-client';
import { styles } from './CollectiveGroupsScreen';

/**
 * J11 one group: rules to approve (exact hash), the schedule with who receives when, each cycle's payment
 * status (transparency the members accepted), my dues, history, votes and disputes. The organizer only
 * prepares (invite, propose rules); after the start nobody has a special power over the money.
 */
const OB = { open: 'à payer', partial: 'partiel', paid: 'payé', late_paid: 'payé en retard', missed: 'en retard', cancelled: 'annulé', refunded: 'remboursé', terminated: 'clos (règlement)' };
const TOPIC = { extend_grace: 'Prolonger le délai', partial_release: 'Verser le pot partiel', cancel: 'Annuler le groupe', exit: 'Sortie d’un membre' };
const HIST = { contribution: 'Cotisation', payout: 'Pot versé', catch_up: 'Rattrapage', refund: 'Remboursement', withdrawal: 'Retrait' };
const dt = (s) => (s ? new Date(s).toLocaleDateString('fr-SN') : '');

export default function CollectiveGroupScreen({ navigation, route }) {
  const id = route.params?.id;
  const [g, setG] = useState(null);
  const [error, setError] = useState(null);
  const [handles, setHandles] = useState('');
  const [reason, setReason] = useState('');
  const [stepUp, setStepUp] = useState(null);
  const showToast = useToast();
  const load = useCallback(async () => {
    try {
      setG(await getCollectiveGroup(id));
      setError(null);
    } catch (e) {
      setError(e.message ?? 'Chargement impossible');
    }
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const act = async (fn, ok) => {
    try {
      await fn();
      if (ok) showToast(ok);
      load();
    } catch (e) {
      showToast(e.message ?? 'Action impossible');
    }
  };
  const pay = async (stepUpToken, idempotencyKey) => {
    try {
      const r = await contributeCollective(id, { stepUpToken, idempotencyKey });
      showToast(r.payout ? `Cotisation enregistrée — le pot du cycle ${r.payout.cycle} a été versé` : 'Cotisation enregistrée');
      load();
    } catch (e) {
      if (e.code === 'step_up_required') return setStepUp({ idempotencyKey: e.idempotencyKey });
      showToast(e.message ?? 'Cotisation impossible');
    }
  };

  if (!g) {
    return (
      <View style={styles.root}><ScreenBackground /><SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Groupe" style={styles.header} />
        <View style={styles.scroll}>{error ? <Text style={styles.empty}>{error}</Text> : <ActivityIndicator />}</View>
      </SafeAreaView></View>
    );
  }
  const forming = ['proposed', 'awaiting_acceptance'].includes(g.status);
  const active = g.status === 'active';
  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title={g.name} style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={[styles.card, styles.column]}>
            <Text style={styles.title}>{g.kind === 'rotating' ? 'Tontine tournante' : 'Épargne objectif'} · {g.contributionKori} ₭ par cycle</Text>
            <Text style={styles.detail}>{g.status === 'active' ? `Cycle ${g.currentCycle} sur ${g.cycleCount}` : g.status === 'settlement_pending' ? 'Fin votée par les membres : aucun mouvement d’argent jusqu’au règlement contrôlé par K21' : g.status}{g.frozen ? ' · gelé par K21 : aucun mouvement d’argent' : ''}</Text>
            {g.kind === 'rotating' && active ? <Text style={styles.detail}>Pot en cours : {g.potKori} ₭</Text> : null}
            {g.kind === 'goal' && g.myShareKori != null ? <Text style={styles.detail}>Mon épargne : {g.myShareKori} ₭ · Groupe : {g.groupSavedKori} ₭</Text> : null}
            {g.myStatement ? <Text style={styles.detail}>Mon bilan : payé {g.myStatement.paidKori} ₭ · reçu {g.myStatement.receivedKori} ₭</Text> : null}
          </View>

          {forming && g.iAmOrganizer ? (
            <View style={[styles.card, styles.column]}>
              <Text style={styles.title}>Préparer le groupe</Text>
              <TextInput value={handles} onChangeText={setHandles} placeholder="@pseudo, @pseudo…" style={styles.input} accessibilityLabel="Pseudos à inviter" autoCapitalize="none" />
              <View style={styles.row}>
                <PressScale onPress={() => act(() => inviteToCollective(id, handles.split(/[\s,]+/).filter(Boolean)), 'Invitations envoyées — rejoindre n’engage à rien')}><Text style={styles.action}>Inviter</Text></PressScale>
                <PressScale onPress={() => act(() => proposeCollectiveRules(id, {}), 'Règles proposées : chaque membre doit les approuver')}><Text style={styles.action}>Proposer les règles</Text></PressScale>
              </View>
            </View>
          ) : null}

          {g.rules && g.status === 'awaiting_acceptance' ? (
            <View style={[styles.card, styles.column, !g.myRulesAccepted && styles.urgent]}>
              <Text style={styles.title}>Règles (version {g.rules.version})</Text>
              {(g.rules.terms.rotation ?? []).map((r) => {
                const m = g.members.find((x) => x.position === r.position);
                return <Text key={r.position} style={styles.detail}>Cycle {r.position} ({dt(g.rules.terms.schedule[r.position - 1].dueAt)}) → @{m?.handle}</Text>;
              })}
              {g.kind === 'goal' ? <Text style={styles.detail}>{g.rules.terms.cycleCount} versements · retrait {g.withdrawPolicy === 'end' ? 'à la fin' : 'à tout moment'}</Text> : null}
              <Text style={styles.detail}>Délai de grâce : {g.graceDays} jours · {Object.values(g.policies).slice(0, 4).join(' · ')}</Text>
              <Text style={styles.detail}>{g.policies.disclaimer}</Text>
              <Text style={styles.detail}>Approuvé par {g.members.filter((m) => m.rulesAccepted).length} / {g.members.filter((m) => m.status === 'joined').length}</Text>
              {!g.myRulesAccepted ? (
                <View style={styles.row}>
                  <PressScale onPress={() => act(() => acceptCollectiveRules(id, g.rules.hash), 'Règles approuvées')}><Text style={styles.action}>J’approuve ces règles</Text></PressScale>
                  {!g.iAmOrganizer ? <PressScale onPress={() => act(() => declineCollectiveRules(id), 'Tu as quitté le groupe')}><Text style={styles.muted}>Je refuse</Text></PressScale> : null}
                </View>
              ) : <Text style={styles.detail}>Tu as approuvé. Le groupe démarre quand tout le monde a approuvé.</Text>}
            </View>
          ) : null}

          {active && g.myStatus === 'joined' && g.myDue?.length ? (
            <View style={[styles.card, styles.column, styles.urgent]}>
              <Text style={styles.title}>À cotiser : {g.myDue[0].dueKori} ₭ (cycle {g.myDue[0].cycle})</Text>
              <Text style={styles.detail}>{g.myDue[0].status === 'missed' ? 'En retard — rien n’est prélevé automatiquement.' : `Avant le ${dt(g.myDue[0].dueAt)}`}</Text>
              <PressScale onPress={() => pay()} disabled={g.frozen}><Text style={styles.action}>Cotiser {g.myDue[0].dueKori} ₭</Text></PressScale>
            </View>
          ) : null}
          {active && g.kind === 'goal' && g.myShareKori > 0 && g.withdrawPolicy === 'anytime' ? (
            <PressScale onPress={() => act(() => withdrawCollective(id), 'Ton épargne est revenue sur ton portefeuille')} style={styles.card}><Text style={styles.action}>Retirer mon épargne ({g.myShareKori} ₭)</Text></PressScale>
          ) : null}

          {(g.schedule ?? []).map((s) => (
            <View key={s.cycle} style={[styles.card, styles.column, s.current && { borderLeftWidth: 3, borderLeftColor: '#00853f' }]}>
              <Text style={styles.title}>Cycle {s.cycle} · {dt(s.dueAt)}{s.recipient ? ` → @${s.recipient.handle}${s.recipient.me ? ' (moi)' : ''}` : ''}</Text>
              <Text style={styles.detail}>{s.settled}/{s.live} payés{s.payout ? ` · pot versé ${s.payout.amountKori} ₭ (${dt(s.payout.at)})` : ''}</Text>
              {s.current || s.obligations.some((o) => o.status === 'missed') ? s.obligations.map((o) => (
                <Text key={o.handle} style={styles.detail}>@{o.handle}{o.me ? ' (moi)' : ''} : {OB[o.status]}</Text>
              )) : null}
            </View>
          ))}

          {(g.votes ?? []).filter((v) => v.status === 'open' || v.myBallot).map((v) => (
            <View key={v.id} style={[styles.card, styles.column]}>
              <Text style={styles.title}>Vote : {TOPIC[v.topic]}{v.subject ? ` (@${v.subject.handle})` : ''}{v.days ? ` (+${v.days} j)` : ''}</Text>
              <Text style={styles.detail}>{v.yes} oui · {v.no} non · {v.eligible} votants · {v.threshold === 'majority' ? 'majorité' : 'unanimité'} · {v.status}</Text>
              {v.canVote ? (
                <View style={styles.row}>
                  <PressScale onPress={() => act(() => castCollectiveBallot(v.id, 'yes'), 'Vote enregistré')}><Text style={styles.action}>Oui</Text></PressScale>
                  <PressScale onPress={() => act(() => castCollectiveBallot(v.id, 'no'), 'Vote enregistré')}><Text style={styles.muted}>Non</Text></PressScale>
                </View>
              ) : null}
            </View>
          ))}

          {active && g.myStatus === 'joined' ? (
            <View style={[styles.card, styles.column]}>
              <Text style={styles.title}>Proposer au groupe</Text>
              <View style={styles.row}>
                <PressScale onPress={() => act(() => openCollectiveVote(id, 'extend_grace', 3), 'Vote ouvert')}><Text style={styles.action}>+3 jours de délai</Text></PressScale>
                {g.kind === 'rotating' ? <PressScale onPress={() => act(() => openCollectiveVote(id, 'partial_release'), 'Vote ouvert')}><Text style={styles.action}>Verser le pot partiel</Text></PressScale> : null}
                <PressScale onPress={() => act(() => openCollectiveVote(id, 'exit'), 'Demande de sortie envoyée aux membres')}><Text style={styles.muted}>Demander à sortir</Text></PressScale>
                <PressScale onPress={() => act(() => openCollectiveVote(id, 'cancel'), 'Vote d’annulation ouvert')}><Text style={styles.muted}>Annuler le groupe</Text></PressScale>
              </View>
              <TextInput value={reason} onChangeText={setReason} placeholder="Décris le problème (10 caractères min.)" style={styles.input} accessibilityLabel="Motif du litige" />
              <PressScale onPress={() => act(() => openCollectiveDispute(id, reason), 'Litige ouvert : le versement du cycle attend la décision de K21')}><Text style={styles.muted}>Ouvrir un litige sur ce cycle</Text></PressScale>
            </View>
          ) : null}

          {g.claims?.length ? (
            <View style={[styles.card, styles.column]}>
              <Text style={styles.title}>Positions à la clôture</Text>
              <Text style={styles.detail}>Enregistrées seulement : rien n’est prélevé automatiquement, rien n’est effacé.</Text>
              {g.claims.map((c) => (
                <Text key={c.handle} style={styles.detail}>@{c.handle}{c.me ? ' (moi)' : ''} : {c.direction === 'owes' ? 'doit' : 'est créancier de'} {c.amountKori} ₭ (versé {c.paidKori} · reçu {c.receivedKori})</Text>
              ))}
            </View>
          ) : null}
          {g.history?.length ? (
            <View style={[styles.card, styles.column]}>
              <Text style={styles.title}>Historique</Text>
              {g.history.slice(-30).reverse().map((h, i) => (
                <Text key={i} style={styles.detail}>{dt(h.at)} · {HIST[h.kind]} · @{h.handle} · {h.amountKori} ₭ (cycle {h.cycle}){h.late ? ' · en retard' : ''}</Text>
              ))}
            </View>
          ) : null}
        </ScrollView>
        <StepUpOverlay visible={Boolean(stepUp)} onCancel={() => setStepUp(null)} onVerified={(token) => { const k = stepUp?.idempotencyKey; setStepUp(null); pay(token, k); }} />
      </SafeAreaView>
    </View>
  );
}
