import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';
import PressScale from '../components/PressScale';
import MbooloAttachSheet from '../components/MbooloAttachSheet';
import MbooloLazyMedia from '../components/MbooloLazyMedia';
import MbooloSaveSheet from '../components/MbooloSaveSheet';
import VoiceWaveform from '../components/VoiceWaveform';
import { colors, fontFamily, radius, spacing } from '../theme';
import { useToast } from '../components/Toast';
import { useAppState } from '../state/AppState';
import { usePreferences } from '../context/PreferencesContext';
import {
  getMe,
  getMboloMessages,
  getMboloThreadPresence,
  markMboloThreadTyping,
  markMboloThreadRead,
  saveMboloMessageMedia,
  sendMboloMessage,
  transferRequest,
  transferSend,
  reportMboloMessage,
} from '../lib/api-client';
import {
  pickMboloImage,
  takeMboloPhoto,
  pickMboloVideoAsset,
  sendMboloMediaMessage,
  resolveVoicePlaybackSource,
} from '../lib/mbolo-media';
import { parseMoneyCommand } from '../lib/mbolo-voice-money';
import { flushMboloOutbox, enqueueMboloMessage } from '../lib/mbolo-outbox';
import { runTerangaGifStudio } from '../lib/mbolo-gif-studio';
import { formatXof, getDirectPartner } from '../lib/mbolo-social';
import { useMbooloVoiceRecorder, formatVoiceDuration } from '../hooks/useMbooloVoiceRecorder';
import { navigateFromRoot } from '../lib/root-navigation';
import { useBlink } from '../hooks/animations';

function VideoMessage({ uri }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  return (
    <VideoView
      player={player}
      style={styles.msgVideo}
      nativeControls
      allowsFullscreen
      contentFit="cover"
    />
  );
}

function formatMsgTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
}

function MessageBubble({
  message,
  isMe,
  lowData,
  onPlayVoice,
  onJoinCall,
  onOpenAffiliateProduct,
  onOpenShare,
  onLongPressMedia,
  onReport,
}) {
  const time = formatMsgTime(message.createdAt);
  const sender = message.sender;
  const isAffiliateProduct = message.kind === 'affiliate_product';
  let affiliatePayload = null;
  if (isAffiliateProduct) {
    try {
      affiliatePayload = JSON.parse(message.body);
    } catch {
      affiliatePayload = null;
    }
  }
  const isShare = message.kind === 'share';
  let sharePayload = null;
  if (isShare) {
    try {
      sharePayload = JSON.parse(message.mediaUrl);
    } catch {
      sharePayload = null;
    }
  }
  const isPayment = message.kind === 'payment';
  const isCommerce = message.kind === 'commerce';
  let paymentPayload = null;
  let commercePayload = null;
  if (isPayment) {
    try {
      paymentPayload = JSON.parse(message.mediaUrl);
    } catch {
      paymentPayload = null;
    }
  }
  if (isCommerce) {
    try {
      commercePayload = JSON.parse(message.mediaUrl);
    } catch {
      commercePayload = null;
    }
  }
  const isMoneyCard = isPayment || message.body?.startsWith('💸') || message.body?.startsWith('🙏');
  const isCallCard =
    message.kind === 'text' &&
    (message.body?.startsWith('📞 Appel') || message.body?.startsWith('🎥 Appel'));
  const isSticker = message.kind === 'sticker';
  const isGif = message.kind === 'gif' || (message.kind === 'image' && message.mediaUrl?.startsWith('http'));
  const isPhoto = message.kind === 'image' && !isGif;

  const renderBody = () => {
    if (isSticker) {
      return <Text style={styles.stickerLarge}>{message.body}</Text>;
    }
    if ((isPhoto || isGif) && message.mediaUrl) {
      return (
        <PressScale
          scaleTo={0.98}
          onLongPress={() => onLongPressMedia?.(message)}
          style={{ alignSelf: 'flex-start' }}
        >
          <MbooloLazyMedia uri={message.mediaUrl} lowData={lowData} isGif={isGif} style={isGif ? styles.msgGif : styles.msgImage} />
        </PressScale>
      );
    }
    if (message.kind === 'video' && message.mediaUrl) {
      return (
        <PressScale scaleTo={0.98} onLongPress={() => onLongPressMedia?.(message)}>
          <VideoMessage uri={message.mediaUrl} />
        </PressScale>
      );
    }
    if (isPayment && paymentPayload) {
      return (
        <View>
          {paymentPayload.attachmentType === 'photo' || paymentPayload.attachmentType === 'gif' ? (
            <MbooloLazyMedia
              uri={paymentPayload.attachmentUrl}
              lowData={lowData}
              style={styles.msgImage}
            />
          ) : null}
          {paymentPayload.attachmentType === 'voice' ? (
            <PressScale
              scaleTo={0.98}
              onPress={() => onPlayVoice(paymentPayload.attachmentUrl)}
              style={styles.voiceChip}
            >
              <VoiceWaveform durationMs={paymentPayload.durationMs} isMe={isMe} />
            </PressScale>
          ) : null}
          <Text style={isMe ? styles.meText : styles.themText}>{message.body}</Text>
          {paymentPayload.reference ? (
            <Text style={[styles.receiptRef, isMe && styles.receiptRefMe]}>
              ✓ {paymentPayload.reference}{paymentPayload.verified ? ' · vérifiable' : ''}
            </Text>
          ) : null}
        </View>
      );
    }
    if (isCommerce && commercePayload) {
      return (
        <View style={styles.commerceCard}>
          <Text style={isMe ? styles.meText : styles.themText}>{message.body}</Text>
          {commercePayload.potBalance != null ? (
            <Text style={styles.commerceMeta}>
              Caisse · {Number(commercePayload.potBalance).toLocaleString('fr-FR')} F ·{' '}
              {Number(commercePayload.amountPerMember).toLocaleString('fr-FR')} F / membre
            </Text>
          ) : null}
          <Text style={styles.callJoin}>Escrow visible · K21 ✓</Text>
        </View>
      );
    }
    if (isShare && sharePayload) {
      return (
        <PressScale scaleTo={0.98} onPress={() => onOpenShare?.(sharePayload)} style={styles.affiliateCard}>
          {sharePayload.imageUrl ? (
            <Image source={{ uri: sharePayload.imageUrl }} style={styles.shareCardImage} resizeMode="cover" />
          ) : null}
          <Text style={isMe ? styles.meText : styles.themText}>
            {sharePayload.refType === 'business' ? '🏪 ' : '🛍️ '}
            {sharePayload.title}
          </Text>
          {sharePayload.subtitle ? (
            <Text style={isMe ? styles.meCaption : styles.gifCaption}>{sharePayload.subtitle}</Text>
          ) : null}
          {sharePayload.price != null ? (
            <Text style={styles.affiliatePrice}>{sharePayload.price?.toLocaleString?.('fr-FR') ?? sharePayload.price} F</Text>
          ) : null}
          <Text style={styles.callJoin}>
            {sharePayload.refType === 'business' ? 'Voir la boutique →' : 'Voir & commander →'}
          </Text>
        </PressScale>
      );
    }
    if (isAffiliateProduct && affiliatePayload) {
      return (
        <PressScale
          scaleTo={0.98}
          onPress={() => onOpenAffiliateProduct?.(affiliatePayload)}
          style={styles.affiliateCard}
        >
          <Text style={isMe ? styles.meText : styles.themText}>🛍️ {affiliatePayload.title}</Text>
          <Text style={styles.affiliatePrice}>{affiliatePayload.price?.toLocaleString?.('fr-FR') ?? affiliatePayload.price} C̶</Text>
          <Text style={styles.callJoin}>Voir & commander →</Text>
        </PressScale>
      );
    }
    if (message.kind === 'voice' && message.mediaUrl) {
      return (
        <PressScale
          scaleTo={0.98}
          onPress={() => onPlayVoice(message.mediaUrl)}
          onLongPress={() => onLongPressMedia?.(message)}
          style={styles.voiceChip}
        >
          <VoiceWaveform
            durationMs={message.mediaAsset?.durationMs}
            waveformJson={message.mediaAsset?.waveformJson}
            isMe={isMe}
          />
          <Text style={isMe ? styles.meText : styles.themText}>▶ Écouter</Text>
        </PressScale>
      );
    }
    if (isCallCard && onJoinCall) {
      return (
        <PressScale scaleTo={0.97} onPress={() => onJoinCall(message)}>
          <Text style={isMe ? styles.meText : styles.themText}>{message.body}</Text>
          <Text style={styles.callJoin}>▶ Rejoindre l’appel</Text>
        </PressScale>
      );
    }
    // J10: long-press someone else's message to report it (a snapshot is kept for review).
    if (!isMe && onReport) {
      return (
        <PressScale scaleTo={1} onLongPress={() => onReport(message)} accessibilityHint="Appui long pour signaler">
          <Text style={styles.themText}>{message.body}</Text>
        </PressScale>
      );
    }
    return <Text style={isMe ? styles.meText : styles.themText}>{message.body}</Text>;
  };

  if (isSticker) {
    return (
      <View style={[styles.msg, isMe ? styles.msgMe : styles.msgThem, styles.msgStickerWrap, !isMe && styles.msgStickerThem]}>
        {!isMe ? (
          <View style={styles.msgAva}>
            <Text style={{ fontSize: 14 }}>{sender?.avatarEmoji ?? '🧑🏾'}</Text>
          </View>
        ) : null}
        <View style={styles.stickerBubble}>{renderBody()}</View>
        <Text style={[styles.bTime, { alignSelf: isMe ? 'flex-end' : 'flex-start', marginTop: 2 }]}>{time}</Text>
      </View>
    );
  }

  const bubbleContent = (
    <>
      {!isMe ? <Text style={styles.bName}>{sender?.name ?? 'Membre'}</Text> : null}
      {renderBody()}
      {isGif ? <Text style={isMe ? styles.meCaption : styles.gifCaption}>GIF</Text> : null}
      {isPhoto ? <Text style={isMe ? styles.meCaption : styles.gifCaption}>Photo</Text> : null}
      <Text style={isMe ? styles.bTimeMe : styles.bTime}>{time}{isMe ? ' ✓' : ''}</Text>
    </>
  );

  if (isMe) {
    return (
      <View style={[styles.msg, styles.msgMe]}>
        <LinearGradient
          colors={isMoneyCard ? [colors.mboolo.mangoDark, colors.mboolo.terra] : [colors.mboolo.terra, colors.mboolo.terraLight]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.bubbleMe, isMoneyCard && styles.moneyBubble, (isPhoto || isGif) && styles.mediaBubbleMe]}
        >
          {bubbleContent}
        </LinearGradient>
      </View>
    );
  }

  return (
    <View style={[styles.msg, styles.msgThem]}>
      <View style={styles.msgAva}>
        <Text style={{ fontSize: 14 }}>{sender?.avatarEmoji ?? '🧑🏾'}</Text>
      </View>
      <View style={[styles.bubbleThem, isMoneyCard && styles.moneyBubbleThem, (isPhoto || isGif) && styles.mediaBubbleThem]}>
        {bubbleContent}
      </View>
    </View>
  );
}

function VoiceRecordingBar({ phase, durationMillis, maxSeconds, onStop, onCancel, processing }) {
  const dotBlink = useBlink(700, 0.25);
  const elapsed = formatVoiceDuration(durationMillis);
  const limit = formatVoiceDuration(maxSeconds * 1000);
  const isReady = phase === 'ready';

  if (processing) {
    return (
      <View style={[styles.recordingBar, styles.recordingBarProcessing]}>
        <ActivityIndicator color={colors.mboolo.terra} size="small" />
        <Text style={styles.recordingText}>Préparation du message vocal…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.recordingBar, isReady && styles.recordingBarReady]}>
      <Animated.View style={[styles.recordingDot, isReady ? { opacity: 1 } : { opacity: dotBlink }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.recordingText}>{isReady ? 'Enregistrement terminé' : 'Enregistrement en cours'}</Text>
        <Text style={styles.recordingTimer}>
          {elapsed} / {limit}
        </Text>
      </View>
      <PressScale scaleTo={0.95} onPress={onCancel} style={styles.recordingCancel}>
        <Text style={styles.recordingCancelText}>Annuler</Text>
      </PressScale>
      <PressScale scaleTo={0.95} onPress={onStop} style={styles.recordingStop}>
        <Text style={styles.recordingStopText}>⏹ Envoyer</Text>
      </PressScale>
    </View>
  );
}

export default function MbooloChatScreen({ navigation, route }) {
  const open = (name, params) => navigateFromRoot(navigation, name, params);
  const { threadId, thread, title } = route.params ?? {};
  const showToast = useToast();
  const { profile, refreshWallet } = useAppState();
  const { lowDataMode } = usePreferences();
  const voicePlayer = useAudioPlayer(null);
  const {
    start: startVoice,
    stop: stopVoice,
    cancel: cancelVoice,
    phase: voicePhase,
    isRecording,
    isReady,
    isProcessing,
    isVoiceBusy,
    durationMillis,
    maxSeconds,
  } = useMbooloVoiceRecorder();
  const micPulse = useBlink(isRecording ? 600 : 100000, isRecording ? 0.55 : 1);
  const readyToastShown = useRef(false);
  const [messages, setMessages] = useState([]);
  const [userId, setUserId] = useState(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestAmount, setRequestAmount] = useState('2000');
  const [requestNote, setRequestNote] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [sendMoneyOpen, setSendMoneyOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState(null);
  const sendIntentKey = useRef(null); // one key per opening of the send sheet: a retry never pays twice
  const [sendAmount, setSendAmount] = useState('2000');
  const [sendNote, setSendNote] = useState('');
  const [sendPhotoUrl, setSendPhotoUrl] = useState(null);
  const [sendingMoney, setSendingMoney] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [saveTarget, setSaveTarget] = useState(null);
  const [typingUsers, setTypingUsers] = useState([]);
  const [commerceBanner, setCommerceBanner] = useState(null);
  const scrollRef = useRef(null);
  const typingTimer = useRef(null);
  const insets = useSafeAreaInsets();
  const composerBottomPad = Math.max(insets.bottom, spacing.md);

  const chatTitle = title ?? thread?.name ?? 'Mboolo';
  const memberCount = thread?.members?.length ?? 0;
  const directPartner = getDirectPartner(thread, userId);

  const playVoice = useCallback(
    async (url) => {
      if (!url) return;
      try {
        const source = await resolveVoicePlaybackSource(url);
        if (Platform.OS === 'web' && typeof Audio !== 'undefined') {
          new Audio(source).play().catch(() => showToast('Lecture impossible'));
          return;
        }
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        voicePlayer.replace(source);
        voicePlayer.play();
      } catch {
        showToast('Lecture impossible');
      }
    },
    [voicePlayer, showToast],
  );

  const loadMessages = useCallback(async () => {
    if (!threadId) return;
    try {
      const q = searchQuery.trim().length >= 2 ? searchQuery.trim() : undefined;
      const [me, data, presence] = await Promise.all([
        getMe(),
        getMboloMessages(threadId, { q, limit: 80 }),
        getMboloThreadPresence(threadId).catch(() => null),
      ]);
      setUserId(me.id);
      const msgs = Array.isArray(data) ? data : data?.messages ?? [];
      setMessages(msgs);
      if (presence?.typing) setTypingUsers(presence.typing);
      if (presence?.commerce?.type === 'tontine') {
        setCommerceBanner(presence.commerce.group);
      } else {
        setCommerceBanner(null);
      }
      markMboloThreadRead(threadId).catch(() => {});
    } catch (err) {
      showToast(err.message ?? 'Messages indisponibles');
    } finally {
      setLoading(false);
    }
  }, [threadId, searchQuery, showToast]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      flushMboloOutbox(threadId)
        .then((sent) => {
          if (sent.length > 0) setMessages((prev) => [...prev, ...sent]);
        })
        .finally(() => loadMessages());
      const timer = setInterval(loadMessages, 3000);
      return () => clearInterval(timer);
    }, [loadMessages, threadId]),
  );

  useEffect(() => {
    if (!threadId) return;
    const q = searchQuery.trim();
    if (q.length === 0 || q.length >= 2) {
      setLoading(true);
      loadMessages();
    }
  }, [searchQuery, threadId, loadMessages]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  useEffect(() => {
    if (isReady && !readyToastShown.current) {
      readyToastShown.current = true;
      showToast('⏹ Enregistrement terminé — appuie sur Envoyer');
    }
    if (!isReady) readyToastShown.current = false;
  }, [isReady, showToast]);

  const postMessage = async (payload) => {
    setSending(true);
    try {
      const msg = await sendMboloMessage(threadId, payload);
      setMessages((prev) => [...prev, msg]);
      setText('');
    } catch (err) {
      if (err?.code === 'verification_required' || err?.status === 403) {
        showToast(err.message ?? 'Vérifie ton profil (nom + téléphone) pour envoyer des messages');
      } else if (!navigator?.onLine && Platform.OS !== 'web') {
        await enqueueMboloMessage(threadId, payload);
        showToast('Hors ligne — message en attente d’envoi');
      } else {
        showToast(err.message ?? 'Envoi impossible');
      }
    } finally {
      setSending(false);
    }
  };

  const handleTextChange = (value) => {
    setText(value);
    if (!threadId) return;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      markMboloThreadTyping(threadId).catch(() => {});
    }, 400);
  };

  // J10: chat text never moves money by itself. A typed "envoie 2000 à @awa" only opens the normal
  // send flow, pre-filled; the person reviews the recipient and amount there and confirms (step-up when required).
  const handleSendMoneyCommand = (cmd) => {
    setText('');
    showToast('Vérifie le destinataire et le montant, puis confirme');
    open('SendMoney', { recipientHandle: cmd.handle, prefilledAmount: cmd.amount, note: cmd.note.slice(0, 140) });
  };

  const handleSend = () => {
    const body = text.trim();
    if (!body || sending || sendingMoney) return;
    const moneyCmd = parseMoneyCommand(body);
    if (moneyCmd) {
      handleSendMoneyCommand(moneyCmd);
      return;
    }
    postMessage({ body, kind: 'text' });
  };

  const submitReport = async (category) => {
    const target = reportTarget;
    setReportTarget(null);
    if (!target?.id) return;
    try {
      await reportMboloMessage(target.id, category, `Signalé depuis la conversation (${category})`);
      showToast('Merci — l’équipe K21 va examiner ce message');
    } catch (err) {
      showToast(err.message ?? 'Signalement impossible');
    }
  };

  const handleLongPressMedia = (message) => {
    const savable =
      message.mediaUrl &&
      ['image', 'gif', 'voice', 'video', 'photo'].includes(message.kind);
    if (savable) setSaveTarget(message);
  };

  const saveMedia = async (retention) => {
    if (!saveTarget?.id) return;
    try {
      await saveMboloMessageMedia(saveTarget.id, { retention });
      showToast(retention === 'profile' ? 'Ajouté à ton profil Rec ✓' : 'Sauvegardé dans Rec ✓');
    } catch (err) {
      showToast(err.message ?? 'Sauvegarde impossible');
    } finally {
      setSaveTarget(null);
    }
  };

  const handleGifStudio = async () => {
    closeAttach();
    try {
      showToast('Studio GIF Teranga…');
      const asset = await runTerangaGifStudio();
      if (!asset) return;
      await postMediaMessage(
        sendMboloMediaMessage({
          threadId,
          kind: asset.mode === 'video_fallback' ? 'video' : 'gif',
          uri: asset.uri,
          mimeType: asset.mimeType,
          blob: asset.blob,
        }),
      );
    } catch (err) {
      showToast(err.message ?? 'Studio GIF impossible');
    }
  };

  const dismissAttachBeforePicker = async () => {
    if (Platform.OS === 'web') return;
    closeAttach();
    await new Promise((resolve) => setTimeout(resolve, 280));
  };

  const closeAttach = () => setAttachOpen(false);

  const postMediaMessage = async (promise) => {
    setSending(true);
    try {
      const msg = await promise;
      setMessages((prev) => [...prev, msg]);
    } catch (err) {
      if (err?.code === 'verification_required' || err?.status === 403) {
        showToast(err.message ?? 'Vérifie ton profil (nom + téléphone) pour envoyer des messages');
      } else if (err?.code === 'storage_unavailable' || err?.code === 'legacy_media_disabled') {
        showToast(err.message ?? 'Stockage média indisponible — contacte le support K21');
      } else {
        showToast(err.message ?? 'Envoi impossible');
      }
    } finally {
      setSending(false);
    }
  };

  const handlePhoto = async () => {
    try {
      await dismissAttachBeforePicker();
      const mediaUrl = await pickMboloImage();
      if (Platform.OS === 'web') closeAttach();
      if (!mediaUrl) return;
      showToast('Envoi de la photo…');
      await postMediaMessage(
        sendMboloMediaMessage({
          threadId,
          kind: 'image',
          uri: mediaUrl,
          mimeType: 'image/jpeg',
        }),
      );
    } catch (err) {
      closeAttach();
      showToast(err.message ?? 'Photo impossible');
    }
  };

  const handleCamera = async () => {
    try {
      await dismissAttachBeforePicker();
      const mediaUrl = await takeMboloPhoto();
      if (Platform.OS === 'web') closeAttach();
      if (!mediaUrl) return;
      showToast('Envoi de la photo…');
      await postMediaMessage(
        sendMboloMediaMessage({
          threadId,
          kind: 'image',
          uri: mediaUrl,
          mimeType: 'image/jpeg',
        }),
      );
    } catch (err) {
      closeAttach();
      showToast(err.message ?? 'Photo impossible');
    }
  };

  const handleVideo = async () => {
    try {
      await dismissAttachBeforePicker();
      const asset = await pickMboloVideoAsset();
      if (Platform.OS === 'web') closeAttach();
      if (!asset) return;
      showToast('Envoi de la vidéo…');
      await postMediaMessage(
        sendMboloMediaMessage({
          threadId,
          kind: 'video',
          uri: asset.uri,
          mimeType: asset.mimeType,
          blob: asset.blob,
        }),
      );
    } catch (err) {
      closeAttach();
      showToast(err.message ?? 'Vidéo impossible');
    }
  };

  const handleVoiceFromSheet = async () => {
    try {
      if (isRecording) {
        closeAttach();
        await finishVoiceRecording();
        return;
      }
      await startVoice();
      closeAttach();
      showToast('🎤 Enregistrement démarré — appuie sur ⏹ pour envoyer');
    } catch (err) {
      closeAttach();
      showToast(err.message ?? 'Micro indisponible');
    }
  };

  const handleReaction = async (emoji) => {
    closeAttach();
    await postMessage({ body: emoji, kind: 'text' });
  };

  const handleSticker = async (sticker) => {
    closeAttach();
    await postMessage({ body: sticker.emoji, kind: 'sticker' });
  };

  const handleGif = async (gif) => {
    closeAttach();
    try {
      showToast('Envoi du GIF…');
      const hasDbId = gif.id && !String(gif.id).startsWith('seed-');
      if (hasDbId) {
        const msg = await sendMboloMessage(threadId, {
          kind: 'gif',
          gifId: gif.id,
          body: 'GIF · ' + gif.label,
        });
        setMessages((prev) => [...prev, msg]);
        return;
      }
      if (!gif.url?.startsWith('http')) {
        showToast('GIF indisponible');
        return;
      }
      await postMediaMessage(
        sendMboloMediaMessage({
          threadId,
          kind: 'gif',
          uri: gif.url,
          mimeType: 'image/gif',
        }),
      );
    } catch (err) {
      showToast(err.message ?? 'GIF impossible');
    }
  };

  const finishVoiceRecording = async () => {
    try {
      const mediaUrl = await stopVoice();
      if (!mediaUrl) return;
      showToast('⏹ Enregistrement terminé — envoi…');
      await postMediaMessage(
        sendMboloMediaMessage({
          threadId,
          kind: 'voice',
          uri: mediaUrl,
          mimeType: Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4',
          durationMs: durationMillis,
        }),
      );
      showToast('Message vocal envoyé ✓');
    } catch (err) {
      showToast(err.message ?? 'Enregistrement impossible');
    }
  };

  const toggleVoice = async () => {
    if (isProcessing) return;
    if (isRecording || isReady) {
      await finishVoiceRecording();
      return;
    }
    try {
      await startVoice();
      showToast('🎤 Enregistrement démarré — appuie sur ⏹ pour envoyer');
    } catch (err) {
      showToast(err.message ?? 'Micro indisponible');
    }
  };

  const cancelVoiceRecording = async () => {
    if (!isVoiceBusy || isProcessing) return;
    await cancelVoice();
    showToast('Enregistrement annulé');
  };

  const handleSendMoney = () => {
    if (!directPartner?.handle) {
      showToast('Envoie à un contact en DM ou choisis un @handle');
      open('SendMoney');
      return;
    }
    setSendAmount('2000');
    setSendNote('');
    setSendPhotoUrl(null);
    sendIntentKey.current = `mbolo-send-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setSendMoneyOpen(true);
  };

  const attachSendMoneyPhoto = async () => {
    try {
      const url = await pickMboloImage();
      if (url) setSendPhotoUrl(url);
    } catch (err) {
      showToast(err.message ?? 'Photo impossible');
    }
  };

  const submitSendMoney = async () => {
    if (!directPartner?.handle) {
      showToast('Envoi disponible en conversation directe');
      return;
    }
    const amount = Math.round(Number(String(sendAmount).replace(/\s/g, '')));
    if (!Number.isFinite(amount) || amount < 100) {
      showToast('Montant minimum 100 F');
      return;
    }
    setSendingMoney(true);
    try {
      const result = await transferSend({
        recipientHandle: directPartner.handle,
        amount,
        note: sendNote.trim() || undefined,
        photoUrl: sendPhotoUrl ?? undefined,
        threadId,
        intentKey: sendIntentKey.current ?? undefined,
      });
      if (result.mboloMessage) setMessages((prev) => [...prev, result.mboloMessage]);
      await refreshWallet();
      setSendMoneyOpen(false);
      setSendNote('');
      setSendPhotoUrl(null);
      showToast('Argent envoyé ✓');
    } catch (err) {
      showToast(err.message ?? 'Envoi impossible');
    } finally {
      setSendingMoney(false);
    }
  };

  const submitMoneyRequest = async () => {
    if (!directPartner?.handle) {
      showToast('Demande d’argent disponible en conversation directe');
      return;
    }
    const amount = Math.round(Number(String(requestAmount).replace(/\s/g, '')));
    if (!Number.isFinite(amount) || amount < 100) {
      showToast('Montant minimum 100 F');
      return;
    }
    setRequesting(true);
    try {
      const note = requestNote.trim() || `Mboolo · ${chatTitle}`;
      await transferRequest({ recipientHandle: directPartner.handle, amount, note });
      await postMessage({
        body: `🙏 Demande ${formatXof(amount)}${note ? ` — ${note}` : ''}`,
        kind: 'text',
      });
      setRequestOpen(false);
      setRequestNote('');
      showToast('Demande envoyée ✓');
    } catch (err) {
      showToast(err.message ?? 'Demande impossible');
    } finally {
      setRequesting(false);
    }
  };

  if (!threadId) {
    return (
      <View style={styles.root}>
        <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ color: colors.mboolo.ink3 }}>Conversation introuvable</Text>
          <PressScale scaleTo={0.96} onPress={() => navigation.goBack()} style={{ marginTop: spacing.lg }}>
            <Text style={{ color: colors.mboolo.terra }}>Retour</Text>
          </PressScale>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        >
        <View style={styles.chatHead}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.chBack}>
            <Text style={{ fontSize: 15, color: '#fff' }}>←</Text>
          </PressScale>
          <View style={{ flex: 1 }}>
            <Text style={styles.chName}>{chatTitle}</Text>
            <Text style={styles.chSub}>
              {memberCount > 0 ? `${memberCount} membre${memberCount > 1 ? 's' : ''}` : `@${String(profile.handle ?? '').replace(/^@+/, '')}`}
            </Text>
          </View>
          <PressScale
            scaleTo={0.9}
            onPress={() => setSearchOpen((v) => !v)}
            style={styles.chBack}
          >
            <Text style={{ fontSize: 15 }}>🔍</Text>
          </PressScale>
          <PressScale
            scaleTo={0.9}
            onPress={() => open('Call', { threadId, title: chatTitle, video: false, ring: true })}
            style={styles.chBack}
          >
            <Text style={{ fontSize: 15 }}>📞</Text>
          </PressScale>
          <PressScale
            scaleTo={0.9}
            onPress={() => open('Call', { threadId, title: chatTitle, video: true, ring: true })}
            style={styles.chBack}
          >
            <Text style={{ fontSize: 15 }}>🎥</Text>
          </PressScale>
          <PressScale
            scaleTo={0.9}
            onPress={() => navigation.navigate('MbooloGroupInfo', { threadId, thread })}
            style={styles.chBack}
          >
            <Text style={{ fontSize: 15 }}>ⓘ</Text>
          </PressScale>
        </View>

        {searchOpen ? (
          <View style={styles.searchBar}>
            <TextInput
              style={styles.searchInput}
              placeholder="Rechercher dans la conversation…"
              placeholderTextColor={colors.mboolo.ink3}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
              returnKeyType="search"
            />
            {searchQuery.length > 0 ? (
              <PressScale scaleTo={0.95} onPress={() => setSearchQuery('')} style={styles.searchClear}>
                <Text style={styles.searchClearText}>✕</Text>
              </PressScale>
            ) : null}
          </View>
        ) : null}

        <View style={styles.moneyBar}>
          <PressScale scaleTo={0.96} onPress={handleSendMoney} style={styles.moneyChip}>
            <Text style={styles.moneyChipText}>💸 Envoyer</Text>
          </PressScale>
          <PressScale
            scaleTo={0.96}
            onPress={() => (directPartner ? setRequestOpen(true) : showToast('Demande en DM seulement'))}
            style={[styles.moneyChip, !directPartner && styles.moneyChipMuted]}
          >
            <Text style={styles.moneyChipText}>🙏 Demander</Text>
          </PressScale>
        </View>

        {commerceBanner ? (
          <View style={styles.commerceBanner}>
            <Text style={styles.commerceBannerTitle}>🤝 {commerceBanner.name}</Text>
            <Text style={styles.commerceBannerSub}>
              Caisse {Number(commerceBanner.potBalance).toLocaleString('fr-FR')} F · escrow visible
            </Text>
          </View>
        ) : null}

        {typingUsers.length > 0 ? (
          <Text style={styles.typingHint}>
            {typingUsers.map((u) => u.name).join(', ')} {typingUsers.length > 1 ? 'écrivent' : 'écrit'}…
          </Text>
        ) : null}

        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={[styles.msgs, { paddingBottom: spacing.xl }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {loading && <ActivityIndicator color={colors.mboolo.terra} style={{ marginVertical: spacing.xl }} />}
          {!loading && messages.length === 0 && (
            <Text style={styles.emptyHint}>
              {searchQuery.trim().length >= 2 ? 'Aucun message trouvé' : 'Aucun message — envoie le premier 👋'}
            </Text>
          )}
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              isMe={m.senderId === userId}
              lowData={lowDataMode}
              onLongPressMedia={handleLongPressMedia}
              onReport={(msg) => setReportTarget(msg)}
              onPlayVoice={playVoice}
              onJoinCall={(msg) =>
                open('Call', {
                  threadId,
                  title: chatTitle,
                  video: msg.body?.startsWith('🎥'),
                  ring: false,
                })
              }
              onOpenAffiliateProduct={(payload) => {
                open('Main', {
                  screen: 'MarketplaceTab',
                  params: {
                    screen: 'ShopDetail',
                    params: {
                      businessId: payload.businessId,
                      affiliateRef: payload.linkCode,
                      mboloThreadId: threadId,
                      highlightProductId: payload.productId,
                    },
                  },
                });
              }}
              onOpenShare={(payload) => {
                open('Main', {
                  screen: 'MarketplaceTab',
                  params: {
                    screen: 'ShopDetail',
                    params: {
                      businessId: payload.refType === 'business' ? payload.refId : payload.businessId,
                      highlightProductId: payload.refType === 'product' ? payload.refId : undefined,
                    },
                  },
                });
              }}
            />
          ))}
        </ScrollView>

        {isVoiceBusy ? (
          <VoiceRecordingBar
            phase={voicePhase}
            durationMillis={durationMillis}
            maxSeconds={maxSeconds}
            processing={isProcessing}
            onStop={finishVoiceRecording}
            onCancel={cancelVoiceRecording}
          />
        ) : null}

        <View style={[styles.inputRow, { paddingBottom: composerBottomPad }]}>
          <PressScale scaleTo={0.9} onPress={() => setAttachOpen(true)} style={styles.ciAttach} disabled={sending || isVoiceBusy}>
            <Text style={{ fontSize: 16 }}>📎</Text>
          </PressScale>
          <PressScale
            scaleTo={0.9}
            onPress={toggleVoice}
            style={[styles.ciAttach, isRecording && styles.ciRecording, (isReady || isProcessing) && styles.ciProcessing]}
            disabled={sending || isProcessing}
          >
            <Animated.View style={{ opacity: isRecording ? micPulse : 1 }}>
              <Text style={{ fontSize: 16 }}>{isRecording ? '⏹' : isReady ? '⏹' : isProcessing ? '…' : '🎤'}</Text>
            </Animated.View>
          </PressScale>
          <TextInput
            style={[styles.ciField, isVoiceBusy && styles.ciFieldMuted]}
            placeholder={
              isRecording
                ? 'Enregistrement en cours…'
                : isReady
                  ? 'Enregistrement terminé — envoie ou annule'
                  : isProcessing
                    ? 'Préparation du vocal…'
                    : 'Message…'
            }
            placeholderTextColor={colors.mboolo.ink3}
            value={text}
            onChangeText={handleTextChange}
            editable={!sending && !isVoiceBusy}
            onSubmitEditing={handleSend}
            returnKeyType="send"
          />
          <PressScale scaleTo={0.9} onPress={handleSend} style={styles.ciSend} disabled={sending || isVoiceBusy || !text.trim()}>
            <LinearGradient colors={[colors.mboolo.terra, colors.mboolo.terraDark]} style={StyleSheet.absoluteFill} borderRadius={19} />
            <Text style={{ fontSize: 17, color: '#fff' }}>{sending ? '…' : '➤'}</Text>
          </PressScale>
        </View>
        </KeyboardAvoidingView>
      </SafeAreaView>

      <MbooloAttachSheet
        visible={attachOpen}
        onClose={closeAttach}
        onPhoto={handlePhoto}
        onCamera={handleCamera}
        onVoice={handleVoiceFromSheet}
        onVideo={handleVideo}
        onReaction={handleReaction}
        onSticker={handleSticker}
        onGif={handleGif}
        onGifStudio={handleGifStudio}
      />

      <MbooloSaveSheet
        visible={Boolean(saveTarget)}
        onClose={() => setSaveTarget(null)}
        onSaveVault={() => saveMedia('vault')}
        onSaveProfile={() => saveMedia('profile')}
      />

      <Modal visible={Boolean(reportTarget)} animationType="slide" transparent onRequestClose={() => setReportTarget(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Signaler ce message</Text>
            <Text style={styles.modalHint}>Le message est conservé pour l’équipe K21. La personne ne sait pas qui l’a signalé.</Text>
            {[['scam', 'Arnaque / demande de code'], ['spam', 'Spam'], ['harassment', 'Harcèlement'], ['hate', 'Haine'], ['other', 'Autre']].map(([c, label]) => (
              <PressScale key={c} scaleTo={0.97} onPress={() => submitReport(c)} style={styles.modalSubmit} accessibilityLabel={`Signaler : ${label}`}>
                <Text style={styles.modalSubmitText}>{label}</Text>
              </PressScale>
            ))}
            <PressScale onPress={() => setReportTarget(null)} style={{ alignItems: 'center', padding: spacing.md }}><Text style={styles.modalHint}>Annuler</Text></PressScale>
          </View>
        </View>
      </Modal>

      <Modal visible={requestOpen} animationType="slide" transparent onRequestClose={() => setRequestOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Demander de l'argent</Text>
            <Text style={styles.modalHint}>
              À @{directPartner?.handle ?? '…'} · ils recevront une notification
            </Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Montant (F CFA)"
              placeholderTextColor={colors.mboolo.ink3}
              keyboardType="numeric"
              value={requestAmount}
              onChangeText={setRequestAmount}
            />
            <TextInput
              style={styles.modalInput}
              placeholder="Raison (optionnel)"
              placeholderTextColor={colors.mboolo.ink3}
              value={requestNote}
              onChangeText={setRequestNote}
            />
            <PressScale scaleTo={0.96} onPress={submitMoneyRequest} style={styles.modalSubmit} disabled={requesting}>
              <LinearGradient colors={[colors.mboolo.terra, colors.mboolo.mangoDark]} style={StyleSheet.absoluteFill} borderRadius={radius.xl} />
              <Text style={styles.modalSubmitText}>{requesting ? 'Envoi…' : 'Envoyer la demande'}</Text>
            </PressScale>
            <PressScale scaleTo={0.96} onPress={() => setRequestOpen(false)} style={{ alignSelf: 'center', marginTop: spacing.sm }}>
              <Text style={{ color: colors.mboolo.ink3, fontSize: 12 }}>Annuler</Text>
            </PressScale>
          </View>
        </View>
      </Modal>

      <Modal visible={sendMoneyOpen} animationType="slide" transparent onRequestClose={() => setSendMoneyOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Envoyer de l'argent</Text>
            <Text style={styles.modalHint}>À @{directPartner?.handle ?? '…'}</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Montant (F CFA)"
              placeholderTextColor={colors.mboolo.ink3}
              keyboardType="numeric"
              value={sendAmount}
              onChangeText={setSendAmount}
            />
            <TextInput
              style={styles.modalInput}
              placeholder="Message (optionnel)"
              placeholderTextColor={colors.mboolo.ink3}
              value={sendNote}
              onChangeText={setSendNote}
            />
            <PressScale scaleTo={0.96} onPress={attachSendMoneyPhoto} style={styles.moneyAttachRow}>
              {sendPhotoUrl ? (
                <Image source={{ uri: sendPhotoUrl }} style={styles.moneyAttachThumb} />
              ) : (
                <Text style={styles.moneyAttachText}>📷 Joindre une photo (optionnel)</Text>
              )}
            </PressScale>
            <PressScale scaleTo={0.96} onPress={submitSendMoney} style={styles.modalSubmit} disabled={sendingMoney}>
              <LinearGradient colors={[colors.mboolo.terra, colors.mboolo.mangoDark]} style={StyleSheet.absoluteFill} borderRadius={radius.xl} />
              <Text style={styles.modalSubmitText}>{sendingMoney ? 'Envoi…' : `Envoyer ${sendAmount || 0} F`}</Text>
            </PressScale>
            <PressScale scaleTo={0.96} onPress={() => setSendMoneyOpen(false)} style={{ alignSelf: 'center', marginTop: spacing.sm }}>
              <Text style={{ color: colors.mboolo.ink3, fontSize: 12 }}>Annuler</Text>
            </PressScale>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.mboolo.bg },
  chatHead: { backgroundColor: colors.mboolo.terra, paddingHorizontal: 14, paddingVertical: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  chBack: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  chName: { fontSize: 13, fontWeight: '700', color: '#fff' },
  callJoin: { fontSize: 11, fontWeight: '700', color: colors.mboolo.terra, marginTop: 4 },
  affiliateCard: { paddingVertical: 4 },
  affiliatePrice: { fontSize: 13, fontWeight: '700', color: colors.mboolo.terra, marginTop: 4 },
  receiptRef: { fontSize: 10, color: colors.mboolo.ink3, marginTop: 4, fontFamily: fontFamily.medium },
  receiptRefMe: { color: 'rgba(255,255,255,0.75)' },
  commerceCard: { gap: 4 },
  commerceMeta: { fontSize: 11, color: colors.mboolo.terra, fontFamily: fontFamily.medium },
  commerceBanner: {
    marginHorizontal: spacing.xl,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(250,216,54,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(250,216,54,0.35)',
  },
  commerceBannerTitle: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.mboolo.ink },
  commerceBannerSub: { fontSize: 11, color: colors.mboolo.ink2, marginTop: 2 },
  typingHint: {
    fontSize: 11,
    color: colors.mboolo.ink3,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    fontStyle: 'italic',
  },
  shareCardImage: { width: 180, height: 120, borderRadius: radius.lg, marginBottom: spacing.sm },
  chSub: { fontSize: 10, color: 'rgba(255,255,255,0.7)' },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    backgroundColor: colors.mboolo.terra,
  },
  searchInput: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontFamily: fontFamily.medium,
    fontSize: 14,
    color: colors.mboolo.ink,
  },
  searchClear: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  moneyBar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
    backgroundColor: colors.mboolo.terra,
  },
  moneyChip: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderRadius: radius.round,
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  moneyChipMuted: { opacity: 0.55 },
  moneyChipText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  moneyBubble: { borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)' },
  moneyBubbleThem: { borderColor: colors.mboolo.mangoDark, backgroundColor: '#fffaf5' },
  msgs: { padding: 14, flexGrow: 1 },
  emptyHint: { textAlign: 'center', color: colors.mboolo.ink3, fontSize: 12, marginTop: spacing.giant },
  msg: { flexDirection: 'row', gap: 7, maxWidth: '88%', marginTop: spacing.lg },
  msgThem: { alignSelf: 'flex-start' },
  msgMe: { alignSelf: 'flex-end', flexDirection: 'row-reverse' },
  msgAva: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end', borderWidth: 1.5, borderColor: 'rgba(232,92,26,0.15)', backgroundColor: '#fff' },
  bubbleThem: { backgroundColor: '#fff', borderWidth: 2, borderColor: 'rgba(232,92,26,0.12)', borderRadius: 18, borderBottomLeftRadius: 4, paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
  bName: { fontSize: 9, fontWeight: '700', color: colors.mboolo.terra, marginBottom: 3 },
  themText: { fontSize: 13, color: colors.mboolo.ink, lineHeight: 19.5 },
  bTime: { fontSize: 9, color: colors.mboolo.ink3, marginTop: 3, textAlign: 'right' },
  gifCaption: { fontSize: 9, color: colors.mboolo.ink3, marginTop: 2 },
  bubbleMe: { borderRadius: 18, borderBottomRightRadius: 4, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, maxWidth: '100%' },
  meText: { fontSize: 13, color: '#fff', lineHeight: 19.5 },
  meCaption: { fontSize: 9, color: 'rgba(255,255,255,0.7)', marginTop: 2 },
  bTimeMe: { fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 3, textAlign: 'right' },
  msgImage: { width: 200, height: 150, borderRadius: radius.lg, marginBottom: 4 },
  msgGif: { width: 180, height: 135, borderRadius: radius.lg, marginBottom: 4 },
  msgVideo: { width: 220, height: 165, borderRadius: radius.lg, marginBottom: 4, backgroundColor: '#000' },
  msgStickerWrap: { maxWidth: '100%', flexDirection: 'column' },
  msgStickerThem: { alignItems: 'flex-start' },
  stickerBubble: { paddingVertical: spacing.xs },
  stickerLarge: { fontSize: 56, lineHeight: 64 },
  voiceChip: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: radius.round,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  mediaBubbleMe: { paddingHorizontal: spacing.sm, paddingVertical: spacing.sm },
  mediaBubbleThem: { paddingHorizontal: spacing.sm, paddingVertical: spacing.sm },
  recordingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(232,92,26,0.12)',
    borderTopWidth: 2,
    borderTopColor: colors.terracotta,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  recordingBarProcessing: {
    backgroundColor: 'rgba(250,216,54,0.16)',
    borderTopColor: colors.goldDark,
    justifyContent: 'center',
  },
  recordingBarReady: {
    backgroundColor: 'rgba(26,240,96,0.1)',
    borderTopColor: colors.greenDark,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.terracotta,
  },
  recordingText: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.terracotta },
  recordingTimer: { fontFamily: fontFamily.bodySemiBold, fontSize: 11, color: 'rgba(232,92,26,0.75)', marginTop: 2 },
  recordingCancel: {
    borderRadius: radius.round,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(232,92,26,0.35)',
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  recordingCancelText: { fontFamily: fontFamily.bodyBold, fontSize: 11, color: colors.terracotta },
  recordingStop: { backgroundColor: colors.terracotta, borderRadius: radius.round, paddingHorizontal: spacing.lg, paddingVertical: 6 },
  recordingStopText: { fontFamily: fontFamily.bodyBold, fontSize: 11, color: '#fff' },
  inputRow: {
    backgroundColor: '#fff',
    borderTopWidth: 2,
    borderTopColor: 'rgba(232,92,26,0.1)',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  ciAttach: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: colors.mboolo.terraPale, borderWidth: 1.5, borderColor: colors.mboolo.border, alignItems: 'center', justifyContent: 'center' },
  ciRecording: { backgroundColor: 'rgba(232,92,26,0.22)', borderColor: colors.terracotta, borderWidth: 2 },
  ciProcessing: { opacity: 0.55 },
  ciFieldMuted: { opacity: 0.55 },
  ciField: { flex: 1, minHeight: 38, borderRadius: 19, backgroundColor: colors.mboolo.bg2, borderWidth: 2, borderColor: colors.mboolo.border, paddingHorizontal: spacing.xxxl, paddingVertical: spacing.sm, fontSize: 13, color: colors.mboolo.ink },
  ciSend: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: colors.mboolo.bg,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.huge,
    borderWidth: 1,
    borderColor: colors.mboolo.border,
    gap: spacing.md,
  },
  modalTitle: { fontFamily: fontFamily.displayBold, fontSize: 16, color: colors.mboolo.ink },
  modalHint: { fontSize: 11, color: colors.mboolo.ink3, lineHeight: 16 },
  modalInput: {
    height: 44,
    borderWidth: 2,
    borderColor: colors.mboolo.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    fontSize: 13,
    color: colors.mboolo.ink,
    backgroundColor: '#fff',
  },
  modalSubmit: {
    height: 48,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginTop: spacing.sm,
  },
  modalSubmitText: { fontFamily: fontFamily.displayBold, fontSize: 13, color: '#fff' },
  moneyAttachRow: {
    height: 44,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.mboolo.border,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  moneyAttachText: { fontSize: 12, color: colors.mboolo.ink3 },
  moneyAttachThumb: { width: '100%', height: '100%' },
});
