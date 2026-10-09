import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import ProfileAvatar from '../components/ProfileAvatar';
import AppScreen, { appUi } from '../components/AppScreen';
import { useToast } from '../components/Toast';
import { useAppState } from '../state/AppState';
import { colors, fontFamily, radius, spacing } from '../theme';
import { COUNTRIES } from '../i18n/countries';
import { toE164, isValidLocalPhone } from '../lib/phone';

function countryFromProfilePhone(phone) {
  if (phone?.startsWith('+1')) return COUNTRIES.find((c) => c.code === 'US') ?? COUNTRIES[0];
  if (phone?.startsWith('+33')) return COUNTRIES.find((c) => c.code === 'FR') ?? COUNTRIES[0];
  if (phone?.startsWith('+221')) return COUNTRIES.find((c) => c.code === 'SN') ?? COUNTRIES[0];
  return COUNTRIES.find((c) => c.code === 'SN') ?? COUNTRIES[0];
}
import { askProfilePoll, closeProfilePoll, getCommunitySettings, mePhoneConfirm, mePhoneRequest, patchMe, saveCommunitySettings } from '../lib/api-client';
import { pickProfilePhoto } from '../lib/profile-photo';

function formatPhoneDisplay(phone) {
  if (!phone) return '—';
  return phone.replace(/(\+\d{1,3})(\d+)/, '$1 $2');
}

export default function EditProfileScreen({ navigation }) {
  const { profile, setProfile } = useAppState();
  const { showToast } = useToast();
  const [email, setEmail] = useState(profile.email ?? '');
  const [country] = useState(countryFromProfilePhone(profile.phone));
  const [newPhone, setNewPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [phoneStep, setPhoneStep] = useState('idle');
  const [pendingPhone, setPendingPhone] = useState('');
  const [devOtp, setDevOtp] = useState(null);
  const [loading, setLoading] = useState(false);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [statusText, setStatusText] = useState(profile.statusText ?? '');
  const [currentSong, setCurrentSong] = useState(profile.currentSong ?? '');
  const [pinnedPhotos, setPinnedPhotos] = useState(Array.isArray(profile.pinnedPhotos) ? profile.pinnedPhotos : []);
  const [publicSaving, setPublicSaving] = useState(false);

  const addPinnedPhoto = async () => {
    if (pinnedPhotos.length >= 3) return;
    const dataUrl = await pickProfilePhoto();
    if (!dataUrl) return;
    const next = [...pinnedPhotos, dataUrl];
    setPinnedPhotos(next);
    try {
      await patchMe({ pinnedPhotos: next });
      setProfile({ pinnedPhotos: next });
      showToast('Photo ajoutée à ton profil ✓');
    } catch (err) {
      setPinnedPhotos(pinnedPhotos);
      showToast(err.message ?? 'Photo impossible');
    }
  };

  const removePinnedPhoto = async (ix) => {
    const next = pinnedPhotos.filter((_, i) => i !== ix);
    setPinnedPhotos(next);
    try {
      await patchMe({ pinnedPhotos: next });
      setProfile({ pinnedPhotos: next });
    } catch (err) {
      setPinnedPhotos(pinnedPhotos);
      showToast(err.message ?? 'Mise à jour impossible');
    }
  };

  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '', '']);
  const [pollSaving, setPollSaving] = useState(false);

  const publishPoll = async () => {
    const options = pollOptions.map((o) => o.trim()).filter(Boolean);
    if (pollQuestion.trim().length < 3 || options.length < 2) {
      showToast('Question + au moins 2 choix');
      return;
    }
    setPollSaving(true);
    try {
      await askProfilePoll({ question: pollQuestion.trim(), options });
      setPollQuestion('');
      setPollOptions(['', '', '']);
      showToast('Sondage publié sur ton profil ✓');
    } catch (err) {
      showToast(err.message ?? 'Publication impossible');
    } finally {
      setPollSaving(false);
    }
  };

  const removePoll = async () => {
    try {
      await closeProfilePoll();
      showToast('Sondage fermé');
    } catch (err) {
      showToast(err.message ?? 'Fermeture impossible');
    }
  };

  const savePublicProfile = async () => {
    setPublicSaving(true);
    try {
      const updated = await patchMe({
        statusText: statusText.trim() || null,
        currentSong: currentSong.trim() || null,
      });
      setProfile({ statusText: updated.statusText, currentSong: updated.currentSong });
      showToast('Profil public enregistré ✓');
    } catch (err) {
      showToast(err.message ?? 'Mise à jour impossible');
    } finally {
      setPublicSaving(false);
    }
  };

  const changePhoto = async () => {
    setPhotoLoading(true);
    try {
      const dataUrl = await pickProfilePhoto();
      if (!dataUrl) return;
      const updated = await patchMe({ avatarUrl: dataUrl });
      setProfile({ avatarUrl: updated.avatarUrl ?? dataUrl, avatarEmoji: updated.avatarEmoji });
      showToast('Photo enregistrée ✓');
    } catch (err) {
      showToast(err.message ?? 'Photo impossible');
    } finally {
      setPhotoLoading(false);
    }
  };

  const removePhoto = async () => {
    setPhotoLoading(true);
    try {
      const updated = await patchMe({ avatarUrl: null });
      setProfile({ avatarUrl: updated.avatarUrl ?? null });
      showToast('Photo retirée');
    } catch (err) {
      showToast(err.message ?? 'Mise à jour impossible');
    } finally {
      setPhotoLoading(false);
    }
  };

  const saveEmail = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      showToast('Email invalide');
      return;
    }
    setLoading(true);
    try {
      const updated = await patchMe({ email: trimmed });
      setProfile({ email: updated.email });
      showToast('Email enregistré ✓');
    } catch (err) {
      showToast(err.message ?? 'Mise à jour impossible');
    } finally {
      setLoading(false);
    }
  };

  const requestPhoneChange = async () => {
    if (!isValidLocalPhone(country, newPhone)) {
      showToast('Numéro invalide');
      return;
    }
    const normalized = toE164(country, newPhone);
    setLoading(true);
    try {
      const res = await mePhoneRequest(normalized);
      setPendingPhone(res.phoneNormalized ?? normalized);
      if (res.otp) setDevOtp(String(res.otp));
      setPhoneStep('otp');
      showToast('Code envoyé au nouveau numéro');
    } catch (err) {
      showToast(err.message ?? 'Envoi impossible');
    } finally {
      setLoading(false);
    }
  };

  const confirmPhoneChange = async () => {
    if (otp.replace(/\D/g, '').length !== 6) {
      showToast('Entre les 6 chiffres');
      return;
    }
    setLoading(true);
    try {
      const updated = await mePhoneConfirm(pendingPhone, otp.replace(/\D/g, ''));
      setProfile({ phone: updated.phone });
      setPhoneStep('idle');
      setNewPhone('');
      setOtp('');
      setDevOtp(null);
      showToast('Numéro mis à jour ✓');
    } catch (err) {
      showToast(err.message ?? 'Code invalide');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppScreen>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={{ fontSize: 16, color: colors.appCanvas.text }}>←</Text>
          </PressScale>
          <Text style={styles.headerTitle}>Mon compte</Text>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.sectionLabel}>Photo de profil</Text>
          <View style={[styles.card, styles.photoCard]}>
            <PressScale scaleTo={0.96} onPress={changePhoto} disabled={photoLoading} style={styles.photoWrap}>
              <ProfileAvatar emoji={profile.avatarEmoji} photoUrl={profile.avatarUrl} size={88} />
              <View style={styles.photoAdd}>
                <Text style={{ fontSize: 14, fontWeight: '900', color: colors.ink }}>+</Text>
              </View>
            </PressScale>
            <Text style={styles.hint}>Visible sur ton profil Moi et l&apos;écran de confirmation avant envoi.</Text>
            <GlowButton
              label={photoLoading ? '…' : profile.avatarUrl ? 'Changer la photo' : 'Ajouter une photo'}
              onPress={changePhoto}
              disabled={photoLoading}
            />
            {profile.avatarUrl ? (
              <PressScale scaleTo={0.95} onPress={removePhoto} style={{ alignSelf: 'center' }}>
                <Text style={styles.link}>Retirer la photo</Text>
              </PressScale>
            ) : null}
          </View>

          <Text style={styles.sectionLabel}>Profil public — ce que les autres voient</Text>
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>✨ Ce que tu fais en ce moment</Text>
            <TextInput
              style={styles.input}
              value={statusText}
              onChangeText={setStatusText}
              placeholder="En ataya à Médina…"
              placeholderTextColor={'rgba(5,8,5,0.4)'}
              maxLength={80}
            />
            <Text style={styles.fieldLabel}>🎵 Ta chanson du moment</Text>
            <TextInput
              style={styles.input}
              value={currentSong}
              onChangeText={setCurrentSong}
              placeholder="Titre — Artiste"
              placeholderTextColor={'rgba(5,8,5,0.4)'}
              maxLength={90}
            />
            <GlowButton
              label={publicSaving ? '…' : 'Enregistrer'}
              onPress={savePublicProfile}
              disabled={publicSaving}
            />

            <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>📸 Photos épinglées (max 3)</Text>
            <View style={styles.pinnedRow}>
              {pinnedPhotos.map((uri, ix) => (
                <PressScale key={ix} scaleTo={0.95} onPress={() => removePinnedPhoto(ix)} style={styles.pinnedSlot}>
                  <Image source={{ uri }} style={styles.pinnedImg} />
                  <View style={styles.pinnedRemove}>
                    <Text style={{ fontSize: 10, fontWeight: '900', color: colors.white }}>×</Text>
                  </View>
                </PressScale>
              ))}
              {pinnedPhotos.length < 3 ? (
                <PressScale scaleTo={0.95} onPress={addPinnedPhoto} style={[styles.pinnedSlot, styles.pinnedAdd]}>
                  <Text style={{ fontSize: 22, color: 'rgba(5,8,5,0.45)' }}>+</Text>
                </PressScale>
              ) : null}
            </View>
            <Text style={styles.hint}>
              Seuls ton nom, ton @handle, ton quartier et ces éléments sont visibles — jamais ton numéro, ton email ou ton solde.
            </Text>

            <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>🤔 Pose une question à tes amis</Text>
            <TextInput
              style={styles.input}
              value={pollQuestion}
              onChangeText={setPollQuestion}
              placeholder="Sortie samedi : on fait quoi ?"
              placeholderTextColor={'rgba(5,8,5,0.4)'}
              maxLength={120}
            />
            {pollOptions.map((opt, ix) => (
              <TextInput
                key={ix}
                style={styles.input}
                value={opt}
                onChangeText={(t) => setPollOptions((prev) => prev.map((o, i) => (i === ix ? t : o)))}
                placeholder={`Choix ${ix + 1}${ix > 1 ? ' (optionnel)' : ''}`}
                placeholderTextColor={'rgba(5,8,5,0.4)'}
                maxLength={40}
              />
            ))}
            <GlowButton
              tone="orange"
              label={pollSaving ? '…' : 'Publier le sondage →'}
              onPress={publishPoll}
              disabled={pollSaving}
            />
            <PressScale scaleTo={0.95} onPress={removePoll} style={{ alignSelf: 'center', marginTop: spacing.sm }}>
              <Text style={styles.link}>Fermer mon sondage actif</Text>
            </PressScale>
            <Text style={styles.hint}>Un seul sondage actif — en publier un nouveau ferme l’ancien.</Text>
          </View>

          <Text style={styles.sectionLabel}>Identité</Text>
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>Nom</Text>
            <Text style={styles.fieldValue}>{profile.name || '—'}</Text>
            <Text style={styles.fieldLabel}>@handle</Text>
            <Text style={styles.fieldValue}>@{String(profile.handle ?? '').replace(/^@+/, '') || '—'}</Text>
          </View>

          <Text style={styles.sectionLabel}>Téléphone</Text>
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>Numéro actuel</Text>
            <Text style={styles.fieldValue}>{formatPhoneDisplay(profile.phone)}</Text>
            <Text style={styles.hint}>
              Tu as changé de SIM ? Mets à jour ton numéro ici. On envoie un code au nouveau numéro pour confirmer.
            </Text>

            {phoneStep === 'idle' ? (
              <>
                <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>Nouveau numéro</Text>
                <View style={styles.phoneRow}>
                  <Text style={styles.dial}>{country?.dial ?? '+221'}</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="77 000 00 00"
                    placeholderTextColor={'rgba(5,8,5,0.4)'}
                    keyboardType="number-pad"
                    value={newPhone}
                    onChangeText={(v) => setNewPhone(v.replace(/[^0-9]/g, ''))}
                    maxLength={country?.code === 'US' ? 11 : 12}
                  />
                </View>
                <GlowButton
                  label={loading ? 'Envoi…' : 'Envoyer le code au nouveau numéro'}
                  onPress={requestPhoneChange}
                  disabled={loading || !newPhone}
                />
              </>
            ) : (
              <>
                <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>Code SMS · {pendingPhone}</Text>
                {devOtp ? (
                  <View style={styles.devOtp}>
                    <Text style={styles.devOtpLabel}>Code beta</Text>
                    <Text style={styles.devOtpCode}>{devOtp}</Text>
                  </View>
                ) : null}
                <TextInput
                  style={styles.input}
                  placeholder="000000"
                  placeholderTextColor={'rgba(5,8,5,0.4)'}
                  keyboardType="number-pad"
                  value={otp}
                  onChangeText={(v) => setOtp(v.replace(/[^0-9]/g, '').slice(0, 6))}
                  maxLength={6}
                />
                <GlowButton label={loading ? '…' : 'Confirmer le nouveau numéro'} onPress={confirmPhoneChange} disabled={loading} />
                <PressScale scaleTo={0.95} onPress={() => setPhoneStep('idle')} style={{ alignSelf: 'center', marginTop: spacing.md }}>
                  <Text style={styles.link}>Annuler</Text>
                </PressScale>
              </>
            )}
          </View>

          <Text style={styles.sectionLabel}>Email</Text>
          <View style={styles.card}>
            <Text style={styles.hint}>Utilise ton email pour te reconnecter si tu changes de numéro.</Text>
            <TextInput
              style={styles.input}
              placeholder="ton@email.com"
              placeholderTextColor={'rgba(5,8,5,0.4)'}
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={setEmail}
            />
            <GlowButton label={loading ? '…' : 'Enregistrer l\'email'} onPress={saveEmail} disabled={loading} />
          </View>

          <PrivacySettings />

          <Text style={styles.sectionLabel}>Solde par SMS</Text>
          <View style={styles.card}>
            <Text style={styles.hint}>
              Envoie <Text style={styles.bold}>SOLDE</Text> au numéro K21 pour voir ton solde — on ne t'envoie pas de SMS sauf si tu le demandes.
            </Text>
          </View>

          {loading ? <ActivityIndicator color={colors.green} style={{ marginTop: spacing.lg }} /> : null}
        </ScrollView>
      </SafeAreaView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingHorizontal: spacing.xxl, paddingVertical: spacing.lg },
  backBtn: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: colors.appCanvas.surface, borderWidth: 1, borderColor: colors.appCanvas.border, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontFamily: fontFamily.displayBold, fontSize: 16, color: colors.appCanvas.text },
  body: { padding: spacing.xxl, paddingBottom: spacing.giant, gap: spacing.md },
  sectionLabel: { ...appUi.sectionLabel, marginTop: spacing.md },
  card: { backgroundColor: colors.appCanvas.surface, borderWidth: 1, borderColor: colors.appCanvas.border, borderRadius: radius.xl, padding: spacing.xl, gap: spacing.sm },
  photoCard: { alignItems: 'center' },
  photoWrap: { position: 'relative', marginBottom: spacing.sm },
  photoAdd: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.green,
    borderWidth: 2,
    borderColor: colors.appCanvas.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldLabel: { fontSize: 10, color: colors.appCanvas.textFaint, fontWeight: '700' },
  fieldValue: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.appCanvas.text, marginBottom: spacing.sm },
  hint: { fontSize: 11, color: colors.appCanvas.textMuted, lineHeight: 16, marginBottom: spacing.sm },
  bold: { fontFamily: fontFamily.bodyBold, color: colors.greenDark },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  dial: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.appCanvas.text },
  pinnedRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm },
  pinnedSlot: { width: 72, height: 72, borderRadius: radius.lg, borderBottomRightRadius: 9, overflow: 'hidden', position: 'relative' },
  pinnedImg: { width: '100%', height: '100%' },
  pinnedRemove: { position: 'absolute', top: 3, right: 3, width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(5,8,5,0.65)', alignItems: 'center', justifyContent: 'center' },
  pinnedAdd: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: 'rgba(5,8,5,0.25)', backgroundColor: 'rgba(255,255,255,0.6)', alignItems: 'center', justifyContent: 'center' },
  input: {
    flex: 1,
    height: 48,
    borderRadius: radius.lg,
    backgroundColor: colors.appCanvas.surfaceStrong,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    paddingHorizontal: spacing.lg,
    fontSize: 15,
    color: colors.appCanvas.text,
    marginBottom: spacing.md,
  },
  devOtp: { backgroundColor: colors.orangeA10, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  devOtpLabel: { fontSize: 10, color: colors.orange, fontWeight: '700' },
  devOtpCode: { fontFamily: fontFamily.displayBlack, fontSize: 24, color: colors.orange, letterSpacing: 4 },
  link: { fontSize: 12, color: colors.greenDark, fontWeight: '700' },
});

/** J10: who can find me by phone number, and whether I appear in my neighbourhood (off by default). */
function PrivacySettings() {
  const showToast = useToast();
  const [st, setSt] = useState(null);
  useEffect(() => { getCommunitySettings().then(setSt).catch(() => {}); }, []);
  if (!st) return null;
  const save = async (patch) => {
    try {
      setSt(await saveCommunitySettings(patch));
      showToast('Confidentialité mise à jour');
    } catch (e) {
      showToast(e.message ?? 'Enregistrement impossible');
    }
  };
  const OPTIONS = [['everyone', 'Tout le monde'], ['connections', 'Mes contacts seulement'], ['nobody', 'Personne']];
  return (
    <>
      <Text style={styles.sectionLabel}>Confidentialité</Text>
      <View style={styles.card}>
        <Text style={styles.hint}>Qui peut me trouver avec mon numéro de téléphone ? (La recherche par @pseudo reste possible.)</Text>
        {OPTIONS.map(([v, label]) => (
          <PressScale key={v} onPress={() => save({ discoverableByPhone: v })} accessibilityLabel={`Me trouver par numéro : ${label}`}>
            <Text style={styles.hint}>{st.discoverableByPhone === v ? '● ' : '○ '}{label}</Text>
          </PressScale>
        ))}
        <PressScale onPress={() => save({ neighbourhoodVisible: !st.neighbourhoodVisible })} accessibilityLabel="Apparaître dans mon quartier">
          <Text style={styles.hint}>{st.neighbourhoodVisible ? '☑' : '☐'} Apparaître dans la liste « Mon quartier » (prénom et @pseudo seulement)</Text>
        </PressScale>
      </View>
    </>
  );
}
