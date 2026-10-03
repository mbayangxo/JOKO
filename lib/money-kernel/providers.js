import { getRailStatus, initiateCashIn, initiateCashOut, verifyWebhookSignature } from '../julaya.js';
import { julayaConfig } from '../payment-config.js';
import { stripeConfigured, verifyStripeWebhook } from '../stripe-service.js';
import { isProduction, RailUnavailableError } from '../runtime-safety.js';

/**
 * Provider adapter boundary (docs/JOKKO-J2-DESIGN.md §5). Every rail exposes
 * the same contract; the kernel never talks to a provider SDK directly.
 *
 *   mode()            'live' | 'sandbox' | 'mock' | 'unavailable'
 *   initiate(op)      → { status: 'submitted'|'failed'|'ambiguous'|'completed', providerReference, raw }
 *   lookupStatus(ref) → { status: 'pending'|'confirmed'|'failed'|'reversed', amountMinor, currency, providerReference }
 *   verifyWebhook(headers, rawBody, body) → boolean
 *   timeoutPolicy     { submitTimeoutMs, outcomeDeadlineMs } — the deadline only
 *                     moves an op to 'expired' (review), never confirms it
 *   parseStatement(rows) → [{ providerReference, direction, amountMinor, currency, settledAt }]
 *
 * Production rule: getProvider() throws unless the adapter is 'live'. A
 * missing key can never silently turn into sandbox or mock.
 */

const mapStatus = (s) =>
  s === 'completed' ? 'confirmed' : s === 'failed' ? 'failed' : s === 'reversed' ? 'reversed' : 'pending';

const julaya = {
  name: 'julaya',
  currencies: ['XOF'],
  mode() {
    const m = julayaConfig().mode; // 'production' | 'sandbox' | 'mock' | 'unavailable'
    return m === 'production' ? 'live' : m;
  },
  timeoutPolicy: { submitTimeoutMs: 15_000, outcomeDeadlineMs: 24 * 3600_000 },
  async initiate(op, { phone, operator, callbackUrl }) {
    const fn = op.direction === 'in' ? initiateCashIn : initiateCashOut;
    try {
      const r = await fn({ reference: op.reference, amount: Number(op.amountMinor), phone, operator, callbackUrl, idempotencyKey: op.idempotencyKey ?? op.reference });
      return {
        status: r.status === 'failed' ? 'failed' : r.status === 'completed' ? 'completed' : r.externalId ? 'submitted' : 'ambiguous',
        providerReference: r.externalId ?? null,
        message: r.message,
        raw: r,
      };
    } catch (error) {
      // Timeout / network: the request may have reached the provider.
      return { status: 'ambiguous', providerReference: null, message: error?.message ?? 'initiation error' };
    }
  },
  async lookupStatus(providerReference) {
    const r = await getRailStatus(providerReference);
    return {
      status: mapStatus(r.status),
      amountMinor: r.amount ?? null,
      currency: r.currency ?? null,
      providerReference: r.externalId ?? providerReference,
      sandbox: String(providerReference ?? '').startsWith('sandbox-'),
    };
  },
  verifyWebhook(headers, rawBody) {
    return verifyWebhookSignature(headers, rawBody);
  },
  parseStatement(rows) {
    return rows.map((r) => ({
      providerReference: String(r.id ?? r.transaction_id ?? r.providerReference),
      direction: r.direction ?? (r.type === 'collection' ? 'in' : 'out'),
      amountMinor: Number(r.amount ?? r.amountMinor),
      currency: String(r.currency ?? 'XOF').toUpperCase(),
      settledAt: r.settledAt ?? r.settled_at ?? new Date().toISOString(),
    }));
  },
};

const stripe = {
  name: 'stripe',
  currencies: ['XOF'],
  mode() {
    if (!stripeConfigured()) return 'unavailable';
    const key = process.env.STRIPE_SECRET_KEY ?? '';
    return key.startsWith('sk_live_') ? 'live' : 'sandbox';
  },
  timeoutPolicy: { submitTimeoutMs: 15_000, outcomeDeadlineMs: 24 * 3600_000 },
  async initiate() {
    throw new Error('Stripe deposits are initiated by checkout sessions (stripe-service)');
  },
  async lookupStatus() {
    return { status: 'pending' };
  },
  verifyWebhook(headers, rawBody) {
    try {
      return Boolean(verifyStripeWebhook(rawBody, headers?.['stripe-signature']));
    } catch {
      return false;
    }
  },
  parseStatement(rows) {
    return rows.map((r) => ({
      providerReference: String(r.payment_intent ?? r.id),
      direction: 'in',
      amountMinor: Number(r.amountXof ?? r.amount),
      currency: 'XOF',
      settledAt: r.available_on ? new Date(r.available_on * 1000).toISOString() : new Date().toISOString(),
    }));
  },
};

const REGISTRY = { julaya, stripe };

/** Adapter for `name`; in production only a live adapter is returned. */
export function getProvider(name) {
  const p = REGISTRY[name];
  if (!p) throw new RailUnavailableError(name, `Unknown provider ${name}`);
  const mode = p.mode();
  if (mode === 'unavailable') throw new RailUnavailableError(name);
  if (isProduction() && mode !== 'live') throw new RailUnavailableError(name, `${name} is not live — refused in production`);
  return p;
}

export function providerModeLabel(name) {
  const p = REGISTRY[name];
  return p ? p.mode() : 'unavailable';
}

export const providers = REGISTRY;
