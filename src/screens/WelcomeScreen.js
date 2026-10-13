import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenBackground from '../components/ScreenBackground';
import PressScale from '../components/PressScale';
import { colors, fontFamily, radius, spacing } from '../theme';
import { useLocale } from '../context/LocaleContext';
import { t } from '../i18n/translations';

// Three worlds of K21, one per slide — each a crafted brand composition,
// no emoji, no stock art: the zero-fee promise, Wey yu 221 bëgg music, and the
// Mboolo/tontine community circle.

/** Slide 1 — giant tilted "0%" inside the K21 orbit, truth chips floating. */
const ZERO_CHIPS = [
  { text: 'Zéro frais', style: { top: '16%', left: '8%' }, delay: 0 },
  { text: 'Instantané', style: { top: '10%', right: '8%' }, delay: 700 },
  { text: 'Sécurisé', style: { bottom: '14%', right: '10%' }, delay: 1400 },
];

function FloatChip({ text, style, delay }) {
  const bob = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(bob, { toValue: 1, duration: 1900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 1900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [bob, delay]);
  return (
    <Animated.View
      style={[
        vs.floatChip,
        style,
        { transform: [{ translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -7] }) }] },
      ]}
    >
      <Text style={vs.floatChipText}>{text}</Text>
    </Animated.View>
  );
}

function ZeroVisual() {
  const pulse = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    const orbit = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 26000, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    orbit.start();
    return () => {
      loop.stop();
      orbit.stop();
    };
  }, [pulse, spin]);

  return (
    <View style={vs.center}>
      <Animated.View
        style={[
          vs.zeroHalo,
          { transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) }] },
        ]}
      />
      <Animated.View
        style={[
          vs.zeroOrbit,
          { transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] },
        ]}
      />
      <Animated.Text
        style={[
          vs.zeroText,
          {
            transform: [
              { rotate: '-7deg' },
              { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] }) },
            ],
          },
        ]}
      >
        0%
      </Animated.Text>
      <View style={vs.zeroStripe}>
        <View style={[vs.stripeSeg, { backgroundColor: colors.green }]} />
        <View style={[vs.stripeSeg, { backgroundColor: colors.flagGold }]} />
        <View style={[vs.stripeSeg, { backgroundColor: colors.terracotta }]} />
      </View>
      {ZERO_CHIPS.map((c) => (
        <FloatChip key={c.text} text={c.text} style={c.style} delay={c.delay} />
      ))}
    </View>
  );
}

/** Slide 2 — living equalizer in flag colors on the ink field. */
const HUSTLE_CHIPS = [
  { text: 'Gigs', style: { top: '16%', left: '10%' }, delay: 0 },
  { text: 'Livraison', style: { top: '10%', right: '10%' }, delay: 700 },
  { text: 'Marché', style: { bottom: '14%', right: '12%' }, delay: 1400 },
];

function HustleVisual() {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 24000, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const counter = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-360deg'] });

  return (
    <View style={vs.center}>
      <View style={vs.hustleHalo} />
      <Animated.View style={[vs.hustleOrbit, { transform: [{ rotate }] }]}>
        <Animated.View style={[vs.hustleSat, { top: -23, left: 108 - 23 }, { transform: [{ rotate: counter }] }]}>
          <Text style={{ fontSize: 20 }}>🛵</Text>
        </Animated.View>
        <Animated.View style={[vs.hustleSat, { bottom: 4, left: -8 }, { transform: [{ rotate: counter }] }]}>
          <Text style={{ fontSize: 20 }}>🛍️</Text>
        </Animated.View>
        <View style={[vs.hustleParcel, { bottom: 30, right: -4 }]} />
      </Animated.View>
      <View style={vs.hustleCore}>
        <Text style={{ fontSize: 44 }}>💼</Text>
        <View style={vs.zeroStripe}>
          <View style={[vs.stripeSeg, { backgroundColor: colors.green }]} />
          <View style={[vs.stripeSeg, { backgroundColor: colors.flagGold }]} />
          <View style={[vs.stripeSeg, { backgroundColor: colors.terracotta }]} />
        </View>
      </View>
      {HUSTLE_CHIPS.map((c) => (
        <FloatChip key={c.text} text={c.text} style={c.style} delay={c.delay} />
      ))}
    </View>
  );
}

/** Slide 3 — the tontine circle: people-dots orbiting the shared pot. */
function TontineVisual() {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 26000, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  const R = 108;
  const FEATURES = ['💬', '📞', '🎟️', '🎶'];
  const DOTS = 8;
  const counter = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-360deg'] });
  return (
    <View style={vs.center}>
      <View style={vs.communityHalo} />
      <Animated.View
        style={[
          vs.orbit,
          { width: R * 2 + 26, height: R * 2 + 26, borderRadius: R + 13 },
          { transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] },
        ]}
      >
        {Array.from({ length: DOTS }).map((_, i) => {
          const a = (i / DOTS) * Math.PI * 2;
          const feature = i % 2 === 0 ? FEATURES[(i / 2) % FEATURES.length] : null;
          const x = R + 13 + Math.cos(a) * R;
          const y = R + 13 + Math.sin(a) * R;
          return feature ? (
            <Animated.View key={i} style={[vs.orbitFeature, { left: x - 21, top: y - 21 }, { transform: [{ rotate: counter }] }]}>
              <Text style={{ fontSize: 17 }}>{feature}</Text>
            </Animated.View>
          ) : (
            <View
              key={i}
              style={[
                vs.orbitDot,
                i % 3 === 0 && { backgroundColor: colors.flagGold },
                { left: x - 8, top: y - 8 },
              ]}
            />
          );
        })}
      </Animated.View>
      <View style={vs.pot}>
        <Text style={{ fontSize: 34 }}>💬</Text>
        <Text style={vs.potText}>Mboolo</Text>
      </View>
    </View>
  );
}

const vs = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  zeroHalo: { position: 'absolute', width: 230, height: 230, borderRadius: 115, backgroundColor: 'rgba(26,240,96,0.14)' },
  zeroOrbit: { position: 'absolute', width: 268, height: 268, borderRadius: 134, borderWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(15,188,72,0.5)' },
  floatChip: {
    position: 'absolute', backgroundColor: 'rgba(255,255,255,0.92)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)',
    borderRadius: radius.round, borderBottomRightRadius: 8, paddingVertical: 6, paddingHorizontal: spacing.lg,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 3,
  },
  floatChipText: { fontFamily: fontFamily.bodyBold, fontSize: 11, color: 'rgba(5,8,5,0.75)' },
  zeroText: { fontFamily: fontFamily.displayBlack, fontSize: 128, letterSpacing: -6, color: colors.greenDark, textShadowColor: 'rgba(26,240,96,0.45)', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 24 },
  zeroStripe: { flexDirection: 'row', height: 4, borderRadius: 2, overflow: 'hidden', width: 74, marginTop: spacing.md },
  stripeSeg: { flex: 1 },

  hustleHalo: { position: 'absolute', width: 230, height: 230, borderRadius: 115, backgroundColor: 'rgba(250,216,54,0.18)' },
  hustleOrbit: { position: 'absolute', width: 216, height: 216, borderRadius: 108, borderWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(232,146,10,0.5)' },
  hustleSat: {
    position: 'absolute', width: 46, height: 46, borderRadius: 23, borderBottomRightRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.95)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.1)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.12, shadowRadius: 8, elevation: 4,
  },
  hustleCore: {
    width: 128, height: 128, borderRadius: 64, borderBottomRightRadius: 16, backgroundColor: colors.flagGold,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.goldDark, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 22, elevation: 9,
  },


  orbit: { position: 'absolute', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.22)', borderStyle: 'dashed' },
  orbitDot: { position: 'absolute', width: 16, height: 16, borderRadius: 8, backgroundColor: colors.terracotta },
  orbitFeature: {
    position: 'absolute', width: 42, height: 42, borderRadius: 21, borderBottomRightRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.95)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.1)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.12, shadowRadius: 8, elevation: 4,
  },
  communityHalo: { position: 'absolute', width: 240, height: 240, borderRadius: 120, backgroundColor: 'rgba(232,92,26,0.12)' },
  hustleParcel: { position: 'absolute', width: 14, height: 14, borderRadius: 4, backgroundColor: colors.terracotta, borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)' },
  pot: {
    width: 118, height: 118, borderRadius: 59, borderBottomRightRadius: 14, backgroundColor: colors.terracotta,
    alignItems: 'center', justifyContent: 'center', gap: 2,
    shadowColor: colors.terracotta, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 20, elevation: 9,
  },
  potText: { fontFamily: fontFamily.displayBlack, fontSize: 14, letterSpacing: 0, color: colors.white },
});

// One shared canvas (ScreenBackground) — each slide keeps its own color
// identity in the artwork and CTA, not in the wallpaper.
const SLIDES = [
  {
    key: 'payments',
    Visual: ZeroVisual,
    ctaBg: colors.green,
    ctaColor: colors.ink,
    accent: colors.greenDark,
  },
  {
    key: 'hustle',
    Visual: HustleVisual,
    ctaBg: colors.flagGold,
    ctaColor: colors.ink,
    accent: colors.goldDark,
  },
  {
    key: 'community',
    Visual: TontineVisual,
    ctaBg: colors.terracotta,
    ctaColor: colors.white,
    accent: colors.terracotta,
  },
];

export default function WelcomeScreen({ onComplete, onBack }) {
  const { langCode } = useLocale();
  const [index, setIndex] = useState(0);
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    enter.setValue(0);
    Animated.timing(enter, { toValue: 1, duration: 480, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [index, enter]);

  const slides = useMemo(
    () =>
      SLIDES.map((meta, i) => ({
        ...meta,
        titleLine1: t(langCode, `welcomeSlide${i + 1}Title1`),
        titleLine2: t(langCode, `welcomeSlide${i + 1}Title2`),
        body: t(langCode, `welcomeSlide${i + 1}Body`),
        button: t(langCode, `welcomeSlide${i + 1}Btn`),
      })),
    [langCode],
  );

  const slide = slides[index];
  const { Visual } = slide;

  const goNext = () => {
    if (index < slides.length - 1) setIndex(index + 1);
    else onComplete?.();
  };
  const goBack = () => {
    if (index > 0) setIndex(index - 1);
  };

  // Stories-style navigation: swipe left/right anywhere on the visual, or
  // tap (left quarter = back, rest = next) — matches the segment bars.
  const indexRef = useRef(0);
  indexRef.current = index;
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (e, g) => {
        if (g.dx <= -48) {
          if (indexRef.current < SLIDES.length - 1) setIndex(indexRef.current + 1);
          return;
        }
        if (g.dx >= 48) {
          if (indexRef.current > 0) setIndex(indexRef.current - 1);
          return;
        }
        if (Math.abs(g.dx) < 10 && Math.abs(g.dy) < 10) {
          const x = e.nativeEvent.pageX ?? 0;
          if (x < 100) {
            if (indexRef.current > 0) setIndex(indexRef.current - 1);
          } else if (indexRef.current < SLIDES.length - 1) {
            setIndex(indexRef.current + 1);
          }
        }
      },
    }),
  ).current;

  const rise = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }) }],
  };

  return (
    <View style={styles.root}>
      <ScreenBackground soft />

      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.frame}>
          <View style={styles.topBar}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
              {onBack ? (
                <PressScale scaleTo={0.9} onPress={onBack} style={styles.topBackBtn} accessibilityRole="button" accessibilityLabel="Retour">
                  <Text style={{ fontSize: 14, color: colors.ink }}>←</Text>
                </PressScale>
              ) : null}
              <Text style={[styles.brandMark, { color: colors.greenDark }]}>K21</Text>
            </View>
            <PressScale scaleTo={0.94} onPress={onComplete}>
              <Text style={[styles.skipText, { color: 'rgba(5,8,5,0.55)' }]}>{t(langCode, 'welcomeSkip')}</Text>
            </PressScale>
          </View>

          <Animated.View style={[{ flex: 1 }, rise]} {...pan.panHandlers}>
            <Visual />
          </Animated.View>

          <Animated.View style={[styles.bottom, rise]}>
            <View style={styles.segRow}>
              {slides.map((s, i) => (
                <View
                  key={s.key}
                  style={[
                    styles.seg,
                    i < index && { backgroundColor: 'rgba(5,8,5,0.35)' },
                    i === index && { backgroundColor: slide.accent },
                  ]}
                />
              ))}
            </View>
            <Text style={[styles.title, { color: colors.ink }]}>
              {slide.titleLine1}
              {'\n'}
              <Text style={{ color: slide.accent }}>{slide.titleLine2}</Text>
            </Text>
            <Text style={[styles.body, { color: 'rgba(5,8,5,0.62)' }]}>{slide.body}</Text>
            <PressScale scaleTo={0.97} onPress={goNext} style={[styles.nextBtn, { backgroundColor: slide.ctaBg, shadowColor: slide.ctaBg }]}>
              <Text style={[styles.nextBtnText, { color: slide.ctaColor }]}>{slide.button}</Text>
            </PressScale>
          </Animated.View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  frame: { flex: 1, width: '100%', maxWidth: 420, alignSelf: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xxl, paddingTop: spacing.lg },
  topBackBtn: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMark: { fontFamily: fontFamily.displayBlack, fontSize: 17, letterSpacing: -0.5 },
  skipText: { fontFamily: fontFamily.bodyBold, fontSize: 12, textDecorationLine: 'underline' },

  bottom: { paddingHorizontal: spacing.xxxl, paddingBottom: spacing.giant + 4 },
  segRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xl },
  seg: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(5,8,5,0.12)', maxWidth: 64 },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 27, letterSpacing: -1, lineHeight: 34, marginBottom: spacing.md },
  body: { fontFamily: fontFamily.bodyRegular, fontSize: 13.5, lineHeight: 21, marginBottom: spacing.xxl },
  nextBtn: {
    width: '100%', height: 56, borderRadius: radius.round, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.22, shadowRadius: 14, elevation: 6,
  },
  nextBtnText: { fontFamily: fontFamily.bodyBold, fontSize: 14.5 },
});
