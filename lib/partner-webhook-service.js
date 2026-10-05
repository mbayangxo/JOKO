import { prisma } from './prisma.js';
import { signPartnerWebhookBody, paymentShape } from './partner-payments-service.js';

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [0, 2_000, 10_000, 60_000, 300_000];

function webhookSecret() {
  return process.env.JOKO_WEBHOOK_SECRET?.trim() || null;
}

export function buildPartnerWebhookPayload(payment) {
  const metadata = payment.metadataJson
    ? (() => {
        try {
          return JSON.parse(payment.metadataJson);
        } catch {
          return {};
        }
      })()
    : {};

  return {
    reference: payment.reference,
    payment_id: payment.id,
    status: 'paid',
    amount_xof: payment.amountXof,
    currency: 'XOF',
    metadata,
    mode: paymentShape(payment).mode,
    // J6.0: where the money settled (target class + canonical ledger reference).
    settlement: paymentShape(payment).settlement,
  };
}

async function postOnce(url, rawBody, signature) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-joko-signature': `sha256=${signature}`,
        'User-Agent': 'Joko-PartnerWebhook/1.0',
      },
      body: rawBody,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return { statusCode: res.status, ok: res.ok, body: text.slice(0, 2000) };
  } catch (err) {
    return { statusCode: 0, ok: false, body: String(err.message ?? err).slice(0, 500) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver payment webhook to partner URL. Retries with backoff on non-2xx.
 * Idempotent: if a prior delivery already ok for this payment, skip.
 */
export async function deliverPartnerWebhook(payment) {
  const url = payment.webhookUrl || process.env.PARTNER_WEBHOOK_URL?.trim();
  if (!url) {
    console.warn('[partner-webhook] no webhook URL for', payment.id);
    return { delivered: false, reason: 'no_url' };
  }

  const secret = webhookSecret();
  if (!secret) {
    console.warn('[partner-webhook] JOKO_WEBHOOK_SECRET unset — skipping delivery');
    return { delivered: false, reason: 'no_secret' };
  }

  const priorOk = await prisma.partnerWebhookDelivery.findFirst({
    where: { paymentId: payment.id, ok: true },
  });
  if (priorOk) return { delivered: true, already: true };

  const payload = buildPartnerWebhookPayload(payment);
  const rawBody = JSON.stringify(payload);
  const signature = signPartnerWebhookBody(rawBody, secret);

  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
      await new Promise((r) => setTimeout(r, wait));
    }

    last = await postOnce(url, rawBody, signature);
    await prisma.partnerWebhookDelivery.create({
      data: {
        paymentId: payment.id,
        url,
        attempt,
        statusCode: last.statusCode || null,
        responseBody: last.body || null,
        ok: last.ok,
        nextRetryAt: last.ok ? null : new Date(Date.now() + (BACKOFF_MS[attempt] ?? 300_000)),
      },
    });

    if (last.ok) return { delivered: true, attempt, statusCode: last.statusCode };
  }

  return { delivered: false, attempt: MAX_ATTEMPTS, statusCode: last?.statusCode };
}
