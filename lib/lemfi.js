/**
 * LemFi international rail adapter (stub) — same resilience contract as Julaya.
 * Wire when LEMFI_API_KEY_SANDBOX / LEMFI_API_KEY are available.
 */

import { fetchExternalJson } from './external-fetch.js';
import { lemfiConfig } from './payment-config.js';
import { RailUnavailableError, mockRailsAllowed } from './runtime-safety.js';

export function lemfiConfigured() {
  return Boolean(lemfiConfig().apiKey);
}

export async function initiateInternationalTransfer(params) {
  const cfg = lemfiConfig();

  if (cfg.mode === 'unavailable' || (cfg.mode === 'mock' && !mockRailsAllowed())) {
    throw new RailUnavailableError('lemfi');
  }
  if (cfg.mode === 'mock') {
    return {
      mode: 'sandbox',
      status: 'completed',
      externalId: `lemfi-sandbox-${params.reference}`,
      reference: params.reference,
    };
  }

  const result = await fetchExternalJson(`${cfg.apiUrl}/transfers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      'Idempotency-Key': params.idempotencyKey,
    },
    body: JSON.stringify({
      reference: params.reference,
      amount: params.amount,
      currency: params.currency ?? 'XOF',
      beneficiary: params.beneficiary,
      idempotency_key: params.idempotencyKey,
    }),
  });

  if (result.ok) {
    return {
      mode: cfg.mode,
      status: String(result.body.status ?? 'pending').toLowerCase(),
      externalId: String(result.body.id ?? params.reference),
      reference: params.reference,
    };
  }

  if (result.explicitFailure) {
    return { mode: cfg.mode, status: 'failed', reference: params.reference, message: result.body?.message };
  }

  return { mode: cfg.mode, status: 'pending', reference: params.reference, ambiguous: true };
}
