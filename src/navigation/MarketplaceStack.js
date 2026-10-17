import { createNativeStackNavigator } from '@react-navigation/native-stack';
import MarcheScreen from '../screens/MarcheScreen';
import MarketplaceScreen from '../screens/MarketplaceScreen';
import ShopDetailScreen from '../screens/ShopDetailScreen';
import MerchantCatalogScreen from '../screens/MerchantCatalogScreen';
import MerchantOrdersScreen from '../screens/MerchantOrdersScreen';
import MerchantAnalyticsScreen from '../screens/MerchantAnalyticsScreen';
import HubParcelScreen from '../screens/HubParcelScreen';
import HubParcelDetailScreen from '../screens/HubParcelDetailScreen';
import TrendingScreen from '../screens/TrendingScreen';
import DiscoverScreen from '../screens/DiscoverScreen';
import DistributionHubScreen from '../screens/DistributionHubScreen';
import TradeInvoicesScreen from '../screens/TradeInvoicesScreen';
import B2BOrderPortalScreen from '../screens/B2BOrderPortalScreen';
import RestockScreen from '../screens/RestockScreen';
import AlertDetailScreen from '../screens/AlertDetailScreen';

const Stack = createNativeStackNavigator();

export default function MarketplaceStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Marche" component={MarcheScreen} />
      <Stack.Screen name="Marketplace" component={MarketplaceScreen} />
      <Stack.Screen name="ShopDetail" component={ShopDetailScreen} />
      <Stack.Screen name="MerchantCatalog" component={MerchantCatalogScreen} />
      <Stack.Screen name="MerchantOrders" component={MerchantOrdersScreen} />
      <Stack.Screen name="MerchantAnalytics" component={MerchantAnalyticsScreen} />
      <Stack.Screen name="HubParcel" component={HubParcelScreen} />
      <Stack.Screen name="HubParcelDetail" component={HubParcelDetailScreen} />
      <Stack.Screen name="Discover" component={DiscoverScreen} />
      <Stack.Screen name="Trending" component={TrendingScreen} />
      <Stack.Screen name="AlertDetail" component={AlertDetailScreen} />
      <Stack.Screen name="DistributionHub" component={DistributionHubScreen} />
      <Stack.Screen name="B2BOrderPortal" component={B2BOrderPortalScreen} />
      <Stack.Screen name="Restock" component={RestockScreen} />
      <Stack.Screen name="TradeInvoices" component={TradeInvoicesScreen} />
    </Stack.Navigator>
  );
}
