import { createHmac, randomBytes } from 'node:crypto';
import { prisma } from './prisma.js';
import { julayaMode } from './payment-config.js';
import { isProduction } from './runtime-safety.js';
import { getRailStatus, initiateCashIn } from './julaya.js';
import { canonicalPhone } from './phone-normalize.js';
import { runMoneyTransaction } from './wallet-atomic.js';
import { mintKoriFromNationalDeposit } from './kori-service.js';
import { formatKori } from './kori-primary.js';

const MAX_XOF = 50_000_000;
const METHODS = new Set(['wave', 'orange_money', 'free_money', 'auto']);

export class PartnerPaymentError extends Error {
  constructor(message, status = 400, code = 'invalid') {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'PartnerPaymentError';
  }
}

export function publicAppBaseUrl() {
  const raw =
    process.env.PUBLIC_APP_URL?.trim() ||
    process.env.EXPO_PUBLIC_API_URL?.trim() ||
    process.env.CRON_API_URL?.trim() ||
    'http://localhost:3000';
  return raw.replace(/\/$/, '');
}

/**
 * Production is always 'live': sandbox completion / auto-complete can never run
 * in production, whatever the Julaya configuration. A live operation without a
 * configured rail fails closed.
 */
export function partnerMode() {
  if (isProduction()) return 'live';
  const mode = julayaMode();
  if (mode === 'live') return 'live';
  return 'sandbox';
}

function payId() {
  return `pay_${randomBytes(12).toString('hex')}`;
}

function checkoutToken() {
  return randomBytes(24).toString('hex');
}

function parseMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[String(k).slice(0, 64)] = String(v).slice(0, 500);
  }
  return out;
}

/** Kebu legacy: USD cents → XOF via shared rate (default 600 XOF ≈ 1 USD). */
export function usdCentsToXof(amountUsdCents) {
  const rate = Number(process.env.JOKO_XOF_PER_USD ?? '600');
  const per = Number.isFinite(rate) && rate > 0 ? rate : 600;
  const cents = Number(amountUsdCents);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return Math.min(MAX_XOF, Math.max(1, Math.round((cents / 100) * per)));
}

export function resolveAmountXof(body) {
  if (body.amount_xof != null) {
    const n = Number(body.amount_xof);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_XOF) {
      throw new PartnerPaymentError('amount_xof must be a positive integer XOF amount');
    }
    return n;
  }
  if (body.amount != null && String(body.currency ?? 'USD').toUpperCase() === 'USD') {
    const xof = usdCentsToXof(body.amount);
    if (xof == null) throw new PartnerPaymentError('amount (USD cents) invalid');
    return xof;
  }
  throw new PartnerPaymentError(
    'amount_xof required (integer XOF). Legacy USD amount+currency also accepted.',
  );
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function paymentShape(row) {
  const base = publicAppBaseUrl();
  const metadata = row.metadataJson ? safeJson(row.metadataJson) : {};
  const payUrl = `${base}/api/v1/pay/${row.id}?token=${row.checkoutToken}`;
  return {
    id: row.id,
    reference: row.reference,
    status: row.status === 'completed' ? 'completed' : row.status,
    payment_url: payUrl,
    checkout_url: payUrl,
    qr_payload: payUrl,
    channel: metadata.channel === 'pos' || metadata.kind === 'pos' ? 'pos' : metadata.channel || 'online',
    amount_xof: row.amountXof,
    currency: row.currency,
    phone: row.phone,
    method: row.method,
    description: row.description,
    mode: partnerMode(),
    metadata,
    return_url: row.returnUrl,
    cancel_url: row.cancelUrl,
    completed_at: row.completedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export function signPartnerWebhookBody(rawBody, secret) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Create or return existing partner payment (idempotent on partnerId+reference).
 */
export async function createPartnerPayment(partnerId, body) {
  const reference = String(body.reference ?? '').trim();
  if (!reference || reference.length > 120) {
    throw new PartnerPaymentError('reference required (max 120 chars)');
  }

  const amountXof = resolveAmountXof(body);
  const methodRaw = String(body.method ?? 'auto').toLowerCase();
  const method = METHODS.has(methodRaw) ? methodRaw : 'auto';
  const phoneRaw = body.customer?.phone ?? body.phone ?? null;
  const phone = phoneRaw ? canonicalPhone(String(phoneRaw)) : null;
  if (phoneRaw && !phone) throw new PartnerPaymentError('customer.phone must be valid E.164');

  const metadata = parseMetadata({
    partner: partnerId,
    ...(body.channel ? { channel: String(body.channel) } : {}),
    ...(body.metadata ?? {}),
  });
  if (!metadata.partner) metadata.partner = partnerId;
  if (body.channel === 'pos' && !metadata.channel) metadata.channel = 'pos';
  if (body.channel === 'pos' && !metadata.kind) metadata.kind = 'pos';

  const webhookUrl =
    (typeof body.webhook_url === 'string' && body.webhook_url.trim()) ||
    process.env.PARTNER_WEBHOOK_URL?.trim() ||
    null;
  const returnUrl = typeof body.return_url === 'string' ? body.return_url.trim() : null;
  const cancelUrl = typeof body.cancel_url === 'string' ? body.cancel_url.trim() : null;
  const description =
    typeof body.description === 'string' ? body.description.trim().slice(0, 200) : null;

  const existing = await prisma.partnerPayment.findUnique({
    where: { partnerId_reference: { partnerId, reference } },
  });
  if (existing) {
    if (existing.amountXof !== amountXof) {
      throw new PartnerPaymentError(
        'reference already used with a different amount_xof',
        409,
        'idempotency_conflict',
      );
    }
    return { payment: existing, created: false };
  }

  const status = phone ? 'requires_action' : 'pending';
  let row;
  try {
    row = await prisma.partnerPayment.create({
      data: {
        id: payId(),
        partnerId,
        reference,
        amountXof,
        currency: 'XOF',
        status,
        phone,
        method,
        description,
        metadataJson: JSON.stringify(metadata),
        webhookUrl,
        returnUrl,
        cancelUrl,
        checkoutToken: checkoutToken(),
        settlementUserId: process.env.PARTNER_SETTLEMENT_USER_ID?.trim() || null,
      },
    });
  } catch (error) {
    // Concurrent create with the same reference: the unique index decides,
    // the loser returns the winner's row (idempotent, never a 500).
    if (error?.code !== 'P2002') throw error;
    const winner = await prisma.partnerPayment.findUnique({ where: { partnerId_reference: { partnerId, reference } } });
    if (!winner || winner.amountXof !== amountXof) {
      throw new PartnerPaymentError('reference already used with different details', 409, 'idempotency_conflict');
    }
    return { payment: winner, created: false };
  }

  return { payment: row, created: true };
}

export async function getPartnerPaymentByReference(partnerId, reference) {
  return prisma.partnerPayment.findUnique({
    where: { partnerId_reference: { partnerId, reference: String(reference) } },
  });
}

export async function getPartnerPaymentById(id) {
  return prisma.partnerPayment.findUnique({ where: { id: String(id) } });
}

export async function assertCheckoutAccess(paymentId, token) {
  const row = await getPartnerPaymentById(paymentId);
  if (!row) throw new PartnerPaymentError('Payment not found', 404, 'not_found');
  if (!token || token !== row.checkoutToken) {
    throw new PartnerPaymentError('Invalid checkout token', 401, 'unauthorized');
  }
  return row;
}

export async function confirmPartnerCheckout(paymentId, token, { phone, method } = {}) {
  const row = await assertCheckoutAccess(paymentId, token);
  if (row.status === 'completed') return row;
  if (row.status === 'failed') throw new PartnerPaymentError('Payment failed', 400, 'failed');

  const normalized = phone ? canonicalPhone(String(phone)) : row.phone;
  if (!normalized) throw new PartnerPaymentError('phone required');

  const methodRaw = String(method ?? row.method ?? 'auto').toLowerCase();
  const nextMethod = METHODS.has(methodRaw) ? methodRaw : 'auto';

  const updated = await prisma.partnerPayment.update({
    where: { id: row.id },
    data: {
      phone: normalized,
      method: nextMethod,
      status: 'requires_action',
    },
  });

  if (partnerMode() === 'sandbox' && process.env.PARTNER_SANDBOX_AUTO_COMPLETE === 'true') {
    return completePartnerPayment(updated.id, { source: 'sandbox_auto' });
  }

  if (partnerMode() === 'live') {
    const operator = nextMethod === 'auto' ? 'wave' : nextMethod;
    try {
      const railRef = `pp_${updated.id}`;
      const result = await initiateCashIn({
        amount: updated.amountXof,
        operator,
        phone: normalized,
        reference: railRef,
        idempotencyKey: railRef,
      });
      await prisma.partnerPayment.update({
        where: { id: updated.id },
        data: { railReference: result.externalId ?? railRef },
      });
      if (result.status === 'completed' && result.externalId) {
        // An initiation response is not settlement: confirm with the provider.
        const confirmed = await getRailStatus(result.externalId);
        if (
          confirmed.status === 'completed' &&
          (confirmed.amount == null || confirmed.amount === updated.amountXof)
        ) {
          return completePartnerPayment(updated.id, {
            source: 'julaya_confirmed',
            externalId: result.externalId,
          });
        }
      }
    } catch (err) {
      console.error('[partner-pay] julaya collect failed', err);
    }
  }

  return prisma.partnerPayment.findUniqueOrThrow({ where: { id: updated.id } });
}

export async function completePartnerPayment(paymentId, { source = 'manual', externalId } = {}) {
  const { deliverPartnerWebhook } = await import('./partner-webhook-service.js');

  const completed = await runMoneyTransaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "PartnerPayment" WHERE id = ${paymentId} FOR UPDATE`;
    const row = await tx.partnerPayment.findUnique({ where: { id: paymentId } });
    if (!row) throw new PartnerPaymentError('Payment not found', 404, 'not_found');
    if (row.status === 'completed') return { payment: row, already: true };

    const settlementUserId =
      row.settlementUserId || process.env.PARTNER_SETTLEMENT_USER_ID?.trim() || null;
    if (settlementUserId) {
      const user = await tx.user.findUnique({
        where: { id: settlementUserId },
        include: { wallet: true },
      });
      if (user?.wallet) {
        const mint = await mintKoriFromNationalDeposit(tx, {
          userId: user.id,
          walletId: user.wallet.id,
          country: user.country ?? 'SN',
          nationalAmount: row.amountXof,
          reference: `partner_${row.id}`,
          note: `Partner collect ${row.partnerId}/${row.reference}`,
          // Sandbox completions (never in production) book against their own
          // clearing account so they can't masquerade as real provider money.
          provider: String(source).startsWith('sandbox') ? 'partner_sandbox' : 'julaya',
        });
        await tx.ledgerEntry.create({
          data: {
            walletId: user.wallet.id,
            userId: user.id,
            type: 'partner_collect',
            amount: mint.koriMinted,
            note: `+${formatKori(mint.koriMinted)} · partner ${row.partnerId}`,
            reference: `partner_${row.id}`,
          },
        });
      }
    }

    const payment = await tx.partnerPayment.update({
      where: { id: row.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        railReference: externalId ?? row.railReference,
        failureReason: null,
      },
    });
    return { payment, already: false, source };
  });

  if (!completed.already) {
    await deliverPartnerWebhook(completed.payment).catch((err) => {
      console.error('[partner-pay] webhook delivery error', err);
    });
  }

  return completed.payment;
}

export async function sandboxCompletePartnerPayment(partnerId, reference) {
  if (partnerMode() === 'live') {
    throw new PartnerPaymentError('sandbox-complete disabled in live mode', 403, 'live_forbidden');
  }
  const row = await getPartnerPaymentByReference(partnerId, reference);
  if (!row) throw new PartnerPaymentError('Payment not found', 404, 'not_found');
  return completePartnerPayment(row.id, { source: 'sandbox_complete' });
}

/**
 * Signed Julaya webhook for a partner collection (`pp_<paymentId>`).
 * Completes only on a provider-confirmed success whose amount matches.
 */
export async function settlePartnerCollectFromWebhook(paymentId, payload) {
  const row = await getPartnerPaymentById(paymentId);
  if (!row) return null;
  const status = String(payload.status ?? '').toLowerCase();
  if (['completed', 'success', 'succeeded', 'paid'].includes(status)) {
    if (payload.amount != null && Number(payload.amount) !== row.amountXof) {
      return prisma.partnerPayment.update({
        where: { id: row.id },
        data: { failureReason: `amount_mismatch:provider=${payload.amount}` },
      }).then((r) => ({ id: r.id, status: r.status, review: true }));
    }
    const done = await completePartnerPayment(row.id, { source: 'julaya_webhook', externalId: payload.id });
    return { id: done.id, status: done.status };
  }
  if (['failed', 'error', 'rejected', 'cancelled'].includes(status) && row.status !== 'completed') {
    const failed = await prisma.partnerPayment.update({
      where: { id: row.id },
      data: { status: 'failed', failureReason: payload.failure_reason ?? 'provider_failed' },
    });
    return { id: failed.id, status: failed.status };
  }
  return { id: row.id, status: row.status };
}
