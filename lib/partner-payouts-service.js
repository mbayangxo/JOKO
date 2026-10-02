import { randomBytes } from 'node:crypto';
import { prisma } from './prisma.js';
import { initiateCashOut } from './julaya.js';
import { canonicalPhone } from './phone-normalize.js';
import { creditNational, runMoneyTransaction, InsufficientFundsError } from './wallet-atomic.js';
import { applyCirculationIncrease } from './kori-reserve.js';
import { julayaOperational } from './payment-config.js';
import { burnKoriForCashOut } from './kori-service.js';
import { nationalToKori } from './kori.js';
import {
  PartnerPaymentError,
  partnerMode,
  publicAppBaseUrl,
  resolveAmountXof,
  signPartnerWebhookBody,
} from './partner-payments-service.js';

const METHODS = new Set(['wave', 'orange_money', 'free_money', 'auto']);

function payoutId() {
  return `po_${randomBytes(12).toString('hex')}`;
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

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function payoutShape(row) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    amount_xof: row.amountXof,
    currency: row.currency,
    phone: row.phone,
    method: row.method,
    description: row.description,
    mode: partnerMode(),
    metadata: row.metadataJson ? safeJson(row.metadataJson) : {},
    completed_at: row.completedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    failure_reason: row.failureReason,
  };
}

export async function createPartnerPayout(partnerId, body) {
  const reference = String(body.reference ?? '').trim();
  if (!reference || reference.length > 120) {
    throw new PartnerPaymentError('reference required (max 120 chars)');
  }
  const amountXof = resolveAmountXof(body);
  const phone = canonicalPhone(String(body.phone ?? body.to_phone ?? ''));
  if (!phone) throw new PartnerPaymentError('phone required (E.164)');

  const methodRaw = String(body.method ?? 'auto').toLowerCase();
  const method = METHODS.has(methodRaw) ? methodRaw : 'auto';
  const metadata = parseMetadata({ partner: partnerId, kind: 'payout', ...(body.metadata ?? {}) });
  const webhookUrl =
    (typeof body.webhook_url === 'string' && body.webhook_url.trim()) ||
    process.env.PARTNER_WEBHOOK_URL?.trim() ||
    null;
  const description =
    typeof body.description === 'string' ? body.description.trim().slice(0, 200) : null;

  const existing = await prisma.partnerPayout.findUnique({
    where: { partnerId_reference: { partnerId, reference } },
  });
  if (existing) {
    if (existing.amountXof !== amountXof || existing.phone !== phone) {
      throw new PartnerPaymentError('reference already used with different amount/phone', 409, 'idempotency_conflict');
    }
    return { payout: existing, created: false };
  }

  let row;
  try {
    row = await prisma.partnerPayout.create({
      data: {
        id: payoutId(),
        partnerId,
        reference,
        amountXof,
        currency: 'XOF',
        status: 'pending',
        phone,
        method,
        description,
        metadataJson: JSON.stringify(metadata),
        webhookUrl,
        settlementUserId: process.env.PARTNER_SETTLEMENT_USER_ID?.trim() || null,
      },
    });
  } catch (error) {
    // Concurrent create with the same reference: the unique index decides,
    // the loser returns the winner's row (idempotent, never a 500).
    if (error?.code !== 'P2002') throw error;
    const winner = await prisma.partnerPayout.findUnique({ where: { partnerId_reference: { partnerId, reference } } });
    if (!winner || winner.amountXof !== amountXof) {
      throw new PartnerPaymentError('reference already used with different details', 409, 'idempotency_conflict');
    }
    return { payout: winner, created: false };
  }

  return { payout: row, created: true };
}

export async function getPartnerPayoutByReference(partnerId, reference) {
  return prisma.partnerPayout.findUnique({
    where: { partnerId_reference: { partnerId, reference: String(reference) } },
  });
}

async function deliverPayoutWebhook(payout) {
  const url = payout.webhookUrl || process.env.PARTNER_WEBHOOK_URL?.trim();
  const secret = process.env.JOKO_WEBHOOK_SECRET?.trim();
  if (!url || !secret) return { delivered: false };

  const priorOk = await prisma.partnerPayoutDelivery.findFirst({
    where: { payoutId: payout.id, ok: true },
  });
  if (priorOk) return { delivered: true, already: true };

  const payload = {
    reference: payout.reference,
    payout_id: payout.id,
    payment_id: payout.id,
    status: payout.status === 'completed' ? 'paid' : payout.status,
    amount_xof: payout.amountXof,
    currency: 'XOF',
    metadata: payout.metadataJson ? safeJson(payout.metadataJson) : {},
    mode: partnerMode(),
    type: 'payout',
  };
  const rawBody = JSON.stringify(payload);
  const signature = signPartnerWebhookBody(rawBody, secret);

  const BACKOFF = [0, 2000, 10000];
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, BACKOFF[attempt - 1] ?? 10000));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
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
      clearTimeout(timer);
      const text = await res.text().catch(() => '');
      last = { ok: res.ok, statusCode: res.status, body: text.slice(0, 2000) };
    } catch (err) {
      last = { ok: false, statusCode: 0, body: String(err.message ?? err).slice(0, 500) };
    }
    await prisma.partnerPayoutDelivery.create({
      data: {
        payoutId: payout.id,
        url,
        attempt,
        statusCode: last.statusCode || null,
        responseBody: last.body,
        ok: last.ok,
      },
    });
    if (last.ok) return { delivered: true, attempt };
  }
  return { delivered: false };
}

/**
 * Complete payout: debit settlement wallet (if set) then MM cash-out, or sandbox mark paid.
 */
export async function completePartnerPayout(payoutId, { source = 'manual' } = {}) {
  const row = await prisma.partnerPayout.findUnique({ where: { id: payoutId } });
  if (!row) throw new PartnerPaymentError('Payout not found', 404, 'not_found');
  if (row.status === 'completed') return row;

  const settlementUserId = row.settlementUserId || process.env.PARTNER_SETTLEMENT_USER_ID?.trim() || null;

  if (partnerMode() === 'live') {
    if (!settlementUserId) {
      throw new PartnerPaymentError('PARTNER_SETTLEMENT_USER_ID required for live payouts', 503, 'no_settlement');
    }
    if (!julayaOperational()) {
      throw new PartnerPaymentError('Payout rail not configured', 503, 'rail_unavailable');
    }

    // Claim the payout exactly once: only a 'pending' payout with no rail yet
    // may be executed. A second call (retry, double click, concurrent request)
    // sees 'processing' and returns the current state — no second burn/payout.
    const claimed = await prisma.partnerPayout.updateMany({
      where: { id: row.id, status: 'pending', railReference: null },
      data: { status: 'processing' },
    });
    if (claimed.count === 0) return prisma.partnerPayout.findUniqueOrThrow({ where: { id: row.id } });

    const operator = row.method === 'auto' ? 'wave' : row.method;
    const burnRef = `payout_${row.id}`;
    let user;
    try {
      await runMoneyTransaction(prisma, async (tx) => {
        user = await tx.user.findUnique({ where: { id: settlementUserId }, include: { wallet: true } });
        if (!user?.wallet) throw new PartnerPaymentError('Settlement wallet missing', 503, 'no_settlement');
        await burnKoriForCashOut(tx, {
          userId: user.id,
          walletId: user.wallet.id,
          koriAmount: nationalToKori(row.amountXof, user.country ?? 'SN'),
          country: user.country ?? 'SN',
          reference: burnRef,
          note: `Partner payout ${row.partnerId}/${row.reference}`,
        });
      });
    } catch (err) {
      await prisma.partnerPayout.update({ where: { id: row.id }, data: { status: 'pending' } });
      if (err instanceof InsufficientFundsError || err?.code === 'insufficient') {
        throw new PartnerPaymentError('Settlement wallet insufficient funds', 402, 'insufficient');
      }
      if (err instanceof PartnerPaymentError) throw err;
      console.error('[partner-payout] debit failed', err);
      throw new PartnerPaymentError('Payout debit failed', 502, 'debit_failed');
    }

    const railRef = `po_${row.id}`;
    let result;
    try {
      result = await initiateCashOut({
        amount: row.amountXof,
        operator,
        phone: row.phone,
        reference: railRef,
        idempotencyKey: railRef,
      });
    } catch (err) {
      // Unknown outcome — funds stay held, payout stays 'processing' for review.
      console.error('[partner-payout] initiation error (held for review)', err);
      return prisma.partnerPayout.update({
        where: { id: row.id },
        data: { railReference: railRef, failureReason: 'initiation_error_review' },
      });
    }

    if (result.status === 'failed') {
      // Explicit provider rejection: return the held ₭ exactly once.
      await runMoneyTransaction(prisma, async (tx) => {
        await creditNational(tx, {
          walletId: user.wallet.id,
          userId: user.id,
          amount: nationalToKori(row.amountXof, user.country ?? 'SN'),
          reference: `${burnRef}-REFUND`,
          ledger: { type: 'cash_out_refund', note: `Partner payout failed ${row.reference}` },
        });
        await applyCirculationIncrease(tx, nationalToKori(row.amountXof, user.country ?? 'SN'));
      });
      return prisma.partnerPayout.update({
        where: { id: row.id },
        data: { status: 'failed', railReference: railRef, failureReason: result.message || 'cash_out_failed' },
      });
    }

    if (result.status !== 'completed') {
      return prisma.partnerPayout.update({
        where: { id: row.id },
        data: { railReference: result.externalId ?? railRef },
      });
    }
  }

  const updated = await prisma.partnerPayout.update({
    where: { id: row.id },
    data: {
      status: 'completed',
      completedAt: new Date(),
      failureReason: null,
    },
  });

  await deliverPayoutWebhook(updated).catch((err) => console.error('[partner-payout] webhook', err));
  return updated;
}

export async function sandboxCompletePartnerPayout(partnerId, reference) {
  if (partnerMode() === 'live') {
    throw new PartnerPaymentError('sandbox-complete disabled in live mode', 403, 'live_forbidden');
  }
  const row = await getPartnerPayoutByReference(partnerId, reference);
  if (!row) throw new PartnerPaymentError('Payout not found', 404, 'not_found');
  return completePartnerPayout(row.id, { source: 'sandbox_complete' });
}

/** Execute payout immediately after create when requested. */
export async function executePartnerPayout(partnerId, reference) {
  const row = await getPartnerPayoutByReference(partnerId, reference);
  if (!row) throw new PartnerPaymentError('Payout not found', 404, 'not_found');
  if (partnerMode() === 'sandbox') {
    return completePartnerPayout(row.id, { source: 'sandbox_execute' });
  }
  return completePartnerPayout(row.id, { source: 'execute' });
}
