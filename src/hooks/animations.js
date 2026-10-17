import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useReduceMotion } from '../context/PreferencesContext';

// Shared animation hooks mapping 1:1 to the @keyframes reused across every
// K21 prototype file (dot-blink, badge-bounce, ci-in/ti-in entrance, etc).
// Centralized here because the same visual patterns repeat verbatim across
// Home, Mboolo, and every other screen in the HTML source.

export const EASE_OUT_BACK = Easing.bezier(0.175, 0.885, 0.32, 1.275);

// Fires once on mount — the brief's §03 celebration moment (sends,
// milestones, certifications) gets its own distinct haptic, not just the
// button-press impact.
export function useSuccessHaptic() {
  useEffect(() => {
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, []);
}

// `ha-float` / `act-float` / `pill-float` / `sc-float`: translateY 0 -> -distance -> 0, infinite, staggered.
export function useFloatLoop(delay = 0, distance = 4, halfDuration = 1500) {
  const val = useRef(new Animated.Value(0)).current;
  const still = useReduceMotion();
  useEffect(() => {
    if (still) return undefined; // J13-F10: no infinite decorative loop under reduce-motion / low data
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(val, { toValue: -distance, duration: halfDuration, delay, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(val, { toValue: 0, duration: halfDuration, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [val, delay, distance, halfDuration, still]);
  return val;
}

// `dot-blink` / `online-blink`: opacity 1 -> low -> 1, infinite.
export function useBlink(periodMs = 800, lowOpacity = 0.3) {
  const val = useRef(new Animated.Value(1)).current;
  const still = useReduceMotion();
  useEffect(() => {
    if (still) return undefined; // J13-F10: no infinite decorative loop under reduce-motion / low data
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(val, { toValue: lowOpacity, duration: periodMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(val, { toValue: 1, duration: periodMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [val, periodMs, lowOpacity, still]);
  return val;
}

// `badge-bounce` / `badge-breathe` / `score-star` / `logo-bounce` / `ring-wobble`: scale 1 -> peak -> 1, infinite.
export function useScalePulse(periodMs = 1500, peak = 1.15) {
  const val = useRef(new Animated.Value(1)).current;
  const still = useReduceMotion();
  useEffect(() => {
    if (still) return undefined; // J13-F10: no infinite decorative loop under reduce-motion / low data
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(val, { toValue: peak, duration: periodMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(val, { toValue: 1, duration: periodMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [val, periodMs, peak, still]);
  return val;
}

// `mboolo-pulse` / `search-glow` / `field-breathe` / `pay-shimmer`: color oscillates between two values, infinite.
export function useColorPulse(from, to, periodMs = 3000) {
  const val = useRef(new Animated.Value(0)).current;
  const still = useReduceMotion();
  useEffect(() => {
    if (still) return undefined; // J13-F10: no infinite decorative loop under reduce-motion / low data
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(val, { toValue: 1, duration: periodMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(val, { toValue: 0, duration: periodMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [val, periodMs, still]);
  return val.interpolate({ inputRange: [0, 1], outputRange: [from, to] });
}

// `rect-glow` / `music-glow` / `gift-shine`: shadow/opacity 0 -> peak -> 0, infinite.
export function useGlowPulse(periodMs = 4000, peakOpacity = 0.5) {
  const val = useRef(new Animated.Value(0)).current;
  const still = useReduceMotion();
  useEffect(() => {
    if (still) return undefined; // J13-F10: no infinite decorative loop under reduce-motion / low data
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(val, { toValue: peakOpacity, duration: periodMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(val, { toValue: 0, duration: periodMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [val, periodMs, peakOpacity, still]);
  return val;
}

// `bar-d`: scaleY 1 -> .3/.35 -> 1, .5s, infinite, staggered per bar.
export function useBarLoop(delay, bottom = 0.3) {
  const val = useRef(new Animated.Value(1)).current;
  const still = useReduceMotion();
  useEffect(() => {
    if (still) return undefined; // J13-F10: no infinite decorative loop under reduce-motion / low data
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(val, { toValue: bottom, duration: 250, delay, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(val, { toValue: 1, duration: 250, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [val, delay, bottom, still]);
  return val;
}

// `cover-spin`: holds still, then flicks a full 360 spin near the end of each cycle.
export function useSpinFlick(cycleMs = 8000, spinMs = 800) {
  const val = useRef(new Animated.Value(0)).current;
  const still = useReduceMotion();
  useEffect(() => {
    if (still) return undefined;
    let cancelled = false;
    const run = () => {
      val.setValue(0);
      Animated.sequence([
        Animated.delay(cycleMs - spinMs),
        Animated.timing(val, { toValue: 360, duration: spinMs, easing: Easing.linear, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished && !cancelled) run();
      });
    };
    run();
    return () => {
      cancelled = true;
      val.stopAnimation();
    };
  }, [val, cycleMs, spinMs, still]);
  return val.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] });
}

// `wait-spin`: continuous linear rotation, infinite.
export function useSpinLoop(periodMs = 3000) {
  const val = useRef(new Animated.Value(0)).current;
  const still = useReduceMotion();
  useEffect(() => {
    if (still) return undefined; // J13-F10: no infinite decorative loop under reduce-motion / low data
    const anim = Animated.loop(
      Animated.timing(val, { toValue: 1, duration: periodMs, easing: Easing.linear, useNativeDriver: true })
    );
    anim.start();
    return () => anim.stop();
  }, [val, periodMs, still]);
  return val.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
}

// `ava-pop` / `scan-pulse` / `live-glow` / `av-pulse`: an expanding, fading
// ring — box-shadow 0 0 0 0 color -> 0 0 0 Npx transparent, infinite.
// Returns { scale, opacity } to drive a ring View absolutely positioned
// around the element it decorates.
export function useRipple(periodMs = 2000, maxScale = 1.18) {
  const val = useRef(new Animated.Value(0)).current;
  const still = useReduceMotion();
  useEffect(() => {
    if (still) return undefined; // J13-F10: no infinite decorative loop under reduce-motion / low data
    const anim = Animated.loop(
      Animated.timing(val, { toValue: 1, duration: periodMs, easing: Easing.out(Easing.ease), useNativeDriver: true })
    );
    anim.start();
    return () => anim.stop();
  }, [val, periodMs, still]);
  return {
    scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, maxScale] }),
    opacity: val.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0.5, 0.2, 0] }),
  };
}

// One-shot entrance: fade + translateY, matching `amount-count-up` / `fade-up` / `ci-in` / `ti-in`.
export function useEntrance(delay = 0, duration = 1000, distance = 12, axis = 'y') {
  const val = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(val, { toValue: 1, duration, delay, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
  }, [val, delay, duration]);
  const translate = val.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] });
  return {
    opacity: val,
    transform: [axis === 'x' ? { translateX: translate } : { translateY: translate }],
  };
}

// One-shot pop-in: scale + opacity with back-out easing, matching `score-pop` / `msg-pop` / `check-bounce`.
export function usePopIn(delay = 0, duration = 1000, fromScale = 0.7) {
  const val = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(val, { toValue: 1, duration, delay, easing: EASE_OUT_BACK, useNativeDriver: true }).start();
  }, [val, delay, duration]);
  return {
    opacity: val.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
    transform: [{ scale: val.interpolate({ inputRange: [0, 1], outputRange: [fromScale, 1] }) }],
  };
}

// One-shot fill: width 0 -> targetPct, matching `bar-fill` / `wf` / `nl-fill`.
export function useFillIn(targetPct, delay = 0, duration = 1200) {
  const val = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(val, { toValue: targetPct, duration, delay, easing: Easing.out(Easing.ease), useNativeDriver: false }).start();
  }, [val, targetPct, delay, duration]);
  return val.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });
}

// Counts a number from `from` to `to` once on mount — used for balance
// figures on success screens so the new total visibly ticks up/down instead
// of just appearing, matching the brief's "feels alive" requirement.
export function useCountUp(from, to, duration = 700) {
  const [display, setDisplay] = useState(from);
  useEffect(() => {
    let raf;
    const start = Date.now();
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return display;
}
