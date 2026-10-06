import { createHmac, randomBytes } from 'node:crypto';
import { prisma } from './prisma.js';
import { julayaMode } from './payment-config.js';
import { isProduction } from './runtime-safety.js';
import { getRailStatus, initiateCashIn } from './julaya.js';
import { canonicalPhone } from './phone-normalize.js';
import { runMoneyTransaction } from './wallet-atomic.js';
import { createOperation, transition } from './money-kernel/external-ops.js';
import { providerModeLabel } from './money-kernel/providers.js';
import { formatKori } from './kori-primary.js';
import { ensureBusinessWallet } from './business-wallet-service.js';
import { recordPayment } from './commerce/acceptance.js';

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
    settlement: settlementShape(row),
    completed_at: row.completedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * J6.0: what the partner learns about settlement — the target class, its own
 * merchant id and the canonical ledger reference. Never a Jokko wallet id,
 * owner or balance.
 */
function settlementShape(row) {
  const target = row.settlementTarget ?? 'legacy_platform';
  return {
    target,
    legacy: target === 'legacy_platform',
    external_business_id: row.externalBusinessId ?? null,
    status: row.status !== 'completed' ? 'pending' : target === 'held_for_review' ? 'held_for_review' : 'settled',
    ledger_reference: row.status === 'completed' ? row.settlementReference ?? null : null,
  };
}

/**
 * J6.0 (D24): a Kabu payment for a mapped merchant names the merchant by
 * Kabu's own business id. It resolves ONLY through the consented, active
 * ExternalLink of the SAME partner — never by name, phone, the legacy
 * Business.kebuId column or a Jokko id the partner supplies.
 */
async function resolveMerchantMapping(db, partnerId, externalBusinessId, assertedJokkoBusinessId) {
  const link = await db.externalLink.findUnique({
    where: { system_objectType_externalId: { system: partnerId, objectType: 'business', externalId: externalBusinessId } },
  });
  if (!link || link.status !== 'active' || !link.businessId) {
    throw new PartnerPaymentError('merchant is not linked to Jokko (consented business link required)', 409, 'merchant_not_linked');
  }
  if (assertedJokkoBusinessId && assertedJokkoBusinessId !== link.businessId) {
    throw new PartnerPaymentError('merchant mapping mismatch', 409, 'mapping_mismatch');
  }
  const business = await db.business.findUnique({ where: { id: link.businessId }, select: { id: true, status: true } });
  if (!business || business.status !== 'active') {
    throw new PartnerPaymentError('merchant is not active', 409, 'merchant_inactive');
  }
  return link;
}

/** LEGACY (D23): unmapped partner collections settle to PARTNER_SETTLEMENT_USER_ID. */
function legacyPlatformSettlementAllowed() {
  return process.env.PARTNER_LEGACY_PLATFORM_SETTLEMENT !== 'false';
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

  const rawExternal = body.merchant?.external_business_id ?? body.external_business_id ?? null;
  const externalBusinessId = rawExternal == null || rawExternal === '' ? null : String(rawExternal).trim().slice(0, 120);
  const assertedJokkoBusinessId = body.merchant?.jokko_business_id ?? body.jokko_business_id ?? null;
  if (!externalBusinessId && assertedJokkoBusinessId) {
    // A Jokko id alone is never a settlement instruction.
    throw new PartnerPaymentError('external_business_id required with jokko_business_id', 400, 'invalid');
  }

  const sameRequest = (row) => row.amountXof === amountXof && (row.externalBusinessId ?? null) === externalBusinessId;
  const existing = await prisma.partnerPayment.findUnique({
    where: { partnerId_reference: { partnerId, reference } },
  });
  if (existing) {
    if (!sameRequest(existing)) {
      throw new PartnerPaymentError(
        'reference already used with a different amount_xof or merchant',
        409,
        'idempotency_conflict',
      );
    }
    return { payment: existing, created: false };
  }

  let settlement;
  if (externalBusinessId) {
    const link = await resolveMerchantMapping(prisma, partnerId, externalBusinessId, assertedJokkoBusinessId ? String(assertedJokkoBusinessId) : null);
    await ensureBusinessWallet(link.businessId, prisma);
    settlement = {
      settlementTarget: 'business_wallet',
      externalBusinessId,
      settlementBusinessId: link.businessId,
      externalLinkId: link.id,
      settlementUserId: null, // a mapped merchant's money never goes to the platform wallet
    };
  } else {
    if (!legacyPlatformSettlementAllowed()) {
      throw new PartnerPaymentError('merchant.external_business_id required (legacy platform settlement disabled)', 400, 'merchant_required');
    }
    settlement = { settlementTarget: 'legacy_platform', settlementUserId: process.env.PARTNER_SETTLEMENT_USER_ID?.trim() || null };
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
        ...settlement,
      },
    });
  } catch (error) {
    // Concurrent create with the same reference: the unique index decides,
    // the loser returns the winner's row (idempotent, never a 500).
    if (error?.code !== 'P2002') throw error;
    const winner = await prisma.partnerPayment.findUnique({ where: { partnerId_reference: { partnerId, reference } } });
    if (!winner || !sameRequest(winner)) {
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

/**
 * J6.0: is the payment's bound merchant still a valid settlement target?
 * Locks the mapping (a concurrent revoke / relink waits or commits first) and
 * share-locks the business (a concurrent suspension waits or commits first).
 * The target is the business bound AT CREATION; a mapping that now points
 * elsewhere is never followed.
 */
async function validateBoundMerchant(tx, row) {
  if (!row.externalLinkId || !row.settlementBusinessId) return 'mapping_missing';
  await tx.$executeRaw`SELECT id FROM "ExternalLink" WHERE id = ${row.externalLinkId} FOR UPDATE`;
  const link = await tx.externalLink.findUnique({ where: { id: row.externalLinkId } });
  if (!link || link.status !== 'active') return 'mapping_revoked';
  if (link.system !== row.partnerId || link.externalId !== row.externalBusinessId || link.businessId !== row.settlementBusinessId) return 'mapping_changed';
  const { assertBusinessCanReceive, BusinessIneligibleError } = await import('./business/eligibility.js');
  try {
    await assertBusinessCanReceive(tx, row.settlementBusinessId, 'partner_settlement');
  } catch (e) {
    if (e instanceof BusinessIneligibleError) return 'merchant_inactive';
    throw e;
  }
  return null;
}

async function confirmPartnerCollection(tx, row, { source, externalId, userId, accountCode }) {
  // J2: a partner collection is an ExternalOperation confirmed by the
  // provider (or a non-production sandbox completion, booked to its own
  // provider so it can never pass for real money).
  const sandbox = String(source).startsWith('sandbox');
  const provider = sandbox ? 'partner_sandbox' : 'julaya';
  const op = await createOperation(tx, {
    provider,
    direction: 'in',
    reference: `partner_${row.id}`,
    amountMinor: row.amountXof,
    currency: 'XOF',
    userId: userId ?? null,
    accountCode,
    providerMode: sandbox ? 'sandbox' : providerModeLabel('julaya'),
    legacyTable: 'PartnerPayment',
    legacyId: row.id,
  });
  if (op.accountCode !== accountCode) throw new PartnerPaymentError('settlement target changed for an existing operation', 409, 'settlement_conflict');
  await transition(tx, op.id, 'submitted', { source: source ?? 'api', providerReference: externalId ?? row.railReference ?? undefined });
  const confirmed = await transition(tx, op.id, 'confirmed', { source: source ?? 'api', signatureOk: !sandbox, evidence: { source, externalId } });
  return { kori: Number(confirmed.op.amountKori), changed: confirmed.changed, provider, ledgerReference: `partner_${row.id}-CONFIRM` };
}

async function holdForReview(tx, row, ctx, reason) {
  const res = await confirmPartnerCollection(tx, row, { ...ctx, accountCode: `partner:${row.partnerId}:unallocated` });
  await tx.reconciliationException.upsert({
    where: { kind_provider_providerReference: { kind: 'partner_settlement_held', provider: res.provider, providerReference: `partner_${row.id}` } },
    create: {
      kind: 'partner_settlement_held', provider: res.provider, providerReference: `partner_${row.id}`,
      amountMinor: BigInt(res.kori), currency: 'KRI',
      detail: `Partner collection ${row.partnerId} held for review: ${reason} (bound merchant ${row.settlementBusinessId ?? 'none'})`,
    },
    update: {},
  });
  return { target: 'held_for_review', settlementReference: res.ledgerReference };
}

export async function completePartnerPayment(paymentId, { source = 'manual', externalId } = {}) {
  const { deliverPartnerWebhook } = await import('./partner-webhook-service.js');

  const completed = await runMoneyTransaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "PartnerPayment" WHERE id = ${paymentId} FOR UPDATE`;
    const row = await tx.partnerPayment.findUnique({ where: { id: paymentId } });
    if (!row) throw new PartnerPaymentError('Payment not found', 404, 'not_found');
    if (row.status === 'completed') return { payment: row, already: true };

    const ctx = { source, externalId };
    let outcome = { target: row.settlementTarget, settlementReference: null };

    if (row.settlementTarget === 'business_wallet') {
      // D24: mapped merchant → ITS business wallet, or held for review. Never
      // the platform wallet, never another business.
      const problem = await validateBoundMerchant(tx, row);
      if (problem) {
        outcome = await holdForReview(tx, row, ctx, problem);
      } else {
        const bw = await ensureBusinessWallet(row.settlementBusinessId, tx);
        const res = await confirmPartnerCollection(tx, row, { ...ctx, accountCode: `business:${row.settlementBusinessId}:wallet` });
        if (res.changed) {
          await tx.businessLedgerEntry.create({
            data: { businessWalletId: bw.id, businessId: row.settlementBusinessId, type: 'partner_collect', amount: res.kori, note: `Paiement ${row.partnerId} · ${row.reference}`.slice(0, 200), reference: `partner_${row.id}` },
          });
          const metadata = row.metadataJson ? safeJson(row.metadataJson) : {};
          await recordPayment(tx, {
            businessId: row.settlementBusinessId, method: 'partner_checkout', sourceChannel: metadata.channel === 'pos' ? 'partner_pos' : 'partner_online',
            sourceSystem: row.partnerId, amountKori: res.kori, ledgerReference: res.ledgerReference, externalRef: row.reference,
          });
        }
        outcome = { target: 'business_wallet', settlementReference: res.ledgerReference };
      }
    } else {
      // LEGACY (D23): unmapped partner collections settle to the platform-wide
      // PARTNER_SETTLEMENT_USER_ID wallet. Kept only for unmapped payments;
      // a mapped merchant can never reach this branch.
      const settlementUserId =
        row.settlementUserId || process.env.PARTNER_SETTLEMENT_USER_ID?.trim() || null;
      const user = settlementUserId
        ? await tx.user.findUnique({ where: { id: settlementUserId }, include: { wallet: true } })
        : null;
      if (user?.wallet) {
        const res = await confirmPartnerCollection(tx, row, { ...ctx, userId: user.id, accountCode: `customer:${user.id}:available` });
        if (res.changed) {
          await tx.koriTransaction.create({
            data: { recipientId: user.id, amountKori: res.kori, transactionType: 'mint', reference: `partner_${row.id}-KORI`, note: `Partner collect ${row.partnerId}/${row.reference}` },
          });
          await tx.ledgerEntry.create({
            data: {
              walletId: user.wallet.id,
              userId: user.id,
              type: 'partner_collect',
              amount: res.kori,
              note: `+${formatKori(res.kori)} · partner ${row.partnerId}`,
              reference: `partner_${row.id}`,
            },
          });
        }
        outcome = { target: 'legacy_platform', settlementReference: res.ledgerReference };
      } else {
        // Collected money is always on the ledger: with no settlement wallet
        // configured it is held for review, never left unbooked.
        outcome = await holdForReview(tx, row, ctx, 'no_settlement_wallet');
      }
    }

    const payment = await tx.partnerPayment.update({
      where: { id: row.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        railReference: externalId ?? row.railReference,
        failureReason: null,
        settlementTarget: outcome.target,
        settlementReference: outcome.settlementReference,
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
