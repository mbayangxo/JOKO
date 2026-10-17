import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import LoadErrorState from '../components/LoadErrorState';
import ScreenBackground from '../components/ScreenBackground';
import { getMerchantAnalytics } from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export default function MerchantAnalyticsScreen({ navigation, route }) {
  const businessId = route.params?.businessId;
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      setData(await getMerchantAnalytics(businessId));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 18 }}>←</Text>
          </PressScale>
          <Text style={styles.title}>Analytics marché</Text>
        </View>
        {loading ? (
          <ActivityIndicator color={colors.greenDark} style={{ marginTop: 40 }} />
        ) : loadFailed && !data ? (
          <LoadErrorState what="les statistiques" onRetry={load} />
        ) : !data ? (
          <Text style={styles.empty}>Données indisponibles</Text>
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            <View style={styles.kpiRow}>
              <View style={styles.kpi}>
                <Text style={styles.kpiVal}>{data.revenue30Formatted}</Text>
                <Text style={styles.kpiLbl}>30 jours</Text>
              </View>
              <View style={styles.kpi}>
                <Text style={styles.kpiVal}>{data.orderCount30}</Text>
                <Text style={styles.kpiLbl}>Commandes</Text>
              </View>
            </View>

            <Section title="Meilleurs clients">
              {(data.topBuyers ?? []).length === 0 ? (
                <Text style={styles.hint}>Pas encore de clients récurrents</Text>
              ) : (
                data.topBuyers.map((b) => (
                  <View key={b.id} style={styles.row}>
                    <Text style={styles.rowTitle}>{b.name ?? b.handle}</Text>
                    <Text style={styles.rowMeta}>
                      {b.orderCount} cmd · {b.totalFormatted}
                      {b.usualItems?.[0] ? ` · aime ${b.usualItems[0].title}` : ''}
                    </Text>
                  </View>
                ))
              )}
            </Section>

            <Section title="Produits populaires">
              {(data.topProducts ?? []).map((p) => (
                <View key={p.id} style={styles.row}>
                  <Text style={styles.rowTitle}>{p.title}</Text>
                  <Text style={styles.rowMeta}>{p.unitsSold} vendus · {p.revenueFormatted}</Text>
                </View>
              ))}
            </Section>

            <Section title="Les plus consultés">
              {(data.mostViewed ?? []).map((p) => (
                <View key={p.id} style={styles.row}>
                  <Text style={styles.rowTitle}>{p.title}</Text>
                  <Text style={styles.rowMeta}>{p.views30} vues · {p.label}</Text>
                </View>
              ))}
            </Section>

            {(data.lowStockProducts ?? []).length > 0 && (
              <Section title="Stock à surveiller">
                {data.lowStockProducts.map((p) => (
                  <View key={p.id} style={[styles.row, styles.warnRow]}>
                    <Text style={styles.rowTitle}>{p.title}</Text>
                    <Text style={styles.rowMeta}>{p.label}</Text>
                  </View>
                ))}
              </Section>
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.huge, paddingVertical: spacing.md },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.appCanvas.surface, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  empty: { ...type.body, textAlign: 'center', marginTop: 48, color: 'rgba(5,8,5,0.5)' },
  body: { padding: spacing.huge, gap: spacing.lg, paddingBottom: 80 },
  kpiRow: { flexDirection: 'row', gap: spacing.md },
  kpi: { flex: 1, backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.appCanvas.border },
  kpiVal: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.greenDark },
  kpiLbl: { ...type.caption, color: 'rgba(5,8,5,0.5)', marginTop: 4 },
  section: { gap: spacing.sm },
  sectionTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  hint: { ...type.bodySmall, color: 'rgba(5,8,5,0.5)' },
  row: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.appCanvas.border },
  warnRow: { borderColor: 'rgba(232,92,26,0.35)', backgroundColor: 'rgba(232,92,26,0.06)' },
  rowTitle: { fontFamily: fontFamily.bodySemiBold, fontSize: 13, color: colors.ink },
  rowMeta: { ...type.caption, color: 'rgba(5,8,5,0.55)', marginTop: 2 },
});
