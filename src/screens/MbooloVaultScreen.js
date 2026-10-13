import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import { useToast } from '../components/Toast';
import { deleteMboloVaultItem, getMboloStorageStatus, getMboloVault } from '../lib/api-client';
import { colors, fontFamily, radius, spacing } from '../theme';

function formatBytes(bytes) {
  const n = Number(bytes ?? 0);
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

function kindLabel(kind) {
  if (kind === 'photo' || kind === 'image') return '📷 Photo';
  if (kind === 'voice') return '🎤 Vocal';
  if (kind === 'video') return '🎬 Vidéo';
  if (kind === 'gif') return 'GIF';
  return 'Média';
}

export default function MbooloVaultScreen({ navigation }) {
  const showToast = useToast();
  const [loading, setLoading] = useState(true);
  const [vault, setVault] = useState(null);
  const [storage, setStorage] = useState('legacy');

  const load = useCallback(async () => {
    try {
      const [data, status] = await Promise.all([
        getMboloVault(),
        getMboloStorageStatus().catch(() => ({ storage: 'legacy' })),
      ]);
      setVault(data);
      setStorage(status.storage ?? 'legacy');
    } catch (err) {
      showToast(err.message ?? 'Souvenirs indisponibles');
      setVault({ quotaBytes: 0, usedBytes: 0, items: [] });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load]),
  );

  const handleDelete = async (assetId) => {
    try {
      await deleteMboloVaultItem(assetId);
      showToast('Souvenir supprimé');
      load();
    } catch (err) {
      showToast(err.message ?? 'Suppression impossible');
    }
  };

  const quotaBytes = vault?.quotaBytes ?? 0;
  const usedBytes = vault?.usedBytes ?? 0;
  const pct = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0;
  const items = vault?.items ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <PressScale scaleTo={0.92} onPress={() => navigation.goBack()} style={styles.back} accessibilityRole="button" accessibilityLabel="Retour">
          <Text style={styles.backText}>←</Text>
        </PressScale>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Souvenirs Rec</Text>
          <Text style={styles.subtitle}>Photos, vocaux et GIFs sauvegardés dans ton profil</Text>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.green} style={{ marginTop: spacing.xxxl }} />
      ) : (
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          {storage === 'legacy' ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                Le coffre Rec complet arrive avec le stockage Supabase. Tes messages Mboolo restent dans les conversations.
              </Text>
            </View>
          ) : null}

          <View style={styles.quotaCard}>
            <View style={styles.quotaRow}>
              <Text style={styles.quotaLabel}>Espace utilisé</Text>
              <Text style={styles.quotaValue}>
                {formatBytes(usedBytes)} / {formatBytes(quotaBytes)}
              </Text>
            </View>
            <View style={styles.quotaTrack}>
              <View style={[styles.quotaFill, { width: `${pct}%` }]} />
            </View>
            {pct >= 95 ? (
              <Text style={styles.quotaWarn}>Espace presque plein — supprime des souvenirs pour continuer à sauvegarder.</Text>
            ) : null}
          </View>

          {items.length === 0 ? (
            <Text style={styles.empty}>
              Aucun souvenir sauvegardé pour l&apos;instant. Depuis Mboolo, tu pourras enregistrer des médias dans ton Rec.
            </Text>
          ) : (
            items.map((item) => (
              <View key={item.id} style={styles.item}>
                {item.readUrl && (item.kind === 'photo' || item.kind === 'gif' || item.kind === 'image') ? (
                  <Image source={{ uri: item.readUrl }} style={styles.thumb} resizeMode="cover" />
                ) : (
                  <View style={styles.thumbPlaceholder}>
                    <Text style={{ fontSize: 22 }}>{kindLabel(item.kind).split(' ')[0]}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemTitle}>{kindLabel(item.kind)}</Text>
                  <Text style={styles.itemMeta}>{formatBytes(item.sizeBytes)}</Text>
                </View>
                <PressScale scaleTo={0.95} onPress={() => handleDelete(item.id)} style={styles.deleteBtn}>
                  <Text style={styles.deleteText}>Suppr.</Text>
                </PressScale>
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.appCanvas.border,
  },
  back: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.appCanvas.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { fontSize: 18, color: colors.appCanvas.text },
  title: { fontFamily: fontFamily.displayBold, fontSize: 18, color: colors.appCanvas.text },
  subtitle: { fontSize: 11, color: colors.appCanvas.textMuted, marginTop: 2 },
  body: { padding: spacing.xl, gap: spacing.lg, paddingBottom: spacing.huge },
  notice: {
    backgroundColor: colors.greenA08,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.greenA20,
  },
  noticeText: { fontSize: 12, color: colors.appCanvas.textMuted, lineHeight: 18 },
  quotaCard: {
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  quotaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  quotaLabel: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.appCanvas.text },
  quotaValue: { fontSize: 12, color: colors.appCanvas.textMuted },
  quotaTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.appCanvas.border,
    overflow: 'hidden',
  },
  quotaFill: { height: '100%', backgroundColor: colors.green, borderRadius: 4 },
  quotaWarn: { fontSize: 11, color: colors.mboolo.terra, marginTop: spacing.sm },
  empty: { fontSize: 13, color: colors.appCanvas.textMuted, lineHeight: 20, textAlign: 'center', marginTop: spacing.xl },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  thumb: { width: 52, height: 52, borderRadius: radius.md },
  thumbPlaceholder: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.appCanvas.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.appCanvas.text },
  itemMeta: { fontSize: 11, color: colors.appCanvas.textMuted, marginTop: 2 },
  deleteBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: 'rgba(232,92,26,0.12)',
  },
  deleteText: { fontSize: 11, fontFamily: fontFamily.bodyBold, color: colors.mboolo.terra },
});
