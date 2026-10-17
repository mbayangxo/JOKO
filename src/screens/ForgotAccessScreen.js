import { useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, TextInput, View } from 'react-native';
import OnboardingShell from '../components/OnboardingShell';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import { useToast } from '../components/Toast';
import { colors, fontFamily, radius, spacing } from '../theme';
import { ob } from '../theme/onboarding';
import { useEntrance } from '../hooks/animations';
import { useLocale } from '../context/LocaleContext';
import { t } from '../i18n/translations';
import { authEmail, authVerify } from '../lib/api-client';
import { saveSessionTokens } from '../lib/secure-storage';

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

export default function ForgotAccessScreen({ onCancel, onRecovered }) {
  const { langCode } = useLocale();
  const showToast = useToast();
  const [step, setStep] = useState('form');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [devOtpHint, setDevOtpHint] = useState(null);
  const [loading, setLoading] = useState(false);
  const entrance = useEntrance(0, 350, 8);

  const emailNorm = email.trim().toLowerCase();
  const validForm = isValidEmail(emailNorm);

  const requestCode = async () => {
    setLoading(true);
    setOtp('');
    try {
      const res = await authEmail(emailNorm, 'recover');
      if (res.otp) setDevOtpHint(String(res.otp));
      else setDevOtpHint(null);
      setStep('otp');
      showToast(t(langCode, 'forgotCodeSent'));
    } catch (err) {
      showToast(err.message ?? t(langCode, 'forgotSendFailed'));
    } finally {
      setLoading(false);
    }
  };

  const verifyAndContinue = async () => {
    setLoading(true);
    try {
      const res = await authVerify({
        email: emailNorm,
        otp: otp.replace(/\D/g, ''),
        intent: 'recover',
      });
      await saveSessionTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      await onRecovered?.();
    } catch (err) {
      const hint = err.data?.hint;
      const msg = hint ? `${err.message ?? t(langCode, 'signupInvalidOtp')} — ${hint}` : (err.message ?? t(langCode, 'signupInvalidOtp'));
      showToast(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <OnboardingShell>
      <Animated.View style={[styles.body, entrance]}>
        <View style={styles.headRow}>
          <PressScale scaleTo={0.9} onPress={onCancel} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 14, color: ob.ink }}>←</Text>
          </PressScale>
          <Text style={styles.headTitle}>{t(langCode, 'forgotTitle')}</Text>
        </View>

        {step === 'form' ? (
          <>
            <Text style={styles.headline}>
              {t(langCode, 'forgotHead1')}{'\n'}
              <Text style={styles.g}>{t(langCode, 'forgotHead2')}</Text>
            </Text>
            <Text style={styles.sub}>{t(langCode, 'forgotSubEmail')}</Text>

            <View style={styles.inputGroup}>
              <Text style={styles.igLabel}>{t(langCode, 'forgotEmailLabel')}</Text>
              <TextInput accessibilityLabel="saliou@email.com"
                style={[styles.igField, validForm && styles.fieldOk]}
                placeholder="saliou@email.com"
                placeholderTextColor={ob.faint}
                keyboardType="email-address"
                autoCapitalize="none"
                value={email}
                onChangeText={setEmail}
              />
            </View>

            <View style={{ flex: 1 }} />
            <GlowButton label={loading ? t(langCode, 'signupSending') : t(langCode, 'forgotSendBtn')} onPress={requestCode} disabled={!validForm || loading} />
            {loading && <ActivityIndicator color={colors.green} style={{ marginTop: spacing.md }} />}
          </>
        ) : (
          <>
            <Text style={styles.headline}>
              {t(langCode, 'signupOtpHeadPrefix')}{'\n'}
              <Text style={styles.g}>{t(langCode, 'forgotOtpHead')}</Text>
            </Text>
            <Text style={styles.sub}>{t(langCode, 'forgotOtpSubEmail')}</Text>

            {devOtpHint ? (
              <View style={styles.devOtpBox}>
                <Text style={styles.devOtpLabel}>{t(langCode, 'forgotBetaCode')}</Text>
                <Text style={styles.devOtpHint}>{devOtpHint}</Text>
              </View>
            ) : null}

            <View style={styles.otpRow}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <View key={i} style={[styles.otpBox, otp.length > i && styles.otpBoxFilled, otp.length === i && styles.otpBoxActive]}>
                  <Text style={styles.otpDigit}>{otp[i] ?? ''}</Text>
                </View>
              ))}
            </View>
            <TextInput
              style={styles.hiddenInput}
              value={otp}
              onChangeText={(v) => setOtp(v.replace(/[^0-9]/g, '').slice(0, 6))}
              keyboardType="number-pad"
              autoFocus
              maxLength={6}
            />

            <View style={{ flex: 1 }} />
            <GlowButton label={loading ? t(langCode, 'signupVerifying') : t(langCode, 'forgotContinueBtn')} onPress={verifyAndContinue} disabled={otp.length < 6 || loading} />
          </>
        )}
      </Animated.View>
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: spacing.xxl, paddingBottom: spacing.xl },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl, paddingTop: spacing.md, marginBottom: spacing.xxl },
  backBtn: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: ob.orangeSoft, borderWidth: 1, borderColor: ob.orangeBorder, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontFamily: fontFamily.displayBold, fontSize: 14, color: ob.ink },
  headline: { fontFamily: fontFamily.displayBlack, fontSize: 22, letterSpacing: -0.6, lineHeight: 27, color: ob.ink, marginBottom: spacing.sm },
  g: { color: ob.green },
  sub: { fontSize: 12, color: ob.muted, marginBottom: spacing.giant, lineHeight: 18 },
  inputGroup: { marginBottom: spacing.xl },
  igLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, color: ob.faint, textTransform: 'uppercase', marginBottom: spacing.sm },
  igField: { width: '100%', height: 50, borderRadius: radius.lg, backgroundColor: ob.surface, borderWidth: 1.5, borderColor: ob.border, paddingHorizontal: spacing.xxxl, fontSize: 14, color: ob.ink },
  fieldOk: { borderColor: ob.greenBorder },
  devOtpBox: { backgroundColor: ob.orangeSoft, borderWidth: 1.5, borderColor: ob.orangeBorder, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.lg, alignItems: 'center' },
  devOtpLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, color: ob.muted, textTransform: 'uppercase', marginBottom: spacing.xs },
  devOtpHint: { fontFamily: fontFamily.displayBlack, fontSize: 28, letterSpacing: 8, color: ob.orange },
  otpRow: { flexDirection: 'row', gap: spacing.md, justifyContent: 'center', marginBottom: spacing.xl },
  otpBox: { width: 42, height: 54, borderRadius: radius.lg, backgroundColor: ob.surface, borderWidth: 1.5, borderColor: ob.border, alignItems: 'center', justifyContent: 'center' },
  otpBoxFilled: { backgroundColor: ob.greenSoft, borderColor: ob.greenBorder },
  otpBoxActive: { borderColor: ob.green },
  otpDigit: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: ob.green },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});
