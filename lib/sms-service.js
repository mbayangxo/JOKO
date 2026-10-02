/**
 * SMS delivery — works without smartphone (feature phones, no data).
 * Balance inquiry + receive alerts + OTP. Failure never blocks money movement.
 */

import { fetchExternalJson } from './external-fetch.js';
import { formatKori } from './kori.js';
import { prisma } from './prisma.js';
import { smsConfig, smsConfigured } from './sms-config.js';
import { secretsEqual } from './field-crypto.js';

export { smsConfigured };

export const BALANCE_KEYWORDS = new Set(['SOLDE', 'BALANCE', 'SALIO', 'SALDO', 'BAL']);
export const HELP_KEYWORDS = new Set(['AIDE', 'HELP', 'INFO', '?']);

const MAX_SMS_PER_HOUR = 20;
const MAX_BALANCE_QUERIES_PER_HOUR = 10;

/** Normalize to E.164-ish for SMS delivery and lookup. */
export function normalizeSmsPhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let phone = raw.replace(/\s/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  else if (!phone.startsWith('+')) phone = `+${phone}`;
  if (phone.length < 9) return null;
  return phone;
}

/** Match User.phone across +prefix variants (carriers send different formats). */
export async function findUserByPhone(raw) {
  const primary = normalizeSmsPhone(raw);
  if (!primary) return null;
  const bare = primary.replace(/^\+/, '');
  const variants = [...new Set([primary, bare, `+${bare}`])];

  for (const phone of variants) {
    const user = await prisma.user.findUnique({ where: { phone }, include: { wallet: true } });
    if (user) return user;
  }
  return null;
}

export function parseInboundKeyword(text) {
  const word = String(text ?? '')
    .trim()
    .split(/\s+/)[0]
    .toUpperCase()
    .replace(/[^A-Z?]/g, '');
  if (BALANCE_KEYWORDS.has(word)) return 'balance';
  if (HELP_KEYWORDS.has(word)) return 'help';
  return 'unknown';
}

export function formatBalanceMessage(wallet) {
  const national = `${wallet.balance.toLocaleString('fr-FR')} ${wallet.currency}`;
  const kori =
    wallet.koriBalance > 0 ? ` et ${formatKori(wallet.koriBalance)}` : '';
  return `K21: Ton solde est ${national}${kori}. Envoie SOLDE pour revérifier.`;
}

export function formatReceivedMessage({ amount, currency, senderLabel, wallet }) {
  const amountLabel =
    currency === 'kori'
      ? formatKori(amount)
      : `${amount.toLocaleString('fr-FR')} ${wallet.currency}`;
  const balanceLabel = `${wallet.balance.toLocaleString('fr-FR')} ${wallet.currency}`;
  const from = senderLabel ? ` de ${senderLabel}` : '';
  return `K21: Tu as reçu ${amountLabel}${from}. Nouveau solde: ${balanceLabel}.`;
}

export function formatDepositMessage({ amount, wallet }) {
  const amountLabel = `${amount.toLocaleString('fr-FR')} ${wallet.currency}`;
  const balanceLabel = `${wallet.balance.toLocaleString('fr-FR')} ${wallet.currency}`;
  return `K21: Dépôt de ${amountLabel} confirmé. Nouveau solde: ${balanceLabel}.`;
}

export function formatOtpMessage(code) {
  return `K21: Ton code est ${code}. Valide 10 minutes. Ne le partage avec personne.`;
}

const HELP_MESSAGE =
  'K21: Envoie SOLDE pour ton solde. Télécharge l\'app K21 ou contacte un agent. Pas de smartphone? Le SMS suffit.';

const UNKNOWN_PHONE_MESSAGE =
  "K21: Ce numéro n'est pas inscrit. Inscris-toi avec ton téléphone sur l'app K21.";

const RATE_LIMIT_MESSAGE = 'K21: Trop de SMS. Réessaie dans une heure.';

async function logSms({ userId, phone, direction, body, provider, status, purpose, externalId }) {
  try {
    await prisma.smsMessage.create({
      data: {
        userId: userId ?? null,
        phone,
        direction,
        body,
        provider: provider ?? null,
        status,
        purpose: purpose ?? null,
        externalId: externalId ?? null,
      },
    });
  } catch (error) {
    console.error('[SMS] audit log failed', error);
  }
}

async function checkSmsRateLimit(phone) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const count = await prisma.smsMessage.count({
    where: { phone, direction: 'outbound', createdAt: { gte: oneHourAgo } },
  });
  return count < MAX_SMS_PER_HOUR;
}

async function checkBalanceQueryRateLimit(phone) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const count = await prisma.smsMessage.count({
    where: {
      phone,
      direction: 'inbound',
      purpose: 'balance_query',
      createdAt: { gte: oneHourAgo },
    },
  });
  return count < MAX_BALANCE_QUERIES_PER_HOUR;
}

async function sendViaAfricasTalking(phone, message) {
  const cfg = smsConfig();
  const params = new URLSearchParams({
    username: cfg.username,
    to: phone,
    message,
  });
  if (cfg.shortCode) params.set('from', cfg.shortCode);

  const result = await fetchExternalJson('https://api.africastalking.com/version1/messaging', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      apiKey: cfg.apiKey,
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (result.ok) {
    const recipients = result.body?.SMSMessageData?.Recipients;
    const first = Array.isArray(recipients) ? recipients[0] : null;
    return {
      ok: true,
      externalId: first?.messageId ?? null,
      status: String(first?.status ?? 'sent').toLowerCase(),
    };
  }
  return { ok: false, status: 'failed', error: result.body?.SMSMessageData?.Message ?? 'send failed' };
}

async function sendViaTwilio(phone, message) {
  const cfg = smsConfig();
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
  const params = new URLSearchParams({ To: phone, From: cfg.fromNumber, Body: message });

  const result = await fetchExternalJson(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
      body: params.toString(),
    },
  );

  if (result.ok) {
    return { ok: true, externalId: result.body.sid ?? null, status: 'sent' };
  }
  return { ok: false, status: 'failed', error: result.body?.message ?? 'send failed' };
}

/** Send SMS — never throws; returns { ok, status }. */
export async function sendSms(phone, message, { userId, purpose } = {}) {
  const normalized = normalizeSmsPhone(phone);
  if (!normalized) return { ok: false, status: 'invalid_phone' };

  if (!(await checkSmsRateLimit(normalized))) {
    await logSms({
      userId,
      phone: normalized,
      direction: 'outbound',
      body: message,
      status: 'rate_limited',
      purpose,
    });
    return { ok: false, status: 'rate_limited' };
  }

  const cfg = smsConfig();
  let result;

  if (cfg.provider === 'mock' && process.env.NODE_ENV === 'production') {
    // No provider in production: nothing is sent and message content (OTPs)
    // is never written to logs.
    result = { ok: false, status: 'no_provider' };
  } else if (cfg.provider === 'mock') {
    console.info('[SMS mock]', normalized, message);
    result = { ok: true, status: 'mock', externalId: `mock-${Date.now()}` };
  } else if (cfg.provider === 'africastalking') {
    result = await sendViaAfricasTalking(normalized, message);
  } else if (cfg.provider === 'twilio') {
    result = await sendViaTwilio(normalized, message);
  } else {
    result = { ok: false, status: 'no_provider' };
  }

  await logSms({
    userId,
    phone: normalized,
    direction: 'outbound',
    // Never persist one-time codes in the SMS log table.
    body: purpose === 'otp' ? '[otp redacted]' : message,
    provider: cfg.provider,
    status: result.ok ? result.status : 'failed',
    purpose,
    externalId: result.externalId,
  });

  return result;
}

export async function sendOtpSms(phone, code) {
  return sendSms(phone, formatOtpMessage(code), { purpose: 'otp' });
}

/**
 * Handle inbound SMS (balance query, help).
 * Returns reply text for the webhook to send back.
 */
export async function handleInboundSms({ from, text, externalId, provider }) {
  const phone = normalizeSmsPhone(from);
  if (!phone) return { reply: UNKNOWN_PHONE_MESSAGE };

  const keyword = parseInboundKeyword(text);

  await logSms({
    phone,
    direction: 'inbound',
    body: String(text ?? '').slice(0, 500),
    provider,
    status: 'received',
    purpose: keyword === 'balance' ? 'balance_query' : keyword,
    externalId,
  });

  if (keyword === 'help') return { reply: HELP_MESSAGE };

  if (keyword === 'balance') {
    if (!(await checkBalanceQueryRateLimit(phone))) {
      return { reply: RATE_LIMIT_MESSAGE };
    }

    const user = await findUserByPhone(phone);

    if (!user?.wallet) return { reply: UNKNOWN_PHONE_MESSAGE };
    if (!user.smsBalanceQueryEnabled) {
      return { reply: 'K21: Consultation SMS désactivée. Active-la dans l\'app ou contacte le support.' };
    }

    return { reply: formatBalanceMessage(user.wallet), userId: user.id };
  }

  return { reply: HELP_MESSAGE };
}

/**
 * Africa's Talking's classic SMS "Incoming Messages" callback has no built-in
 * request signing — you authenticate it yourself, conventionally via a secret
 * embedded in the callback URL you register in their dashboard (e.g.
 * https://yourapp.com/api/webhooks/sms/inbound?secret=xxxx), since AT can't
 * add custom headers. Twilio's classic webhook config is similarly just a
 * URL. So this checks a query-param secret (works for both providers today)
 * and also accepts a header, in case a header-based setup is used later.
 */
export function verifySmsWebhook(req) {
  const { webhookSecret } = smsConfig();
  if (!webhookSecret) return smsConfig().provider === 'mock' && process.env.NODE_ENV !== 'production';
  const provided = req.query?.secret ?? req.headers['x-sms-webhook-secret'] ?? req.headers['x-k21-sms-secret'];
  return secretsEqual(String(provided ?? ''), webhookSecret);
}
