import { Animated, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import PressScale from './PressScale';
import { colors, fontFamily, radius } from '../theme';
import { useGlowPulse } from '../hooks/animations';
import { usePressGuard } from '../hooks/usePressGuard';

const TONES = {
  green: { gradient: ['#3dff87', colors.green, colors.greenDark], glow: colors.green, label: colors.ink },
  gold: { gradient: ['#ffe45c', colors.flagGold, colors.goldDark], glow: colors.flagGold, label: colors.ink },
  orange: { gradient: [colors.terracottaLight, colors.terracotta, colors.terracottaDark], glow: colors.terracotta, label: colors.white },
  ink: { gradient: ['#1a241a', '#0c120c', colors.ink], glow: colors.green, label: colors.green },
};

// The `.btn-g` primary CTA used everywhere: full-width pill, Unbounded 900
// label, gradient fill + pulsing glow shadow. `tone` picks the color world.
export default function GlowButton({ label, onPress, style, disabled = false, tone = 'green' }) {
  const glow = useGlowPulse(2500, 0.25);
  const t = TONES[tone] ?? TONES.green;
  const guard = usePressGuard(disabled ? undefined : onPress);
  return (
    <PressScale
      scaleTo={0.96}
      onPress={guard.busy ? undefined : guard.onPress}
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled), busy: guard.busy }}
      style={[
        styles.btn,
        { shadowColor: t.glow },
        (disabled || guard.busy) && styles.btnDisabled,
        style,
        { shadowOpacity: Animated.add(0.3, glow) },
      ]}
    >
      <LinearGradient colors={t.gradient} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={styles.sheen} />
      <Text style={[styles.label, { color: t.label }]}>{label}</Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: '100%',
    height: 54,
    borderRadius: radius.round,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 5 },
    shadowRadius: 22,
    elevation: 6,
  },
  // top-edge light catch — makes the pill read as a lit object, not a flat rect
  sheen: {
    position: 'absolute',
    top: 0,
    left: '8%',
    right: '8%',
    height: 1.5,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  btnDisabled: { opacity: 0.5 },
  label: {
    fontFamily: fontFamily.displayBlack,
    fontSize: 12,
    letterSpacing: 0.5,
  },
});
