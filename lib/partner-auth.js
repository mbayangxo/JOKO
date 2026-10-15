import { createHash, timingSafeEqual } from 'node:crypto';
import { secretsEqual } from './field-crypto.js';

/**
 * Partner API keys for shops (Kebu, Rect, …).
 *
 * Env:
 *   JOKO_API_KEY=secret                 → partnerId "kebu" (default)
 *   JOKO_API_KEYS=kebu:sec1,rect:sec2   → multi-partner map
 *   JOKO_DEFAULT_PARTNER_ID=kebu        → when using single JOKO_API_KEY
 */

function parseKeyMap() {
  const map = new Map();
  const multi = process.env.JOKO_API_KEYS?.trim();
  if (multi) {
    for (const part of multi.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) continue;
      const partnerId = trimmed.slice(0, idx).trim().toLowerCase();
      const secret = trimmed.slice(idx + 1).trim();
      if (partnerId && secret) map.set(secret, partnerId);
    }
  }
  const single = process.env.JOKO_API_KEY?.trim();
  if (single) {
    const partnerId = (process.env.JOKO_DEFAULT_PARTNER_ID || 'kebu').trim().toLowerCase();
    map.set(single, partnerId);
  }
  return map;
}

/** J14 (D-J14-3): partner ids that exist (environment keys + active scoped keys). */
export async function knownPartnerIds(db) {
  const ids = new Set(parseKeyMap().values());
  if (process.env.PARTNER_SCOPED_KEYS_ENABLED === 'true' && db) {
    const rows = await db.partnerApiKey.findMany({ where: { status: 'active' }, select: { partnerId: true }, distinct: ['partnerId'] });
    for (const r of rows) ids.add(r.partnerId);
  }
  return ids;
}

export function partnerAuthConfigured() {
  return parseKeyMap().size > 0;
}

function extractApiKey(req) {
  const headerKey = req.headers?.['x-api-key'] ?? req.headers?.['X-Api-Key'];
  if (headerKey && typeof headerKey === 'string' && headerKey.trim()) {
    return headerKey.trim();
  }
  const auth = req.headers?.authorization ?? req.headers?.Authorization;
  if (!auth || typeof auth !== 'string') return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

/** @returns {{ partnerId: string } | null} */
export function authenticatePartner(req) {
  const provided = extractApiKey(req);
  if (!provided) return null;
  const map = parseKeyMap();
  for (const [secret, partnerId] of map.entries()) {
    if (secretsEqual(provided, secret)) {
      return { partnerId };
    }
  }
  return null;
}

export function hashPartnerKeyFingerprint(raw) {
  return createHash('sha256').update(String(raw)).digest('hex').slice(0, 12);
}

/** Timing-safe compare helper for tests. */
export function partnerKeysEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
