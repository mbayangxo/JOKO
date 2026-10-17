import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Keypad from '../components/Keypad';
import GlowButton from '../components/GlowButton';
import PressScale from '../components/PressScale';
import OnboardingShell from '../components/OnboardingShell';
import { fontFamily, spacing } from '../theme';
import { ob } from '../theme/onboarding';
import { useSecurity } from '../context/SecurityContext';

const PIN_LENGTH = 6;

export default function PinGateScreen({ mode = 'unlock', title, subtitle, onSuccess, onSetupComplete }) {
  const security = useSecurity();
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [phase, setPhase] = useState(mode === 'setup' ? 'enter' : 'verify');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const heading =
    title ??
    (mode === 'setup'
      ? phase === 'enter'
        ? 'Choisis ton PIN'
        : 'Confirme ton PIN'
      : 'Entre ton PIN');

  const sub =
    subtitle ??
    (mode === 'setup'
      ? 'Minimum 6 chiffres — jamais stocké en clair sur ton téléphone.'
      : 'Ton compte est verrouillé après inactivité.');

  async function submit(value) {
    if (value.length < PIN_LENGTH) return;
    setError('');
    setLoading(true);

    try {
      if (mode === 'setup') {
        if (phase === 'enter') {
          setConfirmPin(value);
          setPin('');
          setPhase('confirm');
          setLoading(false);
          return;
        }
        if (value !== confirmPin) {
          setError('Les PIN ne correspondent pas');
          setPin('');
          setPhase('enter');
          setConfirmPin('');
          setLoading(false);
          return;
        }
        try {
          await security.setupPin(value);
        } catch (err) {
          setError(err?.message ?? 'Impossible d’enregistrer le PIN');
          setPin('');
          setPhase('enter');
          setConfirmPin('');
          return;
        }
        onSetupComplete?.();
        onSuccess?.();
        return;
      }

      if (mode === 'stepup') {
        const result = await security.requestStepUp(value);
        if (!result.ok) {
          setError(result.message ?? 'PIN incorrect');
          setPin('');
          setLoading(false);
          return;
        }
        onSuccess?.(result.stepUpToken);
        return;
      }

      const result = await security.unlockWithPin(value);
      if (!result.ok) {
        setError(result.message ?? 'PIN incorrect');
        setPin('');
        setLoading(false);
        return;
      }
      onSuccess?.();
    } finally {
      setLoading(false);
    }
  }

  function onDigit(d) {
    const next = `${pin}${d}`.slice(0, PIN_LENGTH);
    setPin(next);
    if (next.length === PIN_LENGTH) submit(next);
  }

  return (
    <OnboardingShell edges={['top', 'bottom']}>
      <View style={styles.body}>
        <Text style={styles.title}>{heading}</Text>
        <Text style={styles.sub}>{sub}</Text>

        <View style={styles.dots}>
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <View key={i} style={[styles.dot, i < pin.length && styles.dotFilled]} />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {mode === 'unlock' && security.biometricReady ? (
          <PressScale
            onPress={async () => {
              const result = await security.unlockWithBiometric();
              if (result.ok) onSuccess?.();
              else setError(result.message);
            }}
            style={styles.bioBtn}
          >
            <Text style={styles.bioText}>Utiliser empreinte / Face ID</Text>
          </PressScale>
        ) : null}

        <Keypad variant="onboarding" onDigit={onDigit} onBackspace={() => setPin((p) => p.slice(0, -1))} />

        {mode === 'setup' && security.pinReady === false ? (
          <GlowButton
            label={loading ? '…' : 'Activer biométrie'}
            onPress={async () => {
              const r = await security.enableBiometric();
              if (!r.ok) setError(r.message);
            }}
            style={{ marginTop: spacing.xl }}
          />
        ) : null}
      </View>
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, padding: spacing.xl, justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBold, fontSize: 24, color: ob.ink, marginBottom: spacing.sm },
  sub: { fontFamily: fontFamily.bodyRegular, fontSize: 14, color: ob.muted, marginBottom: spacing.xxl },
  dots: { flexDirection: 'row', gap: spacing.md, justifyContent: 'center', marginBottom: spacing.xl },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: ob.orangeSoft, borderWidth: 1, borderColor: ob.orangeBorder },
  dotFilled: { backgroundColor: ob.green, borderColor: ob.green },
  error: { color: ob.orange, textAlign: 'center', marginBottom: spacing.md, fontFamily: fontFamily.bodyRegular },
  bioBtn: { alignSelf: 'center', marginBottom: spacing.xl, padding: spacing.md },
  bioText: { color: ob.green, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },
});
