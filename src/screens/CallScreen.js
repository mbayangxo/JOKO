import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import CallVideoView from '../components/CallVideoView';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import { getCallToken } from '../lib/api-client';
import { callsSupported, createCallSession } from '../lib/call-room';
import { colors, fontFamily, radius, spacing, type } from '../theme';

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * In-call screen (LiveKit). User taps "Rejoindre" first — required for mic
 * permission and iOS Safari audio. One room per Mboolo thread.
 */
export default function CallScreen({ navigation, route }) {
  const { threadId, title, video: wantsVideo, ring } = route.params ?? {};
  const [phase, setPhase] = useState('prejoin'); // prejoin | connecting | live | error
  const [error, setError] = useState(null);
  const [others, setOthers] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(Boolean(wantsVideo));
  const [elapsed, setElapsed] = useState(0);
  const [remoteVideoTrack, setRemoteVideoTrack] = useState(null);
  const [localVideoTrack, setLocalVideoTrack] = useState(null);

  const sessionRef = useRef(null);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1400, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  useEffect(() => {
    if (phase !== 'live') return undefined;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    return () => {
      sessionRef.current?.disconnect();
      sessionRef.current = null;
    };
  }, []);

  const joinCall = useCallback(async () => {
    if (!threadId) {
      setError('Conversation introuvable.');
      setPhase('error');
      return;
    }
    if (!callsSupported) {
      setError(
        Platform.OS === 'web'
          ? 'Les appels ne sont pas encore activés sur ce serveur.'
          : 'Les appels Mboolo fonctionnent sur K21 web — ouvre keit-six.vercel.app dans Chrome ou Safari.',
      );
      setPhase('error');
      return;
    }

    setPhase('connecting');
    setError(null);
    setRemoteVideoTrack(null);
    setLocalVideoTrack(null);

    try {
      const { url, token } = await getCallToken({
        threadId,
        video: Boolean(wantsVideo),
        ring: Boolean(ring),
      });

      const session = createCallSession({
        onParticipants: (n) => setOthers(n),
        onVideoTrack: (track) => setRemoteVideoTrack(track ?? null),
        onLocalVideoTrack: (track) => setLocalVideoTrack(track ?? null),
        onDisconnected: () => navigation.goBack(),
      });
      sessionRef.current = session;
      await session.connect(url, token, { video: Boolean(wantsVideo) });
      setPhase('live');
    } catch (err) {
      const msg =
        err?.code === 'calls_unavailable'
          ? err.message
          : err?.message ?? 'Appel impossible pour le moment.';
      setError(msg);
      setPhase('error');
      sessionRef.current?.disconnect();
      sessionRef.current = null;
    }
  }, [threadId, wantsVideo, ring, navigation]);

  const toggleMic = async () => {
    const next = !micOn;
    setMicOn(next);
    try {
      await sessionRef.current?.setMic(next);
    } catch {
      /* ignore */
    }
  };

  const toggleCam = async () => {
    const next = !camOn;
    setCamOn(next);
    try {
      await sessionRef.current?.setCamera(next);
    } catch {
      setCamOn(!next);
    }
  };

  const hangUp = () => {
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    navigation.goBack();
  };

  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const pulseFade = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] });

  const statusLine =
    phase === 'prejoin'
      ? ring
        ? 'Tu vas sonner — l’autre personne sera notifiée'
        : 'Prêt à rejoindre'
      : phase === 'connecting'
        ? 'Connexion…'
        : others === 0
          ? 'Ça sonne…'
          : `En appel · ${formatDuration(elapsed)}${others > 1 ? ` · ${others + 1} participants` : ''}`;

  const joinLabel = ring ? (wantsVideo ? '🎥 Appeler' : '📞 Appeler') : '▶ Rejoindre l’appel';

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>{wantsVideo ? 'Appel vidéo' : 'Appel vocal'}</Text>
          <Text style={styles.title} numberOfLines={1}>
            {title ?? 'Mboolo'}
          </Text>
          <Text style={styles.status}>{phase === 'error' ? ' ' : statusLine}</Text>
        </View>

        {phase === 'error' ? (
          <View style={styles.center}>
            <Text style={{ fontSize: 40, marginBottom: spacing.lg }}>{wantsVideo ? '🎥' : '📞'}</Text>
            <Text style={styles.errorText}>{error}</Text>
            <PressScale scaleTo={0.95} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
              <Text style={styles.backBtnText}>← Retour au chat</Text>
            </PressScale>
          </View>
        ) : phase === 'prejoin' || phase === 'connecting' ? (
          <View style={styles.center}>
            <View style={styles.avatarWrap}>
              <Animated.View
                style={[styles.avatarPulse, { opacity: pulseFade, transform: [{ scale: pulseScale }] }]}
              />
              <View style={styles.avatarDisc}>
                <Text style={{ fontSize: 44 }}>{phase === 'connecting' ? '📡' : wantsVideo ? '🎥' : '📞'}</Text>
              </View>
            </View>
            <Text style={styles.voiceHint}>
              {phase === 'connecting'
                ? 'Connexion au serveur d’appel…'
                : wantsVideo
                  ? 'Autorise caméra et micro quand le navigateur le demande.'
                  : 'Autorise le micro quand le navigateur le demande.'}
            </Text>
            {phase === 'prejoin' ? (
              <PressScale scaleTo={0.96} onPress={joinCall} style={styles.joinBtn}>
                <Text style={styles.joinBtnText}>{joinLabel}</Text>
              </PressScale>
            ) : (
              <ActivityIndicator color={colors.green} style={{ marginTop: spacing.xxl }} />
            )}
            <PressScale scaleTo={0.96} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
              <Text style={styles.backBtnText}>Annuler</Text>
            </PressScale>
          </View>
        ) : wantsVideo ? (
          <View style={styles.videoArea}>
            <View style={styles.remoteVideo}>
              {remoteVideoTrack ? (
                <CallVideoView track={remoteVideoTrack} style={styles.videoFill} />
              ) : (
                <View style={styles.center}>
                  <Text style={styles.waitingText}>
                    {others === 0 ? 'En attente de l’autre personne…' : 'Caméra de l’autre personne en cours…'}
                  </Text>
                  {!localVideoTrack ? (
                    <Text style={styles.waitingSub}>Vérifie que la caméra est autorisée dans le navigateur.</Text>
                  ) : null}
                </View>
              )}
            </View>
            {localVideoTrack ? (
              <CallVideoView track={localVideoTrack} mirrored style={styles.localVideo} />
            ) : camOn ? (
              <View style={[styles.localVideo, styles.localPlaceholder]}>
                <Text style={styles.waitingText}>Caméra…</Text>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.center}>
            <View style={styles.avatarWrap}>
              <Animated.View
                style={[styles.avatarPulse, { opacity: pulseFade, transform: [{ scale: pulseScale }] }]}
              />
              <View style={styles.avatarDisc}>
                <Text style={{ fontSize: 44 }}>📞</Text>
              </View>
            </View>
            <Text style={styles.voiceHint}>
              {others === 0
                ? 'Ton ami a été notifié — il peut rejoindre depuis le chat ou les notifications.'
                : 'Appel en cours — bonne discussion !'}
            </Text>
          </View>
        )}

        {phase === 'live' ? (
          <View style={styles.controls}>
            <PressScale scaleTo={0.9} onPress={toggleMic} style={[styles.ctrlBtn, !micOn && styles.ctrlBtnOff]}>
              <Text style={{ fontSize: 22 }}>{micOn ? '🎙️' : '🔇'}</Text>
              <Text style={styles.ctrlLabel}>{micOn ? 'Micro' : 'Coupé'}</Text>
            </PressScale>
            {wantsVideo ? (
              <PressScale scaleTo={0.9} onPress={toggleCam} style={[styles.ctrlBtn, !camOn && styles.ctrlBtnOff]}>
                <Text style={{ fontSize: 22 }}>{camOn ? '🎥' : '🚫'}</Text>
                <Text style={styles.ctrlLabel}>Caméra</Text>
              </PressScale>
            ) : null}
            <PressScale scaleTo={0.9} onPress={hangUp} style={styles.hangBtn}>
              <Text style={{ fontSize: 22, color: '#fff' }}>✕</Text>
              <Text style={styles.hangLabel}>Raccrocher</Text>
            </PressScale>
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { alignItems: 'center', paddingTop: spacing.xxl, paddingHorizontal: spacing.huge },
  eyebrow: { ...type.eyebrow, color: colors.greenDark },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 19, color: colors.ink, marginTop: 4 },
  status: { fontSize: 12, color: 'rgba(5,8,5,0.55)', marginTop: 6, minHeight: 16, textAlign: 'center' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.huge },

  avatarWrap: { width: 150, height: 150, alignItems: 'center', justifyContent: 'center' },
  avatarPulse: {
    position: 'absolute',
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: 'rgba(26,240,96,0.35)',
  },
  avatarDisc: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderWidth: 2,
    borderColor: 'rgba(15,188,72,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceHint: {
    marginTop: spacing.xxl,
    fontSize: 12,
    color: 'rgba(5,8,5,0.55)',
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 280,
  },
  joinBtn: {
    marginTop: spacing.xxl,
    backgroundColor: colors.greenDark,
    borderRadius: radius.xl,
    borderBottomRightRadius: 10,
    paddingHorizontal: spacing.huge,
    paddingVertical: spacing.lg,
  },
  joinBtnText: { fontFamily: fontFamily.displayBold, fontSize: 14, color: '#fff' },

  videoArea: { flex: 1, margin: spacing.xl, position: 'relative', minHeight: 280 },
  remoteVideo: {
    flex: 1,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: 'rgba(5,8,5,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
  },
  videoFill: { flex: 1, width: '100%', height: '100%' },
  waitingText: { fontSize: 12, color: 'rgba(5,8,5,0.5)', textAlign: 'center' },
  waitingSub: { fontSize: 11, color: 'rgba(5,8,5,0.4)', marginTop: 8, textAlign: 'center', maxWidth: 240 },
  localVideo: {
    position: 'absolute',
    right: 10,
    top: 10,
    width: 96,
    height: 128,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.12)',
  },
  localPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.7)' },

  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: spacing.xxl,
    paddingVertical: spacing.xxl,
  },
  ctrlBtn: {
    width: 74,
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderWidth: 1,
    borderColor: 'rgba(5,8,5,0.1)',
    borderRadius: radius.xl,
    borderBottomRightRadius: 9,
    paddingVertical: spacing.lg,
  },
  ctrlBtnOff: { backgroundColor: 'rgba(232,92,26,0.12)', borderColor: 'rgba(232,92,26,0.3)' },
  ctrlLabel: { fontSize: 10, color: 'rgba(5,8,5,0.6)', fontFamily: fontFamily.bodyBold },
  hangBtn: {
    width: 84,
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.orange,
    borderRadius: radius.xl,
    borderBottomRightRadius: 9,
    paddingVertical: spacing.lg,
  },
  hangLabel: { fontSize: 10, color: '#fff', fontFamily: fontFamily.bodyBold },

  errorText: { fontSize: 13, color: 'rgba(5,8,5,0.65)', textAlign: 'center', lineHeight: 19, maxWidth: 300 },
  backBtn: { marginTop: spacing.xxl },
  backBtnText: { fontSize: 13, color: colors.greenDark, fontFamily: fontFamily.bodyBold },
});
