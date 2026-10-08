import { useRef } from 'react';
import { Animated, Platform, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Matches the `:active{transform:scale(x)}` press-feedback used on every
// tappable element across the prototypes (buttons, cards, avatars, pills),
// plus the brief's §03 "every meaningful moment has haptic feedback."
//
// A single animated Pressable (not a Pressable wrapping a separately-styled
// Animated.View) — otherwise layout-affecting styles like `position:
// absolute` on `style` would apply to an inner box while the outer
// Pressable (which actually participates in layout) stays unstyled.
// Accessibility props are forwarded (they were silently dropped before J8 — screen readers
// got no name for icon-only buttons such as steppers and back arrows).
export default function PressScale({ children, style, onPress, onLongPress, scaleTo = 0.9, haptic = 'light', accessibilityLabel, accessibilityHint, accessibilityRole = 'button', accessibilityState, testID }) {
  const scale = useRef(new Animated.Value(1)).current;
  const pressIn = () => {
    Animated.spring(scale, { toValue: scaleTo, useNativeDriver: true, speed: 60, bounciness: 0 }).start();
    if (haptic && Platform.OS !== 'web') {
      const impactStyle =
        haptic === 'medium'
          ? Haptics.ImpactFeedbackStyle.Medium
          : haptic === 'heavy'
            ? Haptics.ImpactFeedbackStyle.Heavy
            : Haptics.ImpactFeedbackStyle.Light;
      Haptics.impactAsync(impactStyle);
    }
  };
  // A soft overshoot on release — snaps back past 1.0 before settling — is
  // what makes a tap read as tactile instead of a flat scale-reset.
  const pressOut = () => Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 9 }).start();
  return (
    <AnimatedPressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      disabled={!onPress && !onLongPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityRole={onPress || onLongPress ? accessibilityRole : undefined}
      accessibilityState={accessibilityState}
      testID={testID}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}
