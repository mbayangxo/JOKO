/**
 * Julaya rail adapter — BCEAO-licensed partner for Orange Money / Wave / Free Money.
 * Built for failure: timeout → pending, retries, idempotency keys.
 */

import crypto from 'crypto';
import { fetchExternalJson } from './external-fetch.js';
import { julayaConfig, julayaConfigured, julayaMode } from './payment-config.js';
import { secretsEqual } from './field-crypto.js';
import { RailUnavailableError, mockRailsAllowed } from './runtime-safety.js';

export { julayaConfigured, julayaMode } from './payment-config.js';

export const JULAYA_OPERATORS = ['orange_money', 'wave', 'free_money'];

function mapOperator(operator) {
  return { orange_money: 'ORANGE', wave: 'WAVE', free_money: 'FREE' }[operator];
}

function sandboxResult(reference, status = 'completed') {
  // Defence in depth: a mock settlement must never be produced in production.
  if (!mockRailsAllowed()) throw new RailUnavailableError('julaya', 'Mock Julaya rail refused in production');
  return {
    mode: 'sandbox',
    status,
    externalId: `sandbox-${reference}`,
    reference,
    message: 'Settled instantly in mock sandbox (no Julaya API key)',
  };
}

function parseLiveStatus(raw) {
  const value = String(raw ?? 'pending').toLowerCase();
  if (['completed', 'success', 'succeeded', 'paid'].includes(value)) return 'completed';
  if (['failed', 'error', 'rejected', 'cancelled'].includes(value)) return 'failed';
  if (['processing', 'in_progress'].includes(value)) return 'processing';
  return 'pending';
}

function liveResult(reference, body) {
  const externalId = String(body.id ?? body.transaction_id ?? body.reference ?? reference);
  const amount = Number(body.amount);
  return {
    mode: julayaMode(),
    status: parseLiveStatus(body.status),
    externalId,
    reference,
    amount: Number.isFinite(amount) ? amount : null,
    currency: typeof body.currency === 'string' ? body.currency.toUpperCase() : null,
    message: typeof body.message === 'string' ? body.message : undefined,
    raw: body,
  };
}

function pendingResult(reference, reason) {
  return {
    mode: julayaMode(),
    status: 'pending',
    externalId: null,
    reference,
    ambiguous: true,
    message: reason,
  };
}

async function julayaRequest(path, { method = 'POST', body, idempotencyKey }) {
  const cfg = julayaConfig();

  if (cfg.mode === 'unavailable') throw new RailUnavailableError('julaya');
  if (cfg.mode === 'mock') {
    return { mock: true };
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
    'Idempotency-Key': idempotencyKey,
  };

  const result = await fetchExternalJson(`${cfg.apiUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return result;
}

async function initiateRail(path, params) {
  const cfg = julayaConfig();

  if (cfg.mode === 'unavailable') throw new RailUnavailableError('julaya');
  if (cfg.mode === 'mock') {
    return sandboxResult(params.reference);
  }

  const payload = {
    reference: params.reference,
    amount: params.amount,
    currency: 'XOF',
    phone: params.phone,
    operator: mapOperator(params.operator),
    callback_url: params.callbackUrl,
    idempotency_key: params.idempotencyKey,
  };

  const result = await julayaRequest(path, {
    method: 'POST',
    body: payload,
    idempotencyKey: params.idempotencyKey,
  });

  if (result.mock) {
    return sandboxResult(params.reference);
  }

  if (result.ok) {
    return liveResult(params.reference, result.body);
  }

  if (result.explicitFailure) {
    const detail = typeof result.body?.message === 'string' ? result.body.message : `Julaya HTTP ${result.status}`;
    return {
      mode: julayaMode(),
      status: 'failed',
      externalId: null,
      reference: params.reference,
      message: detail,
    };
  }

  return pendingResult(
    params.reference,
    result.timeout ? 'Partner API timed out after retries' : 'Partner API unavailable — outcome unknown',
  );
}

export async function initiateCashIn(params) {
  return initiateRail('/collections/mobile-money', params);
}

export async function initiateCashOut(params) {
  return initiateRail('/transfers/mobile-money', params);
}

export async function getRailStatus(externalId) {
  const cfg = julayaConfig();
  if (cfg.mode === 'unavailable') {
    return pendingResult(externalId, 'Julaya rail not configured — cannot confirm status');
  }
  if (cfg.mode === 'mock') {
    if (!mockRailsAllowed()) return pendingResult(externalId, 'Mock status refused in production');
    return {
      mode: 'sandbox',
      status: 'completed',
      externalId,
      reference: externalId.replace(/^sandbox-/, ''),
    };
  }

  const result = await julayaRequest(`/transactions/${encodeURIComponent(externalId)}`, {
    method: 'GET',
    idempotencyKey: `status:${externalId}`,
  });

  if (result.ok) {
    const reference = String(result.body.reference ?? externalId);
    return liveResult(reference, result.body);
  }

  return pendingResult(externalId, 'Unable to confirm partner status');
}

/**
 * Julaya has no public webhook-signing documentation (regional-only partner).
 * This verifies HMAC-SHA256 over the raw request body — the industry-standard
 * scheme used by most payment processors (Stripe/GitHub/Twilio-style) — read
 * from an `X-Julaya-Signature` header as a hex digest. CONFIRM the exact
 * header name and algorithm against Julaya's partner API docs once a real
 * merchant account exists, and update this function if they differ.
 */
export function verifyWebhookSignature(headers, rawBody) {
  const { webhookSecret, mode } = julayaConfig();
  // Unsigned webhooks are accepted only by the dev mock rail, never in production.
  if (!webhookSecret) return mode === 'mock' && mockRailsAllowed();

  const signature = headers?.['x-julaya-signature'];
  if (!signature) return false;

  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody ?? '', 'utf8').digest('hex');
  return secretsEqual(String(signature), expected);
}

export function parseWebhookPayload(body) {
  if (!body || typeof body !== 'object') return {};
  return body;
}
