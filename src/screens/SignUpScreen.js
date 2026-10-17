import { useState } from 'react';
import { ActivityIndicator, Animated, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import OnboardingShell from '../components/OnboardingShell';
import PressScale from '../components/PressScale';
import GlowButton from '../components/GlowButton';
import { useToast } from '../components/Toast';
import { colors, fontFamily, radius, spacing } from '../theme';
import { ob } from '../theme/onboarding';
import { useEntrance } from '../hooks/animations';
import { useLocale } from '../context/LocaleContext';
import { authEmail, authVerify, authPasswordLogin, authCompleteProfile, getMe, getWallet, depositNational, createStripeDepositSession } from '../lib/api-client';
import { usePlatformFeatures } from '../lib/platform-features';
import { saveSessionTokens } from '../lib/secure-storage';
import { pickProfilePhoto } from '../lib/profile-photo';
import ProfileAvatar from '../components/ProfileAvatar';
import { t } from '../i18n/translations';

// Backend-driven signup: email only → OTP → profile → intent → fund (optional).
const STEP_ORDER = ['email', 'otp', 'profile', 'intent', 'fund'];
const STEP_NUM = { email: 1, otp: 2, profile: 3, intent: 4 };

function fundMethodsFor({ stripeEnabled, betaEnabled, lang }) {
  const rows = [];
  if (stripeEnabled) {
    rows.push({
      key: 'stripe_card',
      icon: '💳',
      bg: 'rgba(250,216,54,0.15)',
      name: 'Carte bancaire',
      sub: 'Visa · Mastercard — diaspora (Stripe)',
      badge: 'STRIPE',
      badgeStyle: 'stripe',
    });
  }
  if (betaEnabled) {
    rows.push({
      key: 'beta',
      icon: '🧪',
      bg: colors.greenA08,
      name: 'Crédit test',
      sub: t(lang, 'signupFundBetaSub'),
      badge: 'BETA',
      badgeStyle: 'free',
    });
  }
  if (!rows.length) {
    rows.push({
      key: 'agent_later',
      icon: '🏧',
      bg: colors.greenA08,
      name: 'Agent K21',
      sub: 'Dépôt cash après inscription — points K21 au Sénégal',
      badge: 'GRATUIT',
      badgeStyle: 'free',
    });
  }
  return rows;
}
const FUND_AMOUNTS = [5000, 10000, 25000, 50000];
const INTENTS = [
  { key: 'send_money', icon: '💸', title: 'Envoyer de l\'argent', sub: 'Transfers et paiements' },
  { key: 'mbolo', icon: '🧑‍🤝‍🧑', title: 'Communauté', sub: 'Mboolo — groupes et collectes' },
  { key: 'discover', icon: '📍', title: 'Découvrir', sub: 'Événements et vie locale' },
  { key: 'business', icon: '🏪', title: 'Mon business', sub: 'Vendre et être payé' },
];

function formatAmount(n) {
  return n.toLocaleString('fr-FR').replace(/ /g, ' ');
}

function StepHeader({ lang, title, step, total = 4, onBack }) {
  return (
    <>
      <View style={styles.headRow}>
        <PressScale scaleTo={0.9} onPress={onBack} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
          <Text style={{ fontSize: 14, color: ob.ink }}>←</Text>
        </PressScale>
        <Text style={styles.headTitle}>{title}</Text>
      </View>
      <View style={styles.stepRow}>
        {Array.from({ length: total }, (_, i) => i + 1).map((s) => (
          <View key={s} style={styles.stepTrack}>
            <View style={[styles.stepFill, s <= step && { width: '100%' }, s === step && step === total && { backgroundColor: ob.orange }]} />
          </View>
        ))}
      </View>
      <Text style={styles.stepLabel}>{t(lang, 'signupStepLabel', { n: step, total })}</Text>
    </>
  );
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
}

function EmailStep({
  lang,
  mode,
  email,
  setEmail,
  password,
  setPassword,
  loading,
  onNext,
  onPasswordLogin,
  onBack,
  onForgot,
  onSwitchToSignup,
}) {
  const entrance = useEntrance(0, 350, 8);
  const validEmail = isValidEmail(email);
  const isLogin = mode === 'login';
  const validPassword = String(password ?? '').length >= 8;

  return (
    <Animated.View style={[styles.body, entrance]}>
      {isLogin ? (
        <View style={styles.loginBanner}>
          <Text style={styles.loginBannerText}>{t(lang, 'signupSignIn').toUpperCase()}</Text>
          <Text style={styles.loginBannerSub}>{t(lang, 'signupSignInOnlySub')}</Text>
        </View>
      ) : null}
      <StepHeader
        lang={lang}
        title={isLogin ? t(lang, 'signupSignIn') : t(lang, 'signupCreateAccount')}
        step={STEP_NUM.email}
        total={isLogin ? 2 : 4}
        onBack={onBack}
      />
      <Text style={styles.headline}>
        {isLogin ? t(lang, 'signupSignInHead') : t(lang, 'signupEmailHead')}{'\n'}
        <Text style={styles.g}>
          {isLogin ? t(lang, 'signupSignInEmailTitle') : t(lang, 'signupEmailTitle')}
        </Text>
      </Text>
      <Text style={styles.sub}>
        {isLogin ? t(lang, 'signupSignInPasswordSub') : t(lang, 'signupEmailSub')}
      </Text>

      {!isLogin ? (
        <View style={styles.emailOnlyPill}>
          <Text style={styles.emailOnlyText}>✉️ {t(lang, 'signupEmailOnlyBadge')}</Text>
        </View>
      ) : null}

      <TextInput
        style={[styles.emailField, validEmail && styles.phoneFieldFilled]}
        placeholder={t(lang, 'signupEmailPlaceholder')}
        placeholderTextColor={ob.faint}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        value={email}
        onChangeText={setEmail}
      />

      {isLogin ? (
        <TextInput
          style={[styles.emailField, styles.passwordField, validPassword && styles.phoneFieldFilled]}
          placeholder={t(lang, 'signupPasswordPlaceholder')}
          placeholderTextColor={ob.faint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={password}
          onChangeText={setPassword}
        />
      ) : null}

      <View style={{ flex: 1 }} />
      {isLogin ? (
        <>
          <GlowButton
            label={loading ? t(lang, 'signupSigningIn') : t(lang, 'signupSignInWithPassword')}
            onPress={onPasswordLogin}
            disabled={!validEmail || !validPassword || loading}
          />
          <PressScale scaleTo={0.95} onPress={onNext} style={{ alignSelf: 'center', marginTop: spacing.lg }}>
            <Text style={{ fontSize: 12, color: colors.green, fontFamily: fontFamily.bodyBold }}>
              {t(lang, 'signupUseEmailCode')}
            </Text>
          </PressScale>
        </>
      ) : (
        <GlowButton label={loading ? t(lang, 'signupSending') : t(lang, 'signupSendCode')} onPress={onNext} disabled={!validEmail || loading} />
      )}
      {isLogin && onForgot ? (
        <PressScale scaleTo={0.95} onPress={onForgot} style={{ alignSelf: 'center', marginTop: spacing.lg }}>
          <Text style={{ fontSize: 12, color: ob.orange, fontFamily: fontFamily.bodyBold }}>{t(lang, 'signupForgotAccess')}</Text>
        </PressScale>
      ) : null}
      {isLogin && onSwitchToSignup ? (
        <PressScale scaleTo={0.95} onPress={onSwitchToSignup} style={{ alignSelf: 'center', marginTop: spacing.md }}>
          <Text style={styles.createInstead}>{t(lang, 'signupCreateInstead')}</Text>
        </PressScale>
      ) : null}
      {loading && <ActivityIndicator color={colors.green} style={{ marginTop: spacing.md }} />}
    </Animated.View>
  );
}

function OtpStep({ lang, mode, displayEmail, otp, setOtp, loading, devHint, emailOnly, onResend, onNext, onBack }) {
  const entrance = useEntrance(0, 350, 8);
  const boxes = [0, 1, 2, 3, 4, 5];
  const isLogin = mode === 'login';
  return (
    <Animated.View style={[styles.body, entrance]}>
      <StepHeader
        lang={lang}
        title={t(lang, 'signupVerification')}
        step={STEP_NUM.otp}
        total={isLogin ? 2 : 4}
        onBack={onBack}
      />
      <Text style={styles.headline}>
        {t(lang, 'signupOtpHeadPrefix')}{'\n'}
        <Text style={styles.g}>{t(lang, 'signupOtpHead')}</Text>
      </Text>
      <Text style={styles.otpSentTo}>
        {t(lang, 'signupOtpSent')}{' '}
        <Text style={{ fontFamily: fontFamily.bodyBold, color: ob.ink }}>{displayEmail}</Text>
        {'\n'}{t(lang, 'signupOtpValidEmail')}
      </Text>
      {devHint && !emailOnly ? (
        <View style={styles.devOtpBox}>
          <Text style={styles.devOtpLabel}>{t(lang, 'forgotBetaCode')}</Text>
          <Text style={styles.devOtpHint}>{devHint}</Text>
          <Text style={styles.devOtpNote}>{t(lang, 'signupOtpUseLatest')}</Text>
        </View>
      ) : emailOnly ? (
        <View style={styles.devOtpBox}>
          <Text style={styles.devOtpLabel}>{t(lang, 'signupOtpCheckInbox')}</Text>
          <Text style={styles.devOtpNote}>{t(lang, 'signupOtpCheckSpam')}</Text>
        </View>
      ) : null}

      {/* The real input is stretched invisibly over the boxes: tapping a box
          taps the input, so the keyboard opens from a genuine user gesture —
          mobile browsers block programmatic autofocus, which froze this step
          on phones (code visible, no way to type it). */}
      <View style={{ position: 'relative' }}>
        <View style={styles.otpRow}>
          {boxes.map((i) => (
            <View key={i} style={[styles.otpBox, otp.length > i && styles.otpBoxFilled, otp.length === i && styles.otpBoxActive]}>
              <Text style={styles.otpDigit}>{otp[i] ?? ''}</Text>
            </View>
          ))}
        </View>
        <TextInput
          style={styles.otpTouchInput}
          value={otp}
          onChangeText={(v) => setOtp(v.replace(/[^0-9]/g, '').slice(0, 6))}
          keyboardType="number-pad"
          autoFocus
          maxLength={6}
          caretHidden
        />
      </View>

      <PressScale scaleTo={0.95} onPress={onResend} style={{ alignSelf: 'center' }}>
        <Text style={styles.resendText}>
          {t(lang, 'signupResend')}{' '}
          <Text style={{ color: colors.green, fontFamily: fontFamily.bodyBold }}>{t(lang, 'signupResendAction')}</Text>
        </Text>
      </PressScale>

      <View style={styles.secNote}>
        <Text style={{ fontSize: 14 }}>🛡️</Text>
        <Text style={styles.secText}>
          <Text style={{ color: ob.ink, fontFamily: fontFamily.bodyBold }}>Ne partage jamais ce code</Text> — même si quelqu'un dit travailler pour K21. On ne te demandera jamais ton code.
        </Text>
      </View>

      <View style={{ flex: 1 }} />
      <GlowButton label={loading ? t(lang, 'signupVerifying') : t(lang, 'signupVerify')} onPress={onNext} disabled={otp.length < 6 || loading} />
      {loading && <ActivityIndicator color={colors.green} style={{ marginTop: spacing.md }} />}
    </Animated.View>
  );
}

function ProfileStep({ name, setName, handle, setHandle, avatarUrl, setAvatarUrl, onNext, onBack }) {
  const entrance = useEntrance(0, 350, 8);
  const [photoLoading, setPhotoLoading] = useState(false);

  const addPhoto = async () => {
    setPhotoLoading(true);
    try {
      const dataUrl = await pickProfilePhoto();
      if (dataUrl) setAvatarUrl(dataUrl);
    } finally {
      setPhotoLoading(false);
    }
  };

  return (
    <Animated.View style={[styles.body, entrance]}>
      <StepHeader title="Mon profil" step={STEP_NUM.profile} onBack={onBack} />
      <Text style={styles.headline}>
        Crée ton{'\n'}
        <Text style={styles.g}>identité K21</Text>
      </Text>

      <PressScale scaleTo={0.96} onPress={addPhoto} disabled={photoLoading} style={styles.avatarPick}>
        <View style={styles.avatarCircle}>
          {avatarUrl ? (
            <ProfileAvatar photoUrl={avatarUrl} size={76} style={{ borderWidth: 0, backgroundColor: 'transparent' }} />
          ) : (
            <Text style={{ fontSize: 32 }}>🧑🏾</Text>
          )}
          <View style={styles.avatarAdd}>
            <Text style={{ fontSize: 12, fontWeight: '900', color: ob.ink }}>+</Text>
          </View>
        </View>
        <Text style={styles.avatarHint}>{avatarUrl ? 'Changer la photo' : 'Ajouter une photo'}</Text>
      </PressScale>

      <View style={styles.inputGroup}>
        <Text style={styles.igLabel}>Prénom et nom</Text>
        <TextInput accessibilityLabel="Saliou Diallo" style={styles.igField} placeholder="Saliou Diallo" placeholderTextColor={ob.faint} value={name} onChangeText={setName} />
      </View>
      <View style={styles.inputGroup}>
        <Text style={styles.igLabel}>Ton handle</Text>
        <View style={{ position: 'relative' }}>
          <Text style={styles.handleAt}>@</Text>
          <TextInput
            style={[styles.igField, styles.handleField]}
            value={handle}
            onChangeText={(t) => setHandle(t.replace(/[^a-z0-9_]/gi, '').toLowerCase())}
          />
          {handle.length > 2 && (
            <View style={styles.handleAvail}>
              <Text style={styles.handleAvailText}>✓ Dispo</Text>
            </View>
          )}
        </View>
      </View>

      <View style={{ flex: 1 }} />
      <GlowButton label="Continuer →" onPress={onNext} disabled={!name.trim() || handle.length < 3} />
    </Animated.View>
  );
}

function IntentStep({ lang, intent, setIntent, onNext, onBack }) {
  const entrance = useEntrance(0, 350, 8);
  return (
    <Animated.View style={[styles.body, entrance]}>
      <StepHeader title="Ton objectif" step={STEP_NUM.intent} onBack={onBack} />
      <Text style={styles.headline}>
        {t(lang, 'signupIntentHeadPrefix')}{'\n'}
        <Text style={styles.g}>{t(lang, 'signupIntentHead')}</Text>
      </Text>
      <Text style={styles.sub}>{t(lang, 'signupIntentSub')}</Text>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View style={{ gap: spacing.sm }}>
          {INTENTS.map((opt) => (
            <PressScale key={opt.key} scaleTo={0.98} onPress={() => setIntent(opt.key)} style={[styles.cniOpt, intent === opt.key && styles.cniOptOn]}>
              <Text style={{ fontSize: 22 }}>{opt.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.coTitle}>{opt.title}</Text>
                <Text style={styles.coSub}>{opt.sub}</Text>
              </View>
              {intent === opt.key && (
                <View style={styles.aiCheck}>
                  <Text style={{ fontSize: 9, fontWeight: '900', color: ob.ink }}>✓</Text>
                </View>
              )}
            </PressScale>
          ))}
        </View>
      </ScrollView>

      <GlowButton label="Continuer →" onPress={onNext} disabled={!intent} />
    </Animated.View>
  );
}

function FundStep({ lang, amount, setAmount, method, setMethod, loading, stripeEnabled, betaEnabled, onNext, onSkip, onBack }) {
  const entrance = useEntrance(0, 350, 8);
  const methods = fundMethodsFor({ stripeEnabled, betaEnabled, lang });
  const primaryLabel =
    method === 'stripe_card'
      ? `Payer ${formatAmount(amount)} F par carte →`
      : method === 'agent_later'
        ? 'Continuer — dépôt agent après inscription →'
        : `Ajouter ${formatAmount(amount)} F →`;

  return (
    <Animated.View style={[styles.body, entrance]}>
      <View style={styles.headRow}>
        <PressScale scaleTo={0.9} onPress={onBack} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
          <Text style={{ fontSize: 14, color: ob.ink }}>←</Text>
        </PressScale>
        <Text style={styles.headTitle}>Alimenter mon compte</Text>
      </View>
      <Text style={[styles.headline, { fontSize: 18, marginBottom: spacing.sm }]}>
        Ajoute de <Text style={styles.g}>l'argent</Text>
      </Text>
      <Text style={[styles.sub, { marginBottom: spacing.xl }]}>{t(lang, 'signupFundEmailSub')}</Text>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <View style={{ gap: spacing.sm, marginBottom: spacing.xl }}>
          {methods.map((m) => (
            <PressScale key={m.key} scaleTo={0.98} onPress={() => setMethod(m.key)} style={[styles.fmItem, method === m.key && styles.fmItemOn]}>
              <View style={[styles.fmIco, { backgroundColor: m.bg }]}>
                <Text style={{ fontSize: 20 }}>{m.icon}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.fmName}>{m.name}</Text>
                <Text style={styles.fmSub}>{m.sub}</Text>
              </View>
              <View style={[styles.fmBadge, m.badgeStyle === 'stripe' ? styles.badgeStripe : styles.badgeFree]}>
                <Text style={[styles.fmBadgeText, { color: m.badgeStyle === 'stripe' ? colors.goldDark : colors.green }]}>{m.badge}</Text>
              </View>
            </PressScale>
          ))}
        </View>

        {method !== 'agent_later' ? (
          <>
            <Text style={styles.fasLabel}>Montant rapide</Text>
            <View style={styles.fasAmounts}>
              {FUND_AMOUNTS.map((a) => (
                <PressScale key={a} scaleTo={0.92} onPress={() => setAmount(a)} style={[styles.faChip, amount === a && styles.faChipOn]}>
                  <Text style={[styles.faChipText, amount === a && { color: colors.green }]}>{a / 1000}k F</Text>
                </PressScale>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>

      <PressScale scaleTo={0.96} onPress={onSkip} disabled={loading} style={{ alignSelf: 'center', marginBottom: spacing.md }}>
        <Text style={styles.skipFund}>ou <Text style={{ color: ob.muted }}>Commencer sans argent pour l'instant</Text></Text>
      </PressScale>
      <GlowButton label={loading ? t(lang, 'signupCreating') : primaryLabel} onPress={onNext} disabled={loading} />
    </Animated.View>
  );
}

export default function SignUpScreen({ mode = 'signup', initialEmail, onComplete, onLoginComplete, onCancel, onForgot, onSwitchToSignup, onSwitchToLogin }) {
  const { country, region, langCode, setOnboardingIntent } = useLocale();
  const showToast = useToast();
  const { feature } = usePlatformFeatures();
  const stripeEnabled = feature('cash', 'stripeDeposits');
  const betaEnabled = feature('cash', 'betaDeposits') || process.env.EXPO_PUBLIC_ALLOW_BETA_DEPOSITS === 'true';
  const defaultFundMethod = stripeEnabled ? 'stripe_card' : betaEnabled ? 'beta' : 'agent_later';
  const [step, setStep] = useState('email');
  const [authEmailAddress, setAuthEmailAddress] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [devOtpHint, setDevOtpHint] = useState(null);
  const [otpViaEmail, setOtpViaEmail] = useState(false);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [intent, setIntent] = useState(null);
  const [fundMethod, setFundMethod] = useState(defaultFundMethod);
  const [fundAmount, setFundAmount] = useState(10000);
  const [loading, setLoading] = useState(false);

  const goTo = (s) => setStep(s);
  const back = () => {
    const i = STEP_ORDER.indexOf(step);
    if (i > 0) setStep(STEP_ORDER[i - 1]);
  };

  const otpDestination = authEmailAddress.trim().toLowerCase();
  const authIntent = mode === 'login' ? 'login' : 'signup';

  const requestOtp = async () => {
    setLoading(true);
    setOtp('');
    try {
      const res = await authEmail(otpDestination, authIntent);
      const emailSent = Boolean(res.emailSent ?? res.sent);
      setOtpViaEmail(emailSent);
      setDevOtpHint(emailSent ? null : res.otp ? String(res.otp) : null);
      goTo('otp');
    } catch (err) {
      // Existing account on the signup path → flip straight into login with
      // the email kept, instead of stranding the user on a toast.
      if (err.status === 409 && mode === 'signup' && onSwitchToLogin) {
        showToast('Ce compte existe déjà — connecte-toi ici ✓');
        onSwitchToLogin(authEmailAddress);
        return;
      }
      const msg =
        err.status === 404 || err.status === 409
          ? (err.message ?? t(langCode, 'signupNoAccountEmail'))
          : err.code === 'db_unavailable'
            ? t(langCode, 'signupDbUnavailable')
            : (err.message ?? t(langCode, 'signupSendFailed'));
      showToast(msg);
    } finally {
      setLoading(false);
    }
  };

  const loginWithPassword = async () => {
    setLoading(true);
    try {
      const res = await authPasswordLogin(otpDestination, password);
      if (!res?.accessToken || !res?.refreshToken) {
        showToast(t(langCode, 'signupSignInFailed'));
        return;
      }
      await saveSessionTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      const freshToken = res.accessToken;
      let snap = res.profile;
      const profileComplete = (p) => p?.name?.length >= 2 && p?.handle?.length >= 3;
      if (!profileComplete(snap)) {
        try {
          snap = await getMe(freshToken);
        } catch {
          await onLoginComplete?.({
            accessToken: freshToken,
            refreshToken: res.refreshToken,
            email: otpDestination,
          });
          return;
        }
      }
      if (!profileComplete(snap)) {
        goTo('profile');
        return;
      }
      await onLoginComplete?.({
        accessToken: freshToken,
        refreshToken: res.refreshToken,
        profile: snap,
        email: otpDestination,
      });
    } catch (err) {
      if (err.code === 'password_not_set') {
        showToast(t(langCode, 'signupPasswordNotSet'));
        await requestOtp();
        return;
      }
      showToast(err.message ?? t(langCode, 'signupSignInFailed'));
    } finally {
      setLoading(false);
    }
  };

  const resendOtp = async () => {
    setLoading(true);
    setOtp('');
    try {
      const res = await authEmail(otpDestination, authIntent);
      const emailSent = Boolean(res.emailSent ?? res.sent);
      setOtpViaEmail(emailSent);
      setDevOtpHint(emailSent ? null : res.otp ? String(res.otp) : null);
      showToast('Code renvoyé ✓');
    } catch (err) {
      showToast(err.message ?? t(langCode, 'signupResendFailed'));
    } finally {
      setLoading(false);
    }
  };

  const verifyOtp = async () => {
    setLoading(true);
    try {
      const code = otp.replace(/\D/g, '');
      if (code.length !== 6) {
        showToast(t(langCode, 'signupInvalidOtp'));
        return;
      }
      const res = await authVerify({
        email: otpDestination,
        otp: code,
        intent: authIntent,
      });
      if (!res?.accessToken || !res?.refreshToken) {
        showToast(t(langCode, 'signupInvalidOtp'));
        return;
      }
      await saveSessionTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      const freshToken = res.accessToken;
      if (mode === 'login') {
        if (res.isNewUser) {
          goTo('profile');
          return;
        }
        let snap = res.profile;
        const profileComplete = (p) => p?.name?.length >= 2 && p?.handle?.length >= 3;
        if (!profileComplete(snap)) {
          try {
            snap = await getMe(freshToken);
          } catch {
            await onLoginComplete?.({
              accessToken: freshToken,
              refreshToken: res.refreshToken,
              email: otpDestination,
            });
            return;
          }
        }
        if (!profileComplete(snap)) {
          goTo('profile');
          return;
        }
        await onLoginComplete?.({
          accessToken: freshToken,
          refreshToken: res.refreshToken,
          profile: snap,
          email: otpDestination,
        });
        return;
      }
      if (!res.isNewUser) {
        const snap = res.profile;
        if (snap?.name?.length >= 2 && snap?.handle?.length >= 3) {
          await onLoginComplete?.({
            accessToken: freshToken,
            refreshToken: res.refreshToken,
            profile: snap,
            email: otpDestination,
          });
          return;
        }
        try {
          const me = await getMe(freshToken);
          if (me.name?.length >= 2 && me.handle?.length >= 3) {
            await onLoginComplete?.({
              accessToken: freshToken,
              refreshToken: res.refreshToken,
              profile: me,
              email: otpDestination,
            });
            return;
          }
        } catch {
          /* fall through to profile step */
        }
      }
      goTo('profile');
    } catch (err) {
      const hint = err.data?.hint;
      let msg = err.message ?? t(langCode, 'signupInvalidOtp');
      if (err.status === 401 && !hint && err.code === 'invalid_otp') msg = t(langCode, 'signupInvalidOtp');
      if (err.code === 'db_schema_outdated' || err.code === 'db_unavailable') {
        msg = err.message ?? t(langCode, 'signupDbUnavailable');
      }
      if (err.code === 'auth_not_configured') msg = err.message ?? t(langCode, 'signupDbUnavailable');
      if (hint) msg = `${msg} — ${hint}`;
      showToast(msg);
    } finally {
      setLoading(false);
    }
  };

  const finishSignup = async (amount) => {
    if (!region?.key) {
      showToast('Choisis ton pays et ta région sur l’écran précédent');
      return;
    }
    setLoading(true);
    try {
      if (intent) await setOnboardingIntent(intent);
      const res = await authCompleteProfile({
        name: name.trim(),
        handle,
        arrondissement: { key: region.key, icon: region.icon, name: region.name },
        fundAmount: 0,
        identityChoice: intent,
        isDiaspora: country?.code !== 'SN',
        countryCode: country?.code,
        avatarUrl: avatarUrl ?? undefined,
      });

      let wallet = res;
      let txs = res.transactions ?? [];

      if (amount > 0 && fundMethod === 'beta') {
        try {
          const deposited = await depositNational({ amount, source: 'signup' });
          wallet = deposited;
          if (deposited.transaction) txs = [deposited.transaction, ...txs];
        } catch (depositErr) {
          showToast(depositErr.message ?? 'Crédit test indisponible — tu peux ajouter de l’argent plus tard');
          wallet = await getWallet();
        }
      } else if (amount > 0 && fundMethod === 'stripe_card') {
        try {
          const session = await createStripeDepositSession({ amount });
          if (session.checkoutUrl) {
            await Linking.openURL(session.checkoutUrl);
            showToast('Finalise le paiement Stripe — ton wallet sera crédité automatiquement.');
          }
        } catch (stripeErr) {
          showToast(stripeErr.message ?? 'Paiement carte indisponible');
        }
      }

      const balance = wallet.balance ?? wallet.koriBalance ?? 0;
      onComplete?.({
        email: otpDestination,
        name,
        handle,
        arrondissement: region,
        fundAmount: balance,
        intent,
        profile: res.profile,
        transactions: txs,
      });
    } catch (err) {
      showToast(err.message ?? t(langCode, 'signupProfileFailed'));
    } finally {
      setLoading(false);
    }
  };


  return (
    <OnboardingShell>
        {step === 'email' && (
          <EmailStep
            lang={langCode}
            mode={mode}
            email={authEmailAddress}
            setEmail={setAuthEmailAddress}
            password={password}
            setPassword={setPassword}
            loading={loading}
            onNext={requestOtp}
            onPasswordLogin={loginWithPassword}
            onBack={onCancel}
            onForgot={onForgot}
            onSwitchToSignup={onSwitchToSignup}
          />
        )}
        {step === 'otp' && (
          <OtpStep
            lang={langCode}
            mode={mode}
            displayEmail={otpDestination}
            otp={otp}
            setOtp={setOtp}
            loading={loading}
            devHint={devOtpHint}
            emailOnly
            onResend={resendOtp}
            onNext={verifyOtp}
            onBack={back}
          />
        )}
        {step === 'profile' && (
          <ProfileStep
            name={name}
            setName={setName}
            handle={handle}
            setHandle={setHandle}
            avatarUrl={avatarUrl}
            setAvatarUrl={setAvatarUrl}
            onNext={() => goTo('intent')}
            onBack={back}
          />
        )}
        {step === 'intent' && (
          <IntentStep lang={langCode} intent={intent} setIntent={setIntent} onNext={() => goTo('fund')} onBack={back} />
        )}
        {step === 'fund' && (
          <FundStep
            lang={langCode}
            amount={fundAmount}
            setAmount={setFundAmount}
            method={fundMethod}
            setMethod={setFundMethod}
            loading={loading}
            stripeEnabled={stripeEnabled}
            betaEnabled={betaEnabled}
            onNext={() => finishSignup(fundMethod === 'agent_later' ? 0 : fundAmount)}
            onSkip={() => finishSignup(0)}
            onBack={back}
          />
        )}
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: spacing.xxl, paddingBottom: spacing.xl },

  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl, paddingTop: spacing.md, marginBottom: spacing.xxl },
  backBtn: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: ob.orangeSoft, borderWidth: 1, borderColor: ob.orangeBorder, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontFamily: fontFamily.displayBold, fontSize: 14, color: ob.ink },

  stepRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xl },
  stepTrack: { height: 3, flex: 1, borderRadius: 2, backgroundColor: ob.orangeSoft, overflow: 'hidden' },
  stepFill: { height: '100%', width: 0, borderRadius: 2, backgroundColor: ob.green },
  stepLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, color: ob.faint, textTransform: 'uppercase', marginBottom: spacing.xl },

  headline: { fontFamily: fontFamily.displayBlack, fontSize: 22, letterSpacing: -0.6, lineHeight: 27, color: ob.ink, marginBottom: spacing.sm },
  g: { color: ob.green },
  sub: { fontSize: 12, color: ob.muted, marginBottom: spacing.giant, lineHeight: 18 },

  phoneRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  countrySel: { height: 52, borderRadius: radius.lg, backgroundColor: ob.surface, borderWidth: 1, borderColor: ob.border, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg },
  countryCode: { fontSize: 13, fontWeight: '700', color: ob.ink },
  countryChevron: { fontSize: 10, color: ob.muted, marginLeft: 2 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(5,8,5,0.35)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: ob.bg, borderTopLeftRadius: radius.xxl, borderTopRightRadius: radius.xxl, padding: spacing.xxl, borderWidth: 1, borderColor: ob.border },
  modalTitle: { fontFamily: fontFamily.displayBold, fontSize: 16, color: ob.ink, marginBottom: spacing.lg },
  modalSearch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 44,
    borderRadius: radius.lg,
    backgroundColor: ob.surface,
    borderWidth: 1.5,
    borderColor: ob.border,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  modalSearchInput: { flex: 1, fontSize: 13, color: ob.ink },
  modalRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.lg, paddingHorizontal: spacing.md, borderRadius: radius.lg, marginBottom: spacing.xs },
  modalRowOn: { backgroundColor: ob.greenSoft },
  modalRowTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: ob.ink },
  modalRowSub: { fontSize: 11, color: ob.muted, marginTop: 2 },
  modalClose: { marginTop: spacing.lg, alignItems: 'center', paddingVertical: spacing.lg },
  modalCloseText: { fontSize: 13, fontWeight: '700', color: ob.muted },
  phoneField: { flex: 1, height: 52, borderRadius: radius.lg, backgroundColor: ob.surface, borderWidth: 1, borderColor: ob.border, paddingHorizontal: spacing.xxxl, fontSize: 16, fontWeight: '600', letterSpacing: 0.5, color: ob.ink },
  emailField: { height: 52, borderRadius: radius.lg, backgroundColor: ob.surface, borderWidth: 1, borderColor: ob.border, paddingHorizontal: spacing.xxxl, fontSize: 16, fontWeight: '600', color: ob.ink, marginBottom: spacing.lg },
  passwordField: { marginBottom: spacing.giant },
  channelRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xxl },
  channelPill: { flex: 1, height: 40, borderRadius: radius.lg, backgroundColor: ob.surface, borderWidth: 1, borderColor: ob.border, alignItems: 'center', justifyContent: 'center' },
  channelPillOn: { backgroundColor: ob.orangeSoft, borderColor: ob.orangeBorder },
  channelPillText: { fontSize: 12, fontWeight: '700', color: ob.muted },
  channelPillTextOn: { color: ob.orange },
  phoneFieldFilled: { borderColor: ob.greenBorder },
  fieldNote: { fontSize: 10, color: ob.faint, marginBottom: spacing.giant, lineHeight: 15.5 },

  quickNumsRow: { gap: spacing.md, marginBottom: spacing.xxl },
  qn: { height: 34, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: ob.surface, borderWidth: 1, borderColor: ob.border, alignItems: 'center', justifyContent: 'center' },
  qnText: { fontSize: 12, fontWeight: '600', color: ob.muted },

  secNote: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: ob.orangeSoft, borderWidth: 1, borderColor: ob.orangeBorder, borderRadius: radius.md, padding: spacing.lg, marginBottom: spacing.xl },
  secText: { flex: 1, fontSize: 10, color: ob.muted, lineHeight: 15 },

  otpSentTo: { fontSize: 12, color: ob.muted, textAlign: 'center', marginBottom: spacing.xl, lineHeight: 18 },
  otpRow: { flexDirection: 'row', gap: spacing.md, justifyContent: 'center', marginBottom: spacing.xl },
  otpBox: { width: 42, height: 54, borderRadius: radius.lg, backgroundColor: ob.surface, borderWidth: 1.5, borderColor: ob.border, alignItems: 'center', justifyContent: 'center' },
  otpBoxFilled: { backgroundColor: ob.greenSoft, borderColor: ob.greenBorder },
  otpBoxActive: { borderColor: ob.green },
  otpDigit: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: ob.green },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  otpTouchInput: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    opacity: 0.02, color: 'transparent', fontSize: 1, textAlign: 'center',
  },
  resendText: { fontSize: 11, color: ob.faint, marginBottom: spacing.xxl },
  devOtpBox: { backgroundColor: ob.orangeSoft, borderWidth: 1.5, borderColor: ob.orangeBorder, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.lg, alignItems: 'center' },
  devOtpLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, color: ob.muted, textTransform: 'uppercase', marginBottom: spacing.xs },
  devOtpHint: { fontFamily: fontFamily.displayBlack, fontSize: 28, letterSpacing: 8, color: ob.orange, textAlign: 'center' },
  devOtpNote: { fontSize: 9, color: ob.muted, marginTop: spacing.sm, textAlign: 'center' },
  loginBanner: { backgroundColor: ob.orangeSoft, borderWidth: 1, borderColor: ob.orangeBorder, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.lg },
  loginBannerText: { fontFamily: fontFamily.displayBlack, fontSize: 10, letterSpacing: 2, color: ob.orange, marginBottom: 4 },
  loginBannerSub: { fontSize: 11, color: ob.muted, lineHeight: 16 },
  createInstead: { fontSize: 13, color: colors.green, fontFamily: fontFamily.bodyBold, textDecorationLine: 'underline' },

  avatarPick: { alignItems: 'center', marginBottom: spacing.xl },
  avatarCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: ob.greenSoft, borderWidth: 2, borderColor: ob.greenBorder, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  avatarAdd: { position: 'absolute', bottom: 0, right: 0, width: 22, height: 22, borderRadius: 11, backgroundColor: ob.green, borderWidth: 2, borderColor: ob.surface, alignItems: 'center', justifyContent: 'center' },
  avatarHint: { fontSize: 10, color: ob.green },

  inputGroup: { marginBottom: spacing.xl },
  igLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, color: ob.faint, textTransform: 'uppercase', marginBottom: spacing.sm },
  igField: { width: '100%', height: 50, borderRadius: radius.lg, backgroundColor: ob.surface, borderWidth: 1.5, borderColor: ob.border, paddingHorizontal: spacing.xxxl, fontSize: 14, color: ob.ink },
  handleAt: { position: 'absolute', left: spacing.xxxl, top: 0, bottom: 0, textAlignVertical: 'center', fontSize: 14, fontWeight: '700', color: ob.green, zIndex: 1 },
  handleField: { paddingLeft: spacing.giant + 8 },
  handleAvail: { position: 'absolute', right: spacing.lg, top: 0, bottom: 0, justifyContent: 'center' },
  handleAvailText: { fontSize: 9, fontWeight: '700', backgroundColor: ob.greenSoft, borderWidth: 1, borderColor: ob.greenBorder, color: ob.green, borderRadius: 6, paddingHorizontal: spacing.sm, paddingVertical: 2, overflow: 'hidden' },

  cniHero: { backgroundColor: ob.orangeSoft, borderWidth: 1, borderColor: ob.orangeBorder, borderRadius: radius.xxl, padding: spacing.xxl, alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xl },
  cniTitle: { fontFamily: fontFamily.displayBlack, fontSize: 14, color: ob.ink },
  cniBody: { fontSize: 11, color: ob.muted, lineHeight: 18, textAlign: 'center' },
  cniReason: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, backgroundColor: ob.surface, borderWidth: 1, borderColor: ob.border, borderRadius: radius.md, padding: spacing.lg },
  crText: { flex: 1, fontSize: 11, color: ob.muted, lineHeight: 16.5 },
  cniOpt: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl, backgroundColor: ob.surface, borderWidth: 1.5, borderColor: ob.border, borderRadius: radius.xl, padding: spacing.xl },
  cniOptOn: { backgroundColor: ob.greenSoft, borderColor: ob.greenBorder },
  coTitle: { fontSize: 13, fontWeight: '700', color: ob.ink, marginBottom: 2 },
  coSub: { fontSize: 10, color: ob.muted },
  skipCni: { fontSize: 11, color: ob.faint },

  arrSearch: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: ob.surface, borderWidth: 1.5, borderColor: ob.border, borderRadius: radius.lg, height: 48, paddingHorizontal: spacing.xl, marginBottom: spacing.xl },
  arrSectionLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, color: ob.faint, textTransform: 'uppercase', marginBottom: spacing.md },
  arrItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, backgroundColor: ob.surface, borderWidth: 1.5, borderColor: 'transparent', borderRadius: radius.lg, padding: spacing.xl },
  arrItemOn: { backgroundColor: ob.greenSoft, borderColor: ob.greenBorder },
  aiName: { flex: 1, fontSize: 13, fontWeight: '600', color: ob.ink },
  aiCount: { fontSize: 10, color: ob.faint },
  aiCheck: { width: 18, height: 18, borderRadius: 9, backgroundColor: ob.green, alignItems: 'center', justifyContent: 'center' },

  fmItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl, backgroundColor: ob.surface, borderWidth: 1.5, borderColor: ob.border, borderRadius: radius.xl, padding: spacing.xl },
  fmItemOn: { backgroundColor: ob.greenSoft, borderColor: ob.greenBorder },
  fmIco: { width: 42, height: 42, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  fmName: { fontSize: 13, fontWeight: '700', color: ob.ink, marginBottom: 2 },
  fmSub: { fontSize: 10, color: ob.muted },
  fmBadge: { borderRadius: 6, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  fmBadgeText: { fontSize: 8, fontWeight: '700', letterSpacing: 0.5 },
  badgeFree: { backgroundColor: ob.greenSoft, borderWidth: 1, borderColor: ob.greenBorder },
  badgeStripe: { backgroundColor: 'rgba(250,216,54,0.2)', borderWidth: 1, borderColor: 'rgba(232,146,10,0.35)' },
  emailOnlyPill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.greenA08,
    borderWidth: 1,
    borderColor: colors.greenA20,
    borderRadius: radius.round,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    marginBottom: spacing.lg,
  },
  emailOnlyText: { fontSize: 11, fontFamily: fontFamily.bodyBold, color: colors.greenDark },
  badgeFast: { backgroundColor: ob.orangeSoft, borderWidth: 1, borderColor: ob.orangeBorder },

  fasLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, color: ob.faint, textTransform: 'uppercase', marginBottom: spacing.md },
  fasAmounts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  faChip: { height: 36, paddingHorizontal: spacing.xl, borderRadius: radius.round, backgroundColor: ob.surface, borderWidth: 1.5, borderColor: ob.border, alignItems: 'center', justifyContent: 'center' },
  faChipOn: { backgroundColor: ob.greenSoft, borderColor: ob.greenBorder },
  faChipText: { fontSize: 12, fontWeight: '700', color: ob.ink },
  skipFund: { fontSize: 11, color: ob.faint },
});
