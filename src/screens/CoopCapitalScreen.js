import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { useToast } from '../components/Toast';
import { getMyCoopCapital, respondCoopRecord } from '../lib/api-client';
import { styles } from './CollectiveGroupsScreen';

/** J11 model E: my lines in each cooperative's register. Records only: no shares, no dividends, no money. */
const KIND = { member_capital: 'Part de membre', gift: 'Don', loan: 'Prêt', wage_reference: 'Salaire (référence)' };

export default function CoopCapitalScreen({ navigation }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const showToast = useToast();
  const load = useCallback(async () => {
    try {
      setData(await getMyCoopCapital());
      setError(null);
    } catch (e) {
      setError(e.status === 503 ? 'Le registre coopératif n’est pas encore ouvert.' : e.message);
    }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const respond = async (id, confirm) => {
    try {
      await respondCoopRecord(id, confirm);
      showToast(confirm ? 'Ligne confirmée' : 'Ligne contestée : la coopérative est prévenue');
      load();
    } catch (e) {
      showToast(e.message);
    }
  };
  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Registre coopérative" style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          {!data && !error ? <ActivityIndicator /> : null}
          {error ? <Text style={styles.empty}>{error}</Text> : null}
          {data ? <Text style={styles.note}>{data.disclaimer}</Text> : null}
          {data && !data.coops.length ? <Text style={styles.empty}>Aucune ligne à ton nom.</Text> : null}
          {(data?.coops ?? []).map((c) => (
            <View key={c.businessId} style={[styles.card, styles.column]}>
              <Text style={styles.title}>{c.name}</Text>
              {Object.entries(c.totals).map(([k, t]) => (
                <Text key={k} style={styles.detail}>{KIND[k] ?? k} : entré {t.inXof} F · sorti {t.outXof} F{t.unconfirmed ? ` · ${t.unconfirmed} à vérifier` : ''}{t.disputed ? ` · ${t.disputed} contestée(s)` : ''}</Text>
              ))}
              {c.lines.map((l) => (
                <View key={l.id} style={{ marginTop: 8 }}>
                  <Text style={styles.detail}>{new Date(l.occurredOn).toLocaleDateString('fr-SN')} · {KIND[l.kind]} · {l.direction === 'in' ? 'versé' : 'rendu'} {l.amountXof} F{l.note ? ` · ${l.note}` : ''}</Text>
                  {!l.confirmed && !l.disputed ? (
                    <View style={styles.row}>
                      <PressScale onPress={() => respond(l.id, true)}><Text style={styles.action}>Confirmer</Text></PressScale>
                      <PressScale onPress={() => respond(l.id, false)}><Text style={styles.muted}>Contester</Text></PressScale>
                    </View>
                  ) : <Text style={styles.detail}>{l.confirmed ? '✓ confirmée' : '⚠ contestée'}</Text>}
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
