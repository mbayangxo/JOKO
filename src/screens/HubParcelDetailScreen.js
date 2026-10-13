import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import { useToast } from '../components/Toast';
import { useAppState } from '../state/AppState';
import {
  confirmHubParcelPickup,
  getHubParcel,
  markHubParcelInTransit,
  requestHubParcelLastMile,
} from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

export default function HubParcelDetailScreen({ navigation, route }) {
  const parcelId = route.params?.parcelId;
  const showToast = useToast();
  const { profile } = useAppState();
  const [loading, setLoading] = useState(true);
  const [parcel, setParcel] = useState(null);
  const [pickupCode, setPickupCode] = useState('');
  const [dropoffArea, setDropoffArea] = useState(profile?.arrondissement?.name ?? 'Dakar');
  const [dropoffAddress, setDropoffAddress] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!parcelId) return;
    setLoading(true);
    try {
      const data = await getHubParcel(parcelId);
      setParcel(data);
    } catch (err) {
      showToast(err.message ?? 'Colis introuvable');
      navigation.goBack();
    } finally {
      setLoading(false);
    }
  }, [parcelId, navigation, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const onInTransit = async () => {
    setBusy(true);
    try {
      const data = await markHubParcelInTransit(parcelId);
      setParcel(data);
      showToast('Colis marqué en route');
    } catch (err) {
      showToast(err.message ?? 'Action impossible');
    } finally {
      setBusy(false);
    }
  };

  const onLastMile = async () => {
    if (!dropoffAddress.trim()) {
      showToast('Adresse requise');
      return;
    }
    setBusy(true);
    try {
      const data = await requestHubParcelLastMile(parcelId, {
        area: dropoffArea.trim(),
        address: dropoffAddress.trim(),
      });
      setParcel(data);
      showToast('Livreur K21 notifié — frais à l’acceptation');
    } catch (err) {
      showToast(err.message ?? 'Livraison impossible');
    } finally {
      setBusy(false);
    }
  };

  const onPickup = async () => {
    if (!pickupCode.trim()) {
      showToast('Entre ton code de retrait');
      return;
    }
    setBusy(true);
    try {
      const data = await confirmHubParcelPickup(parcelId, pickupCode.trim());
      setParcel(data);
      showToast('Colis retiré ✓');
    } catch (err) {
      showToast(err.message ?? 'Code incorrect');
    } finally {
      setBusy(false);
    }
  };

  if (loading || !parcel) {
    return (
      <View style={styles.root}>
        <ScreenBackground />
        <ActivityIndicator color={colors.greenDark} style={{ marginTop: 80 }} />
      </View>
    );
  }

  const canPickup = ['at_hub', 'ready_for_pickup'].includes(parcel.status);
  const canLastMile = canPickup && !parcel.lastMile && parcel.fulfillmentPlan === 'pickup';
  const canMarkTransit = parcel.status === 'registered';

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 18 }}>←</Text>
          </PressScale>
          <Text style={styles.title}>{parcel.reference}</Text>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.card}>
            <Text style={styles.status}>{parcel.status.replace(/_/g, ' ')}</Text>
            <Text style={styles.desc}>{parcel.description}</Text>
            <Text style={styles.meta}>
              {parcel.originLabel ?? parcel.originCountry} → {parcel.hub?.name}
            </Text>
          </View>

          {parcel.shippingAddress ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Adresse à donner à l’expéditeur</Text>
              <Text style={styles.addressLine}>{parcel.shippingAddress.label}</Text>
              <Text style={styles.addressLine}>{parcel.shippingAddress.line1}</Text>
              <Text style={styles.addressHighlight}>{parcel.shippingAddress.line2}</Text>
              <Text style={styles.hint}>
                Utilise cette adresse sur Amazon, DHL, ou quand ta famille envoie depuis l’étranger.
              </Text>
            </View>
          ) : null}

          {parcel.pickupCode ? (
            <View style={styles.codeCard}>
              <Text style={styles.cardTitle}>Code de retrait</Text>
              <Text style={styles.code}>{parcel.pickupCode}</Text>
              <Text style={styles.hint}>Montre ce code au Point K21.</Text>
            </View>
          ) : null}

          {canMarkTransit ? (
            <PressScale scaleTo={0.98} onPress={onInTransit} disabled={busy} style={styles.btn}>
              <Text style={styles.btnText}>J’ai expédié — colis en route</Text>
            </PressScale>
          ) : null}

          {canLastMile ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Livraison à domicile</Text>
              <TextInput accessibilityLabel="Quartier"
                style={styles.input}
                value={dropoffArea}
                onChangeText={setDropoffArea}
                placeholder="Quartier"
                placeholderTextColor={colors.appCanvas.textFaint}
              />
              <TextInput accessibilityLabel="Adresse"
                style={[styles.input, { minHeight: 72 }]}
                value={dropoffAddress}
                onChangeText={setDropoffAddress}
                placeholder="Adresse"
                placeholderTextColor={colors.appCanvas.textFaint}
                multiline
              />
              <PressScale scaleTo={0.98} onPress={onLastMile} disabled={busy} style={styles.btn}>
                <Text style={styles.btnText}>Demander un livreur K21</Text>
              </PressScale>
            </View>
          ) : null}

          {canPickup && parcel.fulfillmentPlan === 'pickup' ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Retirer au point</Text>
              <TextInput accessibilityLabel="Code à 6 chiffres"
                style={styles.input}
                value={pickupCode}
                onChangeText={setPickupCode}
                placeholder="Code à 6 chiffres"
                keyboardType="number-pad"
                placeholderTextColor={colors.appCanvas.textFaint}
              />
              <PressScale scaleTo={0.98} onPress={onPickup} disabled={busy} style={styles.btn}>
                <Text style={styles.btnText}>Confirmer le retrait</Text>
              </PressScale>
            </View>
          ) : null}

          {parcel.lastMile ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Livraison</Text>
              <Text style={styles.meta}>
                Course {parcel.lastMile.deliveryId?.slice(0, 8)} · {parcel.lastMile.deliveryFeeNational?.toLocaleString('fr-FR')} F
              </Text>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.huge,
    paddingVertical: spacing.md,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.appCanvas.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 16, color: colors.ink, flex: 1 },
  body: { paddingHorizontal: spacing.huge, paddingBottom: 80, gap: spacing.md },
  card: {
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.06)',
  },
  codeCard: {
    backgroundColor: 'rgba(26,240,96,0.1)',
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(26,240,96,0.25)',
  },
  cardTitle: { fontFamily: fontFamily.bodySemiBold, color: colors.ink },
  status: { ...type.eyebrow, color: colors.terracottaDark, textTransform: 'uppercase' },
  desc: { fontFamily: fontFamily.bodySemiBold, fontSize: 16, color: colors.ink },
  meta: { ...type.bodySmall, color: 'rgba(5,8,5,0.55)' },
  addressLine: { ...type.body, color: colors.ink },
  addressHighlight: { fontFamily: fontFamily.displayBlack, fontSize: 15, color: colors.greenDark },
  hint: { ...type.bodySmall, color: 'rgba(5,8,5,0.5)', lineHeight: 18 },
  code: { fontFamily: fontFamily.displayBlack, fontSize: 28, color: colors.greenDark, letterSpacing: 4 },
  input: {
    ...type.body,
    color: colors.ink,
    backgroundColor: colors.appCanvas.base,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    padding: spacing.md,
  },
  btn: {
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  btnText: { fontFamily: fontFamily.bodySemiBold, color: colors.ink },
});
