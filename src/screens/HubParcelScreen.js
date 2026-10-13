import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import LoadErrorState from '../components/LoadErrorState';
import ScreenBackground from '../components/ScreenBackground';
import { useToast } from '../components/Toast';
import { useAppState } from '../state/AppState';
import { coordsFromArrondissement } from '../lib/dakar-coords';
import { createHubParcel, getMarketplaceHubs, getMyHubParcels } from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

const STATUS_LABELS = {
  registered: 'Enregistré — en attente d’expédition',
  in_transit: 'En route vers le Point K21',
  at_hub: 'Arrivé au point',
  ready_for_pickup: 'Prêt à retirer',
  out_for_delivery: 'Livraison en cours',
  picked_up: 'Retiré',
  delivered: 'Livré',
  cancelled: 'Annulé',
};

function ParcelRow({ parcel, onPress }) {
  return (
    <PressScale scaleTo={0.98} onPress={onPress} style={styles.parcelRow}>
      <Text style={styles.parcelRef}>{parcel.reference}</Text>
      <Text style={styles.parcelDesc} numberOfLines={1}>{parcel.description}</Text>
      <Text style={styles.parcelMeta}>
        {parcel.hub?.city ?? 'SN'} · {STATUS_LABELS[parcel.status] ?? parcel.status}
      </Text>
    </PressScale>
  );
}

export default function HubParcelScreen({ navigation }) {
  const showToast = useToast();
  const { profile } = useAppState();
  const coords = useMemo(
    () => coordsFromArrondissement(profile?.arrondissement?.key),
    [profile?.arrondissement?.key],
  );

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [parcels, setParcels] = useState([]);
  const [hubs, setHubs] = useState([]);
  const [origins, setOrigins] = useState([]);
  const [selectedHubId, setSelectedHubId] = useState(null);
  const [originCountry, setOriginCountry] = useState('US');
  const [originLabel, setOriginLabel] = useState('');
  const [description, setDescription] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [fulfillment, setFulfillment] = useState('pickup');
  const [dropoffArea, setDropoffArea] = useState(profile?.arrondissement?.name ?? 'Dakar');
  const [dropoffAddress, setDropoffAddress] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [hubData, mine] = await Promise.all([
        getMarketplaceHubs({ lat: coords.lat, lng: coords.lng }),
        getMyHubParcels(),
      ]);
      const hubList = hubData?.hubs ?? [];
      setHubs(hubList);
      setOrigins(hubData?.originCountries ?? []);
      if (!selectedHubId && hubList[0]?.id) setSelectedHubId(hubList[0].id);
      setParcels(Array.isArray(mine?.parcels) ? mine.parcels : []);
      setLoadFailed(false);
    } catch {
      setParcels([]);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [coords.lat, coords.lng, selectedHubId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const submit = async () => {
    if (!selectedHubId || !description.trim()) {
      showToast('Choisis un point K21 et décris le colis');
      return;
    }
    if (fulfillment === 'last_mile' && !dropoffAddress.trim()) {
      showToast('Adresse de livraison requise');
      return;
    }
    setSubmitting(true);
    try {
      const parcel = await createHubParcel({
        hubId: selectedHubId,
        originCountry,
        originLabel: originLabel.trim() || undefined,
        description: description.trim(),
        externalRef: externalRef.trim() || undefined,
        fulfillmentPlan: fulfillment,
        dropoff:
          fulfillment === 'last_mile'
            ? { area: dropoffArea.trim(), address: dropoffAddress.trim(), lat: coords.lat, lng: coords.lng }
            : undefined,
      });
      showToast('Colis enregistré — utilise l’adresse K21 pour l’expédition');
      navigation.navigate('HubParcelDetail', { parcelId: parcel.id });
      setDescription('');
      setExternalRef('');
      setOriginLabel('');
    } catch (err) {
      showToast(err.message ?? 'Enregistrement impossible');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 18 }}>←</Text>
          </PressScale>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>Point K21</Text>
            <Text style={styles.title}>Colis USA · Nigeria · CI…</Text>
            <Text style={styles.subtitle}>
              Fais livrer au Point K21 le plus proche — retire sur place ou dernière mile chez toi.
            </Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.sectionLabel}>Nouveau colis entrant</Text>

          <Text style={styles.label}>Pays d’origine</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {(origins.length ? origins : [{ code: 'US', label: 'USA' }, { code: 'NG', label: 'Nigeria' }, { code: 'CI', label: 'CI' }]).map(
              (o) => (
                <PressScale
                  key={o.code}
                  scaleTo={0.96}
                  onPress={() => setOriginCountry(o.code)}
                  style={[styles.chip, originCountry === o.code && styles.chipOn]}
                >
                  <Text style={[styles.chipText, originCountry === o.code && styles.chipTextOn]}>{o.label}</Text>
                </PressScale>
              ),
            )}
          </ScrollView>

          <Text style={styles.label}>Expéditeur (optionnel)</Text>
          <TextInput accessibilityLabel="Ex. Amazon, famille à Lagos"
            style={styles.input}
            value={originLabel}
            onChangeText={setOriginLabel}
            placeholder="Ex. Amazon, famille à Lagos"
            placeholderTextColor={colors.appCanvas.textFaint}
          />

          <Text style={styles.label}>Description du colis</Text>
          <TextInput accessibilityLabel="Ex. Vêtements, téléphone, documents"
            style={styles.input}
            value={description}
            onChangeText={setDescription}
            placeholder="Ex. Vêtements, téléphone, documents"
            placeholderTextColor={colors.appCanvas.textFaint}
          />

          <Text style={styles.label}>N° suivi transporteur (optionnel)</Text>
          <TextInput accessibilityLabel="DHL, FedEx, DHL Africa"
            style={styles.input}
            value={externalRef}
            onChangeText={setExternalRef}
            placeholder="DHL, FedEx, DHL Africa…"
            placeholderTextColor={colors.appCanvas.textFaint}
          />

          <Text style={styles.label}>Point K21 de destination</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {hubs.map((h) => (
              <PressScale
                key={h.id}
                scaleTo={0.96}
                onPress={() => setSelectedHubId(h.id)}
                style={[styles.chip, selectedHubId === h.id && styles.chipOn]}
              >
                <Text style={[styles.chipText, selectedHubId === h.id && styles.chipTextOn]}>
                  {h.city ?? h.name}
                </Text>
              </PressScale>
            ))}
          </ScrollView>

          <Text style={styles.label}>À l’arrivée</Text>
          <View style={styles.fulfillmentRow}>
            {['pickup', 'last_mile'].map((mode) => (
              <PressScale
                key={mode}
                scaleTo={0.97}
                onPress={() => setFulfillment(mode)}
                style={[styles.fulfillmentBtn, fulfillment === mode && styles.fulfillmentBtnOn]}
              >
                <Text style={[styles.fulfillmentText, fulfillment === mode && styles.fulfillmentTextOn]}>
                  {mode === 'pickup' ? '📍 Je viens chercher' : '🛵 Livrer chez moi'}
                </Text>
              </PressScale>
            ))}
          </View>

          {fulfillment === 'last_mile' ? (
            <>
              <TextInput accessibilityLabel="Quartier"
                style={styles.input}
                value={dropoffArea}
                onChangeText={setDropoffArea}
                placeholder="Quartier"
                placeholderTextColor={colors.appCanvas.textFaint}
              />
              <TextInput accessibilityLabel="Adresse complète"
                style={[styles.input, { minHeight: 72 }]}
                value={dropoffAddress}
                onChangeText={setDropoffAddress}
                placeholder="Adresse complète"
                placeholderTextColor={colors.appCanvas.textFaint}
                multiline
              />
            </>
          ) : null}

          <PressScale
            scaleTo={0.98}
            onPress={submit}
            disabled={submitting}
            style={[styles.submit, submitting && { opacity: 0.6 }]}
          >
            <Text style={styles.submitText}>{submitting ? 'Enregistrement…' : 'Enregistrer mon colis'}</Text>
          </PressScale>

          <Text style={[styles.sectionLabel, { marginTop: spacing.xl }]}>Mes colis</Text>
          {loading ? <ActivityIndicator color={colors.greenDark} /> : null}
          {!loading && loadFailed ? <LoadErrorState what="tes colis" onRetry={load} /> : null}
          {!loading && !loadFailed && parcels.length === 0 ? (
            <Text style={styles.empty}>Aucun colis — enregistre un envoi pour obtenir l’adresse K21.</Text>
          ) : null}
          {parcels.map((p) => (
            <ParcelRow
              key={p.id}
              parcel={p}
              onPress={() => navigation.navigate('HubParcelDetail', { parcelId: p.id })}
            />
          ))}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.huge,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.appCanvas.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: { ...type.eyebrow, color: colors.greenDark },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.ink },
  subtitle: { ...type.bodySmall, color: 'rgba(5,8,5,0.55)', lineHeight: 18, marginTop: 4 },
  body: { paddingHorizontal: spacing.huge, paddingBottom: 100, gap: spacing.sm },
  sectionLabel: { ...type.eyebrow, color: 'rgba(5,8,5,0.45)', marginTop: spacing.md },
  label: { ...type.caption, color: 'rgba(5,8,5,0.5)', marginTop: spacing.sm },
  input: {
    ...type.body,
    color: colors.ink,
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.08)',
    padding: spacing.md,
  },
  chips: { gap: spacing.sm, paddingVertical: spacing.xs },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
  },
  chipOn: { backgroundColor: 'rgba(26,240,96,0.12)', borderColor: colors.green },
  chipText: { ...type.bodySmall, color: 'rgba(5,8,5,0.6)' },
  chipTextOn: { color: colors.greenDark, fontFamily: fontFamily.bodySemiBold },
  fulfillmentRow: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.xs },
  fulfillmentBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
    alignItems: 'center',
  },
  fulfillmentBtnOn: { backgroundColor: 'rgba(26,240,96,0.12)', borderColor: colors.green },
  fulfillmentText: { ...type.caption, color: 'rgba(5,8,5,0.6)', textAlign: 'center' },
  fulfillmentTextOn: { color: colors.greenDark, fontFamily: fontFamily.bodySemiBold },
  submit: {
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  submitText: { fontFamily: fontFamily.bodySemiBold, color: colors.ink },
  parcelRow: {
    backgroundColor: colors.appCanvas.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.06)',
    gap: 2,
  },
  parcelRef: { fontFamily: fontFamily.bodySemiBold, color: colors.ink, fontSize: 13 },
  parcelDesc: { ...type.bodySmall, color: 'rgba(5,8,5,0.7)' },
  parcelMeta: { ...type.caption, color: colors.greenDark },
  empty: { ...type.bodySmall, color: 'rgba(5,8,5,0.5)', textAlign: 'center', paddingVertical: spacing.lg },
});
