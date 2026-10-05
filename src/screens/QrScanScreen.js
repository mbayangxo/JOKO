import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../components/ScreenHeader';
import GlowButton from '../components/GlowButton';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import QrCameraScanner from '../components/QrCameraScanner';
import { useToast } from '../components/Toast';
import { routeQrScan } from '../lib/qr-scan-routing';
import { getMerchantPublic, addFriend, lookupUser, vouchForUser, joinMboloGroup } from '../lib/api-client';
import { colors, fontFamily, radius, spacing } from '../theme';

const scanApi = { getMerchantPublic, addFriend, lookupUser, vouchForUser, joinMboloGroup };

export default function QrScanScreen({ navigation, route }) {
  const mode = route.params?.mode ?? 'pay';
  const showToast = useToast();
  const [raw, setRaw] = useState(route.params?.prefill ?? route.params?.prefilled ?? '');
  const [loading, setLoading] = useState(false);
  const [cameraPaused, setCameraPaused] = useState(false);

  const title =
    mode === 'merchant'
      ? 'Scanner marchand'
      : mode === 'friend'
        ? 'Ajouter un ami'
        : mode === 'agent'
          ? 'Scanner le code client'
          : mode === 'tontine_member'
            ? 'Scanner un membre'
            : mode === 'group_join'
              ? 'Rejoindre un groupe'
              : 'Scanner pour envoyer';

  const runScan = useCallback(
    async (value) => {
      const text = String(value ?? raw).trim();
      if (text.length < 3) {
        showToast('Code QR ou @handle invalide');
        return;
      }
      setLoading(true);
      setCameraPaused(true);
      try {
        await routeQrScan({
          raw: text,
          mode,
          navigation,
          route,
          api: scanApi,
          showToast,
        });
      } catch (err) {
        showToast(err.message ?? 'Scan impossible');
        setCameraPaused(false);
      } finally {
        setLoading(false);
      }
    },
    [raw, mode, navigation, route, showToast],
  );

  const handleCameraScan = (data) => {
    setRaw(data);
    runScan(data);
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <ScreenHeader onBack={() => navigation.goBack()} title={title} style={styles.header} />

          <QrCameraScanner onScan={handleCameraScan} paused={cameraPaused || loading} />

          <Text style={styles.orLabel}>ou colle un code</Text>

          <TextInput
            style={styles.input}
            value={raw}
            onChangeText={setRaw}
            placeholder="k21://pay/@fatou ou @fatou"
            placeholderTextColor={'rgba(5,8,5,0.45)'}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <GlowButton label={loading ? 'Chargement…' : 'Continuer →'} onPress={() => runScan(raw)} disabled={loading || raw.trim().length < 3} />

          {mode === 'pay' && (
            <PressScale scaleTo={0.97} onPress={() => navigation.navigate('QrScan', { mode: 'friend' })} style={styles.altLink}>
              <Text style={styles.altLinkText}>Ou ajouter comme ami →</Text>
            </PressScale>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.giant },
  header: { marginBottom: spacing.lg },
  orLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: 'rgba(5,8,5,0.45)',
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  input: {
    height: 52,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderWidth: 1.5,
    borderColor: 'rgba(5,8,5,0.1)',
    paddingHorizontal: spacing.xl,
    color: colors.ink,
    fontSize: 14,
    marginBottom: spacing.xl,
  },
  altLink: { alignSelf: 'center', marginTop: spacing.lg },
  altLinkText: { fontSize: 12, color: colors.greenDark, fontFamily: fontFamily.bodyBold },
});
