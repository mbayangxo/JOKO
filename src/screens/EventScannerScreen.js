import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ConfettiBurst from '../components/ConfettiBurst';
import GlowButton from '../components/GlowButton';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { useToast } from '../components/Toast';
import { checkInEventTicket } from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

export default function EventScannerScreen({ navigation, route }) {
  const showToast = useToast();
  const [code, setCode] = useState(route.params?.prefilledCode ?? '');
  const [last, setLast] = useState(null);
  const [burst, setBurst] = useState(false);
  const [busy, setBusy] = useState(false);

  const scan = async (scanCode) => {
    const trimmed = String(scanCode ?? code).trim().toUpperCase();
    if (trimmed.length < 6) {
      showToast('Code invalide');
      return;
    }
    setBusy(true);
    try {
      const result = await checkInEventTicket(trimmed);
      setLast(result);
      setBurst(true);
      setTimeout(() => setBurst(false), 2000);
      showToast(`${result.buyer?.name ?? 'Invité'} — entrée validée ✓`);
      setCode('');
    } catch (e) {
      showToast(e.message ?? 'Scan refusé');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (route.params?.prefilledCode) {
      scan(route.params.prefilledCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.prefilledCode]);

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <ConfettiBurst active={burst} />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Scanner billets" style={styles.header} />
        <View style={styles.body}>
          <Text style={styles.hero}>Porte d'entrée</Text>
          <Text style={styles.sub}>Scanne le QR ou entre le code TKT-…</Text>
          <TextInput accessibilityLabel="TKT-"
            value={code}
            onChangeText={setCode}
            placeholder="TKT-…"
            autoCapitalize="characters"
            style={styles.input}
            placeholderTextColor="rgba(5,8,5,0.35)"
          />
          <GlowButton label={busy ? 'Vérification…' : 'Valider l\'entrée'} onPress={() => scan(code)} disabled={busy} />
          <PressScale scaleTo={0.97} onPress={() => navigation.navigate('QrScan', { mode: 'ticket' })} style={styles.cam}>
            <Text style={styles.camText}>📷 Ouvrir la caméra</Text>
          </PressScale>
          {last ? (
            <View style={styles.okCard}>
              <Text style={styles.okTitle}>✓ {last.buyer?.name ?? last.buyer?.handle}</Text>
              <Text style={styles.okSub}>{last.event?.title}</Text>
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { paddingHorizontal: spacing.lg },
  body: { padding: spacing.lg, flex: 1 },
  hero: { fontFamily: fontFamily.displayBlack, fontSize: 28, color: colors.greenDark, marginBottom: spacing.xs },
  sub: { ...type.caption, marginBottom: spacing.lg },
  input: { borderWidth: 1, borderColor: 'rgba(5,8,5,0.12)', borderRadius: radius.md, padding: spacing.lg, fontFamily: fontFamily.displayBlack, fontSize: 18, letterSpacing: 1, marginBottom: spacing.lg, backgroundColor: 'rgba(255,255,255,0.9)', color: colors.ink },
  cam: { marginTop: spacing.lg, alignItems: 'center' },
  camText: { fontFamily: fontFamily.bodyBold, color: colors.terracotta },
  okCard: { marginTop: spacing.xxl, backgroundColor: 'rgba(26,240,96,0.15)', borderRadius: radius.lg, padding: spacing.lg },
  okTitle: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.greenDark },
  okSub: { ...type.body, marginTop: 4 },
});
