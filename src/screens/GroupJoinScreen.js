import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../components/ScreenHeader';
import GlowButton from '../components/GlowButton';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import { useToast } from '../components/Toast';
import { joinMboloGroup } from '../lib/api-client';
import { navigateFromRoot } from '../lib/root-navigation';
import { colors, fontFamily, radius, spacing } from '../theme';

/** Paste a Mboolo group invite code (or scan its QR) to join. */
export default function GroupJoinScreen({ navigation, route }) {
  const showToast = useToast();
  const [code, setCode] = useState(route.params?.code ?? '');
  const [joining, setJoining] = useState(false);

  const join = async () => {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length < 3) {
      showToast('Code invalide');
      return;
    }
    setJoining(true);
    try {
      const thread = await joinMboloGroup(trimmed);
      showToast('Groupe rejoint ✓');
      navigateFromRoot(navigation, 'Main', {
        screen: 'MbooloTab',
        params: { screen: 'MbooloChat', params: { threadId: thread.id, thread, title: thread.name ?? 'Conversation' } },
      });
    } catch (err) {
      showToast(err.message ?? 'Code invalide');
    } finally {
      setJoining(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={{ paddingHorizontal: spacing.xl }}>
          <ScreenHeader onBack={() => navigation.goBack()} title="Rejoindre un groupe" />
        </View>
        <View style={styles.body}>
          <Text style={styles.hint}>Colle le code d'invitation qu'on t'a partagé</Text>
          <TextInput accessibilityLabel="ABCD1234"
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="ABCD1234"
            placeholderTextColor="rgba(5,8,5,0.4)"
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <GlowButton label={joining ? 'Connexion…' : 'Rejoindre'} onPress={join} disabled={joining || code.trim().length < 3} />
          <PressScale
            scaleTo={0.97}
            onPress={() => navigation.navigate('QrScan', { mode: 'group_join' })}
            style={{ alignSelf: 'center', marginTop: spacing.lg }}
          >
            <Text style={styles.scanLink}>Ou scanner le QR →</Text>
          </PressScale>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  body: { paddingHorizontal: spacing.huge, paddingTop: spacing.xxl, gap: spacing.lg },
  hint: { fontSize: 12, color: 'rgba(5,8,5,0.55)', textAlign: 'center' },
  input: {
    height: 52,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderWidth: 1.5,
    borderColor: 'rgba(5,8,5,0.1)',
    paddingHorizontal: spacing.xl,
    color: colors.ink,
    fontSize: 16,
    fontFamily: fontFamily.bodyBold,
    letterSpacing: 2,
    textAlign: 'center',
  },
  scanLink: { fontSize: 12, color: colors.greenDark, fontFamily: fontFamily.bodyBold },
});
