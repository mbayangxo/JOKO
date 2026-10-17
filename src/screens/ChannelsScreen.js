import { useCallback, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import ProfileAvatar from '../components/ProfileAvatar';
import GlowButton from '../components/GlowButton';
import { useToast } from '../components/Toast';
import { pickProfilePhoto } from '../lib/profile-photo';
import {
  browseChannelsList,
  deleteChannelPost,
  followChannel,
  getChannelFeed,
  getMyChannel,
  publishChannelPost,
  saveMyChannel,
} from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import LowDataImage from '../components/LowDataImage';

// Channels — WeChat-style: every member can create ONE channel; you follow
// channels and watch what they post. Feed = only channels you follow.

const TABS = [
  { key: 'feed', label: 'Suivis' },
  { key: 'browse', label: 'Découvrir' },
  { key: 'mine', label: 'Ma chaîne' },
];

function timeAgoFr(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'à l’instant';
  if (mins < 60) return `il y a ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `il y a ${h}h`;
  return `il y a ${Math.floor(h / 24)}j`;
}

function PostCard({ post, onDelete }) {
  return (
    <View style={styles.postCard}>
      <View style={styles.postHead}>
        <ProfileAvatar
          emoji={post.channel?.owner?.avatarEmoji}
          photoUrl={post.channel?.owner?.avatarUrl}
          size={34}
          initial={(post.channel?.name ?? '?').charAt(0).toUpperCase()}
          style={{ borderWidth: 0 }}
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.postChannel} numberOfLines={1}>{post.channel?.name ?? 'Ma chaîne'}</Text>
          <Text style={styles.postTime}>{timeAgoFr(post.createdAt)}</Text>
        </View>
        {onDelete ? (
          <PressScale scaleTo={0.9} onPress={() => onDelete(post)}>
            <Text style={styles.postDelete}>×</Text>
          </PressScale>
        ) : null}
      </View>
      {post.body ? <Text style={styles.postBody}>{post.body}</Text> : null}
      {post.imageUrl ? <LowDataImage uri={post.imageUrl} style={styles.postImage} /> : null}
    </View>
  );
}

export default function ChannelsScreen({ navigation, route }) {
  const showToast = useToast();
  const [tab, setTab] = useState(route.params?.initialTab ?? 'feed');
  const [loading, setLoading] = useState(true);
  const [feed, setFeed] = useState([]);
  const [channels, setChannels] = useState([]);
  const [mine, setMine] = useState(null);

  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [draft, setDraft] = useState('');
  const [draftImage, setDraftImage] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [feedRes, browseRes, mineRes] = await Promise.all([
        getChannelFeed().catch(() => ({ posts: [] })),
        browseChannelsList().catch(() => ({ channels: [] })),
        getMyChannel().catch(() => ({ channel: null })),
      ]);
      setFeed(feedRes.posts ?? []);
      setChannels(browseRes.channels ?? []);
      setMine(mineRes.channel ?? null);
      if (mineRes.channel) {
        setName(mineRes.channel.name ?? '');
        setBio(mineRes.channel.bio ?? '');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const toggleFollow = async (channel) => {
    try {
      await followChannel(channel.id, !channel.following);
      await load();
    } catch (err) {
      showToast(err.message ?? 'Action impossible');
    }
  };

  const saveChannel = async () => {
    if (name.trim().length < 2) {
      showToast('Donne un nom à ta chaîne');
      return;
    }
    setBusy(true);
    try {
      await saveMyChannel({ name: name.trim(), bio: bio.trim() || null });
      showToast(mine ? 'Chaîne mise à jour ✓' : 'Chaîne créée ✓');
      await load();
    } catch (err) {
      showToast(err.message ?? 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  };

  const attachPhoto = async () => {
    const dataUrl = await pickProfilePhoto();
    if (dataUrl) setDraftImage(dataUrl);
  };

  const publish = async () => {
    if (!draft.trim() && !draftImage) return;
    setBusy(true);
    try {
      await publishChannelPost({ body: draft.trim() || null, imageUrl: draftImage });
      setDraft('');
      setDraftImage(null);
      showToast('Publié sur ta chaîne ✓');
      await load();
    } catch (err) {
      showToast(err.message ?? 'Publication impossible');
    } finally {
      setBusy(false);
    }
  };

  const removePost = async (post) => {
    try {
      await deleteChannelPost(post.id);
      await load();
    } catch (err) {
      showToast(err.message ?? 'Suppression impossible');
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <ScreenHeader onBack={() => navigation.goBack()} eyebrow="K21" title="Chaînes" style={{ marginBottom: spacing.md }} />

          <View style={styles.tabRow}>
            {TABS.map((t) => (
              <PressScale key={t.key} scaleTo={0.95} onPress={() => setTab(t.key)} style={[styles.tabPill, tab === t.key && styles.tabPillOn]}>
                <Text style={[styles.tabText, tab === t.key && styles.tabTextOn]}>{t.label}</Text>
              </PressScale>
            ))}
          </View>

          {loading ? (
            <ActivityIndicator color={colors.green} style={{ marginTop: spacing.giant }} />
          ) : tab === 'feed' ? (
            feed.length === 0 ? (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyTitle}>Ton fil est vide</Text>
                <Text style={styles.emptyText}>Suis des chaînes dans « Découvrir » — leurs posts apparaîtront ici.</Text>
                <GlowButton label="Découvrir des chaînes →" onPress={() => setTab('browse')} />
              </View>
            ) : (
              <View style={{ gap: spacing.md }}>
                {feed.map((p) => (
                  <PostCard key={p.id} post={p} />
                ))}
              </View>
            )
          ) : tab === 'browse' ? (
            channels.length === 0 ? (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyTitle}>Aucune chaîne pour l’instant</Text>
                <Text style={styles.emptyText}>Sois le premier — crée la tienne dans « Ma chaîne ».</Text>
                <GlowButton tone="gold" label="Créer ma chaîne →" onPress={() => setTab('mine')} />
              </View>
            ) : (
              <View style={{ gap: spacing.sm }}>
                {channels.map((c) => (
                  <View key={c.id} style={styles.channelRow}>
                    <ProfileAvatar
                      emoji={c.owner?.avatarEmoji}
                      photoUrl={c.owner?.avatarUrl}
                      size={42}
                      initial={c.name.charAt(0).toUpperCase()}
                      style={{ borderWidth: 0 }}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.channelName} numberOfLines={1}>{c.name}</Text>
                      <Text style={styles.channelMeta} numberOfLines={1}>
                        {c.bio ? `${c.bio} · ` : ''}{c.followerCount} abonné{c.followerCount === 1 ? '' : 's'} · {c.postCount} post{c.postCount === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <PressScale
                      scaleTo={0.92}
                      onPress={() => toggleFollow(c)}
                      style={[styles.followBtn, c.following && styles.followBtnOn]}
                    >
                      <Text style={[styles.followText, c.following && styles.followTextOn]}>
                        {c.following ? '✓ Suivi' : 'Suivre'}
                      </Text>
                    </PressScale>
                  </View>
                ))}
              </View>
            )
          ) : (
            <View style={{ gap: spacing.md }}>
              <View style={styles.mineCard}>
                <Text style={styles.sectionLabel}>{mine ? 'Ta chaîne' : 'Crée ta chaîne — une par compte'}</Text>
                <TextInput accessibilityLabel="Nom de la chaîne (ex: Awa Cuisine)"
                  style={styles.input}
                  value={name}
                  onChangeText={setName}
                  placeholder="Nom de la chaîne (ex: Awa Cuisine)"
                  placeholderTextColor={'rgba(5,8,5,0.4)'}
                  maxLength={60}
                />
                <TextInput accessibilityLabel="Bio courte (optionnel)"
                  style={styles.input}
                  value={bio}
                  onChangeText={setBio}
                  placeholder="Bio courte (optionnel)"
                  placeholderTextColor={'rgba(5,8,5,0.4)'}
                  maxLength={160}
                />
                <GlowButton tone="gold" label={busy ? '…' : mine ? 'Mettre à jour' : 'Créer ma chaîne →'} onPress={saveChannel} disabled={busy} />
                {mine ? (
                  <Text style={styles.mineMeta}>
                    {mine.followerCount} abonné{mine.followerCount === 1 ? '' : 's'} · {mine.posts.length} post{mine.posts.length === 1 ? '' : 's'}
                  </Text>
                ) : null}
              </View>

              {mine ? (
                <View style={styles.mineCard}>
                  <Text style={styles.sectionLabel}>Publier</Text>
                  <TextInput accessibilityLabel="Quoi de neuf sur ta chaîne ?"
                    style={[styles.input, styles.draftInput]}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Quoi de neuf sur ta chaîne ?"
                    placeholderTextColor={'rgba(5,8,5,0.4)'}
                    multiline
                    maxLength={500}
                  />
                  {draftImage ? <Image source={{ uri: draftImage }} style={styles.draftImage} /> : null}
                  <View style={{ flexDirection: 'row', gap: spacing.md }}>
                    <PressScale scaleTo={0.95} onPress={attachPhoto} style={styles.photoBtn}>
                      <Text style={styles.photoBtnText}>📷 Photo</Text>
                    </PressScale>
                    <View style={{ flex: 1 }}>
                      <GlowButton label={busy ? '…' : 'Publier →'} onPress={publish} disabled={busy || (!draft.trim() && !draftImage)} />
                    </View>
                  </View>
                </View>
              ) : null}

              {mine?.posts?.length ? (
                <View style={{ gap: spacing.md }}>
                  <Text style={styles.sectionLabel}>Tes posts</Text>
                  {mine.posts.map((p) => (
                    <PostCard key={p.id} post={{ ...p, channel: { name: mine.name } }} onDelete={removePost} />
                  ))}
                </View>
              ) : null}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  scroll: { paddingHorizontal: spacing.xxl, paddingBottom: spacing.giant },

  tabRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xl },
  tabPill: { flex: 1, height: 36, borderRadius: radius.round, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.1)', alignItems: 'center', justifyContent: 'center' },
  tabPillOn: { backgroundColor: colors.green, borderColor: colors.green },
  tabText: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: 'rgba(5,8,5,0.55)' },
  tabTextOn: { color: colors.ink },

  emptyBox: { alignItems: 'stretch', gap: spacing.lg, marginTop: spacing.xl, backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', borderRadius: radius.xxl, borderBottomRightRadius: 12, padding: spacing.xxl },
  emptyTitle: { fontFamily: fontFamily.displayBold, fontSize: 15, color: colors.ink, textAlign: 'center' },
  emptyText: { fontSize: 12, color: 'rgba(5,8,5,0.55)', textAlign: 'center', lineHeight: 18 },

  postCard: { backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', borderRadius: radius.xl, borderBottomRightRadius: 10, padding: spacing.xl, gap: spacing.md },
  postHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  postChannel: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  postTime: { fontSize: 10, color: 'rgba(5,8,5,0.45)', marginTop: 1 },
  postDelete: { fontSize: 20, color: 'rgba(5,8,5,0.4)', paddingHorizontal: spacing.md },
  postBody: { fontSize: 13.5, lineHeight: 20, color: 'rgba(5,8,5,0.8)' },
  postImage: { width: '100%', aspectRatio: 1.4, borderRadius: radius.lg, backgroundColor: 'rgba(5,8,5,0.05)' },

  channelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', borderRadius: radius.xl, borderBottomRightRadius: 9, padding: spacing.lg },
  channelName: { fontFamily: fontFamily.bodyBold, fontSize: 13.5, color: colors.ink },
  channelMeta: { fontSize: 10.5, color: 'rgba(5,8,5,0.5)', marginTop: 1 },
  followBtn: { height: 30, paddingHorizontal: spacing.lg, borderRadius: radius.round, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' },
  followBtnOn: { backgroundColor: 'rgba(15,188,72,0.14)', borderWidth: 1, borderColor: colors.greenA35 },
  followText: { fontFamily: fontFamily.bodyBold, fontSize: 11, color: colors.ink },
  followTextOn: { color: colors.greenDark },

  mineCard: { backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)', borderRadius: radius.xxl, borderBottomRightRadius: 12, padding: spacing.xxl, gap: spacing.md },
  sectionLabel: { ...type.eyebrow, color: 'rgba(5,8,5,0.45)' },
  input: { height: 46, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.85)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', paddingHorizontal: spacing.lg, color: colors.ink, fontSize: 14 },
  draftInput: { height: 90, paddingTop: spacing.md, textAlignVertical: 'top' },
  draftImage: { width: '100%', aspectRatio: 1.6, borderRadius: radius.lg },
  photoBtn: { height: 54, paddingHorizontal: spacing.xl, borderRadius: radius.round, backgroundColor: 'rgba(255,255,255,0.85)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.12)', alignItems: 'center', justifyContent: 'center' },
  photoBtnText: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: 'rgba(5,8,5,0.65)' },
  mineMeta: { fontSize: 11, color: 'rgba(5,8,5,0.5)', textAlign: 'center' },
});
