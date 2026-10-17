import { useEffect } from 'react';
import { Linking, Platform } from 'react-native';
import { parseK21Qr } from '../lib/k21-qr';

/** Route k21:// and https /u/@handle invite links into the app. */
export function useInviteDeepLink(navigationRef, ready) {
  useEffect(() => {
    if (!ready || !navigationRef?.current) return undefined;

    const openParsed = (parsed) => {
      if (!parsed) return;
      const nav = navigationRef.current;
      if (!nav) return;

      if (parsed.kind === 'add_user' && parsed.handle) {
        nav.navigate('Friends', { addHandle: parsed.handle });
        return;
      }
      if (parsed.kind === 'pay_user' && parsed.handle) {
        nav.navigate('SendMoney', { recipientHandle: parsed.handle });
        return;
      }
      if (parsed.kind === 'pay_charge' && parsed.code) {
        // J5 payment link: same opaque charge reference as the QR; amount from the server.
        nav.navigate('PayMerchant', { chargeCode: parsed.code });
        return;
      }
      if (parsed.kind === 'pay_merchant' && parsed.businessId) {
        nav.navigate('PayMerchant', { merchantId: parsed.businessId });
      }
    };

    const handleUrl = (url) => {
      if (!url) return;
      openParsed(parseK21Qr(url));
    };

    Linking.getInitialURL().then(handleUrl);
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      handleUrl(window.location.href);
    }

    return () => sub.remove();
  }, [navigationRef, ready]);
}
