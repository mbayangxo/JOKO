import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import OnboardingShell from '../components/OnboardingShell';
import SearchPickerSheet, { SheetRow } from '../components/SearchPickerSheet';
import { fontFamily, radius, spacing, type } from '../theme';
import { ob } from '../theme/onboarding';
import { COUNTRIES, getCountryDisplayName } from '../i18n/countries';
import { LANGUAGES } from '../i18n/languages';
import { getDefaultRegion, getRegionsForCountry } from '../i18n/regions';
import { t } from '../i18n/translations';
import { useLocale } from '../context/LocaleContext';

function PickerField({ eyebrow, leading, value, hint, onPress }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionEyebrow}>{eyebrow}</Text>
      <PressScale scaleTo={0.98} onPress={onPress} style={styles.selectedPill}>
        <Text style={{ fontSize: 20 }}>{leading}</Text>
        <View style={{ flex: 1 }}>
          <Text style={[styles.pillLabel, !value && styles.pillLabelMuted]}>{value || hint}</Text>
        </View>
        <Text style={styles.pillChevron}>›</Text>
      </PressScale>
    </View>
  );
}

export default function OnboardingScreen({ onComplete, onBack }) {
  const { langCode, country: savedCountry, language: savedLanguage, region: savedRegion, setCountry, setLanguage, setRegion } = useLocale();
  const [country, setCountryLocal] = useState(savedCountry);
  const [language, setLanguageLocal] = useState(savedLanguage);
  const [region, setRegionLocal] = useState(savedRegion ?? getDefaultRegion(savedCountry?.code));
  const [activePicker, setActivePicker] = useState(null);
  const [countryQuery, setCountryQuery] = useState('');
  const [languageQuery, setLanguageQuery] = useState('');
  const [regionQuery, setRegionQuery] = useState('');

  const activeLang = language?.code ?? langCode;

  useEffect(() => {
    if (!country?.code) return;
    const regions = getRegionsForCountry(country.code);
    setRegionLocal((prev) => regions.find((r) => r.key === prev?.key) ?? regions[0] ?? null);
  }, [country?.code]);

  const filteredCountries = useMemo(() => {
    const q = countryQuery.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) =>
        getCountryDisplayName(c, activeLang).toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        (c.nameEn ?? '').toLowerCase().includes(q) ||
        c.dial.includes(q) ||
        c.code.toLowerCase().includes(q),
    );
  }, [countryQuery, activeLang]);

  const filteredLanguages = useMemo(() => {
    const q = languageQuery.trim().toLowerCase();
    let list = LANGUAGES;
    if (country?.languages?.length) {
      const suggested = country.languages.map((code) => LANGUAGES.find((l) => l.code === code)).filter(Boolean);
      const rest = LANGUAGES.filter((l) => !country.languages.includes(l.code));
      list = [...suggested, ...rest];
    }
    if (!q) return list;
    return list.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.native.toLowerCase().includes(q) ||
        l.code.toLowerCase().includes(q),
    );
  }, [languageQuery, country]);

  const regions = useMemo(() => getRegionsForCountry(country?.code), [country?.code]);

  const filteredRegions = useMemo(() => {
    const q = regionQuery.trim().toLowerCase();
    if (!q) return regions;
    return regions.filter((r) => r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q));
  }, [regionQuery, regions]);

  const closePicker = () => {
    setActivePicker(null);
    setCountryQuery('');
    setLanguageQuery('');
    setRegionQuery('');
  };

  const finish = async () => {
    if (country) await setCountry(country);
    if (language) await setLanguage(language);
    if (region) await setRegion(region);
    onComplete?.({ country, language, region });
  };

  const canContinue = Boolean(country && language && region);

  const languageDisplay = language ? `${language.native} · ${language.name}` : null;
  const countryDisplay = country ? `${getCountryDisplayName(country, activeLang)} · ${country.dial}` : null;
  const regionDisplay = region?.name ?? null;

  return (
    <OnboardingShell>
      <View style={{ flex: 1 }}>
        <View style={styles.header}>
          {onBack ? (
            <PressScale scaleTo={0.9} onPress={onBack} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
              <Text style={{ fontSize: 15, color: ob.ink }}>←</Text>
            </PressScale>
          ) : null}
          <Text style={styles.eyebrow}>{t(activeLang, 'onboardingUnifiedEyebrow')}</Text>
          <Text style={styles.title}>{t(activeLang, 'onboardingUnifiedTitle')}</Text>
          <Text style={styles.subtitle}>{t(activeLang, 'onboardingUnifiedSubtitle')}</Text>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <PickerField
            eyebrow={t(activeLang, 'languageLabel')}
            leading="🗣️"
            value={languageDisplay}
            hint={t(activeLang, 'languageTapList')}
            onPress={() => setActivePicker('language')}
          />

          <PickerField
            eyebrow={t(activeLang, 'countryLabel')}
            leading={country?.flag ?? '🌍'}
            value={countryDisplay}
            hint={t(activeLang, 'countryTapList')}
            onPress={() => setActivePicker('country')}
          />

          <PickerField
            eyebrow={t(activeLang, 'regionLabel')}
            leading={region?.icon ?? '📍'}
            value={regionDisplay}
            hint={t(activeLang, 'regionTapList')}
            onPress={() => setActivePicker('region')}
          />
        </ScrollView>

        <View style={styles.footer}>
          <GlowButton label={`${t(activeLang, 'continueLabel')} →`} onPress={finish} disabled={!canContinue} />
        </View>
      </View>

      <SearchPickerSheet
        visible={activePicker === 'language'}
        title={t(activeLang, 'languageTitle')}
        searchPlaceholder={t(activeLang, 'searchLanguagePlaceholder')}
        query={languageQuery}
        onChangeQuery={setLanguageQuery}
        onClose={closePicker}
      >
        {filteredLanguages.map((l) => (
          <SheetRow
            key={l.code}
            leading="🗣️"
            title={l.native}
            subtitle={l.name}
            selected={language?.code === l.code}
            onPress={() => {
              setLanguageLocal(l);
              closePicker();
            }}
          />
        ))}
      </SearchPickerSheet>

      <SearchPickerSheet
        visible={activePicker === 'country'}
        title={t(activeLang, 'countryTitle')}
        searchPlaceholder={t(activeLang, 'countrySearchPlaceholder')}
        query={countryQuery}
        onChangeQuery={setCountryQuery}
        onClose={closePicker}
      >
        {filteredCountries.map((c) => (
          <SheetRow
            key={c.code}
            leading={c.flag}
            title={getCountryDisplayName(c, activeLang)}
            subtitle={c.dial}
            selected={country?.code === c.code}
            onPress={() => {
              setCountryLocal(c);
              const nextRegions = getRegionsForCountry(c.code);
              setRegionLocal(nextRegions[0] ?? null);
              closePicker();
            }}
          />
        ))}
      </SearchPickerSheet>

      <SearchPickerSheet
        visible={activePicker === 'region'}
        title={t(activeLang, 'regionTitle')}
        searchPlaceholder={t(activeLang, 'regionSearchPlaceholder')}
        query={regionQuery}
        onChangeQuery={setRegionQuery}
        onClose={closePicker}
      >
        {filteredRegions.map((r) => (
          <SheetRow
            key={r.key}
            leading={r.icon ?? '📍'}
            title={r.name}
            subtitle={country ? getCountryDisplayName(country, activeLang) : undefined}
            selected={region?.key === r.key}
            onPress={() => {
              setRegionLocal(r);
              closePicker();
            }}
          />
        ))}
      </SearchPickerSheet>
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.huge, paddingTop: spacing.xxl, paddingBottom: spacing.md },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  eyebrow: { ...type.eyebrow, color: ob.green, marginBottom: 4 },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 22, color: ob.ink, letterSpacing: -0.5 },
  subtitle: { fontSize: 12, color: ob.muted, marginTop: spacing.sm, lineHeight: 17 },

  scrollContent: { paddingBottom: spacing.xxl },

  section: { marginBottom: spacing.lg },
  sectionEyebrow: { ...type.eyebrow, color: ob.green, marginBottom: spacing.sm, paddingHorizontal: spacing.huge },

  selectedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: ob.surface,
    borderWidth: 1.5,
    borderColor: ob.border,
    borderRadius: radius.xl,
    borderBottomRightRadius: 10,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    marginHorizontal: spacing.huge,
  },
  pillLabel: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: ob.ink },
  pillLabelMuted: { color: ob.muted, fontFamily: fontFamily.bodyMedium, fontWeight: '500' },
  pillChevron: { fontSize: 18, color: ob.muted, fontWeight: '600' },

  footer: { paddingHorizontal: spacing.huge, paddingVertical: spacing.xxl },
});
