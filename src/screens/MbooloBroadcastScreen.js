import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import StoryAvatar from '../components/StoryAvatar';
import { colors, fontFamily, radius, spacing } from '../theme';
import { useToast } from '../components/Toast';
import { getFriends, broadcastMboloMessage } from '../lib/api-client';

/** Compose one message and send it as separate DMs to several contacts at once. */
export default function MbooloBroadcastScreen({ navigation }) {
  const showToast = useToast();
  const [friends, setFriends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      getFriends()
        .then((list) => setFriends(Array.isArray(list) ? list : []))
        .catch(() => setFriends([]))
        .finally(() => setLoading(false));
    }, []),
  );

  const toggle = (handle) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });
  };

  const send = async () => {
    if (selected.size === 0) {
      showToast('Choisis au moins un contact');
      return;
    }
    if (!body.trim()) {
      showToast('Écris un message');
      return;
    }
    setSending(true);
    try {
      const result = await broadcastMboloMessage({ recipientHandles: [...selected], body: body.trim() });
      showToast(`Envoyé à ${result.sentCount} contact${result.sentCount > 1 ? 's' : ''} ✓`);
      navigation.goBack();
    } catch (err) {
      showToast(err.message ?? 'Envoi impossible');
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.root}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 16 }}>←</Text>
          </PressScale>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Diffusion</Text>
            <Text style={styles.subtitle}>Chaque contact reçoit ton message séparément — ils ne se voient pas entre eux</Text>
          </View>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.mboolo.terra} style={{ marginTop: 40 }} />
        ) : (
          <FlatList
            data={friends}
            keyExtractor={(f) => f.handle}
            contentContainerStyle={{ padding: spacing.lg }}
            ListEmptyComponent={<Text style={styles.emptyHint}>Ajoute des amis pour pouvoir leur diffuser un message</Text>}
            renderItem={({ item }) => {
              const isOn = selected.has(item.handle);
              return (
                <PressScale scaleTo={0.98} onPress={() => toggle(item.handle)} style={[styles.row, isOn && styles.rowOn]}>
                  <StoryAvatar photoUrl={item.avatarUrl} emoji={item.avatarEmoji ?? '🧑🏾'} size={40} spin={false} />
                  <Text style={styles.rowName}>{item.name ?? item.handle}</Text>
                  <View style={[styles.checkbox, isOn && styles.checkboxOn]}>
                    {isOn ? <Text style={{ fontSize: 11, color: '#fff' }}>✓</Text> : null}
                  </View>
                </PressScale>
              );
            }}
          />
        )}

        <View style={styles.composer}>
          <TextInput accessibilityLabel="Ton message"
            style={styles.input}
            placeholder="Ton message…"
            placeholderTextColor={colors.mboolo.ink3}
            value={body}
            onChangeText={setBody}
            multiline
          />
          <GlowButton
            label={sending ? 'Envoi…' : `Envoyer à ${selected.size || ''} contact${selected.size > 1 ? 's' : ''}`.trim()}
            onPress={send}
            disabled={sending}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.mboolo.bg },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg, padding: spacing.xl, borderBottomWidth: 1, borderBottomColor: colors.mboolo.border },
  backBtn: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: 'rgba(5,8,5,0.05)', alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBold, fontSize: 15, color: colors.mboolo.ink },
  subtitle: { fontSize: 11, color: colors.mboolo.ink3, marginTop: 2, lineHeight: 15 },
  emptyHint: { textAlign: 'center', color: colors.mboolo.ink3, fontSize: 12, marginTop: spacing.giant },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.lg,
  },
  rowOn: { backgroundColor: colors.mboolo.terraPale },
  rowName: { flex: 1, fontFamily: fontFamily.bodySemiBold, fontSize: 13, color: colors.mboolo.ink },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.mboolo.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.mboolo.terra, borderColor: colors.mboolo.terra },
  composer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.mboolo.border,
    backgroundColor: '#fff',
    gap: spacing.sm,
  },
  input: {
    minHeight: 60,
    borderWidth: 2,
    borderColor: colors.mboolo.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    fontSize: 13,
    color: colors.mboolo.ink,
    backgroundColor: colors.mboolo.bg2,
    textAlignVertical: 'top',
  },
});
