import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { fontFamily, spacing } from '../theme';
import { networkMessage, networkState, reportBrowserOnline, subscribeNetwork } from '../lib/network-state';

/**
 * J12 — one honest line about the network for the whole app (screen-reader announced). It never claims
 * that anything was sent or paid; it only says what the app will and will not do while offline/slow.
 */
export default function NetworkStatusBanner() {
  const [s, setS] = useState(networkState());
  useEffect(() => {
    const off = subscribeNetwork(setS);
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const on = () => reportBrowserOnline(true);
      const down = () => reportBrowserOnline(false);
      window.addEventListener('online', on);
      window.addEventListener('offline', down);
      if (navigator.onLine === false) reportBrowserOnline(false);
      return () => {
        off();
        window.removeEventListener('online', on);
        window.removeEventListener('offline', down);
      };
    }
    return off;
  }, []);
  const text = networkMessage(s.status);
  if (!text) return null;
  return (
    <View style={[styles.bar, s.status === 'offline' ? styles.offline : styles.weak]} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="network-status">
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  offline: { backgroundColor: '#3a3a3a' },
  weak: { backgroundColor: '#8a5a00' },
  text: { color: '#fff', fontFamily: fontFamily.bodyMedium, fontSize: 14, lineHeight: 19 },
});
