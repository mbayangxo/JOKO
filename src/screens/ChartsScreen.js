import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { useToast } from '../components/Toast';
import { getWeeklyChart, searchChartSongs, submitChartSong, voteChartSong } from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import { useEntrance } from '../hooks/animations';

// K21 Charts — "Wey yu 221 bëgg". 100% real: songs are picked from YouTube
// search (never free-typed), ranked purely by user votes (one per person per
// week, movable), next to what Senegal actually streams. No editorial list.

const RANK_TONES = [colors.greenDark, colors.goldDark, colors.terracotta];

function rankColor(i) {
  return RANK_TONES[i] ?? 'rgba(5,8,5,0.45)';
}

function SongRow({ item, index, onVote, voting }) {
  const entrance = useEntrance(index * 60, 320, 8);
  return (
    <View style={[styles.songRow, item.mine && styles.songRowMine, entrance]}>
      <Text style={[styles.songRank, { color: rankColor(index) }]}>#{index + 1}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.songTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.songArtist} numberOfLines={1}>{item.artist}</Text>
      </View>
      <Text style={styles.songVotes}>🔥 {item.votes}</Text>
      <PressScale
        scaleTo={0.92}
        onPress={() => onVote(item)}
        disabled={voting || item.mine}
        style={[styles.voteBtn, item.mine && styles.voteBtnMine]}
      >
        <Text style={[styles.voteBtnText, item.mine && styles.voteBtnTextMine]}>
          {item.mine ? '✓ Mon vote' : 'Voter'}
        </Text>
      </PressScale>
    </View>
  );
}

export default function ChartsScreen({ navigation }) {
  const showToast = useToast();
  const [chart, setChart] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState('');
  const searchTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      setChart(await getWeeklyChart());
    } catch (err) {
      showToast(err.message ?? 'Chart indisponible');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const onQueryChange = (text) => {
    setQuery(text);
    setSearchNote('');
    clearTimeout(searchTimer.current);
    if (text.trim().length < 2) {
      setResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchChartSongs(text.trim());
        setResults(res.results ?? []);
        if ((res.results ?? []).length === 0) setSearchNote('Aucun résultat — essaie un autre titre.');
      } catch (err) {
        setResults([]);
        setSearchNote(
          err.code === 'search_unavailable' || err.status === 503
            ? 'La recherche musique ouvre bientôt — reviens vite !'
            : err.message ?? 'Recherche indisponible',
        );
      } finally {
        setSearching(false);
      }
    }, 650);
  };

  const pickSong = async (r) => {
    setBusy(true);
    try {
      await submitChartSong({ title: r.title, artist: r.artist, videoId: r.videoId });
      setQuery('');
      setResults([]);
      showToast(`Ton vote : ${r.title} ✓`);
      await load();
    } catch (err) {
      showToast(err.message ?? 'Vote impossible');
    } finally {
      setBusy(false);
    }
  };

  const vote = async (song) => {
    setBusy(true);
    try {
      await voteChartSong(song.id);
      showToast(`Ton vote : ${song.title} ✓`);
      await load();
    } catch (err) {
      showToast(err.message ?? 'Vote impossible');
    } finally {
      setBusy(false);
    }
  };

  const weekNum = chart?.weekKey?.split('-W')[1];

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <ScreenHeader
            onBack={() => navigation.goBack()}
            eyebrow="K21 CHARTS"
            title="Wey yu 221 bëgg"
            style={{ marginBottom: spacing.sm }}
          />
          <Text style={styles.sub}>
            Le chart de la communauté — classé uniquement par vos votes.
            {weekNum ? ` Semaine ${weekNum}.` : ''}
          </Text>

          <View style={styles.pollCard}>
            <Text style={styles.pollQuestion}>🎶 {chart?.question ?? 'Ta chanson préférée cette semaine ?'}</Text>
            <View style={styles.searchRow}>
              <Text style={{ fontSize: 13 }}>🔍</Text>
              <TextInput accessibilityLabel="Cherche la chanson sur YouTube"
                style={styles.searchInput}
                placeholder="Cherche la chanson sur YouTube…"
                placeholderTextColor={'rgba(5,8,5,0.45)'}
                value={query}
                onChangeText={onQueryChange}
                autoCorrect={false}
                maxLength={80}
              />
              {searching ? <ActivityIndicator size="small" color={colors.goldDark} /> : null}
            </View>
            {searchNote ? <Text style={styles.searchNote}>{searchNote}</Text> : null}
            {results.length > 0 ? (
              <View style={styles.resultsBox}>
                {results.map((r) => (
                  <PressScale key={r.videoId} scaleTo={0.98} onPress={() => pickSong(r)} disabled={busy} style={styles.resultRow}>
                    {r.thumbnail ? (
                      <Image source={{ uri: r.thumbnail }} style={styles.resultThumb} />
                    ) : (
                      <View style={[styles.resultThumb, styles.resultThumbFallback]}>
                        <Text style={{ fontSize: 14 }}>🎵</Text>
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.resultTitle} numberOfLines={1}>{r.title}</Text>
                      <Text style={styles.resultArtist} numberOfLines={1}>{r.artist}</Text>
                    </View>
                    <View style={styles.resultVote}>
                      <Text style={styles.resultVoteText}>Voter</Text>
                    </View>
                  </PressScale>
                ))}
              </View>
            ) : null}
            <Text style={styles.pollHint}>Choisis la vraie chanson — un vote par semaine, tu peux le déplacer.</Text>
          </View>

          <Text style={styles.sectionLabel}>Classement de la semaine</Text>
          {loading ? (
            <ActivityIndicator color={colors.green} style={{ marginVertical: spacing.xxl }} />
          ) : (chart?.songs?.length ?? 0) === 0 ? (
            <Text style={styles.empty}>
              Aucune chanson cette semaine — cherche la tienne et lance le chart !
            </Text>
          ) : (
            <View style={{ gap: spacing.sm }}>
              {chart.songs.map((s, i) => (
                <SongRow key={s.id} item={s} index={i} onVote={vote} voting={busy} />
              ))}
            </View>
          )}

          <Text style={[styles.sectionLabel, { marginTop: spacing.xxl }]}>En tendance · YouTube Sénégal</Text>
          {(chart?.youtube?.length ?? 0) === 0 ? (
            <Text style={styles.empty}>
              Les tendances YouTube Sénégal apparaîtront ici après la première mise à jour quotidienne.
            </Text>
          ) : (
            <View style={styles.ytGrid}>
              {chart.youtube.map((y) => (
                <View key={y.rank} style={styles.ytTile}>
                  <Text style={[styles.ytRank, { color: rankColor(y.rank - 1) }]}>#{y.rank}</Text>
                  <Text style={styles.ytTitle} numberOfLines={2}>{y.title}</Text>
                  <Text style={styles.ytMeta} numberOfLines={1}>{y.meta}</Text>
                </View>
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
  scroll: { paddingHorizontal: spacing.xxl, paddingBottom: spacing.giant },
  sub: { fontSize: 12, color: 'rgba(5,8,5,0.55)', marginBottom: spacing.xl, lineHeight: 17 },

  pollCard: {
    backgroundColor: 'rgba(250,216,54,0.14)',
    borderWidth: 1.5,
    borderColor: 'rgba(232,146,10,0.3)',
    borderRadius: radius.xxl,
    borderBottomRightRadius: 10,
    padding: spacing.xxl,
    gap: spacing.md,
    marginBottom: spacing.xxl,
  },
  pollQuestion: { fontFamily: fontFamily.displayBold, fontSize: 13, color: colors.ink, marginBottom: spacing.xs },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    height: 46,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
    paddingHorizontal: spacing.lg,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 14, height: '100%' },
  searchNote: { fontSize: 11, color: 'rgba(5,8,5,0.55)', lineHeight: 15 },
  resultsBox: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(5,8,5,0.06)',
  },
  resultThumb: { width: 42, height: 32, borderRadius: 6, backgroundColor: 'rgba(5,8,5,0.06)' },
  resultThumbFallback: { alignItems: 'center', justifyContent: 'center' },
  resultTitle: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.ink },
  resultArtist: { fontSize: 10, color: 'rgba(5,8,5,0.55)', marginTop: 1 },
  resultVote: { backgroundColor: colors.green, borderRadius: radius.round, paddingHorizontal: spacing.lg, paddingVertical: 4 },
  resultVoteText: { fontSize: 10, fontWeight: '800', color: colors.ink },
  pollHint: { fontSize: 10, color: 'rgba(5,8,5,0.5)', textAlign: 'center' },

  sectionLabel: { ...type.eyebrow, color: 'rgba(5,8,5,0.45)', marginBottom: spacing.md },
  empty: { fontSize: 12, color: 'rgba(5,8,5,0.5)', lineHeight: 18, marginBottom: spacing.lg },

  songRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    borderRadius: radius.xl,
    borderBottomRightRadius: 9,
    padding: spacing.xl,
  },
  songRowMine: { borderColor: colors.greenA35, backgroundColor: colors.greenA08 },
  songRank: { fontFamily: fontFamily.displayBlack, fontSize: 14, width: 30 },
  songTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  songArtist: { fontSize: 11, color: 'rgba(5,8,5,0.55)', marginTop: 1 },
  songVotes: { fontSize: 11, fontWeight: '700', color: colors.goldDark },
  voteBtn: {
    height: 28,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.round,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voteBtnMine: { backgroundColor: 'rgba(15,188,72,0.15)', borderWidth: 1, borderColor: colors.greenA35 },
  voteBtnText: { fontSize: 10, fontWeight: '800', color: colors.ink },
  voteBtnTextMine: { color: colors.greenDark },

  ytGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  ytTile: {
    width: '48%',
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    borderRadius: radius.xl,
    borderBottomRightRadius: 9,
    padding: spacing.xl,
    minHeight: 84,
  },
  ytRank: { fontFamily: fontFamily.displayBlack, fontSize: 13, marginBottom: 4 },
  ytTitle: { fontFamily: fontFamily.bodyBold, fontSize: 11, color: colors.ink, lineHeight: 15 },
  ytMeta: { fontSize: 9, color: 'rgba(5,8,5,0.5)', marginTop: 3 },
});
