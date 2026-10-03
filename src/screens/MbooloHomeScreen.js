import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppState } from '../state/AppState';
import { useToast } from '../components/Toast';
import { ActivityIndicator, Animated, Easing, Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenBackground from '../components/ScreenBackground';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import StoryAvatar from '../components/StoryAvatar';
import { colors, fontFamily, radius, spacing } from '../theme';
import { useScalePulse, useColorPulse, useEntrance } from '../hooks/animations';
import { createMboloThread, getMboloRequests, getMboloThreads, getMe, reportMboloRequest, respondMboloRequest } from '../lib/api-client';
import { navigateFromRoot } from '../lib/root-navigation';

const DOTS = [
  { size: 5, left: '12%', color: 'rgba(232,92,26,0.25)', duration: 9000, delay: 0 },
  { size: 4, left: '45%', color: 'rgba(255,179,71,0.3)', duration: 13000, delay: 3000 },
  { size: 6, left: '75%', color: 'rgba(26,240,96,0.2)', duration: 10000, delay: 5000 },
  { size: 3, left: '88%', color: 'rgba(232,92,26,0.2)', duration: 11000, delay: 1500 },
];

function formatThreadTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  if (diffMs < 60_000) return 'maintenant';
  if (diffMs < 86_400_000) {
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
  }
  if (diffMs < 172_800_000) return 'Hier';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function threadToRow(thread, userId) {
  const last = thread.messages?.[0];
  const others = (thread.members ?? []).filter((m) => m.userId !== userId).map((m) => m.user).filter(Boolean);
  const name = thread.name?.trim() || others.map((u) => u.name).join(', ') || 'Conversation';
  const emoji = thread.type === 'group' ? '👥' : others[0]?.avatarEmoji ?? '💬';
  return {
    key: thread.id,
    threadId: thread.id,
    avaBg: '#fff5ee',
    emoji,
    avatarUrl: thread.type === 'group' ? null : others[0]?.avatarUrl ?? null,
    initial: name?.trim()?.[0]?.toUpperCase(),
    isGroup: thread.type === 'group',
    name,
    time: formatThreadTime(last?.createdAt ?? thread.updatedAt),
    preview:
      last?.kind === 'image'
        ? '📷 Photo'
        : last?.kind === 'gif'
          ? '🎬 GIF'
          : last?.kind === 'voice'
            ? '🎤 Message vocal'
            : last?.kind === 'sticker'
              ? `${last.body} · Sticker`
              : last?.body ?? 'Dis bonjour 👋',
    thread,
  };
}

function FloatingDot({ size, left, color, duration, delay }) {
  const val = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([Animated.delay(delay), Animated.timing(val, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: true })])
    );
    anim.start();
    return () => anim.stop();
  }, [val, duration, delay]);

  const translateY = val.interpolate({ inputRange: [0, 1], outputRange: [260, -60] });
  const rotate = val.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const opacity = val.interpolate({ inputRange: [0, 0.1, 0.9, 1], outputRange: [0, 1, 0.6, 0] });
  const scale = val.interpolate({ inputRange: [0, 0.1, 1], outputRange: [0, 1, 1] });

  return (
    <Animated.View
      style={{
        position: 'absolute',
        left,
        bottom: 0,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        opacity,
        transform: [{ translateY }, { rotate }, { scale }],
      }}
    />
  );
}

function ConversationRow({ item, delay, onPress }) {
  const entrance = useEntrance(delay, 350, 10);
  return (
    <Animated.View style={entrance}>
      <PressScale scaleTo={0.98} onPress={onPress} style={styles.convItem}>
        <View style={styles.ciAvaWrap}>
          {item.isGroup ? (
            <View style={[styles.ciAva, { backgroundColor: item.avaBg }]}>
              <Text style={{ fontSize: 24 }}>{item.emoji}</Text>
            </View>
          ) : (
            <StoryAvatar photoUrl={item.avatarUrl} emoji={item.emoji} initial={item.initial} size={54} spin={false} />
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.ciTop}>
            <Text style={styles.ciName}>{item.name}</Text>
            <Text style={styles.ciTime}>{item.time}</Text>
          </View>
          <Text style={styles.ciPreview} numberOfLines={1}>
            {item.preview}
          </Text>
        </View>
      </PressScale>
    </Animated.View>
  );
}

// Instagram-Direct-style row of recent DM partners up top — real people,
// tap to jump straight into that conversation. Groups don't fit a single
// face so they're skipped here (they already lead with the list below).
function RecentPeopleTray({ conversations, onOpen }) {
  const recent = conversations.filter((c) => !c.isGroup).slice(0, 10);
  if (!recent.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.peopleTrayRow}>
      {recent.map((c) => (
        <PressScale key={c.key} scaleTo={0.92} onPress={() => onOpen(c)} style={styles.peopleTrayItem}>
          <StoryAvatar photoUrl={c.avatarUrl} emoji={c.emoji} initial={c.initial} size={62} />
          <Text style={styles.peopleTrayName} numberOfLines={1}>{c.name.split(' ')[0]}</Text>
        </PressScale>
      ))}
    </ScrollView>
  );
}

const SearchBar = ({ query, setQuery, inputRef }) => {
  const borderColor = useColorPulse('rgba(232,92,26,0.15)', 'rgba(232,92,26,0.35)', 4000);
  return (
    <Animated.View style={[styles.searchBar, { borderColor }]}>
      <Text style={{ fontSize: 14, color: colors.mboolo.ink3 }}>🔍</Text>
      <TextInput
        ref={inputRef}
        style={styles.searchInput}
        placeholder="Rechercher..."
        placeholderTextColor={colors.mboolo.ink3}
        value={query}
        onChangeText={setQuery}
      />
    </Animated.View>
  );
};

export default function MbooloHomeScreen({ navigation }) {
  const logoBounce = useScalePulse(3000, 1.03);
  const [query, setQuery] = useState('');
  const [threads, setThreads] = useState([]);
  const [requests, setRequests] = useState([]);
  const [busyRequest, setBusyRequest] = useState(null);
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newHandles, setNewHandles] = useState('');
  const [creating, setCreating] = useState(false);
  const searchRef = useRef(null);
  const { pendingMboloShare, setPendingMboloShare } = useAppState();
  const showToast = useToast();

  const loadThreads = useCallback(async () => {
    try {
      const [me, list, inbox] = await Promise.all([
        getMe(),
        getMboloThreads(),
        getMboloRequests().catch(() => ({ requests: [] })),
      ]);
      setUserId(me.id);
      setThreads(Array.isArray(list) ? list : []);
      setRequests(Array.isArray(inbox?.requests) ? inbox.requests : []);
    } catch (err) {
      showToast(err.message ?? 'Impossible de charger Mboolo');
      setThreads([]);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadThreads();
      if (pendingMboloShare) {
        showToast('Reçu prêt — colle-le dans ta conversation Mboolo');
        setPendingMboloShare(null);
      }
    }, [loadThreads, pendingMboloShare, setPendingMboloShare, showToast])
  );

  const conversations = threads.map((t) => threadToRow(t, userId)).filter(
    (c) => c.name.toLowerCase().includes(query.trim().toLowerCase()) || c.preview.toLowerCase().includes(query.trim().toLowerCase())
  );

  const answerRequest = async (req, action) => {
    if (busyRequest) return;
    setBusyRequest(req.threadId);
    try {
      if (action === 'report') {
        await reportMboloRequest(req.threadId, { category: 'spam' });
        await respondMboloRequest(req.threadId, 'block');
        showToast('Signalé et bloqué');
      } else {
        await respondMboloRequest(req.threadId, action);
        showToast(action === 'accept' ? 'Demande acceptée' : action === 'block' ? 'Bloqué' : 'Demande refusée');
      }
      await loadThreads();
    } catch (err) {
      showToast(err.message ?? 'Action impossible');
    } finally {
      setBusyRequest(null);
    }
  };

  const openChat = (item) => {
    navigation.navigate('MbooloChat', { threadId: item.threadId, thread: item.thread, title: item.name });
  };

  const handleCreate = async () => {
    const handles = newHandles
      .split(/[,;\s]+/)
      .map((h) => h.replace(/^@/, '').trim())
      .filter(Boolean);
    if (!newName.trim() && handles.length === 0) {
      showToast('Nom du groupe ou @handle d’un ami requis');
      return;
    }
    setCreating(true);
    try {
      const thread = await createMboloThread({ name: newName.trim() || undefined, memberHandles: handles });
      setShowNew(false);
      setNewName('');
      setNewHandles('');
      await loadThreads();
      navigation.navigate('MbooloChat', { threadId: thread.id, thread, title: thread.name ?? 'Conversation' });
    } catch (err) {
      showToast(err.message ?? 'Création impossible');
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      {DOTS.map((d, i) => (
        <FloatingDot key={i} {...d} />
      ))}
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.topBar}>
          <Animated.Text style={[styles.logo, { transform: [{ scale: logoBounce }] }]}>Mboolo</Animated.Text>
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <PressScale
              scaleTo={0.9}
              onPress={() => navigateFromRoot(navigation, 'Friends')}
              style={styles.mbIcon}
            >
              <Text style={{ fontSize: 17 }}>🧑‍🤝‍🧑</Text>
            </PressScale>
            <PressScale scaleTo={0.9} onPress={() => setShowNew(true)} style={styles.mbIcon}>
              <Text style={{ fontSize: 17 }}>✏️</Text>
            </PressScale>
            <PressScale scaleTo={0.9} onPress={() => navigation.navigate('MbooloBroadcast')} style={styles.mbIcon}>
              <Text style={{ fontSize: 17 }}>📢</Text>
            </PressScale>
            <PressScale scaleTo={0.9} onPress={() => searchRef.current?.focus()} style={styles.mbIcon}>
              <Text style={{ fontSize: 17 }}>🔍</Text>
            </PressScale>
          </View>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: spacing.giant }} showsVerticalScrollIndicator={false}>
          {!loading && conversations.length > 0 ? (
            <RecentPeopleTray conversations={conversations} onOpen={openChat} />
          ) : null}

          <View style={{ paddingHorizontal: spacing.huge, paddingTop: spacing.lg }}>
            <SearchBar query={query} setQuery={setQuery} inputRef={searchRef} />
          </View>

          {requests.length > 0 ? (
            <View>
              <Text style={styles.convDivider}>Demandes de message · {requests.length}</Text>
              {requests.map((r) => (
                <View key={r.threadId} style={styles.requestCard}>
                  <Text style={styles.requestFrom} numberOfLines={1}>
                    {r.type === 'group' ? `👥 ${r.name ?? 'Groupe'} · ` : ''}
                    {r.from?.name ?? (r.from?.handle ? `@${r.from.handle}` : 'Quelqu’un')}
                  </Text>
                  {r.intro?.body ? (
                    <Text style={styles.requestIntro} numberOfLines={3}>
                      {r.intro.body}
                    </Text>
                  ) : null}
                  <Text style={styles.requestHint}>Il ne voit pas si tu as lu ce message.</Text>
                  <View style={styles.requestActions}>
                    {[
                      ['accept', 'Accepter'],
                      ['decline', 'Refuser'],
                      ['block', 'Bloquer'],
                      ['report', 'Signaler'],
                    ].map(([action, label]) => (
                      <PressScale
                        key={action}
                        scaleTo={0.95}
                        disabled={busyRequest === r.threadId}
                        onPress={() => answerRequest(r, action)}
                        style={[styles.requestBtn, action === 'accept' && styles.requestBtnPrimary]}
                        accessibilityRole="button"
                        accessibilityLabel={`${label} la demande`}
                      >
                        <Text style={[styles.requestBtnText, action === 'accept' && styles.requestBtnTextPrimary]}>{label}</Text>
                      </PressScale>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <Text style={styles.convDivider}>Messages</Text>

          {loading && (
            <View style={{ paddingVertical: spacing.giant, alignItems: 'center' }}>
              <ActivityIndicator color={colors.mboolo.terra} />
            </View>
          )}

          {!loading && conversations.length === 0 && (
            <View style={{ paddingHorizontal: spacing.huge, paddingVertical: spacing.giant, alignItems: 'center', gap: spacing.md }}>
              <Text style={styles.noResults}>Aucune conversation</Text>
              <Text style={[styles.noResults, { fontSize: 11 }]}>Appuie sur ✏️ pour créer un groupe ou DM (@handle)</Text>
              <PressScale scaleTo={0.96} onPress={() => setShowNew(true)} style={styles.newBtn}>
                <Text style={styles.newBtnText}>Nouvelle conversation</Text>
              </PressScale>
            </View>
          )}

          {conversations.map((c, i) => (
            <View key={c.key}>
              <ConversationRow item={c} delay={i * 60} onPress={() => openChat(c)} />
              {i < conversations.length - 1 && <View style={styles.convSep} />}
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>

      <Modal visible={showNew} animationType="slide" transparent onRequestClose={() => setShowNew(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Nouvelle conversation</Text>
            <Text style={styles.modalHint}>Nom du groupe (optionnel) et @handles séparés par des espaces</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Nom du groupe"
              placeholderTextColor={colors.mboolo.ink3}
              value={newName}
              onChangeText={setNewName}
            />
            <TextInput
              style={styles.modalInput}
              placeholder="@fatou @ibou"
              placeholderTextColor={colors.mboolo.ink3}
              autoCapitalize="none"
              value={newHandles}
              onChangeText={setNewHandles}
            />
            <GlowButton label={creating ? 'Création…' : 'Créer'} onPress={handleCreate} disabled={creating} />
            <PressScale
              scaleTo={0.97}
              onPress={() => {
                setShowNew(false);
                navigation.navigate('GroupJoin');
              }}
              style={{ alignSelf: 'center', marginTop: spacing.md }}
            >
              <Text style={{ color: colors.mboolo.terra, fontSize: 12, fontWeight: '700' }}>
                Ou rejoindre un groupe avec un code →
              </Text>
            </PressScale>
            <PressScale scaleTo={0.96} onPress={() => setShowNew(false)} style={{ alignSelf: 'center', marginTop: spacing.md }}>
              <Text style={{ color: colors.mboolo.ink3, fontSize: 12 }}>Annuler</Text>
            </PressScale>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  requestCard: {
    marginHorizontal: spacing.huge,
    marginBottom: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: '#fff5ee',
    gap: spacing.xs,
  },
  requestFrom: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  requestIntro: { fontFamily: fontFamily.bodyRegular, fontSize: 13, color: colors.ink },
  requestHint: { fontFamily: fontFamily.bodyRegular, fontSize: 11, color: colors.mboolo.ink3 },
  requestActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  requestBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.round,
    borderWidth: 1,
    borderColor: colors.mboolo.terra,
    minHeight: 36,
    justifyContent: 'center',
  },
  requestBtnPrimary: { backgroundColor: colors.mboolo.terra },
  requestBtnText: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.mboolo.terra },
  requestBtnTextPrimary: { color: '#fff' },
  root: { flex: 1, backgroundColor: colors.mboolo.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.huge, paddingTop: spacing.lg, paddingBottom: spacing.md },
  logo: { fontFamily: fontFamily.displayBlack, fontSize: 20, letterSpacing: -0.5, color: colors.orange },
  mbIcon: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: colors.greenA10, borderWidth: 1.5, borderColor: colors.greenA20, alignItems: 'center', justifyContent: 'center' },
  peopleTrayRow: { paddingHorizontal: spacing.huge, gap: spacing.lg, paddingBottom: spacing.md, paddingTop: spacing.sm },
  peopleTrayItem: { alignItems: 'center', gap: 5, width: 66 },
  peopleTrayName: { fontFamily: fontFamily.bodySemiBold, fontSize: 10.5, color: colors.mboolo.ink2, maxWidth: 66, textAlign: 'center' },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.appCanvas.surface, borderWidth: 2, borderColor: colors.appCanvas.border, borderRadius: radius.xxl, paddingHorizontal: spacing.xxxl, height: 42, marginBottom: spacing.xxxl, shadowColor: colors.orange, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 2 },
  searchInput: { flex: 1, fontSize: 13, color: colors.mboolo.ink },
  noResults: { textAlign: 'center', fontSize: 12, color: colors.mboolo.ink3 },
  newBtn: { backgroundColor: colors.mboolo.terraPale, borderWidth: 1.5, borderColor: colors.mboolo.border, borderRadius: radius.xl, paddingHorizontal: spacing.xxxl, paddingVertical: spacing.lg },
  newBtnText: { fontSize: 13, fontWeight: '700', color: colors.mboolo.terraDark },
  convDivider: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, color: colors.mboolo.ink3, textTransform: 'uppercase', paddingHorizontal: spacing.huge, paddingBottom: spacing.md },
  convItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl, paddingHorizontal: spacing.huge, paddingVertical: 11 },
  ciAvaWrap: { position: 'relative', flexShrink: 0 },
  ciAva: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', borderWidth: 2.5, borderColor: 'transparent' },
  ciTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  ciName: { fontSize: 14, fontWeight: '700', color: colors.mboolo.ink },
  ciTime: { fontSize: 10, color: colors.mboolo.ink3 },
  ciPreview: { fontSize: 12, color: colors.mboolo.ink3 },
  convSep: { height: 1, backgroundColor: 'rgba(232,92,26,0.08)', marginHorizontal: spacing.huge, marginVertical: 2 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: colors.mboolo.bg, borderTopLeftRadius: radius.xxl, borderTopRightRadius: radius.xxl, padding: spacing.huge, borderWidth: 1, borderColor: colors.mboolo.border, gap: spacing.md },
  modalTitle: { fontFamily: fontFamily.displayBold, fontSize: 16, color: colors.mboolo.ink },
  modalHint: { fontSize: 11, color: colors.mboolo.ink3, lineHeight: 16 },
  modalInput: { height: 44, borderWidth: 2, borderColor: colors.mboolo.border, borderRadius: radius.lg, paddingHorizontal: spacing.xl, fontSize: 13, color: colors.mboolo.ink, backgroundColor: '#fff' },
});
