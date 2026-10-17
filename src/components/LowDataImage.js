import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text } from 'react-native';
import { usePreferences } from '../context/PreferencesContext';

/**
 * J12 — a remote image that respects "Mode données réduites": in low-data mode it shows a light
 * placeholder and downloads only when tapped. Local images (file:, data:) always show.
 */
export default function LowDataImage({ uri, style, accessibilityLabel, resizeMode = 'cover' }) {
  const { lowDataMode } = usePreferences();
  const remote = typeof uri === 'string' && /^https?:/i.test(uri);
  const [show, setShow] = useState(false);
  if (!uri) return null;
  if (lowDataMode && remote && !show) {
    return (
      <Pressable onPress={() => setShow(true)} style={[style, styles.placeholder]} accessibilityRole="button" accessibilityLabel={`${accessibilityLabel ?? 'Image'} — appuyer pour charger (données réduites)`}>
        <Text style={styles.icon}>🖼️</Text>
        <Text style={styles.hint}>Appuyer pour charger</Text>
      </Pressable>
    );
  }
  return <Image source={{ uri }} style={style} resizeMode={resizeMode} accessibilityLabel={accessibilityLabel} />;
}

const styles = StyleSheet.create({
  placeholder: { backgroundColor: 'rgba(128,128,128,0.15)', alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 20 },
  hint: { fontSize: 11, color: 'rgba(5,8,5,0.6)', marginTop: 2 },
});
