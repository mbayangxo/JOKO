import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import StoryAvatar from '../components/StoryAvatar';
import { colors, fontFamily, radius, spacing } from '../theme';
import { useToast } from '../components/Toast';
import { getMboloThreads, getMe, shareToMbolo } from '../lib/api-client';
import { navigateFromRoot } from '../lib/root-navigation';

function threadRow(thread, userId) {
  const others = (thread.members ?? []).filter((m) => m.userId !== userId).map((m) => m.user).filter(Boolean);
  const name = thread.name?.trim() || others.map((u) => u.name).join(', ') || 'Conversation';
  return {
    threadId: thread.id,
    name,
    emoji: thread.type === 'group' ? '👥' : others[0]?.avatarEmoji ?? '💬',
    avatarUrl: thread.type === 'group' ? null : others[0]?.avatarUrl ?? null,
  };
}

/** Pick a Mboolo conversation to drop a business/product card into. */
export default function MbooloSharePickerScreen({ navigation, route }) {
  const { refType, refId, title } = route.params ?? {};
  const showToast = useToast();
  const [threads, setThreads] = useState([]);
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sharingId, setSharingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [me, list] = await Promise.all([getMe(), getMboloThreads()]);
      setUserId(me.id);
      setThreads(Array.isArray(list) ? list : []);
    } catch (err) {
      showToast(err.message ?? 'Impossible de charger Mboolo');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const share = async (row) => {
    setSharingId(row.threadId);
    try {
      await shareToMbolo({ threadId: row.threadId, refType, refId });
      showToast('Partagé ✓');
      navigateFromRoot(navigation, 'Main', {
        screen: 'MbooloTab',
        params: { screen: 'MbooloChat', params: { threadId: row.threadId, title: row.name } },
      });
    } catch (err) {
      showToast(err.message ?? 'Partage impossible');
    } finally {
      setSharingId(null);
    }
  };

  const rows = threads.map((t) => threadRow(t, userId));

  return (
    <View style={styles.root}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 16 }}>←</Text>
          </PressScale>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Partager sur Mboolo</Text>
            {title ? <Text style={styles.subtitle}>{title}</Text> : null}
          </View>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.mboolo.terra} style={{ marginTop: 40 }} />
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(r) => r.threadId}
            contentContainerStyle={{ padding: spacing.lg }}
            ListEmptyComponent={<Text style={styles.emptyHint}>Aucune conversation — commence-en une dans Mboolo</Text>}
            renderItem={({ item }) => (
              <PressScale
                scaleTo={0.98}
                onPress={() => share(item)}
                style={styles.row}
                disabled={sharingId !== null}
              >
                <StoryAvatar photoUrl={item.avatarUrl} emoji={item.emoji} size={44} spin={false} />
                <Text style={styles.rowName}>{item.name}</Text>
                {sharingId === item.threadId ? (
                  <ActivityIndicator color={colors.mboolo.terra} size="small" />
                ) : (
                  <Text style={styles.rowAction}>Envoyer</Text>
                )}
              </PressScale>
            )}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.mboolo.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.mboolo.border,
  },
  backBtn: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: 'rgba(5,8,5,0.05)', alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBold, fontSize: 15, color: colors.mboolo.ink },
  subtitle: { fontSize: 11, color: colors.mboolo.ink3, marginTop: 2 },
  emptyHint: { textAlign: 'center', color: colors.mboolo.ink3, fontSize: 12, marginTop: spacing.giant },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(5,8,5,0.05)',
  },
  rowName: { flex: 1, fontFamily: fontFamily.bodySemiBold, fontSize: 13, color: colors.mboolo.ink },
  rowAction: { fontSize: 12, fontFamily: fontFamily.bodyBold, color: colors.mboolo.terra },
});
