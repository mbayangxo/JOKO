/**
 * J14-F3 — partner record retention (policy decided 2026-10-14). DORMANT unless PARTNER_AUDIT_RETENTION_ENABLED=true.
 *
 *   security / authorization audit (PartnerAuditLog: partner calls AND refused key attempts)
 *        → kept AT LEAST 12 months. PARTNER_AUDIT_RETENTION_DAYS may only lengthen it (values < 365 are raised
 *          to 365). PARTNER_AUDIT_LEGAL_HOLD=true suspends every purge (legal requirements win).
 *   webhook delivery logs (PartnerEventDelivery) → 30 days (lib/integrations/partner-events.js).
 *   financial records (journal, payments, operations, commerce events, admin audit) → NOT touched here; they
 *        follow their own retention rules.
 *
 * Secrets are never logged: audit rows hold ids, routes and status codes only, and free-text reasons written by
 * operators pass through redactSecrets() before they are stored.
 */
import { prisma } from '../prisma.js';

export const SECURITY_AUDIT_MIN_DAYS = 365;
export const partnerRetentionEnabled = () => process.env.PARTNER_AUDIT_RETENTION_ENABLED === 'true';
export const legalHold = () => process.env.PARTNER_AUDIT_LEGAL_HOLD === 'true';

export function securityAuditRetentionDays() {
  const n = Number(process.env.PARTNER_AUDIT_RETENTION_DAYS);
  return Number.isSafeInteger(n) && n > SECURITY_AUDIT_MIN_DAYS ? n : SECURITY_AUDIT_MIN_DAYS;
}

/** Credential material that must never reach a log (partner keys, webhook secrets, bearer tokens). */
const SECRET_PATTERNS = [
  /\bjk_(?:live|test)_[A-Za-z0-9_-]{8,}/g,
  /\bwhsec_[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b[A-Fa-f0-9]{64}\b/g, // raw SHA-256 / hex keys
];
export function redactSecrets(text) {
  let s = String(text ?? '');
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[redacted]');
  return s;
}

/** Purge security audit rows older than the retention (≥ 12 months). Never touches anything else. */
export async function purgePartnerAuditLogs(db = prisma, { now = Date.now() } = {}) {
  if (!partnerRetentionEnabled()) return { enabled: false, purged: 0 };
  if (legalHold()) return { enabled: true, legalHold: true, purged: 0 };
  const days = securityAuditRetentionDays();
  const cutoff = new Date(now - days * 24 * 3600_000);
  const r = await db.partnerAuditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { enabled: true, retentionDays: days, purged: r.count };
}

/** One retention pass: security audit (≥ 12 months) + delivery logs (30 days). */
export async function runPartnerRetention(db = prisma, { now = Date.now() } = {}) {
  if (!partnerRetentionEnabled()) return { enabled: false };
  if (legalHold()) return { enabled: true, legalHold: true };
  const { purgeDeliveryLogs } = await import('./partner-events.js');
  return { enabled: true, audit: await purgePartnerAuditLogs(db, { now }), deliveries: await purgeDeliveryLogs(db, { now }) };
}
