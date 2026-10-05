import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AppLoadingScreen from '../screens/AppLoadingScreen';
import SplashScreen from '../screens/SplashScreen';
import WelcomeScreen from '../screens/WelcomeScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import SignUpScreen from '../screens/SignUpScreen';
import WelcomeCelebrationScreen from '../screens/WelcomeCelebrationScreen';
import BusinessHubScreen from '../screens/BusinessHubScreen';
import BusinessOSScreen from '../screens/BusinessOSScreen';
import AccessibilityScreen from '../screens/AccessibilityScreen';
import MainTabs from './MainTabs';
import SendMoneyScreen from '../screens/SendMoneyScreen';
import PayMerchantScreen from '../screens/PayMerchantScreen';
import CashScreen from '../screens/CashScreen';
import MoreActionsScreen from '../screens/MoreActionsScreen';
import MovementScreen from '../screens/MovementScreen';
import WorkerProfileScreen from '../screens/WorkerProfileScreen';
import NuLekkScreen from '../screens/NuLekkScreen';
import ReceiveScreen from '../screens/ReceiveScreen';
import TontineScreen from '../screens/TontineScreen';
import WalletScreen from '../screens/WalletScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import EditProfileScreen from '../screens/EditProfileScreen';
import QrScanScreen from '../screens/QrScanScreen';
import MyQrScreen from '../screens/MyQrScreen';
import ChartsScreen from '../screens/ChartsScreen';
import PublicProfileScreen from '../screens/PublicProfileScreen';
import ChannelsScreen from '../screens/ChannelsScreen';
import CallScreen from '../screens/CallScreen';
import MbooloSharePickerScreen from '../screens/MbooloSharePickerScreen';
import MbooloBroadcastScreen from '../screens/MbooloBroadcastScreen';
import MbooloGroupInfoScreen from '../screens/MbooloGroupInfoScreen';
import GroupJoinScreen from '../screens/GroupJoinScreen';
import AgentApplyScreen from '../screens/AgentApplyScreen';
import AgentDepositQrScreen from '../screens/AgentDepositQrScreen';
import AgentWithdrawQrScreen from '../screens/AgentWithdrawQrScreen';
import AgentDiscoveryScreen from '../screens/AgentDiscoveryScreen';
import AgentHubScreen from '../screens/AgentHubScreen';
import InviteFriendsScreen from '../screens/InviteFriendsScreen';
import AgentHomeScreen from '../screens/AgentHomeScreen';
import CniVerificationScreen from '../screens/CniVerificationScreen';
import SupportScreen from '../screens/SupportScreen';
import FriendsScreen from '../screens/FriendsScreen';
import StudentPassScreen from '../screens/StudentPassScreen';
import PinGateScreen from '../screens/PinGateScreen';
import ScheduledPaymentsScreen from '../screens/ScheduledPaymentsScreen';
import JekkalScreen from '../screens/JekkalScreen';
import JekkalDetailScreen from '../screens/JekkalDetailScreen';
import MyTicketsScreen from '../screens/MyTicketsScreen';
import EventCreateScreen from '../screens/EventCreateScreen';
import EventScannerScreen from '../screens/EventScannerScreen';
import InfoScreen from '../screens/InfoScreen';
import MbooloVaultScreen from '../screens/MbooloVaultScreen';
import AffiliateScreen from '../screens/AffiliateScreen';
import ForgotAccessScreen from '../screens/ForgotAccessScreen';
import { useAppState } from '../state/AppState';
import { useSession } from '../context/SessionContext';
import { fetchSessionPayload, sessionPayloadFromVerify } from '../lib/session';
import { isPinConfigured } from '../lib/secure-storage';

const Stack = createNativeStackNavigator();

export default function RootNavigator() {
  const { bootstrapped, hasSession, markSignedIn } = useSession();
  const { profile, initAccount, hydrateFromApi } = useAppState();

  const mainRouteFor = (accountType) => (accountType === 'business' ? 'BusinessMain' : 'Main');

  const enterApp = async (navigation, accountType = profile.accountType) => {
    const pin = await isPinConfigured();
    const mainRoute = mainRouteFor(accountType);
    navigation.reset({
      index: 0,
      routes: [{ name: pin ? mainRoute : 'PinSetup' }],
    });
    markSignedIn();
  };

  if (!bootstrapped) {
    return <AppLoadingScreen />;
  }

  const initialRoute = hasSession ? mainRouteFor(profile.accountType) : 'Splash';

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }} initialRouteName={initialRoute}>
      <Stack.Screen name="Splash">
        {({ navigation }) => (
          <SplashScreen
            onCreateAccount={() => navigation.navigate('Welcome')}
            onHaveAccount={() => navigation.replace('SignUp', { mode: 'login' })}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Welcome">
        {({ navigation }) => (
          <WelcomeScreen
            onComplete={() => navigation.navigate('Onboarding')}
            onBack={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Splash'))}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Onboarding">
        {({ navigation }) => (
          <OnboardingScreen
            onComplete={() => navigation.navigate('SignUp', { mode: 'signup' })}
            onBack={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Welcome'))}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="SignUp">
        {({ navigation, route }) => (
          <SignUpScreen
            key={route.params?.mode ?? 'signup'}
            mode={route.params?.mode ?? 'signup'}
            initialEmail={route.params?.email}
            onCancel={() => navigation.goBack()}
            onForgot={() => navigation.navigate('ForgotAccess')}
            onSwitchToSignup={() => navigation.replace('SignUp', { mode: 'signup' })}
            onSwitchToLogin={(email) => navigation.replace('SignUp', { mode: 'login', email })}
            onLoginComplete={async (sessionTokens) => {
              let payload = sessionPayloadFromVerify(sessionTokens);
              if (!payload) {
                payload = {
                  profile: {
                    name: '',
                    handle: '',
                    phone: '',
                    email: sessionTokens?.email ?? '',
                    arrondissement: { key: '', icon: '📍', name: '' },
                    accountType: 'personal',
                    afriId: '',
                    avatarEmoji: '👤',
                    avatarUrl: null,
                  },
                  balance: 0,
                  transactions: [],
                };
              }
              try {
                payload = await fetchSessionPayload(sessionTokens ?? {});
              } catch (err) {
                console.warn('[login] session bootstrap partial', err?.message ?? err);
              }
              hydrateFromApi(payload);
              await enterApp(navigation, payload.profile?.accountType);
            }}
            onComplete={async (signupProfile) => {
              try {
                const payload = await fetchSessionPayload();
                hydrateFromApi(payload);
              } catch {
                initAccount(signupProfile);
              }
              markSignedIn();
              navigation.replace('Celebration', signupProfile);
            }}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="ForgotAccess">
        {({ navigation }) => (
          <ForgotAccessScreen
            onCancel={() => navigation.goBack()}
            onRecovered={async () => {
              const payload = await fetchSessionPayload();
              hydrateFromApi(payload);
              markSignedIn();
              navigation.replace('PinSetup');
            }}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Celebration">
        {({ navigation, route }) => (
          <WelcomeCelebrationScreen
            {...route.params}
            accountType={route.params?.accountType ?? profile.accountType}
            keboId={route.params?.kebuId ?? route.params?.keboId ?? profile.business?.kebuId}
            afriId={route.params?.afriId ?? profile.afriId}
            onEnter={() => navigation.replace('PinSetup')}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="PinSetup">
        {({ navigation }) => (
          <PinGateScreen
            mode="setup"
            onSetupComplete={() =>
              navigation.reset({ index: 0, routes: [{ name: mainRouteFor(profile.accountType) }] })
            }
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Main" component={MainTabs} />
      <Stack.Screen name="BusinessMain" component={BusinessHubScreen} />
      <Stack.Screen name="BusinessOS" component={BusinessOSScreen} />
      <Stack.Screen name="SendMoney" component={SendMoneyScreen} />
      <Stack.Screen name="ScheduledPayments" component={ScheduledPaymentsScreen} />
      <Stack.Screen name="PayMerchant" component={PayMerchantScreen} />
      <Stack.Screen name="Cash" component={CashScreen} />
      <Stack.Screen name="MoreActions" component={MoreActionsScreen} />
      <Stack.Screen name="Movement" component={MovementScreen} />
      <Stack.Screen name="WorkerProfile" component={WorkerProfileScreen} />
      <Stack.Screen name="NuLekk" component={NuLekkScreen} />
      <Stack.Screen name="Receive" component={ReceiveScreen} />
      <Stack.Screen name="Tontine" component={TontineScreen} />
      <Stack.Screen name="Wallet" component={WalletScreen} />
      <Stack.Screen name="Notifications" component={NotificationsScreen} />
      <Stack.Screen name="Accessibility" component={AccessibilityScreen} />
      <Stack.Screen name="EditProfile" component={EditProfileScreen} />
      <Stack.Screen name="CniVerification" component={CniVerificationScreen} />
      <Stack.Screen name="Support" component={SupportScreen} />
      <Stack.Screen name="AgentDepositQr" component={AgentDepositQrScreen} />
      <Stack.Screen name="AgentWithdrawQr" component={AgentWithdrawQrScreen} />
      <Stack.Screen name="AgentDiscovery" component={AgentDiscoveryScreen} />
      <Stack.Screen name="AgentHub" component={AgentHubScreen} />
      <Stack.Screen name="InviteFriends" component={InviteFriendsScreen} />
      <Stack.Screen name="AgentApply" component={AgentApplyScreen} />
      <Stack.Screen name="AgentHome" component={AgentHomeScreen} />
      <Stack.Screen name="QrScan" component={QrScanScreen} />
      <Stack.Screen name="MyQr" component={MyQrScreen} />
      <Stack.Screen name="Charts" component={ChartsScreen} />
      <Stack.Screen name="UserProfile" component={PublicProfileScreen} />
      <Stack.Screen name="Channels" component={ChannelsScreen} />
      <Stack.Screen name="Call" component={CallScreen} />
      <Stack.Screen name="MbooloSharePicker" component={MbooloSharePickerScreen} />
      <Stack.Screen name="MbooloBroadcast" component={MbooloBroadcastScreen} />
      <Stack.Screen name="MbooloGroupInfo" component={MbooloGroupInfoScreen} />
      <Stack.Screen name="GroupJoin" component={GroupJoinScreen} />
      <Stack.Screen name="StudentPass" component={StudentPassScreen} />
      <Stack.Screen name="Jekkal" component={JekkalScreen} />
      <Stack.Screen name="JekkalDetail" component={JekkalDetailScreen} />
      <Stack.Screen name="MyTickets" component={MyTicketsScreen} />
      <Stack.Screen name="EventCreate" component={EventCreateScreen} />
      <Stack.Screen name="EventScanner" component={EventScannerScreen} />
      <Stack.Screen name="GiftReveal" component={GiftRevealScreen} />
      <Stack.Screen name="Affiliate" component={AffiliateScreen} />
      <Stack.Screen name="Friends" component={FriendsScreen} />
      <Stack.Screen name="Info" component={InfoScreen} />
      <Stack.Screen name="MbooloVault" component={MbooloVaultScreen} />
    </Stack.Navigator>
  );
}
