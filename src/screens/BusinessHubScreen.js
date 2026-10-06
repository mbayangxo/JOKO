import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import { useToast } from '../components/Toast';
import { useAppState } from '../state/AppState';
import { createBusiness, createFlashDeal, setBusinessStatus } from '../lib/api-client';
import { colors, fontFamily, radius, spacing } from '../theme';
import { formatKori, formatNationalEquivalent } from '../lib/kori.js';
import KoriAmount from '../components/KoriAmount';
import { useEntrance } from '../hooks/animations';
import {
  getMyBusinesses,
  getPayrollEmployees,
  addPayrollEmployee,
  payPayrollEmployee,
  getSchoolStudents,
  createSchoolFeePeriod,
  getSchoolFeePeriods,
  getSchoolPeriodStatus,
  remindSchoolFees,
  enrollSchoolStudent,
  getCooperativeDeliveries,
  logCooperativeDelivery,
  verifyCooperativeDelivery,
  payoutCooperativeFarmer,
  getBusinessWallet,
  getBusinessCreditSummary,
  getBusinessKebuScore,
  transferBusinessFunds,
  getBusinessMembers,
  inviteBusinessMember,
} from '../lib/api-client';

const TYPE_LABEL = {
  merchant: 'Marchand',
  employer: 'Employeur',
  school: 'École',
  cooperative: 'Coopérative',
};

// In-app business creation (personal account -> KEBU commerce), same
// categories as the signup flow.
const NEW_BIZ_CATEGORIES = [
  { key: 'restaurant', icon: '🍽️', name: 'Restaurant' },
  { key: 'boutique', icon: '🛍️', name: 'Boutique' },
  { key: 'supermarche', icon: '🛒', name: 'Épicerie' },
  { key: 'mode', icon: '👗', name: 'Mode' },
  { key: 'services', icon: '🔧', name: 'Services' },
  { key: 'autre', icon: '✦', name: 'Autre' },
];

const NEW_BIZ_PERKS = [
  { icon: '🆔', title: 'Ton KEBU ID', sub: 'L’identité officielle de ton commerce sur K21 — créée instantanément.' },
  { icon: '📲', title: 'QR d’encaissement', sub: 'Tes clients paient en scannant — l’argent arrive sur le compte du commerce.' },
  { icon: '⚡', title: 'Offres flash', sub: 'Publie des promos à durée réelle, visibles dans Découvrir.' },
  { icon: '🧑‍🤝‍🧑', title: 'Équipe & paie', sub: 'Ajoute des employés et paie-les depuis le tableau de bord.' },
];

function formatAmount(n) {
  return Math.round(n ?? 0).toLocaleString('fr-FR').replace(/ /g, ' ');
}

function TabPill({ label, active, onPress }) {
  return (
    <PressScale scaleTo={0.96} onPress={onPress} style={[styles.tab, active && styles.tabOn]}>
      <Text style={[styles.tabText, active && styles.tabTextOn]}>{label}</Text>
    </PressScale>
  );
}

function PerkRow({ perk, delay = 0 }) {
  const entrance = useEntrance(delay, 300, 10);
  return (
    <Animated.View style={[styles.perkRow, entrance]}>
      <View style={styles.perkIcon}>
        <Text style={{ fontSize: 18 }}>{perk.icon}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.perkTitle}>{perk.title}</Text>
        <Text style={styles.perkSub}>{perk.sub}</Text>
      </View>
    </Animated.View>
  );
}

function SectionCard({ title, children, delay = 0 }) {
  const entrance = useEntrance(delay, 300, 10);
  return (
    <Animated.View style={[styles.card, entrance]}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </Animated.View>
  );
}

export default function BusinessHubScreen({ navigation, route }) {
  const { profile, balance, transactions, refreshWallet, setProfile } = useAppState();
  const { showToast } = useToast();
  const [businesses, setBusinesses] = useState(profile.businesses?.length ? profile.businesses : profile.business ? [profile.business] : []);
  const [activeId, setActiveId] = useState(profile.business?.id ?? profile.businesses?.[0]?.id ?? null);
  const [newBizName, setNewBizName] = useState('');
  const [newBizCategory, setNewBizCategory] = useState('restaurant');
  const [creatingBiz, setCreatingBiz] = useState(false);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(false);
  const heroEntrance = useEntrance(0, 350, 12);

  const [employees, setEmployees] = useState([]);
  const [newHandle, setNewHandle] = useState('');
  const [newPay, setNewPay] = useState('50000');
  const [newRole, setNewRole] = useState('staff');

  const [students, setStudents] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [periodStatus, setPeriodStatus] = useState(null);
  const [newStudentName, setNewStudentName] = useState('');
  const [newParentHandle, setNewParentHandle] = useState('');
  const [periodLabel, setPeriodLabel] = useState('');
  const [periodAmount, setPeriodAmount] = useState('25000');

  const [deliveries, setDeliveries] = useState([]);
  const [deliveryTons, setDeliveryTons] = useState('1');
  const [farmerHandle, setFarmerHandle] = useState('');

  const [flashTitle, setFlashTitle] = useState('');
  const [flashNormalPrice, setFlashNormalPrice] = useState('');
  const [flashDealPrice, setFlashDealPrice] = useState('');
  const [flashHours, setFlashHours] = useState(4);
  const [flashSaving, setFlashSaving] = useState(false);

  const [statusDraft, setStatusDraft] = useState('');
  const [statusSaving, setStatusSaving] = useState(false);

  const [kebuBalance, setKebuBalance] = useState(0);
  const [kebuScore, setKebuScore] = useState(null);
  const [kebuLedger, setKebuLedger] = useState([]);
  const [creditTier, setCreditTier] = useState('starter');
  const [members, setMembers] = useState([]);
  const [memberHandle, setMemberHandle] = useState('');
  const [memberRole, setMemberRole] = useState('staff');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferKebu, setTransferKebu] = useState('');
  const [transferNote, setTransferNote] = useState('');

  const publishFlashDeal = async () => {
    const price = Number(flashNormalPrice);
    const deal = Number(flashDealPrice);
    if (!flashTitle.trim() || !Number.isInteger(price) || price <= 0) {
      showToast('Titre et prix normal requis');
      return;
    }
    if (!Number.isInteger(deal) || deal <= 0 || deal >= price) {
      showToast('Le prix flash doit être inférieur au prix normal');
      return;
    }
    setFlashSaving(true);
    try {
      await createFlashDeal({
        businessId: business.id,
        title: flashTitle.trim(),
        price,
        flashPrice: deal,
        flashHours,
      });
      setFlashTitle('');
      setFlashNormalPrice('');
      setFlashDealPrice('');
      showToast(`Offre flash publiée — expire dans ${flashHours}h ✓`);
    } catch (err) {
      showToast(err.message ?? 'Publication impossible');
    } finally {
      setFlashSaving(false);
    }
  };

  const business = businesses.find((b) => b.id === activeId) ?? businesses[0] ?? profile.business;
  const type = business?.type ?? 'merchant';

  useEffect(() => {
    setStatusDraft(business?.statusText ?? '');
  }, [business?.id, business?.statusText]);

  useEffect(() => {
    if (route.params?.tab) setTab(route.params.tab);
    if (route.params?.businessId) setActiveId(route.params.businessId);
  }, [route.params?.tab, route.params?.businessId]);

  const publishStatus = async (textOverride) => {
    if (!business?.id) return;
    const text = textOverride ?? statusDraft;
    setStatusSaving(true);
    try {
      await setBusinessStatus(business.id, text);
      showToast(text.trim() ? 'Statut publié ✓' : 'Statut effacé ✓');
      const updated = { ...business, statusText: text.trim() || null };
      setBusinesses((prev) => prev.map((b) => (b.id === business.id ? updated : b)));
      setStatusDraft(text.trim());
    } catch (err) {
      showToast(err.message ?? 'Publication impossible');
    } finally {
      setStatusSaving(false);
    }
  };

  const openDistributionHub = () => {
    navigation.navigate('Main', { screen: 'MarketplaceTab', params: { screen: 'DistributionHub' } });
  };

  const openB2BOrderPortal = () => {
    navigation.navigate('Main', { screen: 'MarketplaceTab', params: { screen: 'B2BOrderPortal' } });
  };

  const loadBusinesses = useCallback(async () => {
    try {
      const res = await getMyBusinesses();
      const owned = res.owned ?? [];
      setBusinesses(owned);
      if (owned.length && !activeId) setActiveId(owned[0].id);
      if (owned[0]) setProfile({ business: owned[0], businesses: owned });
    } catch {
      /* keep cached profile */
    }
  }, [activeId, setProfile]);

  const submitNewBusiness = async () => {
    const name = newBizName.trim();
    if (name.length < 2) return;
    setCreatingBiz(true);
    try {
      const created = await createBusiness({ name, type: 'merchant', category: newBizCategory });
      showToast(`${created.name} créé ✓ — KEBU ${created.kebuId ?? ''}`.trim());
      setNewBizName('');
      setActiveId(created.id);
      await loadBusinesses();
    } catch (err) {
      showToast(err.message ?? 'Création impossible — réessaie');
    } finally {
      setCreatingBiz(false);
    }
  };

  const loadKebuWallet = useCallback(async () => {
    if (!business?.id) return;
    try {
      const [walletRes, credit, score] = await Promise.all([
        getBusinessWallet(business.id),
        getBusinessCreditSummary(business.id).catch(() => null),
        getBusinessKebuScore(business.id).catch(() => null),
      ]);
      setKebuBalance(walletRes.wallet?.balance ?? 0);
      setKebuLedger(walletRes.ledger ?? []);
      if (credit?.lifetime?.creditTier) setCreditTier(credit.lifetime.creditTier);
      setKebuScore(score);
    } catch {
      /* non-fatal */
    }
  }, [business?.id]);

  const loadTabData = useCallback(async () => {
    if (!business?.id) return;
    setLoading(true);
    try {
      if (tab === 'overview' || tab === 'wallet') {
        await loadKebuWallet();
      }
      if (tab === 'team') {
        setMembers(await getBusinessMembers(business.id));
      }
      if (tab === 'payroll' || type === 'employer' || type === 'cooperative') {
        setEmployees(await getPayrollEmployees(business.id));
      }
      if (tab === 'school' || type === 'school') {
        setStudents(await getSchoolStudents(business.id));
        setPeriods(await getSchoolFeePeriods(business.id));
        if (periods[0]?.id) {
          setPeriodStatus(await getSchoolPeriodStatus(business.id, periods[0].id));
        }
      }
      if (tab === 'coop' || type === 'cooperative') {
        setDeliveries(await getCooperativeDeliveries(business.id));
      }
    } catch (err) {
      showToast(err.message ?? 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [business?.id, tab, type, periods, showToast, loadKebuWallet]);

  useFocusEffect(
    useCallback(() => {
      refreshWallet().catch(() => {});
      loadBusinesses();
    }, [refreshWallet, loadBusinesses]),
  );

  useFocusEffect(
    useCallback(() => {
      if (business?.id) loadTabData();
    }, [business?.id, tab, loadTabData]),
  );

  const tabsForType = () => {
    const base = [
      { key: 'overview', label: 'Aperçu' },
      { key: 'wallet', label: 'KEBU wallet' },
      { key: 'team', label: 'Équipe' },
    ];
    if (type === 'employer' || type === 'cooperative' || type === 'merchant' || type === 'trader' || type === 'aggregator') {
      base.push({ key: 'payroll', label: 'Paie' });
    }
    if (type === 'school') base.push({ key: 'school', label: 'École' });
    if (type === 'cooperative') base.push({ key: 'coop', label: 'Livraisons' });
    return base;
  };

  const addEmployee = async () => {
    if (!business?.id || !newHandle.trim()) return;
    setLoading(true);
    try {
      await addPayrollEmployee(business.id, {
        userHandle: newHandle.trim(),
        jobTitle: newRole,
        payAmount: parseInt(newPay, 10) || undefined,
      });
      setNewHandle('');
      showToast('Employé ajouté ✓');
      setEmployees(await getPayrollEmployees(business.id));
    } catch (err) {
      showToast(err.message ?? 'Ajout impossible');
    } finally {
      setLoading(false);
    }
  };

  const payEmployee = async (emp) => {
    setLoading(true);
    try {
      await payPayrollEmployee(business.id, { employeeId: emp.id });
      showToast(`Payé ${emp.user?.name ?? ''} ✓`);
      await loadKebuWallet();
    } catch (err) {
      showToast(err.message ?? 'Paiement impossible');
    } finally {
      setLoading(false);
    }
  };

  const enrollStudent = async () => {
    if (!newStudentName.trim() || !newParentHandle.trim()) return;
    setLoading(true);
    try {
      await enrollSchoolStudent(business.id, {
        studentName: newStudentName.trim(),
        parentHandle: newParentHandle.trim(),
      });
      setNewStudentName('');
      setNewParentHandle('');
      showToast('Élève inscrit ✓');
      setStudents(await getSchoolStudents(business.id));
    } catch (err) {
      showToast(err.message ?? 'Inscription impossible');
    } finally {
      setLoading(false);
    }
  };

  const openPeriod = async () => {
    if (!periodLabel.trim()) return;
    setLoading(true);
    try {
      const due = new Date();
      due.setDate(due.getDate() + 30);
      await createSchoolFeePeriod(business.id, {
        label: periodLabel.trim(),
        amount: parseInt(periodAmount, 10) || 25000,
        dueDate: due.toISOString(),
      });
      setPeriodLabel('');
      const p = await getSchoolFeePeriods(business.id);
      setPeriods(p);
      if (p[0]) setPeriodStatus(await getSchoolPeriodStatus(business.id, p[0].id));
      showToast('Période créée ✓');
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    } finally {
      setLoading(false);
    }
  };

  const sendReminders = async () => {
    const pid = periods[0]?.id;
    if (!pid) return;
    setLoading(true);
    try {
      const r = await remindSchoolFees(business.id, pid);
      showToast(`${r.reminded ?? 0} rappel(s) envoyé(s)`);
    } catch (err) {
      showToast(err.message ?? 'Rappel impossible');
    } finally {
      setLoading(false);
    }
  };

  const logDelivery = async () => {
    if (!farmerHandle.trim()) return;
    setLoading(true);
    try {
      const handle = farmerHandle.replace(/^@/, '').trim();
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 86400000);
      await logCooperativeDelivery(business.id, {
        farmerHandle: handle,
        quantityTons: parseFloat(deliveryTons) || 1,
        periodStart: weekAgo.toISOString(),
        periodEnd: now.toISOString(),
        note: 'Log terrain',
      });
      showToast('Livraison enregistrée ✓');
      setDeliveries(await getCooperativeDeliveries(business.id));
    } catch (err) {
      showToast(err.message ?? 'Log impossible — utilise @handle du paysan');
    } finally {
      setLoading(false);
    }
  };

  const fundKebuFromPersonal = async () => {
    const amount = parseInt(transferAmount, 10);
    if (!amount || amount <= 0) return;
    setLoading(true);
    try {
      await transferBusinessFunds(business.id, { kind: 'capital_in', amount, note: transferNote || undefined });
      showToast(`${formatKori(amount)} ajoutés au KEBU ✓`);
      setTransferAmount('');
      await loadKebuWallet();
      await refreshWallet();
    } catch (err) {
      showToast(err.message ?? 'Transfert impossible');
    } finally {
      setLoading(false);
    }
  };

  const drawKebuToPersonal = async () => {
    const amount = parseInt(transferAmount, 10);
    if (!amount || amount <= 0) return;
    setLoading(true);
    try {
      await transferBusinessFunds(business.id, { kind: 'owner_draw', amount, note: transferNote || undefined });
      showToast(`${formatKori(amount)} vers ton wallet AFRI ✓`);
      setTransferAmount('');
      await loadKebuWallet();
      await refreshWallet();
    } catch (err) {
      showToast(err.message ?? 'Retrait impossible');
    } finally {
      setLoading(false);
    }
  };

  const payKebuB2B = async () => {
    const amount = parseInt(transferAmount, 10);
    if (!amount || amount <= 0 || !transferKebu.trim()) return;
    setLoading(true);
    try {
      await transferBusinessFunds(business.id, {
        kind: 'b2b',
        amount,
        recipientKebuId: transferKebu.trim(),
        note: transferNote || undefined,
      });
      showToast(`Paiement B2B ${formatKori(amount)} ✓`);
      setTransferAmount('');
      setTransferKebu('');
      await loadKebuWallet();
    } catch (err) {
      showToast(err.message ?? 'Paiement B2B impossible');
    } finally {
      setLoading(false);
    }
  };

  const inviteMember = async () => {
    if (!memberHandle.trim()) return;
    setLoading(true);
    try {
      await inviteBusinessMember(business.id, { userHandle: memberHandle.trim(), role: memberRole });
      showToast('Membre ajouté ✓');
      setMemberHandle('');
      setMembers(await getBusinessMembers(business.id));
    } catch (err) {
      showToast(err.message ?? 'Invitation impossible');
    } finally {
      setLoading(false);
    }
  };

  if (!business) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <ScrollView contentContainerStyle={styles.createWrap} keyboardShouldPersistTaps="handled">
            <View style={styles.createHeadRow}>
              <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.createBack}>
                <Text style={{ fontSize: 14, color: colors.ink }}>←</Text>
              </PressScale>
              <Text style={styles.createEyebrow}>KEBU</Text>
            </View>
            <Text style={styles.emptyTitle}>Crée ton business</Text>
            <Text style={styles.emptySub}>
              Un seul compte K21 par personne (ton AFRI ID) — chaque commerce que tu crées reçoit son
              propre KEBU ID, avec sa caisse séparée de ton argent personnel.
            </Text>

            <Text style={styles.createLabel}>Nom du commerce</Text>
            <TextInput
              style={styles.createInput}
              value={newBizName}
              onChangeText={setNewBizName}
              placeholder="Ex : Dibiterie Chez Awa"
              placeholderTextColor={'rgba(5,8,5,0.4)'}
            />

            <Text style={styles.createLabel}>Catégorie</Text>
            <View style={styles.createCats}>
              {NEW_BIZ_CATEGORIES.map((c) => (
                <PressScale
                  key={c.key}
                  scaleTo={0.95}
                  onPress={() => setNewBizCategory(c.key)}
                  style={[styles.createCat, newBizCategory === c.key && styles.createCatOn]}
                >
                  <Text style={{ fontSize: 15 }}>{c.icon}</Text>
                  <Text style={styles.createCatText}>{c.name}</Text>
                </PressScale>
              ))}
            </View>

            <Text style={styles.createLabel}>Ce que ton KEBU t'apporte</Text>
            <View style={styles.perksList}>
              {NEW_BIZ_PERKS.map((p, i) => (
                <PerkRow key={p.title} perk={p} delay={i * 60} />
              ))}
            </View>

            <GlowButton
              label={creatingBiz ? 'Création…' : '🏪 Créer mon business'}
              onPress={submitNewBusiness}
              disabled={creatingBiz || newBizName.trim().length < 2}
              style={{ marginTop: spacing.xl }}
            />
            <Text style={styles.createFootnote}>
              Gratuit · Ton KEBU ID est attribué immédiatement · Tu peux gérer plusieurs commerces
            </Text>
          </ScrollView>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={{ paddingBottom: spacing.giant }} showsVerticalScrollIndicator={false}>
          <Animated.View style={[styles.hero, heroEntrance]}>
            <View style={styles.topRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.bizName}>{business.name}</Text>
                <Text style={styles.bizMeta}>
                  {TYPE_LABEL[type] ?? 'Commerce'} · {business.kebuId ?? 'KEBU —'}
                </Text>
              </View>
              <PressScale
                scaleTo={0.9}
                onPress={() => navigation.navigate('MbooloSharePicker', { refType: 'business', refId: business.id, title: business.name })}
                style={styles.notifBtn}
              >
                <Text style={{ fontSize: 16 }}>💬</Text>
              </PressScale>
              <PressScale scaleTo={0.9} onPress={() => navigation.navigate('Main', { screen: 'NotificationsTab' })} style={styles.notifBtn}>
                <Text style={{ fontSize: 16 }}>🔔</Text>
              </PressScale>
            </View>
            {businesses.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
                {businesses.map((b) => (
                  <PressScale key={b.id} scaleTo={0.96} onPress={() => setActiveId(b.id)} style={[styles.bizChip, activeId === b.id && styles.bizChipOn]}>
                    <Text style={[styles.bizChipText, activeId === b.id && styles.bizChipTextOn]}>{b.name}</Text>
                  </PressScale>
                ))}
              </ScrollView>
            ) : null}
            <KoriAmount value={kebuBalance} textStyle={styles.balance} />
            <Text style={styles.balanceLabel}>Solde KEBU · {business.kebuId ?? '—'}</Text>
            <Text style={styles.creditPill}>Crédit KEBU · {creditTier}</Text>
          </Animated.View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabRow}>
            {tabsForType().map((t) => (
              <TabPill key={t.key} label={t.label} active={tab === t.key} onPress={() => setTab(t.key)} />
            ))}
          </ScrollView>

          {loading ? <ActivityIndicator color={colors.flagGold} style={{ marginVertical: spacing.lg }} /> : null}

          {tab === 'overview' && (
            <View style={styles.panel}>
              <View style={styles.actionsRow}>
                <PressScale scaleTo={0.9} onPress={() => navigation.navigate('Receive')} style={styles.actionBtn}>
                  <Text style={{ fontSize: 20 }}>💳</Text>
                  <Text style={styles.actionLabel}>Recevoir</Text>
                </PressScale>
                <PressScale scaleTo={0.9} onPress={() => activeId && navigation.navigate('BusinessOS', { businessId: activeId, section: 'payments' })} style={styles.actionBtn}>
                  <Text style={{ fontSize: 20 }}>🏪</Text>
                  <Text style={styles.actionLabel}>Encaisser</Text>
                </PressScale>
                <PressScale scaleTo={0.9} onPress={() => activeId && navigation.navigate('BusinessOS', { businessId: activeId })} style={styles.actionBtn}>
                  <Text style={{ fontSize: 20 }}>🧾</Text>
                  <Text style={styles.actionLabel}>Mode commerce</Text>
                </PressScale>
                <PressScale scaleTo={0.9} onPress={() => setTab(type === 'school' ? 'school' : type === 'cooperative' ? 'coop' : 'payroll')} style={styles.actionBtn}>
                  <Text style={{ fontSize: 20 }}>⚙️</Text>
                  <Text style={styles.actionLabel}>Gérer</Text>
                </PressScale>
              </View>
              {kebuScore ? (
                <SectionCard title="📊 Score KEBU" delay={0}>
                  <View style={styles.kebuScoreRow}>
                    <Text style={styles.kebuScoreValue}>{kebuScore.score}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.kebuScoreTier}>{kebuScore.tierLabel}</Text>
                      <Text style={styles.kebuScoreHint}>
                        {kebuScore.suggestedCreditLimitKori > 0
                          ? `Crédit B2B suggéré jusqu'à ${formatKori(kebuScore.suggestedCreditLimitKori)}`
                          : 'Paiements réguliers à temps pour débloquer du crédit B2B'}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.kebuScoreDetail}>
                    Paiements à temps · KYC · ancienneté · activité KEBU · avis clients — calculé automatiquement,
                    aucune donnée à saisir.
                  </Text>
                </SectionCard>
              ) : null}
              <SectionCard title="✦ Statut — visible sur ta page publique" delay={70}>
                <TextInput
                  style={styles.input}
                  placeholder="Ex : Inscriptions ouvertes, on recrute, promo ce week-end…"
                  placeholderTextColor={'rgba(5,8,5,0.45)'}
                  value={statusDraft}
                  onChangeText={setStatusDraft}
                  maxLength={80}
                />
                <GlowButton
                  tone="gold"
                  label={statusSaving ? '…' : 'Publier le statut →'}
                  onPress={publishStatus}
                  disabled={statusSaving}
                />
                {business?.statusText ? (
                  <PressScale scaleTo={0.96} onPress={() => publishStatus('')}>
                    <Text style={styles.flashHint}>Effacer le statut actuel</Text>
                  </PressScale>
                ) : null}
              </SectionCard>

              <SectionCard title="📦 Distribution & B2B">
                <Text style={styles.hintText}>
                  Enregistre ta marque, vends en gros (granulés, beurre de cacahuète), facture tes clients et paie tes employés.
                </Text>
                <GlowButton label="Hub distribution" onPress={openDistributionHub} />
                <GlowButton label="Portail commandes B2B" onPress={openB2BOrderPortal} />
                <GlowButton label="Réapprovisionner (fournisseurs connectés)" onPress={() => navigation.navigate('Main', { screen: 'MarketplaceTab', params: { screen: 'Restock' } })} />
                <PressScale scaleTo={0.98} onPress={() => navigation.navigate('AgentHub')} style={styles.linkRow}>
                  <Text style={styles.linkText}>Retrait / dépôt chez un agent K21 →</Text>
                </PressScale>
                <PressScale scaleTo={0.98} onPress={() => navigation.navigate('InviteFriends')} style={styles.linkRow}>
                  <Text style={styles.linkText}>Inviter des clients sur K21 →</Text>
                </PressScale>
                <PressScale scaleTo={0.98} onPress={() => navigation.navigate('Main', { screen: 'MarketplaceTab', params: { screen: 'TradeInvoices' } })} style={styles.linkRow}>
                  <Text style={styles.linkText}>Mes factures B2B à payer →</Text>
                </PressScale>
              </SectionCard>
              <SectionCard title="⚡ Offre flash — visible dans Discover" delay={140}>
                <TextInput
                  style={styles.input}
                  placeholder="Plat ou produit (ex: Dibi 500g)"
                  placeholderTextColor={'rgba(5,8,5,0.45)'}
                  value={flashTitle}
                  onChangeText={setFlashTitle}
                  maxLength={60}
                />
                <View style={{ flexDirection: 'row', gap: spacing.md }}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="Prix normal (F)"
                    placeholderTextColor={'rgba(5,8,5,0.45)'}
                    keyboardType="number-pad"
                    value={flashNormalPrice}
                    onChangeText={setFlashNormalPrice}
                  />
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="Prix flash (F)"
                    placeholderTextColor={'rgba(5,8,5,0.45)'}
                    keyboardType="number-pad"
                    value={flashDealPrice}
                    onChangeText={setFlashDealPrice}
                  />
                </View>
                <View style={styles.flashHoursRow}>
                  {[2, 4, 12, 24].map((h) => (
                    <PressScale
                      key={h}
                      scaleTo={0.94}
                      onPress={() => setFlashHours(h)}
                      style={[styles.flashHourChip, flashHours === h && styles.flashHourChipOn]}
                    >
                      <Text style={[styles.flashHourText, flashHours === h && styles.flashHourTextOn]}>{h}h</Text>
                    </PressScale>
                  ))}
                </View>
                <GlowButton
                  tone="gold"
                  label={flashSaving ? '…' : 'Publier l’offre flash →'}
                  onPress={publishFlashDeal}
                  disabled={flashSaving}
                />
                <Text style={styles.flashHint}>
                  L’offre disparaît automatiquement à l’expiration — vraie réduction, vraie deadline.
                </Text>
              </SectionCard>

              <Text style={styles.sectionEyebrow}>Mouvements KEBU récents</Text>
              {kebuLedger.slice(0, 5).map((tx) => (
                <View key={tx.reference} style={styles.txRow}>
                  <Text style={styles.txTitle}>{tx.counterpartyName ?? tx.type}</Text>
                  <Text style={[styles.txAmt, { color: tx.amount > 0 ? colors.flagGold : colors.terracotta }]}>
                    {tx.amount > 0 ? '+' : ''}{formatAmount(tx.amount)} F
                  </Text>
                </View>
              ))}
            </View>
          )}

          {tab === 'wallet' && (
            <View style={styles.panel}>
              <SectionCard title="Alimenter depuis ton AFRI">
                <TextInput style={styles.input} placeholder="Montant C" placeholderTextColor={'rgba(5,8,5,0.45)'} keyboardType="number-pad" value={transferAmount} onChangeText={setTransferAmount} />
                <TextInput style={styles.input} placeholder="Note (optionnel)" placeholderTextColor={'rgba(5,8,5,0.45)'} value={transferNote} onChangeText={setTransferNote} />
                <GlowButton label="AFRI → KEBU" onPress={fundKebuFromPersonal} disabled={loading} />
              </SectionCard>
              <SectionCard title="Retirer vers ton AFRI">
                <GlowButton tone="gold" label="KEBU → AFRI" onPress={drawKebuToPersonal} disabled={loading} />
              </SectionCard>
              <SectionCard title="Payer un autre KEBU (B2B)">
                <Text style={styles.rowSub}>Ex: laitier → coopérative · KEBU ID destinataire</Text>
                <TextInput style={styles.input} placeholder="KEBU-XXXXXX" placeholderTextColor={'rgba(5,8,5,0.45)'} autoCapitalize="characters" value={transferKebu} onChangeText={setTransferKebu} />
                <GlowButton label="Payer B2B" onPress={payKebuB2B} disabled={loading} />
              </SectionCard>
              <SectionCard title="Historique KEBU">
                {kebuLedger.map((tx) => (
                  <View key={tx.reference} style={styles.listRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{tx.type}</Text>
                      <Text style={styles.rowSub}>{tx.counterpartyName ?? tx.note ?? tx.reference}</Text>
                    </View>
                    <Text style={styles.rowTitle}>{formatAmount(tx.amount)} F</Text>
                  </View>
                ))}
              </SectionCard>
            </View>
          )}

          {tab === 'team' && (
            <View style={styles.panel}>
              <SectionCard title="Inviter un membre">
                <TextInput style={styles.input} placeholder="@handle K21" placeholderTextColor={'rgba(5,8,5,0.45)'} value={memberHandle} onChangeText={setMemberHandle} autoCapitalize="none" />
                <TextInput style={styles.input} placeholder="Rôle (cfo, warehouse, staff…)" placeholderTextColor={'rgba(5,8,5,0.45)'} value={memberRole} onChangeText={setMemberRole} />
                <GlowButton label="Inviter" onPress={inviteMember} disabled={loading} />
              </SectionCard>
              <SectionCard title={`Membres (${members.length})`}>
                {members.map((m) => (
                  <View key={m.id} style={styles.listRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{m.user?.name ?? m.user?.handle}</Text>
                      <Text style={styles.rowSub}>@{m.user?.handle} · {m.role}</Text>
                    </View>
                  </View>
                ))}
              </SectionCard>
            </View>
          )}

          {tab === 'payroll' && (
            <View style={styles.panel}>
              <SectionCard title="Ajouter un employé">
                <TextInput style={styles.input} placeholder="@handle K21" placeholderTextColor={'rgba(5,8,5,0.45)'} value={newHandle} onChangeText={setNewHandle} autoCapitalize="none" />
                <TextInput style={styles.input} placeholder="Rôle (staff, CEO…)" placeholderTextColor={'rgba(5,8,5,0.45)'} value={newRole} onChangeText={setNewRole} />
                <TextInput style={styles.input} placeholder="Salaire XOF" placeholderTextColor={'rgba(5,8,5,0.45)'} keyboardType="number-pad" value={newPay} onChangeText={setNewPay} />
                <GlowButton label="Ajouter" onPress={addEmployee} disabled={loading} />
              </SectionCard>
              <SectionCard title={`Équipe (${employees.length})`}>
                {employees.map((emp) => (
                  <View key={emp.id} style={styles.listRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{emp.user?.name ?? emp.user?.handle}</Text>
                      <Text style={styles.rowSub}>{emp.jobTitle} · {formatAmount(emp.payAmount)} F</Text>
                    </View>
                    <PressScale scaleTo={0.95} onPress={() => payEmployee(emp)} style={styles.payChip}>
                      <Text style={styles.payChipText}>Payer</Text>
                    </PressScale>
                  </View>
                ))}
              </SectionCard>
            </View>
          )}

          {tab === 'school' && (
            <View style={styles.panel}>
              <SectionCard title="Inscrire un élève">
                <TextInput style={styles.input} placeholder="Nom de l'enfant" placeholderTextColor={'rgba(5,8,5,0.45)'} value={newStudentName} onChangeText={setNewStudentName} />
                <TextInput style={styles.input} placeholder="@handle du parent" placeholderTextColor={'rgba(5,8,5,0.45)'} value={newParentHandle} onChangeText={setNewParentHandle} autoCapitalize="none" />
                <GlowButton label="Inscrire" onPress={enrollStudent} disabled={loading} />
              </SectionCard>
              <SectionCard title="Frais mensuels">
                <TextInput style={styles.input} placeholder="Ex: Mars 2026" placeholderTextColor={'rgba(5,8,5,0.45)'} value={periodLabel} onChangeText={setPeriodLabel} />
                <TextInput style={styles.input} placeholder="Montant XOF" placeholderTextColor={'rgba(5,8,5,0.45)'} keyboardType="number-pad" value={periodAmount} onChangeText={setPeriodAmount} />
                <GlowButton label="Ouvrir la période" onPress={openPeriod} disabled={loading} />
                {periods[0] ? (
                  <>
                    <GlowButton label="Rappeler les impayés" onPress={sendReminders} disabled={loading} />
                    {periodStatus ? (
                      <Text style={styles.rowSub}>
                        Payé: {periodStatus.summary?.paidCount ?? 0} · Impayé: {periodStatus.summary?.unpaidCount ?? 0}
                      </Text>
                    ) : null}
                  </>
                ) : null}
              </SectionCard>
              <SectionCard title={`Élèves (${students.length})`}>
                {students.map((s) => (
                  <Text key={s.id} style={styles.rowTitle}>{s.studentName} · parent @{s.parent?.handle}</Text>
                ))}
              </SectionCard>
            </View>
          )}

          {tab === 'coop' && (
            <View style={styles.panel}>
              <SectionCard title="Log livraison (offline OK)">
                <TextInput style={styles.input} placeholder="ID ou @handle paysan" placeholderTextColor={'rgba(5,8,5,0.45)'} value={farmerHandle} onChangeText={setFarmerHandle} />
                <TextInput style={styles.input} placeholder="Tonnes" placeholderTextColor={'rgba(5,8,5,0.45)'} keyboardType="decimal-pad" value={deliveryTons} onChangeText={setDeliveryTons} />
                <GlowButton label="Enregistrer" onPress={logDelivery} disabled={loading} />
              </SectionCard>
              <SectionCard title="Livraisons">
                {deliveries.map((d) => (
                  <View key={d.id} style={styles.listRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{d.farmer?.name ?? d.farmerUserId}</Text>
                      <Text style={styles.rowSub}>{d.quantityTons}t · {d.status}</Text>
                    </View>
                    {d.status === 'pending' ? (
                      <PressScale
                        scaleTo={0.95}
                        onPress={async () => {
                          await verifyCooperativeDelivery(business.id, d.id, { approved: true });
                          setDeliveries(await getCooperativeDeliveries(business.id));
                          showToast('Vérifié ✓');
                        }}
                        style={styles.payChip}
                      >
                        <Text style={styles.payChipText}>OK</Text>
                      </PressScale>
                    ) : null}
                  </View>
                ))}
              </SectionCard>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  emptyTitle: { fontFamily: fontFamily.displayBold, fontSize: 18, color: colors.ink },
  emptySub: { fontSize: 12, color: 'rgba(5,8,5,0.5)', marginTop: spacing.sm, textAlign: 'center' },
  createWrap: { paddingHorizontal: spacing.huge, paddingTop: spacing.xxl, paddingBottom: spacing.giant },
  createHeadRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.xl },
  createBack: {
    width: 36, height: 36, borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  createEyebrow: { fontFamily: fontFamily.bodyBold, fontSize: 11, letterSpacing: 2, color: colors.greenDark },
  createLabel: {
    fontFamily: fontFamily.bodyBold, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase',
    color: 'rgba(5,8,5,0.45)', marginTop: spacing.xxl, marginBottom: spacing.sm,
  },
  createInput: {
    height: 50, borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.1)',
    paddingHorizontal: spacing.lg, color: colors.ink, fontSize: 14,
  },
  createCats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  createCat: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)',
    borderRadius: 999, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
  },
  createCatOn: { backgroundColor: 'rgba(26,240,96,0.14)', borderColor: 'rgba(15,188,72,0.4)' },
  createCatText: { fontSize: 12, color: colors.ink, fontFamily: fontFamily.bodyBold },
  perksList: { gap: spacing.sm },
  perkRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)',
    borderRadius: radius.lg, borderBottomRightRadius: 8,
    padding: spacing.lg,
  },
  perkIcon: {
    width: 40, height: 40, borderRadius: 13, borderBottomRightRadius: 7,
    backgroundColor: 'rgba(250,216,54,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  perkTitle: { fontFamily: fontFamily.bodyBold, fontSize: 12.5, color: colors.ink },
  perkSub: { fontSize: 11, color: 'rgba(5,8,5,0.55)', lineHeight: 15, marginTop: 1 },
  createFootnote: { fontSize: 10.5, color: 'rgba(5,8,5,0.45)', textAlign: 'center', marginTop: spacing.lg },
  hero: { padding: spacing.xxl, backgroundColor: colors.goldA10, borderBottomWidth: 1, borderBottomColor: colors.goldA20 },
  topRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  bizName: { fontFamily: fontFamily.displayBold, fontSize: 16, color: colors.ink },
  bizMeta: { fontSize: 11, color: 'rgba(5,8,5,0.5)', marginTop: 2 },
  notifBtn: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center' },
  bizChip: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.round, backgroundColor: 'rgba(255,255,255,0.7)', marginRight: spacing.sm },
  bizChipOn: { backgroundColor: colors.goldA20 },
  bizChipText: { fontSize: 11, color: 'rgba(5,8,5,0.55)' },
  bizChipTextOn: { color: colors.goldDark, fontWeight: '700' },
  balance: { fontFamily: fontFamily.displayBlack, fontSize: 36, color: colors.goldDark, letterSpacing: -1 },
  balanceLabel: { fontSize: 11, color: 'rgba(5,8,5,0.45)' },
  creditPill: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    fontFamily: fontFamily.bodyBold,
    fontSize: 10,
    color: colors.goldDark,
    backgroundColor: 'rgba(250,216,54,0.15)',
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.round,
    overflow: 'hidden',
  },
  tabRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, gap: spacing.sm },
  tab: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.round, backgroundColor: 'rgba(255,255,255,0.7)', marginRight: spacing.sm },
  tabOn: { backgroundColor: colors.goldA20 },
  tabText: { fontSize: 11, fontWeight: '700', color: 'rgba(5,8,5,0.5)' },
  tabTextOn: { color: colors.goldDark },
  panel: { paddingHorizontal: spacing.xxl, gap: spacing.lg },
  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: spacing.lg },
  kebuScoreRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.sm },
  kebuScoreValue: { fontFamily: fontFamily.displayBlack, fontSize: 32, color: colors.greenDark },
  kebuScoreTier: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  kebuScoreHint: { fontSize: 11, color: 'rgba(5,8,5,0.6)', marginTop: 2 },
  kebuScoreDetail: { fontSize: 10, color: 'rgba(5,8,5,0.45)', lineHeight: 15 },
  actionBtn: { alignItems: 'center', gap: spacing.xs },
  actionLabel: { fontSize: 9, color: 'rgba(5,8,5,0.55)', fontWeight: '700' },
  flashHoursRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  flashHourChip: { flex: 1, height: 34, borderRadius: radius.round, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.1)', alignItems: 'center', justifyContent: 'center' },
  flashHourChipOn: { backgroundColor: 'rgba(250,216,54,0.25)', borderColor: colors.goldDark },
  flashHourText: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: 'rgba(5,8,5,0.55)' },
  flashHourTextOn: { color: colors.goldDark },
  flashHint: { fontSize: 10, color: 'rgba(5,8,5,0.5)', textAlign: 'center', marginTop: spacing.sm },
  sectionEyebrow: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', marginBottom: spacing.sm },
  txRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(5,8,5,0.07)' },
  txTitle: { fontSize: 12, color: colors.ink },
  txAmt: { fontFamily: fontFamily.bodyBold, fontSize: 12 },
  card: { backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: radius.xl, borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', padding: spacing.lg, gap: spacing.sm },
  cardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.goldDark, marginBottom: spacing.xs },
  input: { height: 44, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.09)', paddingHorizontal: spacing.lg, color: colors.ink, fontSize: 13 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(5,8,5,0.07)' },
  rowTitle: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.ink },
  rowSub: { fontSize: 10, color: 'rgba(5,8,5,0.5)', marginTop: 2 },
  payChip: { backgroundColor: colors.greenA12, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.lg },
  payChipText: { fontSize: 10, fontWeight: '800', color: colors.greenDark },
  hintText: { fontSize: 11, color: 'rgba(5,8,5,0.55)', lineHeight: 16 },
  linkRow: { paddingVertical: spacing.sm },
  linkText: { fontSize: 12, color: colors.greenDark, fontFamily: fontFamily.bodyBold },
});
