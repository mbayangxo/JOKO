import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import StepTransition from '../components/StepTransition';
import Keypad from '../components/Keypad';
import ScreenHeader from '../components/ScreenHeader';
import AmountChips from '../components/AmountChips';
import ReceiptCard from '../components/ReceiptCard';
import ConfettiBurst from '../components/ConfettiBurst';
import StoryAvatar from '../components/StoryAvatar';
import { useAppState } from '../state/AppState';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import { useEntrance, useGlowPulse, usePopIn, useSuccessHaptic } from '../hooks/animations';
import ReceiptShareButtons from '../components/ReceiptShareButtons';
import UndoTransferBar from '../components/UndoTransferBar';
import { usePreferences } from '../context/PreferencesContext';
import { useScreenshotBlock } from '../hooks/useScreenshotBlock';
import { useToast } from '../components/Toast';
import ProfileAvatar from '../components/ProfileAvatar';
import StepUpOverlay from '../components/StepUpOverlay';
import { useMoneySubmit } from '../hooks/useMoneySubmit';
import { useSecurity } from '../context/SecurityContext';
import { useLocale } from '../context/LocaleContext';
import { transferSend, lookupUser, getMboloVideoUploadConfig } from '../lib/api-client';
import { toE164, isValidLocalPhone } from '../lib/phone';
import { resolveAccountQuery } from '../lib/k21-qr';
import { formatKori, KORI_SYMBOL } from '../lib/kori.js';
import KoriAmount from '../components/KoriAmount';
import { pickMboloImage, pickAndUploadMboloVideo, resolveGifMediaUrl } from '../lib/mbolo-media';
import { useMbooloVoiceRecorder } from '../hooks/useMbooloVoiceRecorder';
import { MBOLO_GIFS } from '../lib/mboolo-stickers';

const RECIPIENT_MODES = [
  { key: 'scan', icon: '📷', label: 'Scanner' },
  { key: 'handle', icon: '@', label: 'Handle' },
  { key: 'phone', icon: '📱', label: 'Numéro' },
];

// design/k21-remaining-flows.html, Flow 02 (Send Money) — three steps in one
// screen: amount entry -> confirm/safety -> success. The safety screen is
// the brief's §05 requirement (large photo, full name, phone, arrondissement,
// confirm/cancel) before any money moves.

const QUICK_AMOUNTS = [100, 500, 1000, 2500];

function formatPhoneDisplay(phone, masked = false) {
  if (!phone || String(phone).startsWith('e:')) return '';
  const d = String(phone).replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('221')) {
    if (masked) {
      return `+221 ${d.slice(3, 5)} *** ** ${d.slice(-2)}`;
    }
    return `+221 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`.trim();
  }
  return phone;
}

function displayHandle(handle) {
  const h = String(handle).replace(/^@/, '');
  return h ? `@${h}` : '';
}

function RecentRecipientChip({ item, onPress, delay }) {
  const entrance = useEntrance(delay, 350, 10);
  return (
    <Animated.View style={entrance}>
      <PressScale scaleTo={0.92} onPress={() => onPress(item)} style={styles.recentChip}>
        <StoryAvatar initial={item.name?.[0]?.toUpperCase() ?? '?'} size={52} spin={false} />
        <Text style={styles.recentChipName} numberOfLines={1}>{item.name?.split(' ')[0] ?? item.handle}</Text>
      </PressScale>
    </Animated.View>
  );
}

function AmountStep({
  amount,
  setAmount,
  reason,
  setReason,
  recipientMode,
  setRecipientMode,
  countryDial,
  recipientQuery,
  setRecipientQuery,
  recipientProfile,
  lookupLoading,
  lookupError,
  recentRecipients,
  onPickRecent,
  onContinue,
  onBack,
  onScan,
  reduceMotion,
  attachmentType,
  attachmentUrl,
  attaching,
  isRecording,
  isVoiceReady,
  onAttachPhoto,
  onAttachVideo,
  onAttachVoice,
  onAttachGif,
  onRemoveAttachment,
}) {
  const popIn = usePopIn(0, 400, 0.8);
  const heroGlow = useGlowPulse(3200, 0.35);
  const recipientEntrance = useEntrance(80, 400, 12);
  const reasonEntrance = useEntrance(160, 400, 12);
  const pressDigit = (d) => setAmount((prev) => Math.min(999999, Number(`${prev === 0 ? '' : prev}${d}`)));
  const pressBackspace = () => setAmount((prev) => Math.floor(prev / 10));

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View style={styles.sendHero}>
          <ScreenHeader onBack={onBack} title="Envoyer" style={styles.shTop} />

          <View style={styles.amountHero}>
            <Animated.View style={[styles.amountGlow, { opacity: heroGlow }]}>
              <Svg width="100%" height="100%" viewBox="0 0 100 100">
                <Defs>
                  <RadialGradient id="sendGlow" cx="50%" cy="50%" r="50%">
                    <Stop offset="0%" stopColor={colors.green} stopOpacity={0.5} />
                    <Stop offset="100%" stopColor={colors.green} stopOpacity={0} />
                  </RadialGradient>
                </Defs>
                <Rect width="100" height="100" fill="url(#sendGlow)" />
              </Svg>
            </Animated.View>
            <Text style={styles.ahLbl}>Combien ?</Text>
            <Animated.View style={[popIn, styles.ahRow]}>
              <KoriAmount value={amount} textStyle={styles.ahNum} />
            </Animated.View>
          </View>

          <AmountChips options={QUICK_AMOUNTS} value={amount} onChange={setAmount} style={styles.quickRow} />

          <View style={styles.keypadWrap}>
            <Keypad onDigit={pressDigit} onBackspace={pressBackspace} />
          </View>
        </View>

        <Animated.View style={[styles.recipientSection, recipientEntrance]}>
          <Text style={styles.lbl}>À qui ?</Text>

          {recentRecipients.length > 0 && !recipientQuery ? (
            <>
              <Text style={styles.recentLbl}>Envoyé récemment</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentRow}>
                {recentRecipients.map((r, i) => (
                  <RecentRecipientChip key={r.handle} item={r} onPress={onPickRecent} delay={i * 40} />
                ))}
              </ScrollView>
            </>
          ) : null}

          <View style={styles.modeRow}>
            {RECIPIENT_MODES.map((m) => (
              <PressScale
                key={m.key}
                scaleTo={0.96}
                onPress={() => setRecipientMode(m.key)}
                style={[styles.modePill, recipientMode === m.key && styles.modePillOn]}
              >
                <Text style={styles.modePillIcon}>{m.icon}</Text>
                <Text style={[styles.modePillText, recipientMode === m.key && styles.modePillTextOn]}>{m.label}</Text>
              </PressScale>
            ))}
          </View>

          {recipientMode === 'scan' ? (
            <>
              <PressScale scaleTo={0.98} onPress={onScan} style={styles.scanCard}>
                <Text style={styles.scanCardIcon}>📷</Text>
                <Text style={styles.scanCardTitle}>Scanner un QR K21</Text>
                <Text style={styles.scanCardSub}>Pointe la caméra vers le code de ton ami ou marchand</Text>
              </PressScale>
              <Text style={styles.orLabel}>ou colle un lien / @handle</Text>
              <View style={styles.recCard}>
                <View style={styles.recAva}>
                  <Text style={{ fontSize: 20 }}>{recipientProfile?.avatarEmoji ?? '🧑🏾'}</Text>
                </View>
                <TextInput
                  style={styles.handleField}
                  placeholder="k21://pay/@fatou ou @fatou"
                  placeholderTextColor={'rgba(5,8,5,0.4)'}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={recipientQuery}
                  onChangeText={setRecipientQuery}
                />
                {lookupLoading && <ActivityIndicator size="small" color={colors.green} />}
              </View>
            </>
          ) : recipientMode === 'phone' ? (
            <View style={styles.recCard}>
              <View style={styles.dialBadge}>
                <Text style={styles.dialBadgeText}>{countryDial}</Text>
              </View>
              <TextInput
                style={styles.handleField}
                placeholder="77 000 00 00"
                placeholderTextColor={'rgba(5,8,5,0.4)'}
                keyboardType="phone-pad"
                value={recipientQuery}
                onChangeText={setRecipientQuery}
              />
              {lookupLoading && <ActivityIndicator size="small" color={colors.green} />}
            </View>
          ) : (
            <View style={styles.recCard}>
              <View style={styles.recAva}>
                <Text style={{ fontSize: 20 }}>{recipientProfile?.avatarEmoji ?? '🧑🏾'}</Text>
              </View>
              <TextInput
                style={styles.handleField}
                placeholder="@handle"
                placeholderTextColor={'rgba(5,8,5,0.4)'}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="default"
                value={recipientQuery}
                onChangeText={setRecipientQuery}
              />
              {lookupLoading && <ActivityIndicator size="small" color={colors.green} />}
            </View>
          )}
          {recipientProfile && (
            <View style={styles.recipientPreview}>
              <Text style={styles.recipientPreviewName}>{recipientProfile.name}</Text>
              <Text style={styles.recipientPreviewMeta}>
                {displayHandle(recipientProfile.handle)}
                {recipientProfile.arrondissement?.name ? ` · ${recipientProfile.arrondissement.icon} ${recipientProfile.arrondissement.name}` : ''}
              </Text>
              <Text style={styles.recipientPreviewPhone}>{formatPhoneDisplay(recipientProfile.phone)}</Text>
            </View>
          )}
          {lookupError && !lookupLoading && recipientQuery.length >= 3 && (
            <Text style={styles.lookupError}>{lookupError}</Text>
          )}
        </Animated.View>

        <Animated.View style={[styles.reasonWrap, reasonEntrance]}>
          <Text style={styles.lbl}>Pour quoi ? (optionnel)</Text>
          <TextInput
            style={styles.reasonField}
            placeholder="Pour le taxi, pour manger..."
            placeholderTextColor={'rgba(5,8,5,0.4)'}
            value={reason}
            onChangeText={setReason}
          />

          <Text style={[styles.lbl, { marginTop: spacing.lg }]}>Joindre (optionnel)</Text>
          {attachmentType ? (
            <View style={styles.attachPreview}>
              {attachmentType === 'photo' || attachmentType === 'gif' ? (
                <Image source={{ uri: attachmentUrl }} style={styles.attachThumb} />
              ) : (
                <View style={[styles.attachThumb, styles.attachThumbIcon]}>
                  <Text style={{ fontSize: 18 }}>{attachmentType === 'video' ? '🎬' : '🎤'}</Text>
                </View>
              )}
              <Text style={styles.attachLabel}>
                {attachmentType === 'photo' && 'Photo jointe'}
                {attachmentType === 'gif' && 'GIF joint'}
                {attachmentType === 'video' && 'Vidéo jointe'}
                {attachmentType === 'voice' && 'Message vocal joint'}
              </Text>
              <PressScale scaleTo={0.9} onPress={onRemoveAttachment} style={styles.attachRemove}>
                <Text style={{ fontSize: 12, color: colors.terracotta }}>✕</Text>
              </PressScale>
            </View>
          ) : (
            <View style={styles.attachRow}>
              <PressScale scaleTo={0.95} onPress={onAttachPhoto} style={styles.attachBtn} disabled={attaching}>
                <Text style={{ fontSize: 16 }}>📷</Text>
              </PressScale>
              <PressScale scaleTo={0.95} onPress={onAttachVideo} style={styles.attachBtn} disabled={attaching}>
                <Text style={{ fontSize: 16 }}>🎬</Text>
              </PressScale>
              <PressScale
                scaleTo={0.95}
                onPress={onAttachVoice}
                style={[styles.attachBtn, isRecording && styles.attachBtnActive]}
                disabled={attaching && !isRecording && !isVoiceReady}
              >
                <Text style={{ fontSize: 16 }}>{isRecording ? '⏹' : '🎤'}</Text>
              </PressScale>
              <PressScale scaleTo={0.95} onPress={onAttachGif} style={styles.attachBtn} disabled={attaching}>
                <Text style={{ fontSize: 16 }}>GIF</Text>
              </PressScale>
              {attaching ? <ActivityIndicator size="small" color={colors.green} /> : null}
            </View>
          )}
        </Animated.View>

        <View style={{ paddingHorizontal: spacing.huge, paddingBottom: spacing.giant }}>
          <GlowButton
            label="Continuer →"
            onPress={onContinue}
            disabled={!recipientProfile || amount <= 0 || lookupLoading}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function ConfirmStep({ amount, reason, balance, recipientProfile, onConfirm, onCancel, submitting }) {
  const solde = balance - amount;
  const label = recipientProfile?.name || displayHandle(recipientProfile?.handle);
  const arrLabel = recipientProfile?.arrondissement?.name
    ? `${recipientProfile.arrondissement.icon ?? '📍'} ${recipientProfile.arrondissement.name}${recipientProfile?.verified ? ' · Vérifiée K21' : ''}`
    : recipientProfile?.verified
      ? 'Vérifiée K21'
      : null;

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.csHero}>
        <View style={styles.csAva}>
          <ProfileAvatar
            photoUrl={recipientProfile?.avatarUrl}
            initial={label[0]?.toUpperCase() ?? '?'}
            size={64}
            textStyle={{ fontSize: 28 }}
          />
        </View>
        <Text style={styles.csName}>{recipientProfile?.name}</Text>
        <Text style={styles.csHandle}>{displayHandle(recipientProfile?.handle)}</Text>
        <Text style={styles.csPhone}>{formatPhoneDisplay(recipientProfile?.phone, true)}</Text>
        {arrLabel ? <Text style={styles.csArr}>{arrLabel}</Text> : null}
        <KoriAmount value={amount} textStyle={styles.csAmount} style={{ justifyContent: 'center' }} />
        <View style={styles.csFree}>
          <Text style={styles.csFreeText}>✦ Zéro frais{reason ? ` · ${reason}` : ''}</Text>
        </View>

        <View style={styles.csConfirmPhoto}>
          <Text style={{ fontSize: 18 }}>🔒</Text>
          <Text style={styles.cspText}>
            <Text style={{ fontFamily: fontFamily.bodyBold, color: 'rgba(5,8,5,0.8)' }}>Oui c'est bien {recipientProfile?.name} ?</Text>
            {'\n'}
            Vérifie le nom, le numéro et l'arrondissement avant d'envoyer.
          </Text>
        </View>
      </View>

      <View style={styles.csBody}>
        <View style={styles.csRow}>
          <Text style={styles.csrL}>Destinataire</Text>
          <Text style={styles.csrR}>{recipientProfile?.name}</Text>
        </View>
        <View style={styles.csRow}>
          <Text style={styles.csrL}>Téléphone</Text>
          <Text style={styles.csrR}>{formatPhoneDisplay(recipientProfile?.phone)}</Text>
        </View>
        <View style={styles.csRow}>
          <Text style={styles.csrL}>Montant</Text>
          <KoriAmount value={amount} textStyle={[styles.csrR, { color: colors.green }]} />
        </View>
        <View style={styles.csRow}>
          <Text style={styles.csrL}>Frais</Text>
          <Text style={[styles.csrR, { color: colors.green }]}>₭0 ✦</Text>
        </View>
        <View style={[styles.csRow, { borderBottomWidth: 0 }]}>
          <Text style={styles.csrL}>Solde après</Text>
          <KoriAmount value={solde} textStyle={[styles.csrR, { color: 'rgba(5,8,5,0.6)' }]} />
        </View>
      </View>

      <View style={styles.csActions}>
        <GlowButton label={submitting ? 'Envoi…' : `Oui — Envoyer ${formatKori(amount)} →`} onPress={onConfirm} disabled={submitting} />
        <PressScale scaleTo={0.96} onPress={onCancel} disabled={submitting}>
          <Text style={styles.csNo}>Ce n'est pas la bonne personne</Text>
        </PressScale>
      </View>
    </View>
  );
}

function SuccessStep({ amount, reason, reference, recipientProfile, onDone, onMarkedUndone, onShareMbolo, undone }) {
  useSuccessHaptic();
  const ring = usePopIn(0, 500, 0.3);
  const title = useEntrance(200, 500, 10);
  const sub = useEntrance(300, 500, 10);
  const receipt = useEntrance(400, 500, 10);
  const bonus = useEntrance(500, 500, 10);
  const label = recipientProfile?.name || displayHandle(recipientProfile?.handle);

  return (
    <View style={styles.successRoot}>
      {!undone ? <ConfettiBurst /> : null}
      <View style={styles.successContent}>
        <Animated.View style={[styles.ssRing, ring]}>
          <Text style={{ fontSize: 38, color: colors.green }}>{undone ? '↩' : '✓'}</Text>
        </Animated.View>
        <Animated.Text style={[styles.ssTitle, title]}>{undone ? 'Annulé' : 'Envoyé !'}</Animated.Text>
        <Animated.Text style={[styles.ssSub, sub]}>
          {undone
            ? 'L\'argent est revenu sur ton compte.'
            : `${label} a reçu ton argent\nen quelques secondes.`}
        </Animated.Text>

        {!undone && (
          <UndoTransferBar reference={reference} amount={amount} onUndone={onMarkedUndone} />
        )}

        <Animated.View style={receipt}>
          <ReceiptCard
            style={{ marginBottom: spacing.lg }}
            rows={[
              { key: 'to', label: 'À', value: label },
              { key: 'amount', label: 'Montant', kori: amount, color: colors.green },
              { key: 'fee', label: 'Frais', value: '₭0 ✦', color: colors.green },
              { key: 'reason', label: 'Motif', value: reason || '—' },
              { key: 'ref', label: 'Référence', value: reference, small: true },
            ]}
          />
          {!undone && (
            <ReceiptShareButtons
              amount={amount}
              counterparty={label}
              reference={reference}
              note={reason}
              onShareMbolo={onShareMbolo}
              style={{ marginBottom: spacing.lg }}
            />
          )}
        </Animated.View>

        {!undone && (
          <Animated.View style={[styles.wakhnaBonus, bonus]}>
            <Text style={{ fontSize: 16 }}>✦</Text>
            <Text style={styles.wbText}>
              <Text style={{ fontFamily: fontFamily.bodyBold, color: colors.green }}>+10 Ngor</Text> pour cet envoi
            </Text>
          </Animated.View>
        )}

        <GlowButton label={undone ? 'Retour à l\'accueil' : 'Terminer'} onPress={onDone} />
      </View>
    </View>
  );
}

export default function SendMoneyScreen({ navigation, route }) {
  useScreenshotBlock(true);
  const security = useSecurity();
  const { reduceMotion } = usePreferences();
  const { country } = useLocale();
  const showToast = useToast();
  const [step, setStep] = useState('amount');
  const [amount, setAmount] = useState(route.params?.prefilledAmount ?? 5000);
  const [reason, setReason] = useState(route.params?.note ?? '');
  const [recipientMode, setRecipientMode] = useState(route.params?.recipientHandle ? 'handle' : 'handle');
  const [recipientQuery, setRecipientQuery] = useState(route.params?.recipientHandle ?? '');
  const [recipientProfile, setRecipientProfile] = useState(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [reference, setReference] = useState('');
  const [undone, setUndone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stepUpVisible, setStepUpVisible] = useState(false);
  const moneySubmit = useMoneySubmit();
  const [attachmentType, setAttachmentType] = useState(null);
  const [attachmentUrl, setAttachmentUrl] = useState(null);
  const [attaching, setAttaching] = useState(false);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const lookupTimer = useRef(null);
  const { balance, refreshWallet, setPendingMboloShare, transactions } = useAppState();
  const countryDial = country?.dial ?? '+221';
  const voiceRecorder = useMbooloVoiceRecorder();

  const removeAttachment = () => {
    setAttachmentType(null);
    setAttachmentUrl(null);
  };

  const attachPhoto = async () => {
    setAttaching(true);
    try {
      const url = await pickMboloImage();
      if (url) {
        setAttachmentType('photo');
        setAttachmentUrl(url);
      }
    } catch (err) {
      showToast(err.message ?? 'Photo impossible');
    } finally {
      setAttaching(false);
    }
  };

  const attachVideo = async () => {
    setAttaching(true);
    try {
      const config = await getMboloVideoUploadConfig();
      const url = await pickAndUploadMboloVideo(config);
      if (url) {
        setAttachmentType('video');
        setAttachmentUrl(url);
      }
    } catch (err) {
      showToast(err.message ?? 'Vidéo impossible');
    } finally {
      setAttaching(false);
    }
  };

  const attachVoice = async () => {
    if (voiceRecorder.isRecording || voiceRecorder.isReady) {
      setAttaching(true);
      try {
        const url = await voiceRecorder.stop();
        if (url) {
          setAttachmentType('voice');
          setAttachmentUrl(url);
        }
      } catch (err) {
        showToast(err.message ?? 'Enregistrement impossible');
      } finally {
        setAttaching(false);
      }
      return;
    }
    try {
      await voiceRecorder.start();
      showToast('🎤 Enregistrement démarré — appuie à nouveau pour envoyer');
    } catch (err) {
      showToast(err.message ?? 'Micro indisponible');
    }
  };

  const attachGif = (gif) => {
    setGifPickerOpen(false);
    setAttaching(true);
    resolveGifMediaUrl(gif.url)
      .then((url) => {
        setAttachmentType('gif');
        setAttachmentUrl(url);
      })
      .catch((err) => showToast(err.message ?? 'GIF impossible'))
      .finally(() => setAttaching(false));
  };

  const recentRecipients = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const tx of transactions ?? []) {
      if (tx.type !== 'send' || !tx.counterpartyHandle) continue;
      const handle = tx.counterpartyHandle.replace(/^@/, '');
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      list.push({ handle, name: tx.counterpartyName || handle });
      if (list.length >= 8) break;
    }
    return list;
  }, [transactions]);

  const pickRecentRecipient = (item) => {
    setRecipientMode('handle');
    setRecipientQuery(item.handle);
    setLookupError('');
  };

  const runLookup = useCallback(
    async (q, mode) => {
      const trimmed = String(q).trim();
      if (trimmed.length < 3) {
        setRecipientProfile(null);
        setLookupError('');
        return;
      }
      if (mode === 'phone' && !isValidLocalPhone(country, trimmed)) {
        setRecipientProfile(null);
        setLookupError('');
        return;
      }
      setLookupLoading(true);
      setLookupError('');
      try {
        const query =
          mode === 'phone'
            ? toE164(country, trimmed)
            : resolveAccountQuery(trimmed).replace(/^@/, '');
        const profile = await lookupUser(query);
        setRecipientProfile(profile);
      } catch (err) {
        setRecipientProfile(null);
        setLookupError(err.message ?? 'Personne introuvable');
      } finally {
        setLookupLoading(false);
      }
    },
    [country],
  );

  useEffect(() => {
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    lookupTimer.current = setTimeout(() => runLookup(recipientQuery, recipientMode), 400);
    return () => {
      if (lookupTimer.current) clearTimeout(lookupTimer.current);
    };
  }, [recipientQuery, recipientMode, runLookup]);

  const changeRecipientMode = (mode) => {
    setRecipientMode(mode);
    setRecipientQuery('');
    setRecipientProfile(null);
    setLookupError('');
  };

  const executeSend = async (stepUpToken) => {
    if (!recipientProfile?.handle) return;
    if (moneySubmit.busy) return; // a payment is in flight or being checked: never fire a second one
    setSubmitting(true);
    try {
      const attachmentParams =
        attachmentType === 'photo'
          ? { photoUrl: attachmentUrl }
          : attachmentType === 'video'
            ? { videoUrl: attachmentUrl }
            : attachmentType === 'voice'
              ? { voiceNoteUrl: attachmentUrl }
              : attachmentType === 'gif'
                ? { gifUrl: attachmentUrl }
                : {};
      // J4: one intent key for this payment attempt, reused across step-up
      // and retries; an unknown outcome is checked with the server, never re-sent.
      const out = await moneySubmit.submit((intentKey) =>
        transferSend({
          recipientHandle: recipientProfile.handle,
          amount,
          note: reason,
          ...attachmentParams,
          stepUpToken: stepUpToken ?? security.stepUpToken,
          intentKey,
        }),
      );
      if (out.state === 'needs_pin') {
        setStepUpVisible(true);
        return;
      }
      if (out.state === 'done' || out.state === 'accepted_pending') {
        setReference(out.response?.reference ?? out.references?.[0] ?? out.error?.data?.references?.[0] ?? null);
        setUndone(false);
        removeAttachment();
        await refreshWallet();
        setStep('success');
        if (out.state === 'accepted_pending') showToast(out.message);
        return;
      }
      showToast(out.message ?? 'Envoi impossible');
    } finally {
      setSubmitting(false);
    }
  };

  const confirm = () => executeSend();

  const handleStepUpVerified = (token) => {
    setStepUpVisible(false);
    executeSend(token);
  };

  const handleUndone = async () => {
    setUndone(true);
    await refreshWallet();
  };

  const shareMbolo = (text) => {
    setPendingMboloShare(text);
    navigation.navigate('Main', { screen: 'MbooloTab' });
  };

  const finish = () => {
    setStep('amount');
    setAmount(5000);
    setReason('');
    setRecipientQuery('');
    setRecipientProfile(null);
    setUndone(false);
    removeAttachment();
    navigation.goBack();
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {step === 'amount' && (
          <StepTransition>
            <AmountStep
              amount={amount}
              setAmount={setAmount}
              reason={reason}
              setReason={setReason}
              recipientMode={recipientMode}
              setRecipientMode={changeRecipientMode}
              countryDial={countryDial}
              recipientQuery={recipientQuery}
              setRecipientQuery={setRecipientQuery}
              recipientProfile={recipientProfile}
              lookupLoading={lookupLoading}
              lookupError={lookupError}
              recentRecipients={recentRecipients}
              onPickRecent={pickRecentRecipient}
              onContinue={() => setStep('confirm')}
              onBack={() => navigation.goBack()}
              onScan={() => navigation.navigate('QrScan', { prefilledAmount: amount, note: reason })}
              reduceMotion={reduceMotion}
              attachmentType={attachmentType}
              attachmentUrl={attachmentUrl}
              attaching={attaching}
              isRecording={voiceRecorder.isRecording}
              isVoiceReady={voiceRecorder.isReady}
              onAttachPhoto={attachPhoto}
              onAttachVideo={attachVideo}
              onAttachVoice={attachVoice}
              onAttachGif={() => setGifPickerOpen(true)}
              onRemoveAttachment={removeAttachment}
            />
          </StepTransition>
        )}
        {step === 'confirm' && (
          <StepTransition>
            <ConfirmStep
              amount={amount}
              reason={reason}
              balance={balance}
              recipientProfile={recipientProfile}
              onConfirm={confirm}
              onCancel={() => setStep('amount')}
              submitting={submitting}
            />
          </StepTransition>
        )}
        {step === 'success' && (
          <StepTransition>
            <SuccessStep
              amount={amount}
              reason={reason}
              reference={reference}
              recipientProfile={recipientProfile}
              onDone={finish}
              onMarkedUndone={handleUndone}
              onShareMbolo={shareMbolo}
              undone={undone}
            />
          </StepTransition>
        )}
      </SafeAreaView>
      <StepUpOverlay visible={stepUpVisible} onCancel={() => setStepUpVisible(false)} onVerified={handleStepUpVerified} />
      <Modal visible={gifPickerOpen} animationType="slide" transparent onRequestClose={() => setGifPickerOpen(false)}>
        <View style={styles.gifBackdrop}>
          <View style={styles.gifSheet}>
            <Text style={styles.gifSheetTitle}>Choisir un GIF</Text>
            <ScrollView contentContainerStyle={styles.gifGrid}>
              {MBOLO_GIFS.map((gif) => (
                <PressScale key={gif.id} scaleTo={0.95} onPress={() => attachGif(gif)} style={styles.gifCard}>
                  <Image source={{ uri: gif.url }} style={styles.gifCardImage} resizeMode="cover" />
                  <Text style={styles.gifCardLabel}>{gif.label}</Text>
                </PressScale>
              ))}
            </ScrollView>
            <PressScale scaleTo={0.96} onPress={() => setGifPickerOpen(false)} style={{ alignSelf: 'center', marginTop: spacing.sm }}>
              <Text style={{ color: 'rgba(5,8,5,0.5)', fontSize: 12 }}>Fermer</Text>
            </PressScale>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },

  // Amount step
  sendHero: { paddingHorizontal: spacing.huge, paddingTop: spacing.xxl, paddingBottom: spacing.huge, position: 'relative', overflow: 'hidden' },
  shTop: { marginBottom: spacing.giant },

  amountHero: { alignItems: 'center' },
  amountGlow: {
    position: 'absolute', top: -10, width: 200, height: 90, borderRadius: 90,
    backgroundColor: colors.green, alignSelf: 'center',
  },
  ahLbl: { fontFamily: fontFamily.bodyBold, fontSize: 9, letterSpacing: 1.5, color: 'rgba(26,240,96,0.6)', textTransform: 'uppercase', marginBottom: spacing.lg },
  ahRow: { flexDirection: 'row', alignItems: 'center' },
  ahNum: { fontFamily: fontFamily.displayBlack, fontSize: 52, letterSpacing: -3, lineHeight: 52, color: colors.green },
  ahCurr: { fontFamily: fontFamily.bodyRegular, fontSize: 16, fontWeight: '400', color: 'rgba(26,240,96,0.4)' },
  keypadWrap: { marginTop: spacing.xxl },

  quickRow: { justifyContent: 'center', marginTop: spacing.xl },

  recipientSection: { paddingHorizontal: spacing.huge, paddingVertical: spacing.xxl },
  recentLbl: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: 'rgba(5,8,5,0.4)', marginTop: spacing.md, marginBottom: spacing.sm },
  recentRow: { gap: spacing.lg, paddingBottom: spacing.md, paddingRight: spacing.lg },
  recentChip: { alignItems: 'center', width: 60, gap: spacing.xs },
  recentChipName: { fontSize: 10, fontFamily: fontFamily.bodyBold, color: colors.ink },
  modeRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.lg },
  modePill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1.5,
    borderColor: 'rgba(5,8,5,0.12)',
    gap: 2,
  },
  modePillOn: { backgroundColor: colors.greenA08, borderColor: colors.greenA30 },
  modePillIcon: { fontSize: 16 },
  modePillText: { fontFamily: fontFamily.bodyBold, fontSize: 10, color: 'rgba(5,8,5,0.5)' },
  modePillTextOn: { color: colors.green },
  scanCard: {
    backgroundColor: colors.greenA08,
    borderWidth: 1.5,
    borderColor: colors.greenA25,
    borderRadius: radius.xxl,
    padding: spacing.xxl,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  scanCardIcon: { fontSize: 32, marginBottom: spacing.sm },
  scanCardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink, marginBottom: 4 },
  scanCardSub: { fontSize: 11, color: 'rgba(5,8,5,0.5)', textAlign: 'center', lineHeight: 16 },
  orLabel: { fontSize: 10, color: 'rgba(5,8,5,0.4)', textAlign: 'center', marginBottom: spacing.sm, fontWeight: '700' },
  dialBadge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.12)',
  },
  dialBadgeText: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  lbl: { ...type.eyebrow, color: 'rgba(5,8,5,0.4)' },
  recCard: { backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.12)', borderRadius: radius.xxl, padding: spacing.xxl, flexDirection: 'row', alignItems: 'center', gap: spacing.xl, marginTop: spacing.sm },
  handleField: { flex: 1, fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  recAva: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(26,240,96,0.1)', borderWidth: 2, borderColor: colors.greenA25, alignItems: 'center', justifyContent: 'center' },
  recName: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  recHandle: { fontFamily: fontFamily.bodyRegular, fontSize: 11, color: colors.green },
  recipientPreview: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.greenA08,
    borderWidth: 1,
    borderColor: colors.greenA18,
  },
  recipientPreviewName: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  recipientPreviewMeta: { fontSize: 11, color: 'rgba(5,8,5,0.6)', marginTop: 2 },
  recipientPreviewPhone: { fontSize: 11, color: colors.green, marginTop: 4, fontFamily: fontFamily.bodyBold },
  lookupError: { fontSize: 11, color: colors.terracotta, marginTop: spacing.sm },
  recArr: { fontSize: 11, color: 'rgba(5,8,5,0.5)' },

  reasonWrap: { paddingHorizontal: spacing.huge, paddingBottom: spacing.xxl },
  reasonField: { width: '100%', height: 48, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.12)', paddingHorizontal: spacing.xxxl, fontFamily: fontFamily.bodyRegular, fontSize: 13, color: colors.ink, marginTop: spacing.sm },
  attachRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginTop: spacing.sm },
  attachBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1.5,
    borderColor: 'rgba(5,8,5,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachBtnActive: { backgroundColor: colors.greenA08, borderColor: colors.green },
  attachPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.greenA08,
    borderWidth: 1,
    borderColor: colors.greenA18,
  },
  attachThumb: { width: 40, height: 40, borderRadius: radius.md },
  attachThumbIcon: { backgroundColor: 'rgba(255,255,255,0.7)', alignItems: 'center', justifyContent: 'center' },
  attachLabel: { flex: 1, fontSize: 12, fontFamily: fontFamily.bodySemiBold, color: colors.ink },
  attachRemove: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  gifBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  gifSheet: {
    backgroundColor: '#f2f8ec',
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.huge,
    maxHeight: '70%',
  },
  gifSheetTitle: { fontFamily: fontFamily.displayBold, fontSize: 15, color: colors.ink, marginBottom: spacing.md },
  gifGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  gifCard: { width: 96, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#fff', borderWidth: 1.5, borderColor: 'rgba(5,8,5,0.1)' },
  gifCardImage: { width: 96, height: 72 },
  gifCardLabel: { fontSize: 10, color: colors.ink, padding: 6, textAlign: 'center' },

  contactItem: { alignItems: 'center', gap: spacing.xs },
  contactAva: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  contactLabel: { fontFamily: fontFamily.bodyBold, fontSize: 9, color: 'rgba(5,8,5,0.5)' },


  // Confirm step
  csHero: { paddingHorizontal: spacing.giant, paddingTop: spacing.giant + 4, paddingBottom: spacing.giant, alignItems: 'center', position: 'relative', overflow: 'hidden', borderBottomWidth: 1, borderBottomColor: colors.greenA12 },
  csAva: { width: 68, height: 68, borderRadius: 34, borderWidth: 3, borderColor: colors.greenA30, backgroundColor: 'rgba(255,255,255,0.72)', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg },
  csName: { fontFamily: fontFamily.displayBlack, fontSize: 15, color: colors.ink },
  csHandle: { fontFamily: fontFamily.bodyRegular, fontSize: 11, color: colors.green, marginBottom: 2 },
  csPhone: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: 'rgba(5,8,5,0.7)', marginBottom: 2 },
  csArr: { fontSize: 11, color: 'rgba(5,8,5,0.5)', marginBottom: spacing.md },
  csArr: { fontSize: 11, color: 'rgba(5,8,5,0.45)' },
  csAmount: { fontFamily: fontFamily.displayBlack, fontSize: 54, letterSpacing: -3, lineHeight: 54, color: colors.green, marginTop: spacing.xxl, marginBottom: spacing.xs },
  csFree: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.greenA08, borderWidth: 1, borderColor: colors.greenA20, borderRadius: radius.round, paddingHorizontal: spacing.xl, paddingVertical: spacing.xs, marginTop: spacing.sm },
  csFreeText: { fontFamily: fontFamily.bodyBold, fontSize: 10, color: 'rgba(26,240,96,0.8)' },
  csConfirmPhoto: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.greenA06, borderWidth: 1, borderColor: colors.greenA15, borderRadius: radius.lg, paddingHorizontal: spacing.xxl, paddingVertical: spacing.lg, marginTop: spacing.xxl, width: '100%' },
  cspText: { flex: 1, fontFamily: fontFamily.bodyRegular, fontSize: 11, color: 'rgba(5,8,5,0.6)', lineHeight: 16.5 },

  csBody: { paddingHorizontal: spacing.huge, paddingVertical: spacing.xxl },
  csRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: 'rgba(5,8,5,0.07)' },
  csrL: { fontSize: 11, color: 'rgba(5,8,5,0.45)' },
  csrR: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.ink },

  csActions: { paddingHorizontal: spacing.huge, paddingBottom: spacing.giant, paddingTop: spacing.lg, gap: spacing.md, marginTop: 'auto' },
  csNo: { textAlign: 'center', fontSize: 11, color: colors.terracotta, fontFamily: fontFamily.bodySemiBold },

  // Success step
  successRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl + 14 },
  successContent: { alignItems: 'center', width: '100%' },
  ssRing: { width: 90, height: 90, borderRadius: 45, backgroundColor: colors.greenA08, borderWidth: 3, borderColor: colors.green, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xxxl, shadowColor: colors.green, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.2, shadowRadius: 50, elevation: 8 },
  ssTitle: { fontFamily: fontFamily.displayBlack, fontSize: 24, letterSpacing: -0.8, color: colors.ink, marginBottom: spacing.md, textAlign: 'center' },
  ssSub: { fontSize: 12, color: 'rgba(5,8,5,0.5)', marginBottom: spacing.giant + 2, lineHeight: 20.4, textAlign: 'center' },
  wakhnaBonus: { backgroundColor: colors.greenA05, borderWidth: 1, borderColor: colors.greenA15, borderRadius: radius.md, paddingHorizontal: spacing.xl, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.xxxl, alignSelf: 'stretch' },
  wbText: { fontSize: 11, color: 'rgba(5,8,5,0.5)' },
});
