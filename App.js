import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import * as ExpoSplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { colors, fontsToLoad } from './src/theme';
import RootNavigator from './src/navigation/RootNavigator';
import WebAppShell from './src/components/WebAppShell';
import AppLoadingScreen from './src/screens/AppLoadingScreen';
import { AppStateProvider } from './src/state/AppState';
import { PreferencesProvider } from './src/context/PreferencesContext';
import { LocaleProvider } from './src/context/LocaleContext';
import { SessionProvider } from './src/context/SessionContext';
import { SecurityProvider, useSecurity } from './src/context/SecurityContext';
import PinGateScreen from './src/screens/PinGateScreen';
import DeviceSecurityBanner from './src/components/DeviceSecurityBanner';
import { ToastProvider } from './src/components/Toast';
import { navigationIntegration, Sentry } from './src/lib/sentry';
import NavSideEffects from './src/hooks/NavSideEffects';

function AppShell() {
  const { locked, pinReady, pinResetRequired, deviceRisk } = useSecurity();

  if (pinResetRequired) {
    return <PinGateScreen mode="setup" subtitle="Pour ta sécurité, choisis un nouveau code PIN." onSuccess={() => {}} />;
  }

  if (locked && pinReady) {
    return <PinGateScreen mode="unlock" onSuccess={() => {}} />;
  }

  return (
    <>
      <DeviceSecurityBanner risk={deviceRisk} />
      <RootNavigator />
    </>
  );
}

ExpoSplashScreen.preventAutoHideAsync();

const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: '#f2f8ec', card: '#f2f8ec', border: 'rgba(5,8,5,0.08)' },
};

export default Sentry.wrap(function App() {
  const [fontsLoaded] = useFonts(fontsToLoad);
  const navigationRef = useRef(null);
  const [navReady, setNavReady] = useState(false);

  // Deep links registered inside NavSideEffects (needs AppState + Toast).

  // Web: hide the native splash overlay as soon as JS runs — otherwise a white
  // sheet can sit on top of the app forever if fonts or onLayout are slow.
  useEffect(() => {
    ExpoSplashScreen.hideAsync().catch(() => {});
    const fallback = setTimeout(() => {
      ExpoSplashScreen.hideAsync().catch(() => {});
    }, 2500);
    return () => clearTimeout(fallback);
  }, []);

  const onLayout = useCallback(async () => {
    await ExpoSplashScreen.hideAsync().catch(() => {});
  }, []);

  if (!fontsLoaded) {
    return (
      <SafeAreaProvider>
        <View style={styles.root}>
          <AppLoadingScreen />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <WebAppShell>
        <View style={styles.root} onLayout={onLayout}>
          <StatusBar style="dark" />
          <NavigationContainer
            ref={navigationRef}
            theme={navTheme}
            onReady={() => {
              navigationIntegration.registerNavigationContainer(navigationRef);
              setNavReady(true);
            }}
          >
            <AppStateProvider>
              <SessionProvider>
                <PreferencesProvider>
                  <LocaleProvider>
                    <SecurityProvider>
                      <ToastProvider>
                        <NavSideEffects navigationRef={navigationRef} navReady={navReady} />
                        <AppShell />
                      </ToastProvider>
                    </SecurityProvider>
                  </LocaleProvider>
                </PreferencesProvider>
              </SessionProvider>
            </AppStateProvider>
          </NavigationContainer>
        </View>
      </WebAppShell>
    </SafeAreaProvider>
  );
});

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#f2f8ec',
  },
});
