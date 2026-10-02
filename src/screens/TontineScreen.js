import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import StepTransition from '../components/StepTransition';
import ScreenHeader from '../components/ScreenHeader';
import AmountChips from '../components/AmountChips';
import { useToast } from '../components/Toast';
import { useAppState } from '../state/AppState';
import {
  acceptTontineInvite,
  cancelTontine,
  contributeToTontine,
  createTontineGroup,
  declineTontineInvite,
  getTontineGroups,
  leaveTontine,
  lookupUser,
  releaseTontinePot,
  startTontine,
} from '../lib/api-client';
import { formatKori } from '../lib/kori.js';
import KoriAmount from '../components/KoriAmount';
import { parseK21Qr } from '../lib/k21-qr';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import { useBlink, useEntrance, useFillIn, usePopIn } from '../hooks/animations';

// design/k21-four-flows.html, FLOW 1 — NATTA DIGITALE (Screens T1-T3):
// My Tontines list -> Create Group -> Pot Release.

const AMOUNT_CHIPS = ['10k F', '25k F', '50k F', '100k F'];
const FREQ_OPTIONS = ['Hebdo', 'Mensuel', 'Bi-mensuel'];
const AMOUNT_MAP = { '10k F': 10000, '25k F': 25000, '50k F': 50000, '100k F': 100000 };
const RING_SIZE = 220;
const RING_RADIUS = 82;
const AVATAR_SIZE = 48;

function formatAmount(n) {
  return n.toLocaleString('fr-FR').replace(/ /g, ' ');
}

function GroupItem({ item, delay, onPress }) {
  const entrance = useEntrance(delay, 350, 10);
  const fill = useFillIn(item.progress, delay + 150, 700);

  return (
    <Animated.View style={entrance}>
      <PressScale scaleTo={0.98} onPress={onPress} style={[styles.groupItem, item.releasing && styles.groupItemReleasing]}>
        <View style={[styles.groupHeader, item.releasing && styles.groupHeaderReleasing]}>
          <View style={[styles.groupIcon, { backgroundColor: item.iconBg }]}>
            <Text style={{ fontSize: 18 }}>{item.icon}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.groupName}>{item.name}</Text>
            <View style={styles.groupMetaRow}>
              <Text style={styles.groupMeta}>
                {item.members} membres · {formatAmount(item.perMonth)} F/mois
              </Text>
              {item.releasing && (
                <View style={styles.releaseBadge}>
                  <Text style={styles.releaseBadgeText}>TON TOUR !</Text>
                </View>
              )}
            </View>
          </View>
          <View style={styles.groupAmountBox}>
            <KoriAmount value={item.total} textStyle={[styles.groupAmount, { color: item.totalColor }]} />
            <Text style={styles.groupAmountLabel}>{item.totalLabel}</Text>
          </View>
        </View>
        <View style={styles.progressTrack}>
          <Animated.View style={{ width: fill, height: '100%', backgroundColor: item.progressColor }} />
        </View>
      </PressScale>
    </Animated.View>
  );
}

function HomeStep({ groups, loading, onOpenGroup, onCreate, onBack }) {
  const heroEntrance = useEntrance(0, 400, 10);
  const receivedThisMonth = groups.filter((g) => g.isMyTurn).reduce((s, g) => s + (g.expectedPot ?? 0), 0);
  const totalMembers = groups.reduce((s, g) => s + (g.memberCount ?? 0), 0);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <LinearGradient
          colors={['rgba(26,240,96,0.18)', 'rgba(26,240,96,0.04)', 'transparent']}
          start={{ x: 0.2, y: 0 }}
          end={{ x: 0.8, y: 1 }}
          style={styles.hero}
        >
          <ScreenHeader onBack={onBack} style={styles.topRow} />
          <Animated.View style={heroEntrance}>
            <View style={styles.flagStripe}>
              <View style={[styles.flagBar, { backgroundColor: colors.green }]} />
              <View style={[styles.flagBar, { backgroundColor: colors.flagGold }]} />
              <View style={[styles.flagBar, { backgroundColor: colors.terracotta }]} />
            </View>
            <Text style={styles.eyebrow}>NATTA DIGITALE</Text>
            <Text style={styles.title}>Mes groupes</Text>
            <Text style={styles.sub}>Épargne collective · Chacun cotise lui-même</Text>

            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={styles.statNum}>{groups.length}</Text>
                <Text style={styles.statLabel}>Natta actives</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statNum, { color: colors.terracotta, fontSize: 13 }]}>Ce mois</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                  <KoriAmount value={receivedThisMonth} textStyle={styles.statLabel} size={10} />
                  <Text style={styles.statLabel}> reçu</Text>
                </View>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statNum}>{totalMembers}</Text>
                <Text style={styles.statLabel}>Membres total</Text>
              </View>
            </View>
          </Animated.View>
        </LinearGradient>

        {loading && (
          <View style={{ padding: spacing.giant, alignItems: 'center' }}>
            <ActivityIndicator color={colors.green} />
          </View>
        )}

        <View style={styles.groupsList}>
          {!loading && groups.length === 0 && (
            <Text style={{ textAlign: 'center', color: 'rgba(5,8,5,0.5)', fontSize: 12, padding: spacing.xxl }}>
              Aucune tontine — crée ton premier groupe ci-dessous.
            </Text>
          )}
          {groups.map((g, i) => (
            <GroupItem
              key={g.id}
              item={{
                key: g.id,
                icon: '🏆',
                iconBg: g.isMyTurn ? 'rgba(232,92,26,0.12)' : 'rgba(26,240,96,0.08)',
                name: g.name,
                members: g.memberCount,
                perMonth: g.amountPerMember,
                total: g.potBalance || g.expectedPot || 0,
                totalLabel: g.potBalance > 0 ? 'dans le pot' : 'attendus',
                totalColor: g.isMyTurn ? colors.terracotta : colors.green,
                progress: g.expectedPot ? Math.round((g.potBalance / g.expectedPot) * 100) : 0,
                progressColor: g.isMyTurn ? colors.terracotta : colors.green,
                releasing: g.isMyTurn,
                raw: g,
              }}
              delay={200 + i * 80}
              onPress={() => onOpenGroup(g)}
            />
          ))}
        </View>

        <View style={styles.howItWorks}>
          <Text style={styles.howLabel}>Comment ça marche</Text>
          <View style={{ gap: spacing.sm }}>
            <View style={styles.howRow}>
              <View style={styles.howIcon}>
                <Text style={{ fontSize: 15 }}>💳</Text>
              </View>
              <Text style={styles.howText}>Chaque membre cotise le même montant, au même rythme</Text>
            </View>
            <View style={styles.howRow}>
              <View style={styles.howIcon}>
                <Text style={{ fontSize: 15 }}>🔒</Text>
              </View>
              <Text style={styles.howText}>Chaque membre accepte l’invitation puis cotise lui-même — la cagnotte reste bloquée dans un pot dédié</Text>
            </View>
            <View style={styles.howRow}>
              <View style={styles.howIcon}>
                <Text style={{ fontSize: 15 }}>🏆</Text>
              </View>
              <Text style={styles.howText}>La cagnotte est versée à tour de rôle, en toute transparence</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <PressScale scaleTo={0.97} onPress={onCreate} style={styles.createBtn}>
          <Text style={styles.createBtnText}>＋ Créer une tontine</Text>
        </PressScale>
      </View>
    </View>
  );
}

function displayHandle(handle) {
  const h = String(handle ?? '').replace(/^@/, '');
  return h ? `@${h}` : '';
}

function ringPosition(index, total) {
  const angle = (index / Math.max(total, 1)) * 2 * Math.PI - Math.PI / 2;
  const center = RING_SIZE / 2;
  const half = AVATAR_SIZE / 2;
  return {
    left: center + RING_RADIUS * Math.cos(angle) - half,
    top: center + RING_RADIUS * Math.sin(angle) - half,
  };
}

function MemberRing({ members, creatorLabel, onRemove }) {
  const slots = members.length;
  return (
    <View style={styles.ringWrap}>
      <View style={[styles.ringTrack, { width: RING_SIZE, height: RING_SIZE }]}>
        <View style={styles.ringCenter}>
          <Text style={styles.ringCount}>{slots + 1}</Text>
          <Text style={styles.ringCountLabel}>membres{'\n'}avec toi</Text>
        </View>
        {members.map((m, i) => {
          const pos = ringPosition(i, slots);
          return (
            <View key={m.handle} style={[styles.ringAvatarSlot, pos]}>
              <View style={styles.ringAvatar}>
                <Text style={{ fontSize: 22 }}>{m.avatarEmoji ?? '🧑🏾'}</Text>
              </View>
              <PressScale scaleTo={0.88} onPress={() => onRemove(m.handle)} style={styles.ringRemove}>
                <Text style={styles.ringRemoveText}>×</Text>
              </PressScale>
              <Text style={styles.ringAvatarName} numberOfLines={1}>
                {m.name?.split(' ')[0] ?? m.handle}
              </Text>
            </View>
          );
        })}
      </View>
      {creatorLabel ? <Text style={styles.ringCreatorNote}>Toi ({creatorLabel}) es déjà dans le groupe</Text> : null}
    </View>
  );
}

function MemberPreviewCard({ profile, onAdd, onDismiss, adding }) {
  const pop = usePopIn(0, 280, 0.92);
  if (!profile) return null;
  return (
    <Animated.View style={[styles.memberPreview, pop]}>
      <View style={styles.memberPreviewAva}>
        <Text style={{ fontSize: 28 }}>{profile.avatarEmoji ?? '🧑🏾'}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.memberPreviewName}>{profile.name}</Text>
        <Text style={styles.memberPreviewHandle}>{displayHandle(profile.handle)}</Text>
        {profile.arrondissement?.name ? (
          <Text style={styles.memberPreviewMeta}>
            {profile.arrondissement.icon} {profile.arrondissement.name}
          </Text>
        ) : null}
      </View>
      <View style={styles.memberPreviewActions}>
        <PressScale scaleTo={0.94} onPress={onAdd} disabled={adding} style={styles.memberPreviewAdd}>
          <Text style={styles.memberPreviewAddText}>{adding ? '…' : '+ Ajouter'}</Text>
        </PressScale>
        <PressScale scaleTo={0.94} onPress={onDismiss}>
          <Text style={styles.memberPreviewDismiss}>✕</Text>
        </PressScale>
      </View>
    </Animated.View>
  );
}

function CreateStep({ navigation, creatorHandle, pendingMember, onConsumePendingMember, onBack, onCreate, creating }) {
  const showToast = useToast();
  const [name, setName] = useState('');
  const [amountChip, setAmountChip] = useState('25k F');
  const [freq, setFreq] = useState('Mensuel');
  const [members, setMembers] = useState([]);
  const [searchMode, setSearchMode] = useState('handle');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchProfile, setSearchProfile] = useState(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const lookupTimer = useRef(null);

  const normalizeHandle = (h) => String(h ?? '').replace(/^@/, '').trim().toLowerCase();

  const isDuplicate = useCallback(
    (handle) => {
      const h = normalizeHandle(handle);
      if (!h) return true;
      if (h === normalizeHandle(creatorHandle)) return true;
      return members.some((m) => normalizeHandle(m.handle) === h);
    },
    [members, creatorHandle],
  );

  const addMember = useCallback(
    (profile) => {
      const handle = normalizeHandle(profile?.handle);
      if (!handle || isDuplicate(handle)) {
        showToast('Cette personne est déjà dans le groupe');
        return false;
      }
      setMembers((prev) => [
        ...prev,
        {
          handle,
          name: profile.name ?? handle,
          avatarEmoji: profile.avatarEmoji ?? '🧑🏾',
          arrondissement: profile.arrondissement,
        },
      ]);
      setSearchProfile(null);
      setSearchQuery('');
      setLookupError('');
      showToast(`${profile.name ?? handle} ajouté ✓`);
      return true;
    },
    [isDuplicate, showToast],
  );

  const removeMember = (handle) => {
    setMembers((prev) => prev.filter((m) => normalizeHandle(m.handle) !== normalizeHandle(handle)));
  };

  const runLookup = useCallback(
    async (raw) => {
      const trimmed = String(raw).trim();
      if (trimmed.length < 3) {
        setSearchProfile(null);
        setLookupError('');
        return;
      }
      const parsed = parseK21Qr(trimmed);
      const query = parsed?.handle ? parsed.handle : trimmed.replace(/^@/, '');
      setLookupLoading(true);
      setLookupError('');
      try {
        const profile = await lookupUser(query);
        if (isDuplicate(profile.handle)) {
          setSearchProfile(null);
          setLookupError('Déjà dans le groupe');
          return;
        }
        setSearchProfile(profile);
      } catch (err) {
        setSearchProfile(null);
        setLookupError(err.message ?? 'Personne introuvable');
      } finally {
        setLookupLoading(false);
      }
    },
    [isDuplicate],
  );

  useEffect(() => {
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    lookupTimer.current = setTimeout(() => runLookup(searchQuery), 400);
    return () => {
      if (lookupTimer.current) clearTimeout(lookupTimer.current);
    };
  }, [searchQuery, runLookup]);

  useEffect(() => {
    if (pendingMember?.handle) {
      addMember(pendingMember);
      onConsumePendingMember?.();
    }
  }, [pendingMember, addMember, onConsumePendingMember]);

  const submit = () => {
    onCreate({
      name: name.trim(),
      amountPerMember: AMOUNT_MAP[amountChip] ?? 25000,
      frequency: freq,
      memberHandles: members.map((m) => m.handle),
    });
  };

  const perPerson = AMOUNT_MAP[amountChip] ?? 25000;
  const totalMembers = members.length + 1;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={styles.createScroll}>
        <ScreenHeader onBack={onBack} title="Nouvelle tontine" titleStyle={styles.createTitle} style={styles.createHead} />

        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Nom du groupe</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            style={[styles.fieldInput, name.length > 0 && styles.fieldInputFilled]}
            placeholder="Natta Médina"
            placeholderTextColor={'rgba(5,8,5,0.4)'}
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Membres du groupe</Text>
          <MemberRing members={members} creatorLabel={creatorHandle ? `@${creatorHandle}` : 'toi'} onRemove={removeMember} />

          <View style={styles.searchModeRow}>
            <PressScale
              scaleTo={0.96}
              onPress={() => setSearchMode('handle')}
              style={[styles.searchModePill, searchMode === 'handle' && styles.searchModePillOn]}
            >
              <Text style={[styles.searchModeText, searchMode === 'handle' && styles.searchModeTextOn]}>@ Handle</Text>
            </PressScale>
            <PressScale
              scaleTo={0.96}
              onPress={() => setSearchMode('scan')}
              style={[styles.searchModePill, searchMode === 'scan' && styles.searchModePillOn]}
            >
              <Text style={[styles.searchModeText, searchMode === 'scan' && styles.searchModeTextOn]}>📷 Scanner</Text>
            </PressScale>
          </View>

          {searchMode === 'scan' ? (
            <>
              <PressScale
                scaleTo={0.98}
                onPress={() => navigation.navigate('QrScan', { mode: 'tontine_member' })}
                style={styles.scanCard}
              >
                <Text style={{ fontSize: 28 }}>📷</Text>
                <Text style={styles.scanCardTitle}>Scanner un QR K21</Text>
                <Text style={styles.scanCardSub}>Le profil s'ajoute au cercle après le scan</Text>
              </PressScale>
              <Text style={styles.orSearchLabel}>ou colle @handle / k21://…</Text>
            </>
          ) : null}

          <View style={styles.searchRow}>
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={searchMode === 'scan' ? 'k21://pay/@fatou' : '@fatou'}
              placeholderTextColor={'rgba(5,8,5,0.4)'}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.fieldInput, styles.searchInput, searchQuery.length > 0 && styles.fieldInputFilled]}
            />
            {lookupLoading ? <ActivityIndicator color={colors.green} style={{ marginLeft: spacing.sm }} /> : null}
          </View>
          {lookupError && !lookupLoading ? <Text style={styles.lookupError}>{lookupError}</Text> : null}

          <MemberPreviewCard
            profile={searchProfile}
            onAdd={() => addMember(searchProfile)}
            onDismiss={() => {
              setSearchProfile(null);
              setLookupError('');
            }}
            adding={false}
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Montant par personne</Text>
          <AmountChips
            options={AMOUNT_CHIPS.map((c) => ({ value: c, label: c }))}
            value={amountChip}
            onChange={setAmountChip}
            style={styles.chipsRow}
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Fréquence</Text>
          <View style={styles.freqRow}>
            {FREQ_OPTIONS.map((f) => (
              <PressScale key={f} scaleTo={0.94} onPress={() => setFreq(f)} style={[styles.freqOpt, freq === f && styles.freqOptOn]}>
                <Text style={[styles.freqText, freq === f && styles.freqTextOn]}>{f}</Text>
              </PressScale>
            ))}
          </View>
        </View>

        <View style={styles.previewCard}>
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>Pot par cycle</Text>
            <Text style={[styles.previewValue, { color: colors.green }]}>{formatAmount(perPerson * totalMembers)} F</Text>
          </View>
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>Membres</Text>
            <Text style={styles.previewValue}>{totalMembers}</Text>
          </View>
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>Fréquence</Text>
            <Text style={styles.previewValue}>{freq}</Text>
          </View>
          <View style={styles.previewDivider} />
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>Collecte auto</Text>
            <Text style={[styles.previewValue, { color: colors.green }]}>✓ Activée</Text>
          </View>
        </View>

        <GlowButton
          label={creating ? 'Création…' : 'Créer le groupe →'}
          onPress={submit}
          disabled={creating || name.trim().length < 2 || members.length < 1}
        />
        {members.length < 1 ? (
          <Text style={styles.createHint}>Ajoute au moins 1 membre avec @handle ou le scanner</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * What THIS user can do in a group right now — every money action is the
 * user's own explicit choice (accept, cotiser, verser le pot complet).
 */
export function tontineActionsFor(g) {
  const actions = [];
  if (g.myStatus === 'invited' && g.status === 'forming') {
    actions.push({ key: 'accept', label: 'Accepter l’invitation' }, { key: 'decline', label: 'Refuser' });
  }
  if (g.isCreator && g.status === 'forming') actions.push({ key: 'start', label: 'Démarrer la tontine' });
  if (g.canContribute) actions.push({ key: 'contribute', label: `Cotiser ${formatKori(g.contributionKori ?? 0)}` });
  if (g.cycleFunded) actions.push({ key: 'release', label: 'Verser le pot complet' });
  if (!g.isCreator && g.myStatus === 'accepted' && g.status === 'forming') actions.push({ key: 'leave', label: 'Quitter' });
  if (g.isCreator && ['forming', 'active'].includes(g.status)) actions.push({ key: 'cancel', label: 'Annuler la tontine' });
  return actions;
}

function GroupActionStep({ group, onBack, onAction, busy }) {
  const actions = tontineActionsFor(group);
  const statusLabel = {
    forming: 'En formation — en attente des acceptations',
    active: `Cycle ${group.currentCycle} · ${group.members?.filter((m) => m.paidThisCycle).length ?? 0}/${group.memberCount} cotisations`,
    completed: 'Terminée',
    cancelled: 'Annulée',
  }[group.status] ?? group.status;
  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View style={styles.releaseHero}>
          <ScreenHeader onBack={onBack} style={styles.topRow} />
          <View style={{ alignItems: 'center' }}>
            <Text style={styles.releaseName}>{group.name}</Text>
            <KoriAmount value={group.potBalance ?? 0} textStyle={styles.releaseAmount} style={{ justifyContent: 'center' }} />
            <Text style={styles.releaseRecipient}>{statusLabel}</Text>
            {group.recipientThisCycle ? (
              <Text style={styles.releaseRecipient}>Bénéficiaire du tour : {group.recipientThisCycle.name ?? displayHandle(group.recipientThisCycle.handle)}</Text>
            ) : null}
          </View>
        </View>
        <View style={styles.potMembers}>
          <Text style={styles.potMembersLabel}>Membres</Text>
          {(group.members ?? []).map((m) => (
            <View key={m.userId} style={styles.potMemberItem}>
              <Text style={styles.howText}>
                {m.name ?? displayHandle(m.handle)} · {m.status === 'accepted' ? (m.paidThisCycle ? 'a cotisé ✓' : 'membre') : m.status === 'invited' ? 'invité·e' : m.status}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={[styles.footer, { gap: spacing.sm }]}>
        {actions.length === 0 ? <Text style={styles.howText}>Aucune action pour toi pour l’instant.</Text> : null}
        {actions.map((a) => (
          <PressScale key={a.key} scaleTo={0.97} onPress={() => !busy && onAction(a.key)} style={styles.createBtn}>
            <Text style={styles.createBtnText}>{busy ? '…' : a.label}</Text>
          </PressScale>
        ))}
      </View>
    </View>
  );
}

function ReleaseStep({ group, onBack, onReceive, receiving }) {
  const blink = useBlink(800);
  const heroEntrance = useEntrance(0, 400, 10);
  const potAmount = group?.potBalance || group?.expectedPot || 0;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View style={styles.releaseHero}>
          <ScreenHeader onBack={onBack} style={styles.topRow} />
          <Animated.View style={[{ alignItems: 'center' }, heroEntrance]}>
            <View style={styles.releaseBadgeBig}>
              <Animated.View style={[styles.releaseDot, { opacity: blink }]} />
              <Text style={styles.releaseBadgeBigText}>C'est ton tour !</Text>
            </View>
            <Text style={styles.releaseName}>{group?.name}</Text>
            <KoriAmount value={potAmount} textStyle={styles.releaseAmount} style={{ justifyContent: 'center' }} />
            <Text style={styles.releaseRecipient}>Pot complet · Versement au bénéficiaire du tour</Text>
          </Animated.View>
        </View>

        <View style={styles.potMembers}>
          <Text style={styles.potMembersLabel}>Ordre de rotation</Text>
          {(group?.members ?? []).map((m) => (
            <View
              key={m.userId}
              style={[styles.potMemberItem, m.rotationOrder === group.rotationIndex && styles.potMemberCurrent]}
            >
              <View
                style={[
                  styles.potOrder,
                  m.rotationOrder === group.rotationIndex && styles.potOrderNow,
                  m.hasReceivedPayout && styles.potOrderDone,
                ]}
              >
                <Text
                  style={[
                    styles.potOrderText,
                    m.rotationOrder === group.rotationIndex && { color: colors.ink },
                    m.hasReceivedPayout && { color: colors.green },
                  ]}
                >
                  {m.hasReceivedPayout ? '✓' : m.rotationOrder + 1}
                </Text>
              </View>
              <Text style={{ fontSize: 18 }}>{m.avatarEmoji ?? '🧑🏾'}</Text>
              <Text style={styles.potMemberName}>{m.name}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <PressScale scaleTo={0.97} onPress={onReceive} style={styles.receiveBtn} disabled={receiving}>
          <Text style={styles.receiveBtnText}>{receiving ? 'Versement…' : 'Recevoir mon pot →'}</Text>
        </PressScale>
        <Text style={styles.releaseFootnote}>K21 collecte les cotisations puis verse le pot à ton tour</Text>
      </View>
    </View>
  );
}

export default function TontineScreen({ navigation, route }) {
  const showToast = useToast();
  const { profile, refreshWallet } = useAppState();
  const [step, setStep] = useState('home');
  const [groups, setGroups] = useState([]);
  const [activeGroup, setActiveGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [pendingMember, setPendingMember] = useState(null);

  useEffect(() => {
    if (route.params?.pickedMember) {
      setPendingMember(route.params.pickedMember);
      setStep('create');
      navigation.setParams({ pickedMember: undefined });
    }
  }, [route.params?.pickedMember, navigation]);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getTontineGroups();
      setGroups(Array.isArray(list) ? list : []);
    } catch (err) {
      showToast(err.message ?? 'Impossible de charger les tontines');
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useFocusEffect(
    useCallback(() => {
      loadGroups();
    }, [loadGroups]),
  );

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  const receivePot = async () => {
    if (!activeGroup?.id) return;
    setReceiving(true);
    try {
      const result = await releaseTontinePot(activeGroup.id);
      await refreshWallet();
      showToast(`Pot versé · ${formatKori(result.payout?.amountKori ?? 0)} ✓`);
      setStep('home');
      await loadGroups();
    } catch (err) {
      showToast(err.message ?? 'Versement impossible');
    } finally {
      setReceiving(false);
    }
  };

  const runAction = async (key) => {
    if (!activeGroup?.id) return;
    const fns = {
      accept: acceptTontineInvite,
      decline: declineTontineInvite,
      start: startTontine,
      contribute: contributeToTontine,
      release: releaseTontinePot,
      leave: leaveTontine,
      cancel: cancelTontine,
    };
    setReceiving(true);
    try {
      const updated = await fns[key](activeGroup.id);
      if (['contribute', 'release', 'cancel'].includes(key)) await refreshWallet();
      showToast(
        {
          accept: 'Invitation acceptée ✓',
          decline: 'Invitation refusée',
          start: 'Tontine démarrée ✓',
          contribute: 'Cotisation versée dans le pot ✓',
          release: `Pot versé · ${formatKori(updated?.payout?.amountKori ?? 0)} ✓`,
          leave: 'Tu as quitté la tontine',
          cancel: 'Tontine annulée — cotisations remboursées',
        }[key],
      );
      if (updated?.id) setActiveGroup(updated);
      await loadGroups();
    } catch (err) {
      showToast(err.message ?? 'Action impossible');
    } finally {
      setReceiving(false);
    }
  };

  const createGroup = async (payload) => {
    setCreating(true);
    try {
      await createTontineGroup(payload);
      showToast('Natta créée ✓');
      setStep('home');
      await loadGroups();
    } catch (err) {
      showToast(err.message ?? 'Création impossible');
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {step === 'home' && (
          <StepTransition>
            <HomeStep
              groups={groups}
              loading={loading}
              onOpenGroup={(g) => {
                setActiveGroup(g);
                setStep('group');
              }}
              onCreate={() => setStep('create')}
              onBack={() => navigation.goBack()}
            />
          </StepTransition>
        )}
        {step === 'create' && (
          <StepTransition>
            <CreateStep
              navigation={navigation}
              creatorHandle={profile.handle}
              pendingMember={pendingMember}
              onConsumePendingMember={() => setPendingMember(null)}
              onBack={() => setStep('home')}
              onCreate={createGroup}
              creating={creating}
            />
          </StepTransition>
        )}
        {step === 'group' && activeGroup && (
          <StepTransition>
            <GroupActionStep group={activeGroup} onBack={() => setStep('home')} onAction={runAction} busy={receiving} />
          </StepTransition>
        )}
        {step === 'release' && activeGroup && (
          <StepTransition>
            <ReleaseStep group={activeGroup} onBack={() => setStep('home')} onReceive={receivePot} receiving={receiving} />
          </StepTransition>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },

  topRow: { paddingHorizontal: spacing.huge, paddingTop: spacing.xl },

  // Home / list
  hero: { paddingHorizontal: spacing.huge, paddingBottom: spacing.xxl, position: 'relative', overflow: 'hidden', borderBottomWidth: 1, borderBottomColor: colors.greenA15 },
  flagStripe: { flexDirection: 'row', height: 2, borderRadius: 1, overflow: 'hidden', width: 48, marginTop: spacing.xl, marginBottom: spacing.lg },
  flagBar: { flex: 1 },
  eyebrow: { ...type.eyebrow, color: colors.green, marginBottom: spacing.xs },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 22, letterSpacing: -0.8, color: colors.ink, marginBottom: 2 },
  sub: { fontSize: 12, color: 'rgba(5,8,5,0.5)' },
  statsRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl },
  statBox: { flex: 1, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', borderRadius: radius.lg, padding: spacing.md, alignItems: 'center' },
  statNum: { fontFamily: fontFamily.displayBlack, fontSize: 18, fontWeight: '900', color: colors.greenDark, letterSpacing: -0.5 },
  statLabel: { fontSize: 10, color: 'rgba(5,8,5,0.5)', marginTop: 2, textAlign: 'center' },

  groupsList: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.md, gap: spacing.md },

  howItWorks: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.xxl },
  howLabel: { ...type.eyebrow, color: 'rgba(5,8,5,0.4)', marginBottom: spacing.md },
  howRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.07)', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  howIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.greenA08, alignItems: 'center', justifyContent: 'center' },
  howText: { flex: 1, fontSize: 11, color: 'rgba(5,8,5,0.5)', lineHeight: 16 },
  groupItem: { borderRadius: radius.xl, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)' },
  groupItemReleasing: { borderColor: 'rgba(232,92,26,0.3)' },
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md, backgroundColor: 'rgba(255,255,255,0.03)' },
  groupHeaderReleasing: { backgroundColor: 'rgba(232,92,26,0.1)' },
  groupIcon: { width: 40, height: 40, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  groupName: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink, marginBottom: 2 },
  groupMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs },
  groupMeta: { fontSize: 10, color: 'rgba(5,8,5,0.45)' },
  releaseBadge: { backgroundColor: colors.terracotta, borderRadius: 6, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  releaseBadgeText: { fontSize: 8, fontWeight: '700', letterSpacing: 0.5, color: colors.ink, textTransform: 'uppercase' },
  groupAmountBox: { alignItems: 'flex-end' },
  groupAmount: { fontFamily: fontFamily.displayBlack, fontSize: 14, fontWeight: '900' },
  groupAmountLabel: { fontSize: 10, color: 'rgba(5,8,5,0.5)' },
  progressTrack: { height: 3, backgroundColor: 'rgba(255,255,255,0.72)' },

  footer: { paddingHorizontal: spacing.huge, paddingTop: spacing.md, paddingBottom: spacing.xxl },
  createBtn: { marginHorizontal: 0, height: 48, borderRadius: radius.xl, backgroundColor: colors.greenA08, borderWidth: 1.5, borderColor: colors.greenA20, alignItems: 'center', justifyContent: 'center' },
  createBtnText: { fontFamily: fontFamily.displayBlack, fontSize: 10, fontWeight: '900', letterSpacing: 0.5, color: colors.green },

  // Create
  createScroll: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.giant, gap: 0 },
  createHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.xxl },
  createTitle: { fontFamily: fontFamily.displayBold, fontSize: 14, color: colors.ink },
  fieldGroup: { marginBottom: spacing.lg },
  fieldLabel: { ...type.eyebrow, color: 'rgba(5,8,5,0.4)', marginBottom: spacing.sm },
  fieldInput: { width: '100%', height: 50, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.12)', paddingHorizontal: spacing.xl, fontFamily: fontFamily.bodyRegular, fontSize: 14, color: colors.ink },
  fieldInputFilled: { borderColor: colors.greenA25 },
  chipsRow: { gap: spacing.sm, flexWrap: 'wrap' },
  freqRow: { flexDirection: 'row', gap: spacing.sm },
  freqOpt: { flex: 1, height: 44, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.1)', alignItems: 'center', justifyContent: 'center' },
  freqOptOn: { backgroundColor: 'rgba(250,216,54,0.1)', borderColor: 'rgba(250,216,54,0.3)' },
  freqText: { fontFamily: fontFamily.bodyBold, fontSize: 11, color: colors.ink },
  freqTextOn: { color: colors.flagGold },
  memberList: { gap: spacing.xs, marginBottom: spacing.sm },
  memberItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  memberAva: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  memberName: { flex: 1, fontFamily: fontFamily.bodyMedium, fontSize: 12, color: colors.ink },
  memberOrder: { backgroundColor: colors.greenA10, borderRadius: 6, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  memberOrderText: { fontFamily: fontFamily.bodyBold, fontSize: 9, color: colors.green },
  addMember: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.12)', borderStyle: 'dashed', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  addMemberIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.72)', alignItems: 'center', justifyContent: 'center' },
  addMemberText: { fontSize: 12, color: 'rgba(5,8,5,0.45)' },
  previewCard: { backgroundColor: colors.greenA08, borderWidth: 1, borderColor: colors.greenA20, borderRadius: radius.xl, padding: spacing.lg, marginBottom: spacing.lg },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  previewLabel: { fontSize: 10, color: 'rgba(5,8,5,0.4)' },
  previewValue: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.ink },
  previewDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.72)', marginVertical: spacing.sm },
  createHint: { fontSize: 11, color: 'rgba(5,8,5,0.45)', textAlign: 'center', marginTop: spacing.md },

  ringWrap: { alignItems: 'center', marginBottom: spacing.lg },
  ringTrack: {
    position: 'relative',
    borderRadius: RING_SIZE / 2,
    borderWidth: 2,
    borderColor: colors.greenA20,
    borderStyle: 'dashed',
    marginBottom: spacing.sm,
    backgroundColor: colors.greenA05,
  },
  ringCenter: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  ringCount: { fontFamily: fontFamily.displayBlack, fontSize: 28, color: colors.green, letterSpacing: -1 },
  ringCountLabel: { fontSize: 9, color: 'rgba(5,8,5,0.5)', textAlign: 'center', lineHeight: 12, marginTop: 2 },
  ringAvatarSlot: { position: 'absolute', width: AVATAR_SIZE, alignItems: 'center' },
  ringAvatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderWidth: 2,
    borderColor: colors.greenA30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringRemove: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.terracotta,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.ink,
  },
  ringRemoveText: { fontSize: 12, fontWeight: '900', color: colors.ink, lineHeight: 14 },
  ringAvatarName: { fontSize: 8, fontWeight: '700', color: 'rgba(5,8,5,0.6)', marginTop: 2, maxWidth: 56, textAlign: 'center' },
  ringCreatorNote: { fontSize: 10, color: 'rgba(5,8,5,0.45)', textAlign: 'center' },

  searchModeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  searchModePill: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1.5,
    borderColor: 'rgba(5,8,5,0.12)',
    alignItems: 'center',
  },
  searchModePillOn: { backgroundColor: colors.greenA08, borderColor: colors.greenA30 },
  searchModeText: { fontFamily: fontFamily.bodyBold, fontSize: 11, color: 'rgba(5,8,5,0.5)' },
  searchModeTextOn: { color: colors.green },
  scanCard: {
    backgroundColor: colors.greenA08,
    borderWidth: 1.5,
    borderColor: colors.greenA25,
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  scanCardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink, marginTop: spacing.sm },
  scanCardSub: { fontSize: 10, color: 'rgba(5,8,5,0.5)', textAlign: 'center', marginTop: 4 },
  orSearchLabel: { fontSize: 10, color: 'rgba(5,8,5,0.4)', textAlign: 'center', marginBottom: spacing.sm, fontWeight: '700' },
  searchRow: { flexDirection: 'row', alignItems: 'center' },
  searchInput: { flex: 1 },
  lookupError: { fontSize: 11, color: colors.terracotta, marginTop: spacing.sm },
  memberPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.xl,
    backgroundColor: colors.greenA10,
    borderWidth: 1.5,
    borderColor: colors.greenA25,
  },
  memberPreviewAva: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberPreviewName: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  memberPreviewHandle: { fontSize: 11, color: colors.green, marginTop: 2 },
  memberPreviewMeta: { fontSize: 10, color: 'rgba(5,8,5,0.5)', marginTop: 2 },
  memberPreviewActions: { alignItems: 'flex-end', gap: spacing.sm },
  memberPreviewAdd: {
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  memberPreviewAddText: { fontFamily: fontFamily.bodyBold, fontSize: 11, color: colors.ink },
  memberPreviewDismiss: { fontSize: 14, color: 'rgba(5,8,5,0.5)', paddingHorizontal: spacing.sm },

  // Release
  releaseHero: { paddingBottom: spacing.xxl, position: 'relative', overflow: 'hidden', backgroundColor: 'rgba(232,92,26,0.1)', borderBottomWidth: 1, borderBottomColor: 'rgba(232,92,26,0.2)' },
  releaseBadgeBig: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: colors.terracotta, borderRadius: radius.round, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, marginTop: spacing.xxl, marginBottom: spacing.xl },
  releaseDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.white },
  releaseBadgeBigText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5, color: colors.ink, textTransform: 'uppercase' },
  releaseName: { fontFamily: fontFamily.displayBlack, fontSize: 14, fontWeight: '900', color: colors.ink, marginBottom: spacing.md },
  releaseAmount: { fontFamily: fontFamily.displayBlack, fontSize: 44, fontWeight: '900', letterSpacing: -2, color: colors.terracotta, lineHeight: 44 },
  releaseCurr: { fontFamily: fontFamily.bodyRegular, fontSize: 16, fontWeight: '400', color: 'rgba(232,92,26,0.5)' },
  releaseRecipient: { fontSize: 12, color: 'rgba(5,8,5,0.5)', marginTop: spacing.md },
  releaseRecipientBold: { fontFamily: fontFamily.bodyBold, color: colors.ink },

  potMembers: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xl, gap: spacing.sm },
  potMembersLabel: { ...type.eyebrow, color: 'rgba(5,8,5,0.35)', marginBottom: spacing.xs },
  potMemberItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.07)', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  potMemberCurrent: { backgroundColor: colors.greenA08 /* matches .pm-item.current */, borderColor: colors.greenA20 },
  potOrder: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.72)', alignItems: 'center', justifyContent: 'center' },
  potOrderNow: { backgroundColor: colors.green },
  potOrderDone: { backgroundColor: colors.greenA15 },
  potOrderText: { fontSize: 10, fontWeight: '700', color: 'rgba(5,8,5,0.4)' },
  potMemberName: { flex: 1, fontFamily: fontFamily.bodyMedium, fontSize: 12, color: colors.ink },
  potStatus: { borderRadius: 6, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  potStatusNow: { backgroundColor: colors.green },
  potStatusDone: { backgroundColor: colors.greenA10 },
  potStatusWait: { backgroundColor: 'rgba(255,255,255,0.7)' },
  potStatusText: { fontSize: 9, fontWeight: '700' },

  receiveBtn: { height: 50, borderRadius: radius.xl, backgroundColor: colors.terracotta, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  receiveBtnText: { fontFamily: fontFamily.displayBlack, fontSize: 12, fontWeight: '900', color: colors.ink },
  releaseFootnote: { fontSize: 11, color: 'rgba(5,8,5,0.4)', textAlign: 'center' },
});
