import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { prisma, databaseConfigured } from './prisma.js';
import { profileShape, publicProfileShape, recipientLookupShape, merchantPublicShape, txShape } from './shapes.js';
import {
  hashToken,
  otp,
  reference,
  refreshExpiry,
  signAccessToken,
  signRefreshToken,
} from '../api/_lib/auth.js';
import { walletShape, formatKori, countryFromPhone, countryConfig, nationalToKori } from './kori.js';
import { tierShape } from './tier-limits.js';
import {
  mintKoriFromNationalDeposit,
  creditKoriEarn,
  sendKoriTransfer,
  convertKoriToNational,
  spendKoriAtMerchant,
  ensureReserve,
} from './kori-service.js';
import { reserveShape } from './kori-reserve.js';
import { computeMoiSummary, computeNgorScore, enrollStudentPass, studentPassShape } from './moi-service.js';
import {
  WorkerError,
  activateWorkerProfile,
  getWorkerCreditSummary,
  getWorkerProfile,
  listWorkerReceipts,
  requireWorkerMode,
} from './worker-service.js';
import {
  assertCanCashOut,
  assertCanCreateBusiness,
  assertCanInternational,
  assertCanReceive,
  assertCanSend,
  assertWalletWithinCaps,
  recordDailyCashOut,
  recordDailySend,
  TierLimitError,
  tierErrorStatus,
} from './tier-service.js';
import {
  getKycStatus,
  handleKycWebhook,
  KycError,
  purgeExpiredKycImageMetadata,
  submitAddressVerification,
  submitCniVerification,
  verifySmileWebhookSignature,
  verifySumsubWebhookSignature,
} from './kyc-service.js';
import { normalizeSmsPhone, findUserByPhone } from './sms-service.js';
import { canonicalPhone, phoneVariants as buildPhoneVariants } from './phone-normalize.js';
import { getCultureFeed } from './culture-feed.js';
import { getTrendingFeed } from './trending-feed-service.js';
import {
  buildAlertShareMessage,
  getRegionalAlert,
  markAlertRead,
} from './regional-alerts-service.js';
import {
  acceptMoneyRequest,
  cancelMoneyRequest,
  denyMoneyRequest,
  moneyRequestShape,
  RequestError,
  requestErrorStatus,
} from './money-request-service.js';
import { completeCashIn, railShape, RailError, settleRailFromWebhook, startCashIn, startCashOut } from './rail-service.js';
import { RailUnavailableError, betaDepositsAllowed, otpDisclosureAllowed, unfundedIncentivesAllowed } from './runtime-safety.js';
import { settlePartnerCollectFromWebhook } from './partner-payments-service.js';
import { validationError } from './validation.js';
import {
  PasswordError,
  passwordErrorStatus,
  setUserPassword,
  verifyPassword,
} from './password-service.js';
import {
  PinError,
  pinErrorStatus,
  setBiometricEnabled,
  setUserPin,
  storeCniNumber,
  unlockAccountWithCni,
  verifyUserPin,
} from './pin-service.js';
import { touchActivity } from './session-security.js';
import { assertStepUpForAmount, StepUpRequiredError } from './step-up.js';
import { normalizeAmountToKori, amountToNationalXof, legacyNationalToKori } from './kori-primary.js';
import {
  acceptDelivery,
  confirmDelivery,
  DeliveryError,
  deliveryErrorStatus,
  getDeliveryDetail,
  listNearbyDeliveries,
  createDeliveryTask,
  markDelivered,
  markPickedUp,
  openDispute,
  resolveDispute,
  submitDisputeEvidence,
} from './delivery-service.js';
import {
  InsufficientFundsError,
  isMoneyError,
  moneyErrorStatus,
  runMoneyTransaction,
  transferNational,
} from './wallet-atomic.js';
import { gateOrExecute } from './risk-gate.js';
import { attachReferralOnSignup, ensureUserInviteCode } from './invite-service.js';
import { assertEventCapacity, createTicketPasses, ticketShape } from './event-ticket-service.js';
import { registerDeviceLogin, verifyDeviceWithOtp } from './device-session.js';
import { deviceIdFromRequest } from './geo-ip.js';
import {
  approveHeldTransaction,
  HeldTransactionError,
  listFraudAlerts,
  listHeldTransactions,
  rejectHeldTransaction,
} from './held-transaction-service.js';
import { assignKebuId, BUSINESS_TYPES } from './kebu-id.js';
import { ensureBusinessWallet } from './business-wallet-service.js';
import { assignAfriId, ensureAfriId } from './afri-id.js';
import { releaseTontinePot, TontineError } from './tontine-service.js';
import {
  assertCanMessageInThread,
  getFriendRelation,
  listFriendRequests,
  listFriends,
  removeFriend,
  respondFriendRequest,
  sendFriendRequest,
  FriendError,
} from './friends-service.js';
import { isConfirmed, vouchForUser, vouchStatus, VouchError } from './vouch-service.js';
import { mintCallToken, CallError } from './calls-service.js';
import { shareToMbolo, MboloShareError } from './mbolo-share-service.js';
import { blobConfigured, mintMboloVideoUploadToken } from './mbolo-video-service.js';
import { broadcastMboloMessage, BroadcastError } from './mbolo-broadcast-service.js';
import {
  getMediaReadUrl,
  MboloMediaError,
  rejectLegacyDataUrl,
  resolveMessageMediaUrl,
  supabaseStorageConfigured,
} from './mbolo-media-storage-service.js';
import { resolveGifForMessage } from './mbolo-gif-service.js';
import {
  buildReceiptPayload,
  postPaymentReceipt,
} from './mbolo-receipt-service.js';
import { ensureTontineThread, postTontineEscrowCard } from './mbolo-commerce-service.js';
import { markThreadRead } from './mbolo-presence-service.js';
import { getPlatformConfig } from './platform-config.js';
import { buildUserPayUrl, buildGroupJoinUrl, buildWebGroupJoinUrl } from './k21-qr.js';
import { generateInviteCode } from './invite-service.js';
import { createInAppNotification, notifyDepositReceived, notifyMoneyReceived } from './notify-service.js';
import { getMerchantVoucherBalance, listMerchantVouchers, spendMerchantVoucher } from './merchant-voucher-service.js';
import { handleInboundSms, sendOtpSms, smsConfigured, verifySmsWebhook } from './sms-service.js';
import { JULAYA_OPERATORS, julayaMode, parseWebhookPayload, verifyWebhookSignature } from './julaya.js';
import { sendOtpEmail, emailConfigured } from './email-service.js';
import { authSecretsConfigured } from './auth-config.js';
import {
  findUserByEmail,
  normalizeEmail,
  otpKeyForEmail,
  otpKeysForPhone,
  syntheticPhoneForEmail,
} from './auth-otp.js';

import { authConfigStatus } from './auth-config.js';
import { smsConfig } from './sms-config.js';
import { assertCronAuth } from './cron-auth.js';
import { createTransferUndoInTx, handleTransferUndoError, undoShape, undoTransfer } from './transfer-undo-service.js';
import { ChartsError, getWeeklyChart, submitAndVote, voteForSong } from './charts-service.js';
import { searchYouTubeMusic } from './youtube-music.js';
import { geocodeSearch } from './geocode.js';
import { ReviewError, getBusinessReviews, ratingSummaries, upsertReview } from './reviews-service.js';
import { PollError, activePollShape, askPoll, closePoll, votePoll } from './polls-service.js';
import { ChannelError, browseChannels, deletePost, followFeed, myChannel, publishPost, setFollow, upsertChannel, viewChannel } from './channels-service.js';

const bootedAt = Date.now();

async function requireWallet(userId) {
  return prisma.wallet.findUniqueOrThrow({ where: { userId } });
}

async function ensureRole(userId, role) {
  return prisma.accountRole.upsert({
    where: { userId_role: { userId, role } },
    update: { status: 'active' },
    create: { userId, role },
  });
}

const phoneBody = z.object({
  phone: z.string().min(8).max(24),
  intent: z.enum(['login', 'signup', 'recover']).optional().default('signup'),
});
const verifyBody = z
  .object({
    phone: z.string().min(8).max(24).optional(),
    email: z.string().email().optional(),
    otp: z.string().trim().length(6),
    intent: z.enum(['login', 'signup', 'recover']).optional().default('signup'),
  })
  .refine((v) => Boolean(v.phone) !== Boolean(v.email), {
    message: 'Provide phone or email, not both',
  });
const emailAuthBody = z.object({
  email: z.string().email(),
  intent: z.enum(['login', 'signup', 'recover']).optional().default('login'),
});
const passwordLoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});
const passwordSetBody = z.object({
  password: z.string().min(8).max(128),
});
const passwordSetWithOtpBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  otp: z.string().trim().length(6),
});

function normalizeAuthPhone(raw) {
  return canonicalPhone(raw) ?? normalizeSmsPhone(raw) ?? String(raw).replace(/\s/g, '');
}

function phoneVariants(normalized) {
  return buildPhoneVariants(normalized);
}

async function findValidOtpForKeys(keys, code) {
  const trimmedCode = String(code).trim();
  const variants = [...new Set(keys.filter(Boolean))];
  if (!variants.length) return null;

  const latest = await prisma.otpCode.findFirst({
    where: { phone: { in: variants }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) return null;
  return latest.code === trimmedCode ? latest : null;
}

async function findValidOtp(normalizedPhone, code) {
  return findValidOtpForKeys(phoneVariants(normalizedPhone), code);
}

function isEmailSchemaError(err) {
  const msg = err?.message ?? '';
  return (
    err?.code === 'P2022' ||
    /Unknown arg `email`/i.test(msg) ||
    /column [`"]?User\.email/i.test(msg) ||
    /column [`"]?emailVerifiedAt/i.test(msg)
  );
}

async function createEmailAuthUser(emailNorm) {
  const { currency } = countryConfig('SN');
  const base = {
    phone: syntheticPhoneForEmail(emailNorm),
    country: 'SN',
    otpVerifiedAt: new Date(),
    lastActivityAt: new Date(),
    wallet: { create: { currency } },
    roles: { create: { role: 'personal' } },
  };
  const select = { id: true };

  try {
    return await prisma.user.create({
      data: { ...base, email: emailNorm, emailVerifiedAt: new Date() },
      select,
    });
  } catch (err) {
    if (err.code === 'P2002') {
      const existing = await findUserByEmail(prisma, emailNorm);
      if (existing) return existing;
    }
    if (isEmailSchemaError(err)) {
      console.warn('[authVerify] email columns missing — using synthetic phone user');
      return prisma.user.create({ data: base, select });
    }
    throw err;
  }
}

async function updateVerifiedUser(user, updateData) {
  const select = { id: true };
  try {
    return await prisma.user.update({ where: { id: user.id }, data: updateData, select });
  } catch (err) {
    if (isEmailSchemaError(err)) {
      const { emailVerifiedAt, email, ...rest } = updateData;
      return prisma.user.update({ where: { id: user.id }, data: rest, select });
    }
    throw err;
  }
}

async function issueAuthSession(req, res, user, { isNewUser, intent, otpKeys }) {
  if (!authSecretsConfigured()) {
    res.status(503).json({
      error: 'Connexion temporairement indisponible. Réessaie dans quelques minutes.',
      code: 'auth_not_configured',
      hint: 'JWT secrets missing on server — set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in Vercel.',
    });
    return;
  }

  if (!user?.id) {
    res.status(500).json({ error: 'Connexion impossible — compte introuvable.', code: 'auth_user_missing' });
    return;
  }

  await prisma.otpCode.deleteMany({ where: { phone: { in: otpKeys } } });

  const accessToken = signAccessToken(user.id);
  const refreshToken = signRefreshToken(user.id);
  try {
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiry() },
    });
  } catch (err) {
    console.error('[authVerify] refreshToken store failed (access token still issued)', err);
  }

  try {
    await touchActivity(user.id);
  } catch (err) {
    console.error('[authVerify] touchActivity failed', err);
  }

  let device = {
    isNewDevice: false,
    requiresVerification: false,
    devicesLast24h: 0,
    flags: [],
  };
  try {
    device = await registerDeviceLogin(user.id, req);
  } catch (err) {
    console.error('[authVerify] registerDeviceLogin failed', err);
  }

  let profile = null;
  if (!isNewUser) {
    try {
      let full = await prisma.user.findUnique({ where: { id: user.id } });
      if (full && !full.afriId) {
        try {
          full = await ensureAfriId(user.id);
        } catch (afriErr) {
          console.warn('[authVerify] afriId assign skipped', afriErr?.message);
        }
      }
      if (full) profile = profileShape(full, { accountType: 'personal' });
    } catch (err) {
      console.error('[authVerify] profile snapshot failed', err);
    }
  }

  res.json({
    accessToken,
    refreshToken,
    isNewUser,
    profile,
    recoverPin: intent === 'recover',
    deviceVerificationRequired: device.requiresVerification,
    device: {
      isNew: device.isNewDevice,
      requiresVerification: device.requiresVerification,
      devicesLast24h: device.devicesLast24h,
      flags: device.flags,
    },
  });
}
const arrondissementBody = z.object({ key: z.string(), icon: z.string().optional(), name: z.string() });
const completeProfileBody = z.object({
  name: z.string().min(2),
  handle: z.string().min(3).regex(/^[a-z0-9_]+$/),
  arrondissement: arrondissementBody,
  fundAmount: z.number().int().min(0).default(0),
  identityChoice: z.string().optional(),
  avatarEmoji: z.string().max(8).optional(),
  avatarUrl: z.string().max(400_000).optional().nullable(),
  cniNumber: z.string().min(6).max(24).optional(),
  isDiaspora: z.boolean().optional(),
  countryCode: z.string().length(2).optional(),
  email: z.string().email().optional(),
  inviteRef: z.string().min(4).max(16).optional(),
});
const recoverBody = z.object({
  phone: z.string().min(8).max(24),
  email: z.string().email(),
});
const refreshBody = z.object({ refreshToken: z.string().min(1) });
const cashBody = z.object({
  amount: z.number().int().positive(),
  operator: z.enum(JULAYA_OPERATORS),
  phone: z.string().min(8).max(24).optional(),
});

async function checkOtpRateLimitForKeys(keys) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (!uniqueKeys.length) return false;
  const total = await prisma.otpCode.count({
    where: { phone: { in: uniqueKeys }, createdAt: { gt: oneHourAgo } },
  });
  return total < 5;
}

async function checkOtpRateLimit(phone) {
  return checkOtpRateLimitForKeys(phoneVariants(phone));
}

export async function health(req, res) {
  const deep = req.query?.deep === '1';
  const checkedAt = new Date().toISOString();
  const base = {
    status: 'ok',
    service: 'joko-api',
    checkedAt,
    uptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000),
    // Which code is actually live — ground truth when debugging deploys.
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE?.slice(0, 60) ?? null,
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    const payload = { ...base, db: 'ok' };
    // Login-critical schema probe: the exact columns the auth check reads.
    payload.loginSchemaOk = await prisma.user
      .findFirst({ select: { id: true, frozenByAdminAt: true, accountLockedAt: true, lastActivityAt: true } })
      .then(() => true)
      .catch(() => false);

    if (deep) {
      const [pendingRails, openFraud, reserve, emailSchemaOk] = await Promise.all([
        prisma.railTransaction.count({ where: { status: 'pending' } }),
        prisma.fraudAlert.count({ where: { acknowledgedAt: null } }),
        prisma.koriReserve.findUnique({ where: { id: 'global' } }),
        prisma.user
          .findFirst({ select: { id: true, email: true, emailVerifiedAt: true } })
          .then(() => true)
          .catch(() => false),
      ]);
      payload.ops = {
        pendingRails,
        openFraudAlerts: openFraud,
        koriReserveXof: reserve?.totalReserveHeldXof ?? null,
      };
      payload.auth = { ...authConfigStatus(), emailSchemaOk };
      if (!payload.auth.jwtAccess || !payload.auth.jwtRefresh) {
        payload.auth.hint =
          'Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in Vercel (each ≥16 chars). Generate: openssl rand -base64 32';
      }
    }

    res.json(payload);
  } catch (error) {
    console.error('[health] db check failed', error);
    const hint = !databaseConfigured()
      ? 'DATABASE_URL is not set on the server'
      : error.message?.includes('P1001') || error.message?.includes("Can't reach")
        ? 'Database unreachable — check Supabase pooler URL (port 6543) and ?sslmode=require'
        : undefined;
    res.status(503).json({
      ...base,
      status: 'degraded',
      db: 'error',
      ...(hint ? { hint } : {}),
    });
  }
}

/** Public capability map for K21 + future apps (Rect, partners). */
export async function platformConfig(_req, res) {
  res.json(getPlatformConfig());
}

export async function authPhone(req, res) {
  const parsed = phoneBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const normalized = normalizeAuthPhone(parsed.data.phone);
  const storedPhone = canonicalPhone(normalized) ?? normalized;
  const intent = parsed.data.intent ?? 'signup';

  if (intent === 'login' || intent === 'recover') {
    const existing = await findUserByPhone(storedPhone);
    if (!existing) {
      res.status(404).json({ error: 'Aucun compte K21 pour ce numéro — crée un compte d\'abord.' });
      return;
    }
  }

  if (!(await checkOtpRateLimit(storedPhone))) {
    res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
    return;
  }

  const code = otp();
  await prisma.otpCode.create({
    data: { phone: storedPhone, code, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  });

  try {
    await sendOtpSms(storedPhone, code);
  } catch (smsError) {
    console.error('[authPhone] SMS delivery failed (OTP saved)', smsError);
  }

  const allowBetaOtp = process.env.ALLOW_BETA_OTP === 'true';
  const hideOtp = process.env.NODE_ENV === 'production' && !allowBetaOtp && smsConfigured();

  if (hideOtp) {
    res.json({ sent: true, message: 'Code envoyé par SMS' });
  } else {
    res.json({
      otp: code,
      phoneNormalized: storedPhone,
      sms: smsConfigured() ? 'sent' : allowBetaOtp ? 'beta' : 'mock',
      ...(allowBetaOtp ? { betaOtp: true } : {}),
    });
  }
}

/** Email OTP — signup, sign-in, and recover (no phone required during beta). */
export async function authEmail(req, res) {
  const parsed = emailAuthBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const emailNorm = normalizeEmail(parsed.data.email);
  const intent = parsed.data.intent ?? 'login';
  const otpKey = otpKeyForEmail(emailNorm);

  const existing = await findUserByEmail(prisma, emailNorm);

  if (intent === 'signup') {
    if (existing) {
      res.status(409).json({ error: 'Un compte existe déjà pour cet email — connecte-toi.' });
      return;
    }
  } else if (intent === 'recover' && !existing) {
    res.status(404).json({
      error: 'Aucun compte K21 pour cet email — crée un compte d\'abord.',
    });
    return;
  }
  // login: always send OTP — new emails create an account after verify (no dead-end 404)

  if (!(await checkOtpRateLimitForKeys([otpKey]))) {
    res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
    return;
  }

  const code = otp();
  await prisma.otpCode.deleteMany({ where: { phone: otpKey } });
  await prisma.otpCode.create({
    data: { phone: otpKey, code, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  });

  let emailDelivered = false;
  try {
    const emailResult = await sendOtpEmail(emailNorm, code);
    emailDelivered = emailResult?.delivered === true;
  } catch (emailError) {
    console.error('[authEmail] Email delivery failed (OTP saved)', emailError);
  }

  const allowBetaOtp = process.env.ALLOW_BETA_OTP === 'true';
  // When email delivery succeeds, never expose the OTP in the API response —
  // the user reads it from their inbox. On-screen beta box caused confusion.
  const hideOtp =
    emailDelivered || (!allowBetaOtp && emailConfigured());

  if (hideOtp) {
    res.json({
      sent: true,
      message: emailDelivered ? 'Code envoyé par email' : 'Code envoyé',
      emailSent: emailDelivered,
      accountExists: Boolean(existing),
    });
  } else {
    res.json({
      otp: code,
      emailNormalized: emailNorm,
      email: emailDelivered ? 'sent' : emailConfigured() ? 'sent' : allowBetaOtp ? 'beta' : 'mock',
      emailSent: emailDelivered,
      accountExists: Boolean(existing),
      ...(allowBetaOtp ? { betaOtp: true } : {}),
    });
  }
}

/** Email + password sign-in (optional alternative to OTP). */
export async function authPasswordLogin(req, res) {
  const parsed = passwordLoginBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const emailNorm = normalizeEmail(parsed.data.email);
  const user = await findUserByEmail(prisma, emailNorm);
  if (!user) {
    res.status(401).json({ error: 'Email ou mot de passe incorrect.', code: 'invalid_credentials' });
    return;
  }

  let row;
  try {
    row = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        passwordHash: true,
        frozenByAdminAt: true,
        accountLockedAt: true,
      },
    });
  } catch (err) {
    if (err?.code === 'P2022') {
      res.status(401).json({
        error: 'Mot de passe pas encore activé — utilise le code email.',
        code: 'password_not_set',
      });
      return;
    }
    throw err;
  }

  if (row.frozenByAdminAt) {
    res.status(423).json({ error: 'Compte suspendu — contacte le support K21.', code: 'account_frozen' });
    return;
  }
  if (row.accountLockedAt) {
    res.status(423).json({
      error: 'Compte verrouillé — utilise « Récupérer mon accès » pour le débloquer.',
      code: 'account_locked',
    });
    return;
  }
  if (!row.passwordHash) {
    res.status(401).json({
      error: 'Aucun mot de passe défini — utilise le code email ou définis-en un après connexion.',
      code: 'password_not_set',
    });
    return;
  }

  const ok = await verifyPassword(parsed.data.password, row.passwordHash);
  if (!ok) {
    res.status(401).json({ error: 'Email ou mot de passe incorrect.', code: 'invalid_credentials' });
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastActivityAt: new Date(),
      otpVerifiedAt: new Date(),
      emailVerifiedAt: new Date(),
      pinFailedAttempts: 0,
      accountLockedAt: null,
      accountLockReason: null,
    },
  });

  await issueAuthSession(req, res, { id: user.id }, {
    isNewUser: false,
    intent: 'login',
    otpKeys: [otpKeyForEmail(emailNorm)],
  });
}

/** Set or update login password while signed in. */
export async function authPasswordSet(req, res) {
  const parsed = passwordSetBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    await setUserPassword(req.userId, parsed.data.password);
    res.json({ ok: true, message: 'Mot de passe enregistré' });
  } catch (error) {
    if (error instanceof PasswordError) {
      res.status(passwordErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    if (error?.code === 'P2022') {
      res.status(503).json({
        error: 'Mise à jour en cours — réessaie dans quelques minutes.',
        code: 'db_schema_outdated',
      });
      return;
    }
    throw error;
  }
}

/** Set login password using a one-time email code (no session required). */
export async function authPasswordSetWithOtp(req, res) {
  const parsed = passwordSetWithOtpBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const emailNorm = normalizeEmail(parsed.data.email);
  const otpKeys = [otpKeyForEmail(emailNorm)];
  const stored = await findValidOtpForKeys(otpKeys, parsed.data.otp);
  if (!stored) {
    res.status(401).json({ error: 'Code invalide ou expiré', code: 'invalid_otp' });
    return;
  }

  const user = await findUserByEmail(prisma, emailNorm);
  if (!user) {
    res.status(404).json({ error: 'Aucun compte K21 pour cet email.', code: 'user_not_found' });
    return;
  }

  try {
    await setUserPassword(user.id, parsed.data.password);
    await prisma.otpCode.deleteMany({ where: { phone: { in: otpKeys } } });
    res.json({ ok: true, message: 'Mot de passe enregistré — tu peux te connecter avec.' });
  } catch (error) {
    if (error instanceof PasswordError) {
      res.status(passwordErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    if (error?.code === 'P2022') {
      res.status(503).json({
        error: 'Mise à jour en cours — réessaie dans quelques minutes.',
        code: 'db_schema_outdated',
      });
      return;
    }
    throw error;
  }
}

/** Forgot access — SMS + email OTP for existing accounts (resets app PIN after verify). */
export async function authRecover(req, res) {
  const parsed = recoverBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const normalized = normalizeAuthPhone(parsed.data.phone);
  const emailNorm = parsed.data.email.toLowerCase().trim();

  const user = await findUserByPhone(normalized);
  if (!user) {
    res.status(404).json({ error: 'Aucun compte K21 pour ce numéro.' });
    return;
  }

  if (user.email && user.email.toLowerCase() !== emailNorm) {
    res.status(400).json({ error: 'Cet email ne correspond pas à ce compte.' });
    return;
  }

  if (!(await checkOtpRateLimit(normalized))) {
    res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
    return;
  }

  if (!user.email) {
    await prisma.user.update({ where: { id: user.id }, data: { email: emailNorm } });
  }

  const code = otp();
  await prisma.otpCode.create({
    data: { phone: normalized, code, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  });

  try {
    await sendOtpSms(normalized, code);
  } catch (smsError) {
    console.error('[authRecover] SMS failed (OTP saved)', smsError);
  }

  try {
    await sendOtpEmail(user.email ?? emailNorm, code);
  } catch (emailError) {
    console.error('[authRecover] Email failed (OTP saved)', emailError);
  }

  const allowBetaOtp = process.env.ALLOW_BETA_OTP === 'true';
  const hideOtp = process.env.NODE_ENV === 'production' && !allowBetaOtp && smsConfigured();

  if (hideOtp) {
    res.json({ sent: true, message: 'Code envoyé par SMS et email', emailSent: true });
  } else {
    res.json({
      otp: code,
      sms: smsConfigured() ? 'sent' : allowBetaOtp ? 'beta' : 'mock',
      email: emailConfigured() ? 'sent' : allowBetaOtp ? 'beta' : 'mock',
      emailSent: true,
      ...(allowBetaOtp ? { betaOtp: true } : {}),
    });
  }
}

export async function authVerify(req, res) {
  const parsed = verifyBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { otp: code, intent = 'signup' } = parsed.data;
  const isEmailLogin = Boolean(parsed.data.email);

  let otpKeys;
  let user;
  let hintMeta = {};

  if (isEmailLogin) {
    const emailNorm = normalizeEmail(parsed.data.email);
    otpKeys = [otpKeyForEmail(emailNorm)];
    user = await findUserByEmail(prisma, emailNorm);
    hintMeta = { emailNormalized: emailNorm };
  } else {
    const normalized = normalizeAuthPhone(parsed.data.phone);
    const storedPhone = canonicalPhone(normalized) ?? normalized;
    otpKeys = otpKeysForPhone(storedPhone);
    user = await findUserByPhone(storedPhone);
    hintMeta = { phoneNormalized: storedPhone };
  }

  const stored = await findValidOtpForKeys(otpKeys, code);

  if (!stored) {
    res.status(401).json({
      error: 'Invalid or expired OTP',
      ...(process.env.ALLOW_BETA_OTP === 'true' || emailConfigured()
        ? {
            hint: isEmailLogin
              ? 'Tap « Renvoyer », then enter the newest code from your email (or the orange box if shown).'
              : 'Request a new code. Use the latest code.',
            ...hintMeta,
          }
        : {}),
    });
    return;
  }

  let isNewUser = false;

  if (!user) {
    if (intent === 'recover' || (!isEmailLogin && intent === 'login')) {
      res.status(404).json({
        error: isEmailLogin
          ? 'Aucun compte K21 pour cet email — crée un compte d\'abord.'
          : 'Aucun compte K21 pour ce numéro — crée un compte d\'abord.',
      });
      return;
    }
    isNewUser = true;
    if (isEmailLogin) {
      const emailNorm = normalizeEmail(parsed.data.email);
      user = await createEmailAuthUser(emailNorm);
    } else {
      const normalized = normalizeAuthPhone(parsed.data.phone);
      const country = countryFromPhone(normalized);
      const { currency } = countryConfig(country);
      user = await prisma.user.create({
        data: {
          phone: normalized,
          country,
          otpVerifiedAt: new Date(),
          lastActivityAt: new Date(),
          wallet: { create: { currency } },
          roles: { create: { role: 'personal' } },
        },
        select: { id: true },
      });
    }
    try {
      await ensureReserve(prisma);
    } catch (err) {
      console.error('[authVerify] ensureReserve failed', err);
    }
  } else {
    const updateData = {
      otpVerifiedAt: new Date(),
      lastActivityAt: new Date(),
      // A verified OTP re-proves control of the email/phone. Clear any PIN
      // brute-force lock so the real owner can always get back in — without
      // this, a locked account 401s on every call right after a successful
      // login (dead end). Admin freezes are NOT cleared here.
      pinFailedAttempts: 0,
      accountLockedAt: null,
      accountLockReason: null,
      ...(isEmailLogin ? { emailVerifiedAt: new Date() } : {}),
      ...(intent === 'recover' ? { pinHash: null } : {}),
    };
    user = await updateVerifiedUser(user, updateData);
  }

  await issueAuthSession(req, res, user, { isNewUser, intent, otpKeys });
}

export async function authRefresh(req, res) {
  const parsed = refreshBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const { refreshToken } = parsed.data;
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    if (!payload.sub || payload.type !== 'refresh') throw new Error('Invalid refresh token');

    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      res.status(401).json({ error: 'Invalid or revoked refresh token' });
      return;
    }

    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    const nextRefreshToken = signRefreshToken(payload.sub);
    await prisma.refreshToken.create({
      data: { userId: payload.sub, tokenHash: hashToken(nextRefreshToken), expiresAt: refreshExpiry() },
    });

    res.json({ accessToken: signAccessToken(payload.sub), refreshToken: nextRefreshToken });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
}

export async function authCompleteProfile(req, res) {
  const parsed = completeProfileBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  // Signup must never mint wallet credit — real top-up via /api/cash/in when rails are live.
  const body = { ...parsed.data, fundAmount: 0 };

  const existingHandle = await prisma.user.findFirst({
    where: { handle: body.handle, NOT: { id: req.userId } },
  });
  if (existingHandle) {
    res.status(409).json({ error: 'Handle already taken' });
    return;
  }

  const result = await prisma.$transaction(async (db) => {
    const countryUpdate = body.countryCode
      ? { country: body.countryCode, isDiaspora: body.isDiaspora ?? body.countryCode !== 'SN' }
      : { isDiaspora: body.isDiaspora ?? false };

    const user = await db.user.update({
      where: { id: req.userId },
      data: {
        name: body.name,
        handle: body.handle,
        arrondissementKey: body.arrondissement.key,
        arrondissementIcon: body.arrondissement.icon ?? '📍',
        arrondissementName: body.arrondissement.name,
        avatarEmoji: body.avatarEmoji ?? '👤',
        avatarUrl: body.avatarUrl ?? undefined,
        identityChoice: body.identityChoice,
        ...(body.email ? { email: body.email.toLowerCase().trim(), emailVerifiedAt: new Date() } : {}),
        ...countryUpdate,
      },
    });

    const withAfri = user.afriId
      ? user
      : await db.user.update({
          where: { id: user.id },
          data: { afriId: await assignAfriId(db) },
        });

    if (body.countryCode) {
      const { currency } = countryConfig(body.countryCode);
      await db.wallet.update({
        where: { userId: user.id },
        data: { currency },
      });
    }

    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    let tx = null;
    let koriMinted = 0;

    if (body.fundAmount > 0) {
      const ref = reference('TOPUP');
      const mint = await mintKoriFromNationalDeposit(db, {
        userId: user.id,
        walletId: wallet.id,
        country: user.country,
        nationalAmount: body.fundAmount,
        reference: ref,
        note: 'Dépôt initial — conversion nationale → Kori',
      });
      koriMinted = mint.koriMinted;
      tx = await db.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          userId: user.id,
          type: 'external_topup',
          amount: koriMinted,
          note: `Dépôt initial · +${formatKori(koriMinted)} Kori`,
          reference: ref,
        },
      });
    }

    const updatedWallet = await db.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    await ensureUserInviteCode(db, user.id);
    return { user: withAfri, wallet: updatedWallet, tx, koriMinted };
  });

  if (body.inviteRef) {
    await attachReferralOnSignup(prisma, req.userId, body.inviteRef).catch(() => null);
  }

  if (body.cniNumber) {
    // Legacy path — prefer POST /api/kyc/cni/submit for Tier 2 upgrade
    await storeCniNumber(req.userId, body.cniNumber);
  }

  res.json({
    profile: profileShape(result.user),
    ...walletShape(result.wallet),
    koriMinted: result.koriMinted,
    transactions: result.tx ? [txShape(result.tx)] : [],
  });
}

function handlePinError(res, error) {
  if (error instanceof PinError) {
    res.status(pinErrorStatus(error.code)).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

function handleStepUpError(res, error) {
  if (error instanceof StepUpRequiredError) {
    res.status(403).json({
      error: error.message,
      code: error.code,
      thresholdXOF: 50_000,
    });
    return true;
  }
  return false;
}

export async function authPinSet(req, res) {
  const schema = z.object({ pin: z.string().regex(/^\d{6,}$/) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    await setUserPin(req.userId, parsed.data.pin);
    res.json({ ok: true, message: 'PIN configured' });
  } catch (error) {
    if (handlePinError(res, error)) return;
    throw error;
  }
}

export async function authPinVerify(req, res) {
  const schema = z.object({
    pin: z.string().regex(/^\d{6,}$/),
    forStepUp: z.boolean().optional().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const result = await verifyUserPin(req.userId, parsed.data.pin, { grantStepUp: parsed.data.forStepUp });
    res.json({ verified: true, stepUpToken: result.stepUpToken });
  } catch (error) {
    if (handlePinError(res, error)) return;
    throw error;
  }
}

export async function authPinUnlock(req, res) {
  const schema = z.object({ cniNumber: z.string().min(6).max(24) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const result = await unlockAccountWithCni(req.userId, parsed.data.cniNumber);
    res.json(result);
  } catch (error) {
    if (handlePinError(res, error)) return;
    throw error;
  }
}

export async function authBiometric(req, res) {
  const schema = z.object({ enabled: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
  if (!user.pinHash) {
    res.status(400).json({ error: 'Set a PIN before enabling biometrics' });
    return;
  }

  await setBiometricEnabled(req.userId, parsed.data.enabled);
  res.json({ biometricEnabled: parsed.data.enabled });
}

export async function authDeviceVerify(req, res) {
  const schema = z.object({
    phone: z.string().min(8).max(24),
    otp: z.string().length(6),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const normalized = parsed.data.phone.replace(/\s/g, '');
  const stored = await prisma.otpCode.findFirst({
    where: { phone: normalized, code: parsed.data.otp, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!stored) {
    res.status(401).json({ error: 'Invalid or expired OTP' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { phone: normalized } });
  if (!user || user.id !== req.userId) {
    res.status(403).json({ error: 'Phone does not match signed-in account' });
    return;
  }

  const deviceId = deviceIdFromRequest(req);
  if (!deviceId) {
    res.status(400).json({ error: 'X-Device-Id header required' });
    return;
  }

  await verifyDeviceWithOtp(user.id, deviceId);
  await prisma.otpCode.deleteMany({ where: { phone: normalized } });

  res.json({ verified: true, message: 'Device verified' });
}

function requireAdmin(req, res) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    res.status(401).json({ error: 'Admin authorization required' });
    return false;
  }
  return true;
}

export async function adminHeldTransactionsList(req, res) {
  if (!requireAdmin(req, res)) return;
  const status = req.query.status ?? 'pending_review';
  const items = await listHeldTransactions({ status: String(status) });
  res.json(
    items.map((h) => ({
      id: h.id,
      userId: h.userId,
      operationType: h.operationType,
      status: h.status,
      amountNational: h.amountNational,
      flags: JSON.parse(h.flagsJson),
      reference: h.reference,
      expiresAt: h.expiresAt.toISOString(),
      createdAt: h.createdAt.toISOString(),
      alerts: h.fraudAlerts,
    })),
  );
}

export async function adminHeldTransactionApprove(req, res) {
  if (!requireAdmin(req, res)) return;
  const schema = z.object({ note: z.string().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const result = await approveHeldTransaction(req.query.id, req.userId ?? 'admin', parsed.data.note);
    res.json(result);
  } catch (error) {
    if (error instanceof HeldTransactionError) {
      res.status(400).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function adminHeldTransactionReject(req, res) {
  if (!requireAdmin(req, res)) return;
  const schema = z.object({ reason: z.string().min(3) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const held = await rejectHeldTransaction(req.query.id, req.userId ?? 'admin', parsed.data.reason);
    res.json(held);
  } catch (error) {
    if (error instanceof HeldTransactionError) {
      res.status(400).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function adminFraudAlerts(req, res) {
  if (!requireAdmin(req, res)) return;
  const alerts = await listFraudAlerts({ unacknowledgedOnly: true });
  res.json(alerts);
}

function handleTierError(res, error) {
  if (error instanceof TierLimitError) {
    res.status(tierErrorStatus(error.code)).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

function handleKycError(res, error) {
  if (error instanceof KycError) {
    res.status(400).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

export async function kycStatus(req, res) {
  const status = await getKycStatus(req.userId);
  res.json(status);
}

export async function kycCniSubmit(req, res) {
  const schema = z.object({
    frontImage: z.string().min(100),
    backImage: z.string().min(100),
    selfieImage: z.string().min(100).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const result = await submitCniVerification(req.userId, parsed.data);
    res.status(202).json(result);
  } catch (error) {
    if (handleKycError(res, error)) return;
    throw error;
  }
}

export async function kycAddressSubmit(req, res) {
  const schema = z.object({
    addressLine: z.string().min(5),
    city: z.string().min(2),
    region: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const result = await submitAddressVerification(req.userId, parsed.data);
    res.json(result);
  } catch (error) {
    if (handleKycError(res, error)) return;
    throw error;
  }
}

export async function webhooksKycSmile(req, res) {
  const rawBody = req.rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
  const payload = JSON.parse(rawBody || '{}');

  if (!verifySmileWebhookSignature(payload)) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  const result = await handleKycWebhook('smile_id', payload);
  res.json(result);
}

export async function webhooksKycSumsub(req, res) {
  const rawBody = req.rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));

  if (!verifySumsubWebhookSignature(req.headers, rawBody)) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  const result = await handleKycWebhook('sumsub', JSON.parse(rawBody || '{}'));
  res.json(result);
}

export async function kycPurgeCron(req, res) {
  if (!assertCronAuth(req, res)) return;
  const purged = await purgeExpiredKycImageMetadata();
  res.json(purged);
}

export async function cultureFeed(req, res) {
  const country = String(req.query?.country ?? 'SN').toUpperCase().slice(0, 2);
  const q = String(req.query?.q ?? '');
  res.json(await getCultureFeed({ country, query: q }));
}

export async function trendingFeed(req, res) {
  const tab = String(req.query?.tab ?? 'all');
  const q = String(req.query?.q ?? '');
  res.json(await getTrendingFeed(req.userId, { tab, query: q }));
}

export async function trendingAlertDetail(req, res) {
  const alertId = req.query.id;
  const alert = await getRegionalAlert(req.userId, alertId);
  if (!alert) {
    res.status(404).json({ error: 'Alerte introuvable ou hors zone' });
    return;
  }
  res.json(alert);
}

export async function trendingAlertRead(req, res) {
  const alertId = req.query.id;
  const alert = await getRegionalAlert(req.userId, alertId);
  if (!alert) {
    res.status(404).json({ error: 'Alerte introuvable' });
    return;
  }
  await markAlertRead(req.userId, alertId);
  if (alertId && !String(alertId).startsWith('seed-')) {
    await prisma.notification.updateMany({
      where: { userId: req.userId, kind: 'alert', refId: alertId, read: false },
      data: { read: true },
    });
  }
  res.json({ ok: true });
}

export async function trendingAlertShare(req, res) {
  const alertId = req.query.id;
  const alert = await getRegionalAlert(req.userId, alertId);
  if (!alert) {
    res.status(404).json({ error: 'Alerte introuvable' });
    return;
  }
  const ctx = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { arrondissementName: true },
  });
  res.json({
    message: buildAlertShareMessage(alert, ctx?.arrondissementName),
    alertId: alert.id,
  });
}

export async function getMe(req, res) {
  const user = await ensureAfriId(req.userId);
  const [ownedBusinesses, worker, roles] = await Promise.all([
    prisma.business.findMany({
      where: { ownerId: req.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, type: true, category: true, kebuId: true, verified: true },
    }),
    getWorkerProfile(req.userId),
    prisma.accountRole.findMany({
      where: { userId: req.userId, status: 'active' },
      select: { role: true },
    }),
  ]);
  const primary = ownedBusinesses[0] ?? null;
  const roleList = roles.map((r) => r.role);
  res.json(
    profileShape(user, {
      accountType: primary?.type === 'cooperative' ? 'cooperative' : primary ? 'business' : 'personal',
      businesses: ownedBusinesses,
      business: primary,
      payQrUrl: user.handle ? buildUserPayUrl(user.handle) : null,
      studentPass: studentPassShape(user),
      worker,
      roles: roleList,
      isAgent: roleList.includes('agent'),
    }),
  );
}

export async function getMeSummary(req, res) {
  res.json(await computeMoiSummary(req.userId));
}

const studentPassBody = z.object({
  schoolName: z.string().min(2).max(120),
});

export async function meStudentPass(req, res) {
  if (req.method === 'GET') {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    res.json(studentPassShape(user));
    return;
  }

  const parsed = studentPassBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const updated = await enrollStudentPass(req.userId, parsed.data.schoolName);
  res.status(201).json(studentPassShape(updated));
}

const mePatchBody = z.object({
  email: z.string().email().optional(),
  name: z.string().min(2).max(80).optional(),
  smsBalanceQueryEnabled: z.boolean().optional(),
  avatarUrl: z.string().max(400_000).optional().nullable(),
  avatarEmoji: z.string().max(8).optional(),
  statusText: z.string().max(80).optional().nullable(),
  currentSong: z.string().max(90).optional().nullable(),
  pinnedPhotos: z.array(z.string().max(400_000)).max(3).optional().nullable(),
});

export async function meUpdate(req, res) {
  const parsed = mePatchBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const data = {};
  if (parsed.data.email != null) {
    data.email = parsed.data.email.toLowerCase().trim();
    data.emailVerifiedAt = new Date();
  }
  if (parsed.data.name != null) data.name = parsed.data.name.trim();
  if (parsed.data.smsBalanceQueryEnabled != null) {
    data.smsBalanceQueryEnabled = parsed.data.smsBalanceQueryEnabled;
  }
  if (parsed.data.avatarUrl !== undefined) data.avatarUrl = parsed.data.avatarUrl;
  if (parsed.data.avatarEmoji != null) data.avatarEmoji = parsed.data.avatarEmoji;
  if (parsed.data.statusText !== undefined) {
    data.statusText = parsed.data.statusText ? parsed.data.statusText.trim() || null : null;
  }
  if (parsed.data.currentSong !== undefined) {
    data.currentSong = parsed.data.currentSong ? parsed.data.currentSong.trim() || null : null;
  }
  if (parsed.data.pinnedPhotos !== undefined) {
    data.pinnedPhotos = parsed.data.pinnedPhotos ?? [];
  }

  if (!Object.keys(data).length) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }

  if (data.email) {
    const taken = await prisma.user.findFirst({
      where: { email: data.email, NOT: { id: req.userId } },
    });
    if (taken) {
      res.status(409).json({ error: 'Cet email est déjà utilisé sur un autre compte.' });
      return;
    }
  }

  const user = await prisma.user.update({ where: { id: req.userId }, data });
  res.json(profileShape(user));
}

/** Request OTP on a new phone before changing account number. */
export async function mePhoneRequest(req, res) {
  const schema = z.object({ phone: z.string().min(8).max(24) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const normalized = normalizeAuthPhone(parsed.data.phone);
  const storedPhone = canonicalPhone(normalized) ?? normalized;

  const existing = await findUserByPhone(storedPhone);
  if (existing && existing.id !== req.userId) {
    res.status(409).json({ error: 'Ce numéro est déjà lié à un autre compte K21.' });
    return;
  }

  const current = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
  if (current.phone === storedPhone) {
    res.status(400).json({ error: 'C\'est déjà ton numéro actuel.' });
    return;
  }

  if (!(await checkOtpRateLimitForKeys(otpKeysForPhone(storedPhone)))) {
    res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
    return;
  }

  const code = otp();
  const otpKey = `change:${req.userId}:${storedPhone}`;
  await prisma.otpCode.create({
    data: { phone: otpKey, code, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  });

  try {
    await sendOtpSms(storedPhone, code);
  } catch (smsError) {
    console.error('[mePhoneRequest] SMS failed (OTP saved)', smsError);
  }

  const allowBetaOtp = process.env.ALLOW_BETA_OTP === 'true';
  const hideOtp = process.env.NODE_ENV === 'production' && !allowBetaOtp && smsConfigured();

  if (hideOtp) {
    res.json({ sent: true, phoneNormalized: storedPhone });
  } else {
    res.json({
      sent: true,
      phoneNormalized: storedPhone,
      otp: code,
      ...(allowBetaOtp ? { betaOtp: true } : {}),
    });
  }
}

/** Confirm new phone with OTP and update account. */
export async function mePhoneConfirm(req, res) {
  const schema = z.object({
    phone: z.string().min(8).max(24),
    otp: z.string().trim().length(6),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const normalized = normalizeAuthPhone(parsed.data.phone);
  const storedPhone = canonicalPhone(normalized) ?? normalized;
  const otpKey = `change:${req.userId}:${storedPhone}`;

  const stored = await findValidOtpForKeys([otpKey], parsed.data.otp);
  if (!stored) {
    res.status(401).json({ error: 'Invalid or expired OTP' });
    return;
  }

  const taken = await findUserByPhone(storedPhone);
  if (taken && taken.id !== req.userId) {
    res.status(409).json({ error: 'Ce numéro est déjà lié à un autre compte.' });
    return;
  }

  await prisma.otpCode.deleteMany({ where: { phone: otpKey } });

  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { phone: storedPhone, otpVerifiedAt: new Date() },
  });

  res.json(profileShape(user));
}

export async function usersLookup(req, res) {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3) {
    res.status(400).json({ error: 'Enter at least 3 characters' });
    return;
  }

  let user;
  const stripped = q.replace(/^@/, '').trim();
  const digits = stripped.replace(/\D/g, '');

  if (digits.length >= 8) {
    const phone = stripped.startsWith('+') ? `+${digits}` : `+221${digits.replace(/^0/, '')}`;
    user = await prisma.user.findUnique({ where: { phone } });
  } else {
    user = await prisma.user.findUnique({ where: { handle: stripped.toLowerCase() } });
  }

  if (!user) {
    res.status(404).json({ error: 'Personne introuvable sur K21' });
    return;
  }
  if (user.id === req.userId) {
    res.status(400).json({ error: 'Tu ne peux pas t\'envoyer de l\'argent à toi-même' });
    return;
  }

  res.json(recipientLookupShape(user));
}

export async function getWallet(req, res) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
  const wallet = await requireWallet(req.userId);
  res.json({ ...walletShape(wallet, user.country), verification: tierShape(user) });
}

export async function getTransactions(req, res) {
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const wallet = await requireWallet(req.userId);
  const transactions = await prisma.ledgerEntry.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json(transactions.map(txShape));
}

export async function transfersSend(req, res) {
  const schema = z.object({
    recipientHandle: z.string().min(3),
    amount: z.number().int().positive(),
    currency: z.enum(['national', 'kori']).default('kori'),
    note: z.string().max(500).optional(),
    voiceNoteUrl: z.string().max(780_000).optional(),
    photoUrl: z.string().max(720_000).optional(),
    videoUrl: z.string().max(720_000).optional(),
    gifUrl: z.string().max(800_000).optional(),
    giftCardTheme: z.enum(['tabaski', 'korite', 'birthday', 'thank_you', 'love', 'new_year']).optional(),
    threadId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { recipientHandle, note, voiceNoteUrl, photoUrl, videoUrl, gifUrl, giftCardTheme, threadId } = parsed.data;
  const attachmentUrl = voiceNoteUrl ?? photoUrl ?? videoUrl ?? gifUrl ?? null;
  const attachmentType = voiceNoteUrl ? 'voice' : photoUrl ? 'photo' : videoUrl ? 'video' : gifUrl ? 'gif' : null;
  const sender = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, include: { wallet: true } });
  const amount = normalizeAmountToKori(parsed.data.amount, parsed.data.currency, sender.country);
  const currency = 'kori';

  try {
    await assertStepUpForAmount(req, amountToNationalXof(amount, currency, sender.country));
  } catch (error) {
    if (handleStepUpError(res, error)) return;
    throw error;
  }

  const recipient = await prisma.user.findUnique({ where: { handle: recipientHandle }, include: { wallet: true } });

  if (!recipient?.wallet) {
    res.status(404).json({ error: 'Recipient not found' });
    return;
  }

  if (recipient.id === sender.id) {
    res.status(400).json({ error: 'Tu ne peux pas t’envoyer de l’argent à toi-même.', code: 'self_transfer' });
    return;
  }

  // A payment can be posted into a Mboolo thread as a receipt card, but only
  // into a thread both the sender and recipient are actually members of —
  // otherwise anyone could forge a "money received" bubble in someone else's
  // conversation without any money moving.
  if (threadId) {
    const [senderMember, recipientMember] = await Promise.all([
      prisma.mboloMember.findUnique({ where: { threadId_userId: { threadId, userId: sender.id } } }),
      prisma.mboloMember.findUnique({ where: { threadId_userId: { threadId, userId: recipient.id } } }),
    ]);
    if (!senderMember || !recipientMember) {
      res.status(403).json({ error: 'Conversation introuvable pour cet envoi' });
      return;
    }
  }

  const amountNational = amountToNationalXof(amount, currency, sender.country);

  try {
    await assertCanSend(prisma, sender, amountNational);
    await assertCanReceive(prisma, recipient, recipient.wallet, 0, amount);
  } catch (error) {
    if (handleTierError(res, error)) return;
    throw error;
  }

  if (currency === 'kori') {
    try {
      const gate = await gateOrExecute(
        req,
        res,
        {
          operationType: 'send_kori',
          amountNational,
          recipientHandle,
          recipientId: recipient.id,
          payload: {
            senderId: sender.id,
            senderWalletId: sender.wallet.id,
            recipientId: recipient.id,
            recipientWalletId: recipient.wallet.id,
            amountKori: amount,
            note,
            attachmentUrl,
            attachmentType,
            giftCardTheme,
          },
        },
        async (ref) => {
          let undoRow;
          await runMoneyTransaction(prisma, async (db) => {
            await sendKoriTransfer(db, {
              senderId: sender.id,
              senderWalletId: sender.wallet.id,
              recipientId: recipient.id,
              recipientWalletId: recipient.wallet.id,
              amountKori: amount,
              reference: ref,
              note,
              attachmentUrl,
              attachmentType,
              giftCardTheme,
              senderName: sender.name,
              senderHandle: sender.handle,
              recipientName: recipient.name,
              recipientHandle: recipient.handle,
            });
            undoRow = await createTransferUndoInTx(db, {
              senderUserId: sender.id,
              recipientUserId: recipient.id,
              amount,
              currency: 'kori',
              originalReference: ref,
              recipientReference: `${ref}-R`,
              operationType: 'send',
            });
            await creditKoriEarn(db, sender.id, sender.wallet.id, 'send', `${ref}-EARN`);
          });
          return { currency: 'kori', amount, formatted: formatKori(amount), reference: ref, recipientHandle, undo: undoShape(undoRow) };
        },
      );
      if (gate.held) return;
      await recordDailySend(prisma, sender.id, amountNational);
      await notifyMoneyReceived(recipient.id, {
        amount,
        currency: 'kori',
        senderLabel: sender.name ?? sender.handle,
        giftCardTheme,
        reference: gate.result?.reference,
      });
      const receiptPayload = buildReceiptPayload({
        type: 'send',
        reference: gate.result?.reference,
        amountKori: amount,
        note: note ?? null,
        attachmentUrl,
        attachmentType,
        giftCardTheme: giftCardTheme ?? null,
        undoUntil: gate.result?.undo?.reversibleUntil ?? null,
      });
      const mboloMessage = await postPaymentReceipt(prisma, {
        threadId,
        senderId: sender.id,
        recipientId: recipient.id,
        payload: receiptPayload,
      });
      if (mboloMessage) {
        res.status(201).json({ ...gate.result, mboloMessage });
        return;
      }
      res.status(201).json(gate.result);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
    return;
  }
}

export async function transferUndo(req, res) {
  const ref = req.query.reference ?? req.query.id;
  if (!ref) {
    res.status(400).json({ error: 'reference required' });
    return;
  }

  try {
    const result = await undoTransfer(prisma, { reference: String(ref), userId: req.userId });
    res.json({
      undone: true,
      message: 'Paiement annulé — l\'argent est revenu sur ton compte',
      ...result,
    });
  } catch (error) {
    if (handleTransferUndoError(res, error)) return;
    throw error;
  }
}

export async function transfersRequest(req, res) {
  const schema = z.object({
    recipientHandle: z.string().min(3),
    amount: z.number().int().positive(),
    currency: z.enum(['national', 'kori']).default('kori'),
    purposeCategory: z
      .enum(['general', 'food', 'grocery', 'school', 'transport', 'rent', 'health', 'other'])
      .default('general'),
    note: z.string().max(500).optional(),
    voiceNoteUrl: z.string().max(780_000).optional(),
    photoUrl: z.string().max(720_000).optional(),
    videoUrl: z.string().max(720_000).optional(),
    lockToBusinessId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { recipientHandle, note, voiceNoteUrl, photoUrl, videoUrl, purposeCategory, lockToBusinessId } =
    parsed.data;
  const requester = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
  const amount = normalizeAmountToKori(parsed.data.amount, parsed.data.currency, requester.country);
  const currency = 'kori';
  const payer = await prisma.user.findUnique({ where: { handle: recipientHandle } });

  if (!payer) {
    res.status(404).json({ error: 'Recipient not found' });
    return;
  }
  if (payer.id === requester.id) {
    res.status(400).json({ error: 'Cannot request money from yourself' });
    return;
  }

  if (lockToBusinessId) {
    const business = await prisma.business.findUnique({ where: { id: lockToBusinessId } });
    if (!business) {
      res.status(404).json({ error: 'Marchand introuvable pour verrouillage' });
      return;
    }
  }

  const ref = reference('REQ');
  const moneyRequest = await prisma.$transaction(async (db) => {
    const created = await db.moneyRequest.create({
      data: {
        requesterId: requester.id,
        payerId: payer.id,
        amount,
        currency,
        purposeCategory,
        note,
        voiceNoteUrl,
        photoUrl,
        videoUrl,
        lockToBusinessId: lockToBusinessId ?? null,
        reference: ref,
      },
      include: {
        requester: { select: { id: true, name: true, handle: true, avatarEmoji: true } },
        payer: { select: { id: true, name: true, handle: true, avatarEmoji: true } },
        lockToBusiness: { select: { id: true, name: true, category: true } },
      },
    });

    const amountLabel = currency === 'kori' ? formatKori(amount) : `${amount.toLocaleString('fr-FR')} F`;
    const lockLabel = created.lockToBusiness ? ` · 🔒 ${created.lockToBusiness.name}` : '';
    const context = note
      ? ` · ${note}`
      : voiceNoteUrl
        ? ' · note vocale'
        : photoUrl
          ? ' · photo'
          : videoUrl
            ? ' · vidéo'
            : '';

    await db.notification.create({
      data: {
        userId: payer.id,
        title: "Demande d'argent",
        body: `${requester.name ?? requester.handle} demande ${amountLabel}${lockLabel}${context}`,
        kind: 'money_request',
        refId: created.id,
        actionLabel: 'Payer',
      },
    });

    return created;
  });

  res.status(201).json(moneyRequestShape(moneyRequest));
}

export async function transfersRequestsList(req, res) {
  const role = String(req.query.role ?? 'all');
  const status = req.query.status ? String(req.query.status) : undefined;

  const where =
    role === 'incoming'
      ? { payerId: req.userId, ...(status ? { status } : {}) }
      : role === 'outgoing'
        ? { requesterId: req.userId, ...(status ? { status } : {}) }
        : { OR: [{ payerId: req.userId }, { requesterId: req.userId }], ...(status ? { status } : {}) };

  const requests = await prisma.moneyRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      requester: { select: { id: true, name: true, handle: true, avatarEmoji: true } },
      payer: { select: { id: true, name: true, handle: true, avatarEmoji: true } },
      lockToBusiness: { select: { id: true, name: true, category: true } },
    },
  });

  res.json(requests.map(moneyRequestShape));
}

export async function transfersRequestById(req, res) {
  const id = req.query.id;
  const request = await prisma.moneyRequest.findUnique({
    where: { id },
    include: {
      requester: { select: { id: true, name: true, handle: true, avatarEmoji: true } },
      payer: { select: { id: true, name: true, handle: true, avatarEmoji: true } },
      lockToBusiness: { select: { id: true, name: true, category: true } },
    },
  });

  if (!request || (request.requesterId !== req.userId && request.payerId !== req.userId)) {
    res.status(404).json({ error: 'Money request not found' });
    return;
  }

  res.json(moneyRequestShape(request));
}

async function moneyRequestAction(req, res, action) {
  try {
    const updated = await action(req.query.id, req.userId);
    res.json(moneyRequestShape(updated));
  } catch (error) {
    if (error instanceof RequestError) {
      res.status(requestErrorStatus(error.code)).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function transfersRequestAccept(req, res) {
  const request = await prisma.moneyRequest.findUnique({
    where: { id: req.query.id },
    include: { requester: true },
  });
  if (!request || request.payerId !== req.userId) {
    res.status(404).json({ error: 'Money request not found' });
    return;
  }

  const payer = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
  try {
    await assertStepUpForAmount(req, amountToNationalXof(request.amount, request.currency, payer.country));
  } catch (error) {
    if (error instanceof StepUpRequiredError) return handleStepUpError(res, error);
    throw error;
  }

  const amountNational = amountToNationalXof(request.amount, request.currency, payer.country);
  try {
    await assertCanSend(prisma, payer, amountNational);
  } catch (error) {
    if (handleTierError(res, error)) return;
    throw error;
  }

  try {
    const gate = await gateOrExecute(
      req,
      res,
      {
        operationType: 'money_request_accept',
        amountNational,
        recipientHandle: request.requester.handle ?? undefined,
        recipientId: request.requesterId,
        payload: { requestId: request.id, payerUserId: req.userId },
      },
      async () => {
        const updated = await acceptMoneyRequest(prisma, {
          requestId: request.id,
          payerUserId: req.userId,
        });
        return moneyRequestShape(updated);
      },
    );
    if (gate.held) return;
    await recordDailySend(prisma, payer.id, amountNational);
    const receiptPayload = buildReceiptPayload({
      type: 'request_accept',
      reference: gate.result?.reference ?? request.reference,
      amountKori: request.amount,
      requestId: request.id,
      note: request.note ?? null,
    });
    const mboloMessage = await postPaymentReceipt(prisma, {
      senderId: payer.id,
      recipientId: request.requesterId,
      payload: receiptPayload,
    });
    res.json(mboloMessage ? { ...gate.result, mboloMessage } : gate.result);
  } catch (error) {
    if (error instanceof RequestError) {
      res.status(requestErrorStatus(error.code)).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function transfersRequestDeny(req, res) {
  return moneyRequestAction(req, res, (id, userId) =>
    denyMoneyRequest(prisma, { requestId: id, payerUserId: userId }),
  );
}

export async function transfersRequestCancel(req, res) {
  return moneyRequestAction(req, res, (id, userId) =>
    cancelMoneyRequest(prisma, { requestId: id, requesterUserId: userId }),
  );
}

/** Client-supplied Idempotency-Key, scoped to user + operation so keys can't collide across users. */
function scopedIdempotencyKey(req, operation) {
  const raw = req.headers?.['idempotency-key'];
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim();
  if (!key || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) return undefined;
  return `${req.userId}:${operation}:${key}`;
}

function railUnavailable(res) {
  res.status(503).json({
    error: 'Ce moyen de paiement est momentanément indisponible. Aucun montant n’a été débité ni crédité.',
    code: 'rail_unavailable',
  });
}

export async function cashIn(req, res) {
  const parsed = cashBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { amount, operator, phone } = parsed.data;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, include: { wallet: true } });
  if (!user.wallet) {
    res.status(400).json({ error: 'Wallet not found' });
    return;
  }

  try {
    const koriMint = nationalToKori(amount, user.country);
    await assertWalletWithinCaps(user, user.wallet, {
      incomingNational: amount,
      incomingKori: koriMint,
    });
  } catch (error) {
    if (handleTierError(res, error)) return;
    throw error;
  }

  const ref = reference('CIN');
  try {
    const result = await startCashIn(prisma, {
      userId: user.id,
      wallet: user.wallet,
      country: user.country,
      amount,
      phone: (phone ?? user.phone).replace(/\s/g, ''),
      operator,
      reference: ref,
      idempotencyKey: scopedIdempotencyKey(req, 'cash_in'),
      callbackUrl: process.env.JULAYA_CALLBACK_URL,
    });

    if (result.rail.status === 'completed' && result.wallet && !result.cached) {
      await notifyDepositReceived(user.id, { amount });
    }

    res.status(result.rail.status === 'completed' ? 201 : 202).json({
      rail: railShape(result.rail, result.wallet, { cached: result.cached }),
      koriMinted: result.mint?.koriMinted ?? null,
      reserveXofAdded: result.mint?.reserveXof ?? null,
      transaction: result.ledger ? txShape(result.ledger) : null,
      mode: julayaMode(),
      message: result.userMessage ?? null,
    });
  } catch (error) {
    if (error instanceof RailUnavailableError) return railUnavailable(res);
    console.error('[cashIn]', error);
    res.status(502).json({ error: 'Dépôt impossible pour le moment — aucun montant n’a été crédité.' });
  }
}

export async function cashOut(req, res) {
  const parsed = cashBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { amount, operator, phone } = parsed.data;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, include: { wallet: true } });
  if (!user.wallet) {
    res.status(400).json({ error: 'Wallet not found' });
    return;
  }

  try {
    await assertStepUpForAmount(req, amount);
  } catch (error) {
    if (handleStepUpError(res, error)) return;
    throw error;
  }

  try {
    await assertCanCashOut(prisma, user, amount);
  } catch (error) {
    if (handleTierError(res, error)) return;
    throw error;
  }

  const ref = reference('COUT');
  const phoneNorm = (phone ?? user.phone).replace(/\s/g, '');
  const koriRequired = nationalToKori(amount, user.country);
  if (user.wallet.koriBalance < koriRequired) {
    res.status(400).json({ error: 'Insufficient Kori balance', code: 'insufficient' });
    return;
  }
  try {
    const gate = await gateOrExecute(
      req,
      res,
      {
        operationType: 'cash_out',
        amountNational: amount,
        payload: {
          userId: user.id,
          amount,
          phone: phoneNorm,
          operator,
          callbackUrl: process.env.JULAYA_CALLBACK_URL,
        },
      },
      async (txRef) => {
        const result = await startCashOut(prisma, {
          userId: user.id,
          wallet: user.wallet,
          country: user.country,
          amount,
          phone: phoneNorm,
          operator,
          reference: txRef,
          idempotencyKey: scopedIdempotencyKey(req, 'cash_out'),
          callbackUrl: process.env.JULAYA_CALLBACK_URL,
        });
        return {
          status: result.rail.status === 'completed' ? 201 : result.rail.status === 'failed' ? 400 : 202,
          body: {
            rail: railShape(result.rail, result.wallet, { cached: result.cached }),
            transaction: result.ledger ? txShape(result.ledger) : null,
            mode: julayaMode(),
            message: result.userMessage ?? null,
          },
        };
      },
    );
    if (gate.held) return;
    if (gate.result.status !== 400 && !gate.result.body?.rail?.cached) {
      // Funds are held at initiation, so pending payouts count toward the daily limit too.
      await recordDailyCashOut(prisma, user.id, amount);
    }
    res.status(gate.result.status).json(gate.result.body);
  } catch (error) {
    if (error instanceof RailError && error.code === 'insufficient') {
      res.status(400).json({ error: error.message, code: 'insufficient' });
      return;
    }
    if (error instanceof RailUnavailableError) return railUnavailable(res);
    console.error('[cashOut]', error);
    res.status(502).json({ error: 'Retrait impossible pour le moment.' });
  }
}

export async function cashTransactions(req, res) {
  const rails = await prisma.railTransaction.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(rails.map((rail) => railShape(rail)));
}

export async function depositsNational(req, res) {
  // Closed-loop beta test credits ONLY. Real deposits enter through a
  // provider-confirmed rail (POST /api/cash/in, Stripe, agents). This route
  // never trusts a client-supplied `source` and is disabled in production.
  const allowBeta = betaDepositsAllowed();
  const schema = z.object({ amount: z.number().int().positive(), source: z.string().max(60).optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { amount, source } = parsed.data;
  const maxBeta = Number(process.env.BETA_DEPOSIT_MAX ?? 100_000);

  if (!allowBeta) {
    res.status(403).json({
      error: 'Les dépôts passent par Mobile Money, carte ou un agent Joko.',
      code: 'deposits_disabled',
    });
    return;
  }

  if (amount > maxBeta) {
    res.status(400).json({ error: `Beta test credit max is ${maxBeta} XOF`, code: 'beta_deposit_cap' });
    return;
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, include: { wallet: true } });
  if (!user.wallet) {
    res.status(400).json({ error: 'Wallet not found' });
    return;
  }

  const ref = reference('BETA');
  const result = await prisma.$transaction(async (db) => {
    const settled = await completeCashIn(db, {
      userId: user.id,
      walletId: user.wallet.id,
      country: user.country,
      amount,
      reference: ref,
      sourceNote: `Beta test credit${source ? ` · ${source}` : ''}`,
    });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { id: user.wallet.id } });
    return { ...settled, wallet };
  });

  await notifyDepositReceived(user.id, { amount });

  res.status(201).json({
    ...walletShape(result.wallet, user.country),
    koriMinted: result.mint.koriMinted,
    reserveXofAdded: result.mint.reserveXof,
    transaction: txShape(result.ledger),
    beta: true,
  });
}

export async function koriConvert(req, res) {
  const schema = z.object({ amountKori: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { amountKori } = parsed.data;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, include: { wallet: true } });
  if (!user.wallet) {
    res.status(400).json({ error: 'Wallet not found' });
    return;
  }

  try {
    await assertStepUpForAmount(req, amountToNationalXof(amountKori, 'kori', user.country));
  } catch (error) {
    if (handleStepUpError(res, error)) return;
    throw error;
  }

  const amountNational = amountToNationalXof(amountKori, 'kori', user.country);

  try {
    const gate = await gateOrExecute(
      req,
      res,
      {
        operationType: 'kori_convert',
        amountNational,
        payload: {
          userId: user.id,
          walletId: user.wallet.id,
          country: user.country,
          amountKori,
          ledgerNote: `Conversion ${formatKori(amountKori)} → ${user.wallet.currency}`,
        },
      },
      async (ref) => {
        const result = await runMoneyTransaction(prisma, async (db) => {
          const conversion = await convertKoriToNational(db, {
            userId: user.id,
            walletId: user.wallet.id,
            country: user.country,
            koriAmount: amountKori,
            reference: ref,
          });

          const ledger = await db.ledgerEntry.create({
            data: {
              walletId: user.wallet.id,
              userId: user.id,
              type: 'cash_out',
              amount: -amountKori,
              note: `Conversion ${formatKori(amountKori)} → ${conversion.netNational.toLocaleString('fr-FR')} F (fee ${conversion.feeNational})`,
              reference: `${ref}-NAT`,
            },
          });

          const wallet = await db.wallet.findUniqueOrThrow({ where: { id: user.wallet.id } });
          return { conversion, ledger, wallet };
        });

        return {
          ...walletShape(result.wallet),
          convertedKori: amountKori,
          formattedKori: formatKori(amountKori),
          feeNational: result.conversion.feeNational,
          netNational: result.conversion.netNational,
          transaction: txShape(result.ledger),
        };
      },
    );
    if (gate.held) return;
    res.status(201).json(gate.result);
  } catch (error) {
    if (error instanceof ConversionsFrozenError) {
      res.status(503).json({ error: error.message, code: 'conversions_frozen' });
      return;
    }
    if (error instanceof InsufficientFundsError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function koriTransactions(req, res) {
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const rows = await prisma.koriTransaction.findMany({
    where: { OR: [{ senderId: req.userId }, { recipientId: req.userId }] },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json(rows);
}

export async function koriReserve(_req, res) {
  const reserve = await ensureReserve(prisma);
  res.json(reserveShape(reserve));
}

export async function koriReconcileCron(req, res) {
  const { cronKoriReconcile } = await import('./cron/http-handlers.js');
  return cronKoriReconcile(req, res);
}

export async function merchantPublic(req, res) {
  const idOrKebu = String(req.query.id ?? '').trim();
  if (!idOrKebu) {
    res.status(400).json({ error: 'Merchant id required' });
    return;
  }

  const business = await prisma.business.findFirst({
    where: {
      OR: [{ id: idOrKebu }, { kebuId: idOrKebu }],
    },
  });

  if (!business) {
    res.status(404).json({ error: 'Marchand introuvable' });
    return;
  }

  res.json(merchantPublicShape(business));
}

export async function merchantVouchersMine(req, res) {
  const vouchers = await listMerchantVouchers(prisma, req.userId);
  res.json({ vouchers });
}

export async function merchantPay(req, res) {
  const businessId = req.query.id;
  const schema = z.object({
    amount: z.number().int().positive(),
    currency: z.enum(['national', 'kori']).default('kori'),
    useVoucher: z.boolean().optional(),
    threadId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { owner: { include: { wallet: true } } },
  });
  const payer = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, include: { wallet: true } });
  const amount = normalizeAmountToKori(parsed.data.amount, parsed.data.currency, payer.country);
  const currency = 'kori';

  try {
    await assertStepUpForAmount(req, amountToNationalXof(amount, currency, payer.country));
  } catch (error) {
    if (handleStepUpError(res, error)) return;
    throw error;
  }

  if (!business?.owner.wallet) {
    res.status(404).json({ error: 'Merchant not found' });
    return;
  }

  const amountNational = amountToNationalXof(amount, currency, payer.country);
  const useVoucher = parsed.data.useVoucher === true;

  if (useVoucher) {
    const voucherBalance = await getMerchantVoucherBalance(prisma, payer.id, businessId);
    if (voucherBalance < amount) {
      res.status(400).json({ error: 'Bon marchand insuffisant pour ce paiement' });
      return;
    }
  }

  if (currency === 'kori') {
    try {
      const gate = await gateOrExecute(
        req,
        res,
        {
          operationType: useVoucher ? 'merchant_voucher_pay' : 'merchant_pay_kori',
          amountNational,
          recipientId: business.ownerId,
          payload: {
            payerId: payer.id,
            payerWalletId: payer.wallet.id,
            merchantUserId: business.ownerId,
            merchantWalletId: business.owner.wallet.id,
            amountKori: amount,
            merchantName: business.name,
            useVoucher,
          },
        },
        async (ref) => {
          if (useVoucher) {
            await spendMerchantVoucher(prisma, {
              userId: payer.id,
              businessId,
              amountKori: amount,
              merchantUserId: business.ownerId,
              merchantWalletId: business.owner.wallet.id,
              merchantName: business.name,
              payerName: payer.name ?? payer.handle,
              reference: ref,
            });
            return {
              currency: 'kori',
              amount,
              formatted: formatKori(amount),
              merchant: business.name,
              reference: ref,
              paidWith: 'voucher',
            };
          }

          let undoRow;
          await runMoneyTransaction(prisma, async (db) => {
            await spendKoriAtMerchant(db, {
              payerId: payer.id,
              payerWalletId: payer.wallet.id,
              merchantUserId: business.ownerId,
              merchantWalletId: business.owner.wallet.id,
              amountKori: amount,
              merchantName: business.name,
              payerName: payer.name ?? payer.handle,
              reference: ref,
            });
            undoRow = await createTransferUndoInTx(db, {
              senderUserId: payer.id,
              recipientUserId: business.ownerId,
              amount,
              currency: 'kori',
              originalReference: ref,
              recipientReference: `${ref}-R`,
              operationType: 'merchant_pay',
            });
            await creditKoriEarn(db, payer.id, payer.wallet.id, 'pay_merchant', `${ref}-EARN`);
          });
          return {
            currency: 'kori',
            amount,
            formatted: formatKori(amount),
            merchant: business.name,
            reference: ref,
            paidWith: 'wallet',
            undo: undoShape(undoRow),
          };
        },
      );
      if (gate.held) return;
      await recordDailySend(prisma, payer.id, amountNational);
      await notifyMoneyReceived(business.ownerId, {
        amount,
        currency: 'kori',
        senderLabel: payer.name ?? payer.handle,
      });
      const receiptPayload = buildReceiptPayload({
        type: 'merchant_pay',
        reference: gate.result?.reference,
        amountKori: amount,
        merchantName: business.name,
        merchantId: business.id,
        paidWith: gate.result?.paidWith ?? 'wallet',
        undoUntil: gate.result?.undo?.reversibleUntil ?? null,
      });
      let mboloMessage = null;
      if (parsed.data.threadId) {
        mboloMessage = await postPaymentReceipt(prisma, {
          threadId: parsed.data.threadId,
          senderId: payer.id,
          recipientId: business.ownerId,
          payload: receiptPayload,
        });
      } else {
        mboloMessage = await postPaymentReceipt(prisma, {
          senderId: payer.id,
          recipientId: business.ownerId,
          payload: receiptPayload,
        });
      }
      res.status(201).json(mboloMessage ? { ...gate.result, mboloMessage } : gate.result);
    } catch (error) {
      if (isMoneyError(error)) {
        res.status(moneyErrorStatus(error)).json({ error: error.message });
        return;
      }
      throw error;
    }
    return;
  }
}

export async function rolesAssign(req, res) {
  const requestedRole = req.query.role;
  const allowed = ['personal', 'business_owner', 'seller', 'driver', 'promoter', 'cooperative'];
  if (!allowed.includes(requestedRole)) {
    res.status(400).json({ error: 'Unsupported role' });
    return;
  }
  const role = await ensureRole(req.userId, requestedRole);
  res.status(201).json(role);
}

export async function businessesCreate(req, res) {
  const schema = z.object({
    name: z.string().min(2),
    type: z.enum(BUSINESS_TYPES).default('merchant'),
    category: z.string().optional(),
    arrondissement: z.string().optional(),
    description: z.string().optional(),
    address: z.string().max(200).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const roleMap = {
    merchant: 'business_owner',
    employer: 'business_owner',
    school: 'business_owner',
    cooperative: 'cooperative',
    trader: 'business_owner',
    logistics: 'business_owner',
    cold_storage: 'business_owner',
    aggregator: 'cooperative',
    marketplace_seller: 'business_owner',
  };
  await ensureRole(req.userId, roleMap[parsed.data.type] ?? 'business_owner');
  const owner = await ensureAfriId(req.userId);
  if (!owner.afriId) {
    res.status(403).json({
      error: 'AFRI ID requis — ton identité personnelle (AFRI) avant d\'ouvrir un commerce (KEBU)',
      code: 'afri_id_required',
    });
    return;
  }
  try {
    await assertCanCreateBusiness(owner);
  } catch (error) {
    if (handleTierError(res, error)) return;
    throw error;
  }

  const kebuId = await assignKebuId();
  const business = await prisma.business.create({
    data: {
      ownerId: req.userId,
      kebuId,
      ...parsed.data,
      members: { create: { userId: req.userId, role: 'owner' } },
    },
  });
  await ensureBusinessWallet(business.id, prisma);
  res.status(201).json(business);
}

export async function businessesList(req, res) {
  const category = req.query.category ? String(req.query.category) : undefined;
  const items = await prisma.business.findMany({
    where: category ? { category } : undefined,
    orderBy: { name: 'asc' },
    take: 100,
    include: { owner: { select: { id: true, name: true, handle: true } } },
  });
  const ratings = await ratingSummaries(items.map((b) => b.id));
  res.json(
    items.map((b) => ({
      ...b,
      rating: ratings.get(b.id) ?? { average: null, count: 0 },
    })),
  );
}

export async function businessesPayroll(req, res) {
  const businessId = req.query.id;
  const schema = z.object({
    employeeHandle: z.string().min(3),
    amount: z.number().int().positive(),
    note: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { employeeHandle, amount, note } = parsed.data;
  const business = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.userId } });
  const ownerWallet = await requireWallet(req.userId);
  const employee = await prisma.user.findUnique({ where: { handle: employeeHandle }, include: { wallet: true } });

  if (!business) {
    res.status(404).json({ error: 'Business not found' });
    return;
  }
  if (!employee?.wallet) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  try {
    await assertStepUpForAmount(req, amount);
  } catch (error) {
    if (handleStepUpError(res, error)) return;
    throw error;
  }

  try {
    const gate = await gateOrExecute(
      req,
      res,
      {
        operationType: 'payroll',
        amountNational: amount,
        recipientHandle: employeeHandle,
        recipientId: employee.id,
        payload: {
          amount,
          senderUserId: req.userId,
          recipientUserId: employee.id,
          senderWalletId: ownerWallet.id,
          recipientWalletId: employee.wallet.id,
          senderLedger: {
            type: 'payroll',
            counterpartyName: employee.name,
            counterpartyHandle: employee.handle,
            note,
          },
          recipientLedger: {
            type: 'payroll',
            counterpartyName: business.name,
            note,
          },
        },
      },
      async (txRef) => {
        const entry = await runMoneyTransaction(prisma, async (db) =>
          transferNational(db, {
            amount,
            senderWalletId: ownerWallet.id,
            recipientWalletId: employee.wallet.id,
            senderUserId: req.userId,
            recipientUserId: employee.id,
            reference: txRef,
            senderLedger: {
              type: 'payroll',
              counterpartyName: employee.name,
              counterpartyHandle: employee.handle,
              note,
            },
            recipientLedger: {
              type: 'payroll',
              counterpartyName: business.name,
              note,
              reference: `${txRef}-E`,
            },
          }),
        );
        return txShape(entry);
      },
    );
    if (gate.held) return;
    res.status(201).json(gate.result);
  } catch (error) {
    if (isMoneyError(error)) {
      res.status(moneyErrorStatus(error)).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function sellersProfile(req, res) {
  if (req.method === 'GET') {
    const profile = await prisma.sellerProfile.findUnique({
      where: { userId: req.userId },
      include: {
        products: { where: { active: true }, orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    const businesses = await prisma.business.findMany({
      where: { ownerId: req.userId },
      include: {
        products: { where: { active: true }, orderBy: { createdAt: 'desc' }, take: 50 },
      },
      orderBy: { name: 'asc' },
    });
    res.json({ profile, businesses });
    return;
  }

  const schema = z.object({ shopName: z.string().min(2), category: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    await requireWorkerMode(req.userId, 'seller');
  } catch (error) {
    if (error instanceof WorkerError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }

  await ensureRole(req.userId, 'seller');
  const profile = await prisma.sellerProfile.upsert({
    where: { userId: req.userId },
    update: parsed.data,
    create: { userId: req.userId, ...parsed.data },
  });
  res.status(201).json(profile);
}

export async function products(req, res) {
  if (req.method === 'GET') {
    const category = req.query.category ? String(req.query.category) : undefined;
    const flashOnly = req.query.flash === '1' || req.query.flash === 'true';
    const items = await prisma.product.findMany({
      where: {
        active: true,
        ...(category ? { category } : {}),
        // Flash deals are real or absent: a deal only exists while its true
        // expiry is in the future — no evergreen fake discounts.
        ...(flashOnly ? { flashExpiresAt: { gt: new Date() } } : {}),
      },
      orderBy: flashOnly ? { flashExpiresAt: 'asc' } : { createdAt: 'desc' },
      take: 100,
      include: { business: { select: { id: true, name: true } }, seller: { select: { shopName: true } } },
    });
    res.json(items);
    return;
  }

  const schema = z.object({
    title: z.string().min(2),
    description: z.string().optional(),
    imageUrl: z.string().optional(),
    price: z.number().int().positive(),
    category: z.string().optional(),
    inventory: z.number().int().min(0).default(0),
    trackInventory: z.boolean().optional(),
    allowBackorder: z.boolean().optional(),
    lowStockThreshold: z.number().int().min(0).max(9999).optional(),
    flashPrice: z.number().int().positive().optional(),
    flashHours: z.number().min(1).max(168).optional(),
    businessId: z.string().optional(),
    b2bPrice: z.number().int().positive().optional(),
    b2bMinQty: z.number().int().min(1).optional(),
    unitLabel: z.string().max(32).optional(),
    saleChannel: z.enum(['b2c', 'b2b', 'both']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const { flashPrice, flashHours, businessId, ...base } = parsed.data;

  // A flash deal must be a real discount with a real deadline.
  if ((flashPrice != null) !== (flashHours != null)) {
    res.status(400).json({ error: 'Une offre flash a besoin d’un prix réduit ET d’une durée.', code: 'flash_incomplete' });
    return;
  }
  if (flashPrice != null && flashPrice >= base.price) {
    res.status(400).json({ error: 'Le prix flash doit être inférieur au prix normal.', code: 'flash_not_a_discount' });
    return;
  }

  let ownedBusinessId = null;
  if (businessId) {
    const business = await prisma.business.findFirst({ where: { id: businessId, ownerId: req.userId } });
    if (!business) {
      res.status(403).json({ error: 'Ce commerce ne t’appartient pas.' });
      return;
    }
    ownedBusinessId = business.id;
  }

  const seller = ownedBusinessId
    ? null
    : await prisma.sellerProfile.findUnique({ where: { userId: req.userId } });
  if (!ownedBusinessId && !seller) {
    res.status(403).json({ error: 'Create a seller profile first' });
    return;
  }

  const product = await prisma.product.create({
    data: {
      ...base,
      sellerId: seller?.id ?? null,
      businessId: ownedBusinessId,
      flashPrice: flashPrice ?? null,
      flashExpiresAt: flashHours != null ? new Date(Date.now() + flashHours * 3600_000) : null,
    },
  });
  res.status(201).json(product);
}

export async function driversProfile(req, res) {
  const schema = z.object({ vehicle: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    await requireWorkerMode(req.userId, 'delivery');
  } catch (error) {
    if (error instanceof WorkerError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }

  await ensureRole(req.userId, 'driver');
  const driver = await prisma.driverProfile.upsert({
    where: { userId: req.userId },
    update: { vehicle: parsed.data.vehicle, status: 'available' },
    create: { userId: req.userId, vehicle: parsed.data.vehicle },
  });
  res.status(201).json(driver);
}

export async function deliveriesNearby(req, res) {
  const riderLat = req.query.lat != null ? Number(req.query.lat) : null;
  const riderLng = req.query.lng != null ? Number(req.query.lng) : null;
  const list = await listNearbyDeliveries(prisma, {
    riderLat: Number.isFinite(riderLat) ? riderLat : null,
    riderLng: Number.isFinite(riderLng) ? riderLng : null,
    viewerId: req.userId,
  });
  res.json(list);
}

export async function deliveriesCreate(req, res) {
  const schema = z.object({
    pickupLabel: z.string().min(2),
    pickupAddress: z.string().min(2),
    dropoffArea: z.string().min(2),
    dropoffAddress: z.string().min(2),
    deliveryFeeNational: z.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const fee = parsed.data.deliveryFeeNational ?? 1500;
  try {
    const task = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          buyerId: req.userId,
          status: 'pending_delivery',
          totalAmount: fee,
          deliveryAddress: parsed.data.dropoffAddress,
        },
      });
      return createDeliveryTask(tx, {
        orderId: order.id,
        buyerId: req.userId,
        pickupLabel: parsed.data.pickupLabel,
        pickupAddress: parsed.data.pickupAddress,
        dropoffArea: parsed.data.dropoffArea,
        dropoffAddress: parsed.data.dropoffAddress,
        deliveryFeeNational: fee,
      });
    });
    const detail = await getDeliveryDetail(prisma, task.id, req.userId);
    res.status(201).json(detail);
  } catch (error) {
    if (error instanceof DeliveryError) {
      res.status(deliveryErrorStatus(error.code)).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function deliveryDetail(req, res) {
  try {
    const detail = await getDeliveryDetail(prisma, req.query.id, req.userId);
    res.json(detail);
  } catch (error) {
    if (error instanceof DeliveryError) {
      res.status(deliveryErrorStatus(error.code)).json({ error: error.message });
      return;
    }
    throw error;
  }
}

async function handleDeliveryError(res, error) {
  if (error instanceof DeliveryError) {
    res.status(deliveryErrorStatus(error.code)).json({ error: error.message });
    return true;
  }
  if (isMoneyError(error)) {
    res.status(moneyErrorStatus(error)).json({ error: error.message });
    return true;
  }
  return false;
}

export async function deliveriesAccept(req, res) {
  await ensureRole(req.userId, 'driver');
  const ref = reference('DACC');
  try {
    const task = await acceptDelivery(prisma, { taskId: req.query.id, riderId: req.userId, reference: ref });
    const detail = await getDeliveryDetail(prisma, task.id, req.userId);
    res.status(201).json(detail);
  } catch (error) {
    if (await handleDeliveryError(res, error)) return;
    throw error;
  }
}

export async function deliveriesClaim(req, res) {
  return deliveriesAccept(req, res);
}

export async function deliveriesPickup(req, res) {
  try {
    const task = await markPickedUp(prisma, { taskId: req.query.id, riderId: req.userId });
    res.json(task);
  } catch (error) {
    if (await handleDeliveryError(res, error)) return;
    throw error;
  }
}

export async function deliveriesDeliver(req, res) {
  try {
    const task = await markDelivered(prisma, { taskId: req.query.id, riderId: req.userId });
    res.json({
      ...task,
      autoReleaseAt: task.autoReleaseAt?.toISOString(),
      message: 'En attente de confirmation client (libération auto dans 30 min)',
    });
  } catch (error) {
    if (await handleDeliveryError(res, error)) return;
    throw error;
  }
}

export async function deliveriesConfirm(req, res) {
  try {
    const result = await confirmDelivery(prisma, { taskId: req.query.id, buyerId: req.userId });
    res.json({
      task: result.task,
      koriCredited: result.koriCredited,
      wallet: walletShape(result.wallet),
      animation: 'kori_balance_increase',
    });
  } catch (error) {
    if (await handleDeliveryError(res, error)) return;
    throw error;
  }
}

export async function deliveriesDispute(req, res) {
  const note = req.body?.note;
  try {
    const result = await openDispute(prisma, { taskId: req.query.id, buyerId: req.userId, note });
    res.status(201).json({
      task: result.task,
      dispute: {
        id: result.dispute.id,
        status: result.dispute.status,
        holdUntil: result.dispute.holdUntil.toISOString(),
        message: 'Paiement retenu 24h le temps de l’examen',
      },
    });
  } catch (error) {
    if (await handleDeliveryError(res, error)) return;
    throw error;
  }
}

export async function deliveriesDisputeEvidence(req, res) {
  const schema = z.object({
    type: z.enum(['photo_url', 'location', 'note']),
    content: z.string().min(1),
    lat: z.number().optional(),
    lng: z.number().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const evidence = await submitDisputeEvidence(prisma, {
      taskId: req.query.id,
      userId: req.userId,
      ...parsed.data,
    });
    res.status(201).json(evidence);
  } catch (error) {
    if (await handleDeliveryError(res, error)) return;
    throw error;
  }
}

export async function deliveriesDisputeResolve(req, res) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    res.status(401).json({ error: 'Admin authorization required' });
    return;
  }

  const schema = z.object({
    outcome: z.enum(['rider', 'customer']),
    resolutionNote: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const result = await resolveDispute(prisma, {
      taskId: req.query.id,
      outcome: parsed.data.outcome,
      resolutionNote: parsed.data.resolutionNote,
    });
    res.json(result);
  } catch (error) {
    if (await handleDeliveryError(res, error)) return;
    throw error;
  }
}

export async function deliveriesAutoReleaseCron(req, res) {
  const { cronDeliveriesAutoRelease } = await import('./cron/http-handlers.js');
  return cronDeliveriesAutoRelease(req, res);
}

export async function events(req, res) {
  if (req.method === 'GET') {
    const items = await prisma.event.findMany({ orderBy: { startsAt: 'asc' } });
    res.json(items);
    return;
  }

  const schema = z.object({
    title: z.string().min(2),
    description: z.string().optional(),
    venue: z.string().optional(),
    startsAt: z.string().datetime(),
    ticketPrice: z.number().int().min(0),
    capacity: z.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  await ensureRole(req.userId, 'promoter');
  const event = await prisma.event.create({
    data: { promoterId: req.userId, ...parsed.data, startsAt: new Date(parsed.data.startsAt) },
  });
  res.status(201).json(event);
}

export async function eventsTickets(req, res) {
  const eventId = req.query.id;
  const schema = z.object({ quantity: z.number().int().positive().default(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { quantity } = parsed.data;
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: { promoter: { include: { wallet: true } } },
  });
  const buyerWallet = await requireWallet(req.userId);

  if (!event?.promoter.wallet) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  const amount = event.ticketPrice * quantity;

  try {
    await assertStepUpForAmount(req, amount);
  } catch (error) {
    if (handleStepUpError(res, error)) return;
    throw error;
  }

  try {
    const gate = await gateOrExecute(
      req,
      res,
      {
        operationType: 'ticket_purchase',
        amountNational: amount,
        recipientId: event.promoterId,
        payload: {
          amount,
          buyerId: req.userId,
          eventId: event.id,
          quantity,
          senderUserId: req.userId,
          recipientUserId: event.promoterId,
          senderWalletId: buyerWallet.id,
          recipientWalletId: event.promoter.wallet.id,
          senderLedger: { type: 'ticket_purchase', counterpartyName: event.title },
          recipientLedger: { type: 'ticket_sale', counterpartyName: event.title },
        },
      },
      async (ref) => {
        const ticket = await runMoneyTransaction(prisma, async (db) => {
          await assertEventCapacity(db, event, quantity);
          await transferNational(db, {
            amount,
            senderWalletId: buyerWallet.id,
            recipientWalletId: event.promoter.wallet.id,
            senderUserId: req.userId,
            recipientUserId: event.promoterId,
            reference: ref,
            senderLedger: { type: 'ticket_purchase', counterpartyName: event.title },
            recipientLedger: {
              type: 'ticket_sale',
              counterpartyName: event.title,
              reference: `${ref}-P`,
            },
          });
          const row = await db.ticket.create({
            data: { eventId: event.id, buyerId: req.userId, quantity, amount },
          });
          const passes = await createTicketPasses(db, row.id, quantity);
          return { ...row, passes, event };
        });
        return ticketShape(ticket, ticket.event, null);
      },
    );
    if (gate.held) return;
    res.status(201).json(gate.result);
  } catch (error) {
    if (error.code === 'event_sold_out') {
      res.status(409).json({ error: error.message });
      return;
    }
    if (isMoneyError(error)) {
      res.status(moneyErrorStatus(error)).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export async function mboloThreads(req, res) {
  if (req.method === 'GET') {
    const threads = await prisma.mboloThread.findMany({
      where: { members: { some: { userId: req.userId } } },
      include: { members: { include: { user: true } }, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(threads);
    return;
  }

  const schema = z.object({ name: z.string().optional(), memberHandles: z.array(z.string()).default([]) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { name, memberHandles } = parsed.data;
  const members = await prisma.user.findMany({ where: { handle: { in: memberHandles } } });
  const memberIds = Array.from(new Set([req.userId, ...members.map((m) => m.id)]));

  const thread = await prisma.mboloThread.create({
    data: {
      creatorId: req.userId,
      name,
      type: memberIds.length > 2 ? 'group' : 'direct',
      members: { create: memberIds.map((userId) => ({ userId })) },
    },
    include: { members: { include: { user: true } } },
  });
  res.status(201).json(thread);
}

export async function mboloThreadMessages(req, res) {
  const threadId = req.query.id;
  if (!threadId) {
    res.status(400).json({ error: 'Thread id required' });
    return;
  }

  const member = await prisma.mboloMember.findUnique({
    where: { threadId_userId: { threadId, userId: req.userId } },
  });
  if (!member) {
    res.status(403).json({ error: 'Not a member of this MBLOL thread' });
    return;
  }

  if (req.method === 'GET') {
    const q = String(req.query?.q ?? '').trim();
    const limit = Math.min(100, Math.max(20, Number(req.query?.limit ?? 50) || 50));
    const cursor = req.query?.cursor;

    const where = { threadId };
    if (q.length >= 2) {
      where.body = { contains: q, mode: 'insensitive' };
    }

    const messages = await prisma.mboloMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        sender: { select: { id: true, name: true, handle: true, avatarEmoji: true } },
        mediaAsset: { select: { id: true, kind: true, durationMs: true, waveformJson: true } },
      },
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const resolved = await Promise.all(
      page.map(async (m) => ({
        ...m,
        mediaUrl: (await resolveMessageMediaUrl(m, req.userId)) ?? m.mediaUrl,
      })),
    );

    await markThreadRead(req.userId, threadId).catch(() => {});

    res.json({
      messages: resolved.reverse(),
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
      storage: supabaseStorageConfigured() ? 'supabase' : 'legacy',
    });
    return;
  }

  const schema = z.object({
    body: z.string().max(5000).optional(),
    kind: z.enum(['text', 'voice', 'image', 'gif', 'sticker', 'video']).default('text'),
    mediaUrl: z.string().max(800_000).optional(),
    mediaAssetId: z.string().optional(),
    gifId: z.string().optional(),
    retention: z.enum(['thread', 'vault', 'profile', 'ephemeral']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { body, kind, mediaUrl, mediaAssetId, gifId, retention } = parsed.data;
  if (kind === 'text' && !body?.trim()) {
    res.status(400).json({ error: 'Message body required' });
    return;
  }
  if (kind === 'sticker' && !body?.trim()) {
    res.status(400).json({ error: 'Sticker body required' });
    return;
  }
  if ((kind === 'voice' || kind === 'image' || kind === 'gif' || kind === 'video') && !mediaUrl && !mediaAssetId && !gifId) {
    res.status(400).json({ error: 'mediaUrl, mediaAssetId, or gifId required for media messages' });
    return;
  }

  let resolvedMediaAssetId = mediaAssetId ?? null;
  let resolvedMediaUrl = mediaUrl ?? null;

  if (kind === 'gif' && gifId) {
    try {
      const gif = await resolveGifForMessage(req.userId, threadId, gifId);
      resolvedMediaUrl = gif.mediaUrl;
      resolvedMediaAssetId = gif.mediaAssetId ?? resolvedMediaAssetId;
    } catch (err) {
      if (err instanceof MboloMediaError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  }

  try {
    rejectLegacyDataUrl(resolvedMediaUrl);
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message, code: err.code });
    return;
  }

  if (resolvedMediaUrl?.startsWith('data:') && resolvedMediaUrl.length > 800_000) {
    res.status(413).json({ error: 'Fichier média trop lourd — choisis quelque chose de plus léger' });
    return;
  }
  if (kind === 'video' && resolvedMediaUrl && !resolvedMediaUrl.startsWith('https://') && !resolvedMediaAssetId) {
    res.status(400).json({ error: 'Vidéo invalide — envoie via Supabase Storage' });
    return;
  }

  if (resolvedMediaAssetId && !gifId) {
    try {
      resolvedMediaUrl = await getMediaReadUrl(resolvedMediaAssetId, req.userId);
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message, code: err.code });
      return;
    }
  }

  // WeChat-style trust: your first message in a direct chat requires the
  // friend verification gate (name + verified phone now, CNI later).
  try {
    const thread = await prisma.mboloThread.findUnique({
      where: { id: threadId },
      select: { id: true, type: true },
    });
    if (thread) await assertCanMessageInThread(req.userId, thread);
  } catch (error) {
    if (handleFriendError(res, error)) return;
    throw error;
  }

  const defaultBody =
    kind === 'image'
      ? '📷 Photo'
      : kind === 'gif'
        ? '🎬 GIF'
        : kind === 'voice'
          ? '🎤 Message vocal'
          : kind === 'video'
            ? '🎬 Vidéo'
            : body?.trim() ?? '';

  const expiresAt =
    retention === 'ephemeral' ? new Date(Date.now() + 24 * 3600 * 1000) : null;

  const message = await prisma.$transaction(async (tx) => {
    const row = await tx.mboloMessage.create({
      data: {
        threadId,
        senderId: req.userId,
        body: body?.trim() || defaultBody,
        kind,
        mediaUrl: kind === 'sticker' || kind === 'text' ? null : resolvedMediaUrl,
        mediaAssetId: resolvedMediaAssetId ?? null,
        retention: retention ?? 'thread',
        expiresAt,
      },
      include: { sender: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
    });

    if (resolvedMediaAssetId) {
      await tx.mbooloMediaAsset.update({
        where: { id: resolvedMediaAssetId },
        data: { threadId, status: 'ready' },
      });
    }

    return row;
  });
  await prisma.mboloThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });
  res.status(201).json(message);
}

export async function mboloBroadcast(req, res) {
  const schema = z.object({
    recipientHandles: z.array(z.string()).min(1),
    body: z.string().max(5000).optional(),
    kind: z.enum(['text', 'voice', 'image', 'gif', 'video']).default('text'),
    mediaUrl: z.string().max(800_000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  if (parsed.data.kind === 'text' && !parsed.data.body?.trim()) {
    res.status(400).json({ error: 'Message requis' });
    return;
  }

  try {
    const result = await broadcastMboloMessage(prisma, req.userId, parsed.data);
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof BroadcastError) {
      res.status(error.code === 'not_friends' ? 403 : 400).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function mboloVideoUploadToken(req, res) {
  if (!blobConfigured()) {
    res.status(503).json({
      error: 'Les vidéos ne sont pas encore activées sur ce serveur.',
      code: 'video_unavailable',
    });
    return;
  }
  try {
    const result = await mintMboloVideoUploadToken(req);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

export async function mboloThreadMembers(req, res) {
  const threadId = String(req.query.id ?? '');
  if (!threadId) {
    res.status(400).json({ error: 'Thread id required' });
    return;
  }
  const member = await prisma.mboloMember.findUnique({ where: { threadId_userId: { threadId, userId: req.userId } } });
  if (!member) {
    res.status(403).json({ error: 'Conversation introuvable' });
    return;
  }

  const schema = z.object({ handles: z.array(z.string()).min(1).max(20) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const normalized = [...new Set(parsed.data.handles.map((h) => String(h).replace(/^@+/, '').trim().toLowerCase()))];
  const users = await prisma.user.findMany({ where: { handle: { in: normalized } } });
  if (users.length === 0) {
    res.status(404).json({ error: 'Aucun de ces comptes n’existe' });
    return;
  }

  const existingMembers = await prisma.mboloMember.findMany({ where: { threadId } });
  const existingUserIds = new Set(existingMembers.map((m) => m.userId));
  const toAdd = users.filter((u) => !existingUserIds.has(u.id));

  if (toAdd.length > 0) {
    await prisma.mboloMember.createMany({
      data: toAdd.map((u) => ({ threadId, userId: u.id })),
      skipDuplicates: true,
    });
    const totalMembers = existingMembers.length + toAdd.length;
    await prisma.mboloThread.update({
      where: { id: threadId },
      data: { updatedAt: new Date(), type: totalMembers > 2 ? 'group' : undefined },
    });
    const adder = await prisma.user.findUnique({ where: { id: req.userId }, select: { name: true, handle: true } });
    await Promise.all(
      toAdd.map((u) =>
        createInAppNotification(
          u.id,
          'Ajouté à une conversation',
          `${adder?.name ?? adder?.handle ?? 'Un membre'} t’a ajouté à un groupe Mboolo`,
          { kind: 'mbolo_added', refId: threadId },
        ),
      ),
    );
  }

  const thread = await prisma.mboloThread.findUnique({
    where: { id: threadId },
    include: { members: { include: { user: true } } },
  });
  res.status(201).json(thread);
}

export async function mboloThreadInvite(req, res) {
  const threadId = String(req.query.id ?? '');
  if (!threadId) {
    res.status(400).json({ error: 'Thread id required' });
    return;
  }
  const member = await prisma.mboloMember.findUnique({ where: { threadId_userId: { threadId, userId: req.userId } } });
  if (!member) {
    res.status(403).json({ error: 'Conversation introuvable' });
    return;
  }

  let thread = await prisma.mboloThread.findUnique({ where: { id: threadId } });
  if (!thread) {
    res.status(404).json({ error: 'Conversation introuvable' });
    return;
  }

  if (!thread.inviteCode) {
    for (let i = 0; i < 5; i += 1) {
      try {
        thread = await prisma.mboloThread.update({
          where: { id: threadId },
          data: { inviteCode: generateInviteCode() },
        });
        break;
      } catch (error) {
        if (error.code !== 'P2002') throw error;
      }
    }
  }

  res.json({
    inviteCode: thread.inviteCode,
    joinUrl: buildGroupJoinUrl(thread.inviteCode),
    webUrl: buildWebGroupJoinUrl(thread.inviteCode),
  });
}

export async function mboloJoinByInvite(req, res) {
  const schema = z.object({ code: z.string().min(3) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const code = parsed.data.code.trim().toUpperCase();
  const thread = await prisma.mboloThread.findUnique({ where: { inviteCode: code } });
  if (!thread) {
    res.status(404).json({ error: 'Code d’invitation invalide' });
    return;
  }

  const existing = await prisma.mboloMember.findUnique({
    where: { threadId_userId: { threadId: thread.id, userId: req.userId } },
  });
  if (!existing) {
    await prisma.mboloMember.create({ data: { threadId: thread.id, userId: req.userId } });
    const memberCount = await prisma.mboloMember.count({ where: { threadId: thread.id } });
    await prisma.mboloThread.update({
      where: { id: thread.id },
      data: { updatedAt: new Date(), type: memberCount > 2 ? 'group' : undefined },
    });
  }

  const full = await prisma.mboloThread.findUnique({
    where: { id: thread.id },
    include: { members: { include: { user: true } } },
  });
  res.status(existing ? 200 : 201).json(full);
}

export async function mboloShare(req, res) {
  const schema = z.object({
    threadId: z.string().min(1),
    refType: z.enum(['business', 'product']),
    refId: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const message = await shareToMbolo(prisma, req.userId, parsed.data);
    res.status(201).json(message);
  } catch (error) {
    if (error instanceof MboloShareError) {
      const status = error.code === 'not_a_member' ? 403 : error.code === 'not_found' ? 404 : 400;
      res.status(status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

const TONTINE_FREQ = {
  Hebdo: 'hebdo',
  Mensuel: 'mensuel',
  'Bi-mensuel': 'bi-mensuel',
  hebdo: 'hebdo',
  mensuel: 'mensuel',
  'bi-mensuel': 'bi-mensuel',
  weekly: 'weekly',
  monthly: 'monthly',
};

function tontineGroupShape(group, userId) {
  const myMembership = group.memberships?.find((m) => m.userId === userId);
  const isMyTurn =
    Boolean(myMembership) &&
    myMembership.rotationOrder === group.rotationIndex &&
    !myMembership.hasReceivedPayout;
  const memberCount = group.memberships?.length ?? 0;
  const expectedPotNational = group.amountPerMember * memberCount;
  const expectedPot = legacyNationalToKori(expectedPotNational, 'SN');
  return {
    id: group.id,
    name: group.name,
    amountPerMember: group.amountPerMember,
    amountPerMemberNational: group.amountPerMember,
    frequency: group.frequency,
    potBalance: group.potBalance,
    rotationIndex: group.rotationIndex,
    memberCount,
    expectedPot,
    expectedPotNational,
    isMyTurn,
    releasing: isMyTurn && group.potBalance >= expectedPot && expectedPot > 0,
    members: (group.memberships ?? []).map((m) => ({
      userId: m.userId,
      name: m.user?.name,
      handle: m.user?.handle,
      avatarEmoji: m.user?.avatarEmoji,
      rotationOrder: m.rotationOrder,
      hasReceivedPayout: m.hasReceivedPayout,
    })),
    nextDueAt: group.nextDueAt,
    createdAt: group.createdAt,
  };
}

export async function tontineGroups(req, res) {
  const include = {
    memberships: {
      include: { user: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
      orderBy: { rotationOrder: 'asc' },
    },
  };

  if (req.method === 'GET') {
    const groups = await prisma.tontineGroup.findMany({
      where: { memberships: { some: { userId: req.userId } } },
      include,
      orderBy: { updatedAt: 'desc' },
    });
    res.json(groups.map((g) => tontineGroupShape(g, req.userId)));
    return;
  }

  const schema = z.object({
    name: z.string().min(2),
    amountPerMember: z.number().int().positive(),
    frequency: z.string().default('mensuel'),
    memberHandles: z.array(z.string()).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const { name, amountPerMember, memberHandles } = parsed.data;
  const frequency = TONTINE_FREQ[parsed.data.frequency] ?? 'mensuel';
  const others = await prisma.user.findMany({
    where: { handle: { in: memberHandles.map((h) => h.replace(/^@/, '')) } },
  });
  const memberIds = Array.from(new Set([req.userId, ...others.map((u) => u.id)]));

  const group = await prisma.tontineGroup.create({
    data: {
      name,
      amountPerMember,
      frequency,
      createdBy: req.userId,
      nextDueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      memberships: {
        create: memberIds.map((userId, index) => ({
          userId,
          rotationOrder: index,
        })),
      },
    },
    include,
  });

  const tontineThread = await ensureTontineThread(prisma, {
    groupId: group.id,
    creatorId: req.userId,
    memberIds,
    name: group.name,
  });
  await postTontineEscrowCard(prisma, {
    threadId: tontineThread.id,
    senderId: req.userId,
    group,
    amountKori: 0,
    reference: `TONTINE-${group.id.slice(0, 8)}`,
    action: 'created',
  });

  res.status(201).json({ ...tontineGroupShape(group, req.userId), mboloThreadId: tontineThread.id });
}

function handleTontineError(res, error) {
  if (error instanceof TontineError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

export async function tontineRelease(req, res) {
  const groupId = req.query.id;
  if (!groupId) {
    res.status(400).json({ error: 'Group id required' });
    return;
  }

  try {
    const result = await releaseTontinePot(groupId, req.userId);
    const group = await prisma.tontineGroup.findUnique({
      where: { id: groupId },
      include: {
        memberships: {
          include: { user: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
          orderBy: { rotationOrder: 'asc' },
        },
      },
    });
    res.json({
      ...result,
      group: group ? tontineGroupShape(group, req.userId) : null,
    });
  } catch (error) {
    if (handleTontineError(res, error)) return;
    throw error;
  }
}

function handleFriendError(res, error) {
  if (error instanceof FriendError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

export async function friendsHandler(req, res) {
  if (req.method === 'GET') {
    res.json(await listFriends(req.userId));
    return;
  }

  const schema = z.object({ handle: z.string().min(3), message: z.string().max(200).optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const result = await sendFriendRequest(req.userId, parsed.data.handle, parsed.data.message);
    if (result.requested) {
      await createInAppNotification(
        result.request.to.id,
        'Nouvelle demande d’ami',
        'Quelqu’un veut t’ajouter sur K21 — réponds dans Contacts.',
        { kind: 'friend' },
      );
    }
    res.status(result.alreadyFriends ? 200 : 201).json(result);
  } catch (error) {
    if (handleFriendError(res, error)) return;
    throw error;
  }
}

export async function friendRequestsList(req, res) {
  res.json(await listFriendRequests(req.userId));
}

export async function friendRequestRespond(req, res) {
  const accept = req.body?.accept !== false;
  try {
    const result = await respondFriendRequest(req.userId, req.query.id, accept);
    if (result.accepted && result.friend?.id) {
      const accepter = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { name: true, handle: true },
      });
      const label = accepter?.name?.trim() || `@${String(accepter?.handle ?? '').replace(/^@+/, '')}` || 'Quelqu’un';
      await createInAppNotification(
        result.friend.id,
        'Demande d’ami acceptée',
        `${label} t’a ajouté — vous êtes amis sur K21.`,
        { kind: 'friend' },
      );
    }
    res.json(result);
  } catch (error) {
    if (handleFriendError(res, error)) return;
    throw error;
  }
}

// ── Community vouch — 6-month member scans your QR to confirm you ──

export async function vouchHandler(req, res) {
  try {
    if (req.method === 'GET') {
      res.json(await vouchStatus(req.userId));
      return;
    }
    const result = await vouchForUser(req.userId, req.body?.handle);
    if (result.newlyConfirmed) {
      await createInAppNotification(
        result.target.id,
        'Compte confirmé 🛡️',
        'Un membre de confiance t’a confirmé — ton badge est actif.',
      );
    }
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof VouchError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

// ── Mboolo calls — LiveKit room token per thread ──

export async function callsToken(req, res) {
  const schema = z.object({
    threadId: z.string().min(1),
    video: z.boolean().optional(),
    ring: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const { threadId, video, ring } = parsed.data;
    const result = await mintCallToken(req.userId, threadId);

    // Ring = the caller starting the call: drop a join card in the chat and
    // notify the other members so they can pick up.
    if (ring) {
      const caller = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { name: true, handle: true },
      });
      const callerName = caller?.name || caller?.handle || 'Un membre';
      await prisma.mboloMessage.create({
        data: {
          threadId,
          senderId: req.userId,
          body: video ? '🎥 Appel vidéo en cours — rejoins !' : '📞 Appel en cours — rejoins !',
          kind: 'text',
        },
      });
      const others = await prisma.mboloMember.findMany({
        where: { threadId, NOT: { userId: req.userId } },
        select: { userId: true },
      });
      await Promise.all(
        others.map((m) =>
          createInAppNotification(
            m.userId,
            video ? 'Appel vidéo entrant 🎥' : 'Appel entrant 📞',
            `${callerName} t’appelle sur Mboolo — touche pour répondre.`,
            { kind: 'call', refId: threadId, actionLabel: 'Rejoindre' },
          ),
        ),
      );
    }

    res.json(result);
  } catch (error) {
    if (error instanceof CallError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function friendsRemove(req, res) {
  const friendUserId = req.query.id;
  if (!friendUserId) {
    res.status(400).json({ error: 'Friend id required' });
    return;
  }
  try {
    res.json(await removeFriend(req.userId, friendUserId));
  } catch (error) {
    if (handleFriendError(res, error)) return;
    throw error;
  }
}

export async function notificationsList(req, res) {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(notifications);
}

export async function notificationsRead(req, res) {
  const notificationId = req.query.id;
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, userId: req.userId } });
  if (!notification) {
    res.status(404).json({ error: 'Notification not found' });
    return;
  }
  res.json(await prisma.notification.update({ where: { id: notification.id }, data: { read: true } }));
}

export async function webhooksJulaya(req, res) {
  const rawBody = req.rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
  if (!verifyWebhookSignature(req.headers, rawBody)) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  const payload = parseWebhookPayload(JSON.parse(rawBody || '{}'));
  if (!payload.reference) {
    res.status(400).json({ error: 'Missing reference' });
    return;
  }

  const rail = await settleRailFromWebhook(prisma, {
    reference: payload.reference,
    status: payload.status ?? 'pending',
    amount: payload.amount ?? undefined,
    externalId: payload.id,
    failureReason: payload.failure_reason,
  });

  if (!rail) {
    // Partner (Kebu) collections use `pp_<paymentId>` rail references.
    if (String(payload.reference).startsWith('pp_')) {
      const outcome = await settlePartnerCollectFromWebhook(String(payload.reference).slice(3), payload);
      if (outcome) {
        res.json({ ok: true, partnerPayment: outcome });
        return;
      }
    }
    res.status(404).json({ error: 'Rail transaction not found' });
    return;
  }

  res.json({ ok: true, rail: railShape(rail) });
}

export async function smsPreferencesGet(req, res) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
  res.json({
    smsAlertsEnabled: user.smsAlertsEnabled,
    smsBalanceQueryEnabled: user.smsBalanceQueryEnabled,
    smsProviderConfigured: smsConfigured(),
    helpText: 'Envoie SOLDE par SMS pour consulter ton solde sans smartphone.',
  });
}

export async function smsPreferencesUpdate(req, res) {
  const schema = z.object({
    smsAlertsEnabled: z.boolean().optional(),
    smsBalanceQueryEnabled: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  const user = await prisma.user.update({
    where: { id: req.userId },
    data: parsed.data,
  });

  res.json({
    smsAlertsEnabled: user.smsAlertsEnabled,
    smsBalanceQueryEnabled: user.smsBalanceQueryEnabled,
  });
}

function parseSmsWebhookBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  const raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const params = new URLSearchParams(raw);
    return Object.fromEntries(params.entries());
  }
}

/** Inbound SMS — balance query (SOLDE) and help. Works on feature phones, no app required. */
export async function webhooksSmsInbound(req, res) {
  if (!verifySmsWebhook(req)) {
    res.status(401).json({ error: 'Invalid webhook secret' });
    return;
  }

  const body = parseSmsWebhookBody(req);
  const from = body.from ?? body.From;
  const text = body.text ?? body.Body ?? body.message;
  const externalId = body.id ?? body.MessageSid ?? body.smsId;

  const { reply } = await handleInboundSms({
    from,
    text,
    externalId,
    provider: smsConfig().provider,
  });

  const cfg = smsConfig();
  if (cfg.provider === 'twilio') {
    const escaped = String(reply ?? 'OK')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`,
    );
    return;
  }

  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send(reply ?? 'OK');
}


// ── K21 Charts — community favorite-song poll + YouTube SN trending ──

export async function chartsGet(req, res) {
  const chart = await getWeeklyChart(req.userId);
  res.json(chart);
}

export async function chartsSubmit(req, res) {
  try {
    const song = await submitAndVote(req.userId, req.body ?? {});
    res.status(201).json({ ok: true, songId: song.id });
  } catch (err) {
    if (err instanceof ChartsError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}

export async function chartsVote(req, res) {
  try {
    const song = await voteForSong(req.userId, req.body?.songId);
    res.json({ ok: true, songId: song.id });
  } catch (err) {
    if (err instanceof ChartsError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}

// ── OpenStreetMap geocoding proxy (Nominatim usage policy: server-side only) ──

export async function geoSearch(req, res) {
  const result = await geocodeSearch(req.query.q);
  if (!result.ok) {
    const status = result.code === 'query_too_short' || result.code === 'query_too_long' ? 400 : 502;
    res.status(status).json({ error: 'Recherche d’adresse indisponible', code: result.code });
    return;
  }
  res.json({ results: result.results });
}

// ── Real merchant reviews — computed ratings only, never seeded ──

export async function businessReviewsCreate(req, res) {
  try {
    const review = await upsertReview(req.userId, req.query.id, req.body ?? {});
    res.status(201).json({ ok: true, reviewId: review.id });
  } catch (err) {
    if (err instanceof ReviewError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}

export async function businessReviewsList(req, res) {
  const reviews = await getBusinessReviews(req.query.id);
  res.json(reviews);
}


export async function chartsSearch(req, res) {
  const result = await searchYouTubeMusic(req.query.q);
  if (!result.ok) {
    if (result.reason === 'no_api_key') {
      res.status(503).json({ error: 'Recherche musique bientôt disponible', code: 'search_unavailable' });
      return;
    }
    if (result.reason === 'query_too_short') {
      res.status(400).json({ error: 'Tape au moins 2 caractères', code: result.reason });
      return;
    }
    res.status(502).json({ error: 'Recherche YouTube indisponible', code: result.reason });
    return;
  }
  res.json({ results: result.results });
}


/** Public profile by @handle — only what the member chose to show. */
export async function publicProfileGet(req, res) {
  const handle = String(req.query.id ?? '').replace(/^@+/, '').toLowerCase();
  if (handle.length < 2) {
    res.status(400).json({ error: 'Handle invalide' });
    return;
  }
  const user = await prisma.user.findFirst({ where: { handle: { equals: handle, mode: 'insensitive' } } });
  if (!user) {
    res.status(404).json({ error: 'Profil introuvable' });
    return;
  }
  const [ngor, poll, communityConfirmed, friendRelation] = await Promise.all([
    computeNgorScore(user.id).catch(() => 0),
    activePollShape(user.id, req.userId).catch(() => null),
    isConfirmed(user.id).catch(() => false),
    getFriendRelation(req.userId, user.id).catch(() => 'none'),
  ]);
  res.json(publicProfileShape(user, { ngor, poll, communityConfirmed, friendRelation, id: user.id }));
}


// ── Profile polls — ask a question, friends vote ──

export async function pollsAsk(req, res) {
  try {
    if (req.body?.close === true) {
      await closePoll(req.userId);
      res.json({ ok: true, closed: true });
      return;
    }
    const poll = await askPoll(req.userId, req.body ?? {});
    res.status(201).json({ ok: true, pollId: poll.id });
  } catch (err) {
    if (err instanceof PollError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}

export async function pollsVote(req, res) {
  try {
    await votePoll(req.userId, req.query.id, req.body?.optionIx);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof PollError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}


// ── Channels — one per account, follow + feed ──

function channelErrorOut(res, err) {
  if (err instanceof ChannelError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

export async function channelsMine(req, res) {
  if (req.method === 'GET') {
    res.json({ channel: await myChannel(req.userId) });
    return;
  }
  try {
    const channel = await upsertChannel(req.userId, req.body ?? {});
    res.status(201).json({ ok: true, channelId: channel.id });
  } catch (err) {
    if (!channelErrorOut(res, err)) throw err;
  }
}

export async function channelsPost(req, res) {
  try {
    const post = await publishPost(req.userId, req.body ?? {});
    res.status(201).json({ ok: true, postId: post.id });
  } catch (err) {
    if (!channelErrorOut(res, err)) throw err;
  }
}

export async function channelsPostDelete(req, res) {
  try {
    await deletePost(req.userId, req.query.id);
    res.json({ ok: true });
  } catch (err) {
    if (!channelErrorOut(res, err)) throw err;
  }
}

export async function channelsBrowse(req, res) {
  res.json({ channels: await browseChannels(req.userId) });
}

export async function channelsFeed(req, res) {
  res.json({ posts: await followFeed(req.userId) });
}

export async function channelsView(req, res) {
  try {
    res.json(await viewChannel(req.query.id, req.userId));
  } catch (err) {
    if (!channelErrorOut(res, err)) throw err;
  }
}

export async function channelsFollow(req, res) {
  try {
    await setFollow(req.userId, req.query.id, req.body?.follow !== false);
    res.json({ ok: true });
  } catch (err) {
    if (!channelErrorOut(res, err)) throw err;
  }
}

const workerActivateBody = z.object({
  modes: z.array(z.enum(['delivery', 'seller', 'gigs'])).min(1),
});

export async function workersProfile(req, res) {
  if (req.method === 'GET') {
    const profile = await getWorkerProfile(req.userId);
    if (!profile) {
      res.status(404).json({ error: 'Aucun profil travailleur', code: 'worker_not_found' });
      return;
    }
    res.json(profile);
    return;
  }

  const parsed = workerActivateBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const profile = await activateWorkerProfile(req.userId, parsed.data);
    res.status(201).json(profile);
  } catch (error) {
    if (error instanceof WorkerError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function workersReceipts(req, res) {
  const receipts = await listWorkerReceipts(req.userId, {
    limit: req.query.limit ? Number(req.query.limit) : 50,
  });
  res.json(receipts);
}

export async function workersCreditSummary(req, res) {
  try {
    const summary = await getWorkerCreditSummary(req.userId);
    res.json(summary);
  } catch (error) {
    if (error instanceof WorkerError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}
