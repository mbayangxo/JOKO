import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useEntrance } from '../hooks/animations';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import ScreenHeader from '../components/ScreenHeader';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import { useToast } from '../components/Toast';
import {
  getFriends,
  addFriend,
  getFriendRequests,
  respondFriendRequest,
  getMboloThreads,
  createMboloThread,
  getVouchStatus,
  lookupUser,
} from '../lib/api-client';
import { findDirectThreadForUser, navigateToMboloChat } from '../lib/mbolo-social';
import ProfileShareButtons from '../components/ProfileShareButtons';
import { useAppState } from '../state/AppState';
import { buildWebFriendUrl, resolveAccountQuery } from '../lib/k21-qr';
import { navigateFromRoot } from '../lib/root-navigation';
import { colors, fontFamily, radius, spacing } from '../theme';

function FriendRow({ friend, onSend, onMbolo, delay = 0 }) {
  const entrance = useEntrance(delay, 320, 10);
  return (
    <Animated.View style={entrance}>
      <PressScale scaleTo={0.98} onPress={onSend} style={styles.row}>
        <View style={styles.ava}>
          <Text style={{ fontSize: 22 }}>{friend.avatarEmoji ?? '🧑🏾'}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowName}>{friend.name}</Text>
          <Text style={styles.rowMeta}>@{String(friend.handle ?? '').replace(/^@+/, '')}</Text>
        </View>
        <PressScale scaleTo={0.9} onPress={onMbolo} style={styles.mboloBtn} accessibilityRole="button" accessibilityLabel="Écrire dans Mboolo">
          <Text style={styles.mboloBtnText}>💬</Text>
        </PressScale>
      </PressScale>
    </Animated.View>
  );
}

function IncomingRequestRow({ request, onAccept, onDecline, responding, delay = 0 }) {
  const entrance = useEntrance(delay, 320, 10);
  return (
    <Animated.View style={[styles.requestRow, entrance]}>
      <View style={styles.ava}>
        <Text style={{ fontSize: 22 }}>{request.user?.avatarEmoji ?? '🧑🏾'}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName}>{request.user?.name ?? 'Membre K21'}</Text>
        <Text style={styles.rowMeta}>@{String(request.user?.handle ?? '').replace(/^@+/, '')}</Text>
        {request.message ? <Text style={styles.requestMsg}>“{request.message}”</Text> : null}
      </View>
      <PressScale scaleTo={0.92} onPress={onAccept} style={[styles.acceptBtn, responding && { opacity: 0.5 }]}>
        <Text style={styles.acceptBtnText}>Accepter</Text>
      </PressScale>
      <PressScale scaleTo={0.92} onPress={onDecline} style={[styles.declineBtn, responding && { opacity: 0.5 }]} accessibilityRole="button" accessibilityLabel="Refuser la demande">
        <Text style={styles.declineBtnText}>✕</Text>
      </PressScale>
    </Animated.View>
  );
}

function OutgoingRequestRow({ request, delay = 0 }) {
  const entrance = useEntrance(delay, 320, 10);
  return (
    <Animated.View style={[styles.requestRow, entrance]}>
      <View style={styles.ava}>
        <Text style={{ fontSize: 22 }}>{request.user?.avatarEmoji ?? '🧑🏾'}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName}>{request.user?.name ?? 'Membre K21'}</Text>
        <Text style={styles.rowMeta}>@{String(request.user?.handle ?? '').replace(/^@+/, '')}</Text>
      </View>
      <Text style={styles.pendingTag}>⏳ Envoyée</Text>
    </Animated.View>
  );
}

export default function FriendsScreen({ navigation, route }) {
  const { profile } = useAppState();
  const showToast = useToast();
  const open = (name, params) => navigateFromRoot(navigation, name, params);
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [loading, setLoading] = useState(true);
  const [handle, setHandle] = useState('');
  const [adding, setAdding] = useState(false);
  const [respondingId, setRespondingId] = useState(null);
  const [vouch, setVouch] = useState(null);
  const inviteEntrance = useEntrance(0, 380, 14);
  const findEntrance = useEntrance(80, 380, 14);
  const vouchEntrance = useEntrance(160, 380, 14);

  useEffect(() => {
    const incoming = route.params?.addHandle;
    if (incoming) {
      setHandle(`@${String(incoming).replace(/^@/, '')}`);
    }
  }, [route.params?.addHandle]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, reqs, vouchInfo] = await Promise.all([
        getFriends(),
        getFriendRequests(),
        getVouchStatus().catch(() => null),
      ]);
      setFriends(Array.isArray(list) ? list : []);
      setRequests({
        incoming: Array.isArray(reqs?.incoming) ? reqs.incoming : [],
        outgoing: Array.isArray(reqs?.outgoing) ? reqs.outgoing : [],
      });
      setVouch(vouchInfo);
    } catch (err) {
      showToast(err.message ?? 'Impossible de charger les amis');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const submitAdd = async () => {
    const query = resolveAccountQuery(handle);
    if (query.replace(/^@/, '').trim().length < 3) return;
    setAdding(true);
    try {
      const digits = query.replace(/\D/g, '');
      // J13-F12: letters mean a handle ("awa77123456"), never a phone number.
      const looksLikePhone = !query.startsWith('@') && /^[+\d\s().-]+$/.test(query.trim()) && digits.length >= 8;
      // A handle from a link/code or typed directly goes straight to
      // addFriend; a phone number needs resolving to a handle first —
      // handles and phones both point at the same K21 account.
      const targetHandle = looksLikePhone ? (await lookupUser(query)).handle : query.replace(/^@/, '');
      const h = String(targetHandle ?? '').replace(/^@/, '').trim();
      if (!h) throw new Error('Compte introuvable sur K21');
      const result = await addFriend(h);
      if (result?.alreadyFriends) showToast('Vous êtes déjà amis');
      else if (result?.autoAccepted || result?.accepted) showToast('Vous êtes amis ✓');
      else showToast('Demande envoyée ✓ — en attente de sa réponse');
      setHandle('');
      await load();
    } catch (err) {
      showToast(err.message ?? 'Compte introuvable — vérifie le handle ou le numéro');
    } finally {
      setAdding(false);
    }
  };

  const respond = async (request, accept) => {
    setRespondingId(request.id);
    try {
      const result = await respondFriendRequest(request.id, accept);
      if (result?.accepted) showToast(`${request.user?.name ?? 'Nouvel ami'} ajouté ✓`);
      else showToast('Demande refusée');
      await load();
    } catch (err) {
      if (err?.code === 'verification_required' || err?.status === 403) {
        showToast(err.message ?? 'Vérifie ton profil pour accepter des demandes');
      } else {
        showToast(err.message ?? 'Réponse impossible');
      }
    } finally {
      setRespondingId(null);
    }
  };

  const openMbooloWithFriend = async (friend) => {
    try {
      const threads = await getMboloThreads();
      let thread = findDirectThreadForUser(threads, friend.id);
      if (!thread) {
        thread = await createMboloThread({ memberHandles: [friend.handle] });
      }
      navigateToMboloChat(navigation, {
        threadId: thread.id,
        thread,
        title: friend.name ?? friend.handle,
      });
    } catch (err) {
      showToast(err.message ?? 'Mboolo indisponible');
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <ScreenHeader onBack={() => navigation.goBack()} title="Mes amis" style={styles.header} />
          <Text style={styles.sub}>Envoie de l'argent ou ouvre Mboolo en un tap.</Text>

          {profile.handle ? (
            <Animated.View style={[styles.inviteCard, inviteEntrance]}>
              <Text style={styles.inviteTitle}>Invite tes amis sur K21</Text>
              <Text style={styles.inviteMeta}>@{String(profile.handle ?? '').replace(/^@+/, '')}</Text>
              {buildWebFriendUrl(profile.handle) ? (
                <Text style={styles.inviteLink}>{buildWebFriendUrl(profile.handle)}</Text>
              ) : null}
              <ProfileShareButtons profile={profile} mode="friend" />
              <PressScale scaleTo={0.97} onPress={() => open('MyQr')} style={styles.inviteQr}>
                <Text style={styles.inviteQrText}>📲 Mon QR à scanner</Text>
              </PressScale>
            </Animated.View>
          ) : null}

          <Animated.View style={findEntrance}>
            <Text style={styles.addLbl}>Trouver un compte</Text>
            <View style={styles.addRow}>
              <TextInput accessibilityLabel="@handle, numéro, ou lien k21://"
                style={styles.input}
                value={handle}
                onChangeText={setHandle}
                placeholder="@handle, numéro, ou lien k21://"
                placeholderTextColor={'rgba(5,8,5,0.45)'}
                autoCapitalize="none"
              />
              <GlowButton label={adding ? '…' : 'Ajouter'} onPress={submitAdd} disabled={adding || handle.trim().length < 3} style={styles.addBtn} />
            </View>

            <PressScale scaleTo={0.97} onPress={() => open('QrScan', { mode: 'friend' })} style={styles.scanLink}>
              <Text style={styles.scanLinkText}>📷 Scanner un QR pour ajouter</Text>
            </PressScale>
          </Animated.View>

          {vouch ? (
            <Animated.View style={[styles.vouchCard, vouchEntrance]}>
              {vouch.confirmed ? (
                <Text style={styles.vouchConfirmed}>🛡️ Confirmé par la communauté ✓</Text>
              ) : (
                <>
                  <Text style={styles.vouchTitle}>🛡️ Pas encore confirmé</Text>
                  <Text style={styles.vouchMeta}>
                    Demande à un membre K21 depuis 6 mois+ de scanner ton QR pour prouver que tu n'es pas
                    un spammeur.
                  </Text>
                  <PressScale scaleTo={0.96} onPress={() => open('MyQr')} style={styles.vouchAction}>
                    <Text style={styles.vouchActionText}>📲 Montrer mon QR</Text>
                  </PressScale>
                </>
              )}
              {vouch.canVouch ? (
                <PressScale
                  scaleTo={0.96}
                  onPress={() => open('QrScan', { mode: 'vouch' })}
                  style={styles.vouchAction}
                >
                  <Text style={styles.vouchActionText}>🛡️ Confirmer un ami (scanner son QR)</Text>
                </PressScale>
              ) : null}
            </Animated.View>
          ) : null}

          {requests.incoming.length > 0 ? (
            <View style={styles.requestsBlock}>
              <Text style={styles.sectionLabel}>Demandes reçues</Text>
              {requests.incoming.map((r, i) => (
                <IncomingRequestRow
                  key={r.id}
                  request={r}
                  onAccept={() => respond(r, true)}
                  onDecline={() => respond(r, false)}
                  responding={respondingId === r.id}
                  delay={i * 40}
                />
              ))}
            </View>
          ) : null}

          {requests.outgoing.length > 0 ? (
            <View style={styles.requestsBlock}>
              <Text style={styles.sectionLabel}>En attente de réponse</Text>
              {requests.outgoing.map((r, i) => (
                <OutgoingRequestRow key={r.id} request={r} delay={i * 40} />
              ))}
            </View>
          ) : null}

          {loading ? (
            <ActivityIndicator color={colors.green} style={{ marginTop: spacing.xxl }} />
          ) : friends.length === 0 ? (
            <Text style={styles.empty}>
              {requests.outgoing.length > 0
                ? 'Ta demande est envoyée — dès qu’elle est acceptée, ton ami apparaît ici.'
                : "Pas encore d'amis — envoie une demande par @handle ou QR."}
            </Text>
          ) : (
            <View style={styles.list}>
              {friends.map((f, i) => (
                <FriendRow
                  key={f.id}
                  friend={f}
                  onSend={() => open('UserProfile', { handle: f.handle })}
                  onMbolo={() => openMbooloWithFriend(f)}
                  delay={i * 35}
                />
              ))}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.giant },
  header: { marginBottom: spacing.sm },
  sub: { fontSize: 12, color: 'rgba(5,8,5,0.5)', marginBottom: spacing.xl },
  inviteCard: {
    backgroundColor: colors.greenA08,
    borderWidth: 1,
    borderColor: colors.greenA20,
    borderRadius: radius.xl,
    padding: spacing.xl,
    marginBottom: spacing.xxl,
    gap: spacing.md,
  },
  inviteTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  inviteMeta: { fontSize: 12, color: colors.greenDark },
  inviteLink: { fontSize: 10, color: 'rgba(5,8,5,0.45)' },
  inviteQr: { alignSelf: 'center', marginTop: spacing.xs },
  inviteQrText: { fontSize: 11, color: colors.greenDark, fontFamily: fontFamily.bodyBold },
  addLbl: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: 'rgba(5,8,5,0.4)', marginBottom: spacing.xs, textTransform: 'uppercase' },
  addRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  input: {
    flex: 1,
    height: 48,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderWidth: 1.5,
    borderColor: 'rgba(5,8,5,0.1)',
    paddingHorizontal: spacing.lg,
    color: colors.ink,
    fontSize: 14,
  },
  addBtn: { width: 112 },
  scanLink: { alignSelf: 'center', marginBottom: spacing.xxl },
  scanLinkText: { fontSize: 12, color: colors.greenDark, fontFamily: fontFamily.bodyBold },
  vouchCard: {
    backgroundColor: 'rgba(232,92,26,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(232,92,26,0.22)',
    borderRadius: radius.xl,
    borderBottomRightRadius: 10,
    padding: spacing.xl,
    marginBottom: spacing.xxl,
    gap: spacing.md,
  },
  vouchTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  vouchConfirmed: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.greenDark },
  vouchMeta: { fontSize: 12, color: 'rgba(5,8,5,0.6)', lineHeight: 17 },
  vouchAction: { alignSelf: 'flex-start' },
  vouchActionText: { fontSize: 12, color: colors.orange, fontFamily: fontFamily.bodyBold },
  requestsBlock: { marginBottom: spacing.xxl, gap: spacing.sm },
  sectionLabel: {
    fontFamily: fontFamily.bodyBold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: 'rgba(5,8,5,0.45)',
    marginBottom: spacing.xs,
  },
  requestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(250,216,54,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(232,146,10,0.25)',
    borderRadius: radius.lg,
    borderBottomRightRadius: 8,
    padding: spacing.lg,
  },
  requestMsg: { fontSize: 11, color: 'rgba(5,8,5,0.6)', fontStyle: 'italic', marginTop: 2 },
  acceptBtn: {
    backgroundColor: colors.greenDark,
    borderRadius: radius.lg,
    borderBottomRightRadius: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  acceptBtnText: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: '#ffffff' },
  declineBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  declineBtnText: { fontSize: 13, color: 'rgba(5,8,5,0.55)' },
  pendingTag: { fontSize: 11, color: colors.goldDark, fontFamily: fontFamily.bodyBold },
  empty: { textAlign: 'center', color: 'rgba(5,8,5,0.45)', fontSize: 12, marginTop: spacing.xxl },
  list: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  ava: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.greenA08, alignItems: 'center', justifyContent: 'center' },
  rowName: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  rowMeta: { fontSize: 11, color: 'rgba(5,8,5,0.45)' },
  mboloBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.greenA10, alignItems: 'center', justifyContent: 'center' },
  mboloBtnText: { fontSize: 16 },
});
