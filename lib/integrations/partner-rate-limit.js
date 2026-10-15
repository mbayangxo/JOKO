/**
 * J15 decision 3 — partner rate limits are SHARED and ATOMIC across every API instance (Postgres fixed-window
 * counter, lib/request-limits.js hitBucket: one upsert per hit, no read-modify-write in the application).
 *
 * Budgets: per partner (JOKO_PARTNER_RATE_LIMITS=kebu:120,rect:30; default JOKO_PARTNER_RATE_LIMIT_DEFAULT or 60 / min, shared by all of that
 * partner's credentials) and, for a scoped key with rate_limit_per_min, per key.
 *
 * If enforcement is UNAVAILABLE (the counter store errors), financially sensitive partner operations FAIL CLOSED
 * (503 rate_limit_unavailable, nothing executed); read-only operations proceed (degraded, logged).
 * A route whose permission is unknown is treated as sensitive.
 */
import { hitBucket } from '../request-limits.js';
import { labPoint } from '../lab/faults.js';

export const DEFAULT_PARTNER_RATE_LIMIT = 60;
const WINDOW_MS = 60_000;
/** Partner permissions that create, move or bind money (or identity used for money). */
export const SENSITIVE_PARTNER_PERMS = new Set([
  'partner.checkout', 'partner.collect', 'partner.pos', 'partner.payout', 'partner.sandbox',
  'partner.debits.request', 'partner.business_link', 'partner.messages.send',
]);

export function partnerRateLimit(partnerId) {
  for (const part of String(process.env.JOKO_PARTNER_RATE_LIMITS ?? '').split(',')) {
    const [id, n] = part.split(':').map((x) => x?.trim());
    if (id && id.toLowerCase() === String(partnerId).toLowerCase() && Number.isSafeInteger(Number(n)) && Number(n) > 0) return Number(n);
  }
  const d = Number(process.env.JOKO_PARTNER_RATE_LIMIT_DEFAULT);
  return Number.isSafeInteger(d) && d > 0 ? d : DEFAULT_PARTNER_RATE_LIMIT;
}

/** @returns {Promise<{ ok: true, degraded?: boolean } | { ok: false, status: number, body: object }>} */
export async function enforcePartnerLimits({ partnerId, keyId = null, keyLimit = null, perm = null }) {
  const sensitive = !perm || SENSITIVE_PARTNER_PERMS.has(perm);
  try {
    await labPoint('ratelimit.partner', { partnerId, perm });
    const n = await hitBucket(`partner:${partnerId}`, WINDOW_MS);
    if (n > partnerRateLimit(partnerId)) return { ok: false, status: 429, body: { error: 'Too many partner API requests', code: 'rate_limited' } };
    if (keyId && keyLimit) {
      const k = await hitBucket(`partner-key:${keyId}`, WINDOW_MS);
      if (k > keyLimit) return { ok: false, status: 429, body: { error: 'Too many partner API requests', code: 'rate_limited' } };
    }
    return { ok: true };
  } catch (e) {
    console.error('[partner-rate-limit] enforcement unavailable', e?.code ?? e?.message);
    if (sensitive) return { ok: false, status: 503, body: { error: 'Rate limiting temporarily unavailable — nothing was executed, retry later', code: 'rate_limit_unavailable' } };
    return { ok: true, degraded: true };
  }
}
