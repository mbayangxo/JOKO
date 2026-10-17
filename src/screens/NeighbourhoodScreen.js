import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { getNeighbourhood } from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

/** J10 "Mon quartier": verified, active businesses in my area and neighbours who chose to appear. Nothing invented, no ranking. */
export default function NeighbourhoodScreen({ navigation }) {
  const [data, setData] = useState(null);
  useFocusEffect(useCallback(() => { getNeighbourhood().then(setData).catch(() => setData({ businesses: [], people: [], hint: 'Chargement impossible' })); }, []));
  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title={data?.area ? `Mon quartier · ${data.area}` : 'Mon quartier'} style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          {!data ? <ActivityIndicator color={colors.green} /> : null}
          {data?.hint ? <Text style={styles.empty}>{data.hint}</Text> : null}
          {data && !data.hint ? (
            <>
              <Text style={styles.section}>Commerces vérifiés</Text>
              {data.businesses.length === 0 ? <Text style={styles.empty}>Aucun commerce vérifié dans ton quartier pour l’instant.</Text> : null}
              {data.businesses.map((b) => (
                <View key={b.id} style={styles.card}><Text style={styles.title}>{b.name}</Text><Text style={styles.detail}>{[b.category, b.type].filter(Boolean).join(' · ')}</Text></View>
              ))}
              <Text style={styles.section}>Voisins qui ont choisi d’apparaître</Text>
              {data.people.length === 0 ? <Text style={styles.empty}>Personne pour l’instant. Tu peux apparaître depuis ton profil → Confidentialité.</Text> : null}
              {data.people.map((p) => (
                <View key={p.userId} style={styles.card}><Text style={styles.title}>{p.avatarEmoji ?? '🧑🏾'} {p.firstName ?? ''}</Text><Text style={styles.detail}>{p.handle ? `@${p.handle}` : ''}</Text></View>
              ))}
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { paddingHorizontal: spacing.lg },
  scroll: { padding: spacing.lg, paddingBottom: spacing.huge },
  section: { fontFamily: fontFamily.bodyBold, color: colors.ink, marginTop: spacing.lg, marginBottom: spacing.sm },
  empty: { ...type.body, color: 'rgba(5,8,5,0.5)' },
  card: { backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.sm },
  title: { fontFamily: fontFamily.bodyBold, color: colors.ink },
  detail: { ...type.caption, marginTop: 2 },
});
