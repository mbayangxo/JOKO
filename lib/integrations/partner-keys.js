/**
 * J14-S6 — partner credential hardening. DORMANT unless PARTNER_SCOPED_KEYS_ENABLED=true; with the flag off
 * every partner request is authenticated exactly as before (environment key map, 60 req/min, no audit rows).
 *
 * With the flag on:
 *   - Database keys (`jk_live_…` / `jk_test_…`): only the SHA-256 is stored, the key is shown once. A key is
 *     USABLE only after a different operator approves it (maker/checker through AdminApproval), only for its
 *     scopes (= the route policy permission, e.g. `partner.collect`), only in its environment, until revoked
 *     or expired. Rotation = a new pending key; when it is approved the old key expires after the overlap
 *     (≤ 24 h). Revocation is immediate and single-operator (it only ever removes access).
 *   - Environment keys keep working unchanged (legacy, every scope) so existing partners are never cut off.
 *   - Rate limits: per partner (JOKO_PARTNER_RATE_LIMITS=kebu:120,rect:30; default 60/min) and per key.
 *   - Sandbox parity: a sandbox key is refused while the server is in live mode; a live key never reaches a
 *     sandbox-only route.
 *   - Partner audit trail: one PartnerAuditLog row per mutating call (partner, key, route, status; no bodies).
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { ROUTE_POLICY } from '../authz/route-policy.js';
import { secretsEqual } from '../field-crypto.js';

export const MAX_ROTATION_OVERLAP_MS = 24 * 3600_000;
const LAST_USED_WRITE_EVERY_MS = 60_000;

export const partnerScopedKeysEnabled = () => process.env.PARTNER_SCOPED_KEYS_ENABLED === 'true';

/** Every scope a key may carry: the permissions of the partner routes in the central route policy. */
export function partnerScopes() {
  return [...new Set(Object.values(ROUTE_POLICY).filter((p) => p.actor === 'partner' && p.perm).map((p) => p.perm))].sort();
}

export class PartnerKeyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const hashPartnerKey = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const newRawKey = (environment) => `jk_${environment === 'live' ? 'live' : 'test'}_${crypto.randomBytes(32).toString('base64url')}`;

const PARTNER_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export function keyShape(k) {
  return {
    id: k.id,
    partner_id: k.partnerId,
    key_prefix: k.keyPrefix,
    scopes: JSON.parse(k.scopesJson),
    environment: k.environment,
    status: k.status,
    rate_limit_per_min: k.rateLimitPerMin,
    expires_at: k.expiresAt?.toISOString() ?? null,
    rotates_key_id: k.rotatesKeyId,
    created_by: k.createdBy,
    activated_by: k.activatedBy,
    activated_at: k.activatedAt?.toISOString() ?? null,
    revoked_at: k.revokedAt?.toISOString() ?? null,
    last_used_at: k.lastUsedAt?.toISOString() ?? null,
    created_at: k.createdAt.toISOString(),
  };
}

function validateScopes(scopes) {
  const all = new Set(partnerScopes());
  if (!Array.isArray(scopes) || scopes.length === 0) throw new PartnerKeyError('scopes_required', 'At least one scope is required');
  const bad = scopes.filter((s) => !all.has(s));
  if (bad.length) throw new PartnerKeyError('unknown_scope', `Unknown scope: ${bad.join(', ')}`);
  return [...new Set(scopes)].sort();
}

/**
 * Maker step: create a PENDING key (unusable) and the approval request that activates it. The raw key is
 * returned once, here, and never again.
 */
export async function issuePartnerKey(req, partnerId, body, { rotatesKey = null } = {}, db = prisma) {
  if (!partnerScopedKeysEnabled()) throw new PartnerKeyError('disabled', 'Scoped partner keys are not enabled', 403);
  const pid = String(partnerId ?? '').toLowerCase();
  if (!PARTNER_ID_RE.test(pid)) throw new PartnerKeyError('invalid_partner', 'partnerId must be 2–32 lowercase letters, digits, - or _');
  const environment = rotatesKey ? rotatesKey.environment : body?.environment;
  if (!['sandbox', 'live'].includes(environment)) throw new PartnerKeyError('invalid_environment', 'environment must be sandbox or live');
  const scopes = rotatesKey ? JSON.parse(rotatesKey.scopesJson) : validateScopes(body?.scopes);
  const rate = body?.rate_limit_per_min ?? rotatesKey?.rateLimitPerMin ?? null;
  if (rate !== null && !(Number.isSafeInteger(rate) && rate >= 1 && rate <= 6000)) throw new PartnerKeyError('invalid_rate_limit', 'rate_limit_per_min must be 1–6000');
  const days = body?.expires_in_days ?? null;
  if (days !== null && !(Number.isSafeInteger(days) && days >= 1 && days <= 730)) throw new PartnerKeyError('invalid_expiry', 'expires_in_days must be 1–730');
  const overlap = rotatesKey ? Math.min(Number(body?.overlap_hours ?? 24) * 3600_000, MAX_ROTATION_OVERLAP_MS) : null;
  if (rotatesKey && !(overlap >= 0)) throw new PartnerKeyError('invalid_overlap', 'overlap_hours must be 0–24');

  const raw = newRawKey(environment);
  const { requestApproval, approvalShape } = await import('../authz/approvals.js');
  const key = await db.partnerApiKey.create({
    data: {
      partnerId: pid,
      keyHash: hashPartnerKey(raw),
      keyPrefix: raw.slice(0, 12),
      scopesJson: JSON.stringify(scopes),
      environment,
      rateLimitPerMin: rate,
      expiresAt: days ? new Date(Date.now() + days * 24 * 3600_000) : null,
      rotatesKeyId: rotatesKey?.id ?? null,
      rotationOverlapMs: overlap,
      createdBy: req.adminId,
    },
  });
  const { redactSecrets } = await import('./partner-retention.js');
  const approval = await requestApproval(db, req, { action: 'partner_key_activate', payload: { keyId: key.id }, reason: body?.reason == null ? body?.reason : redactSecrets(body.reason) });
  // Auditable without ever recording the key: prefix + hash-free metadata only.
  await db.adminAuditLog.create({ data: { adminUserId: req.adminId, action: rotatesKey ? 'partner_key.rotate_request' : 'partner_key.issue', targetType: 'partner_api_key', targetId: key.id, detailJson: JSON.stringify({ partnerId: pid, keyPrefix: key.keyPrefix, scopes, environment, rotatesKeyId: rotatesKey?.id ?? null, approvalId: approval.id }) } });
  return { key: { ...keyShape(key), secret: raw, secret_shown_once: true }, approval: approvalShape(approval) };
}

export async function rotatePartnerKey(req, keyId, body, db = prisma) {
  const old = await db.partnerApiKey.findUnique({ where: { id: String(keyId) } });
  if (!old) throw new PartnerKeyError('not_found', 'Key not found', 404);
  if (old.status !== 'active') throw new PartnerKeyError('not_active', `Key is ${old.status}`, 409);
  return issuePartnerKey(req, old.partnerId, body, { rotatesKey: old }, db);
}

/** Checker step (executed by the approvals module inside its transaction, after the dual-control checks). */
export async function activatePartnerKeyInTx(tx, keyId, { approvedBy }) {
  const key = await tx.partnerApiKey.findUnique({ where: { id: keyId } });
  if (!key) throw new PartnerKeyError('not_found', 'Key not found', 404);
  if (key.status !== 'pending') throw new PartnerKeyError('not_pending', `Key is ${key.status}`, 409);
  if (key.createdBy === approvedBy) throw new PartnerKeyError('dual_authorization', 'A second, different operator must approve', 403);
  // J14-F4: strict separation — the checker may not hold issuing authority at all (role-level SoD, re-checked
  // at approval time so a grant made outside the normal flow cannot bypass it).
  const { activeAdminRoles } = await import('../authz/admin-authz.js');
  const { permissionsForRoles } = await import('../authz/catalog.js');
  const approverPerms = permissionsForRoles(await activeAdminRoles(approvedBy, tx));
  if (approverPerms.has('partner_keys.issue')) throw new PartnerKeyError('sod_conflict', 'The approver of a partner key may not hold key-issuing authority', 403);
  if (!approverPerms.has('partner_keys.approve')) throw new PartnerKeyError('permission_denied', 'Missing operator permission: partner_keys.approve', 403);
  const now = new Date();
  const updated = await tx.partnerApiKey.update({ where: { id: key.id }, data: { status: 'active', activatedBy: approvedBy, activatedAt: now } });
  if (key.rotatesKeyId) {
    const old = await tx.partnerApiKey.findUnique({ where: { id: key.rotatesKeyId } });
    if (old?.status === 'active') {
      const end = new Date(now.getTime() + (key.rotationOverlapMs ?? MAX_ROTATION_OVERLAP_MS));
      await tx.partnerApiKey.update({ where: { id: old.id }, data: { expiresAt: old.expiresAt && old.expiresAt < end ? old.expiresAt : end } });
    }
  }
  await tx.adminAuditLog.create({ data: { adminUserId: approvedBy, action: 'partner_key.activate', targetType: 'partner_api_key', targetId: key.id, detailJson: JSON.stringify({ partnerId: key.partnerId, keyPrefix: key.keyPrefix, createdBy: key.createdBy, approvedBy, scopes: JSON.parse(key.scopesJson), rotatesKeyId: key.rotatesKeyId }) } });
  return keyShape(updated);
}

/** Immediate, single operator (it only removes access). Audited. A pending key's approval can no longer activate it. */
export async function revokePartnerKey(adminId, keyId, reason, db = prisma) {
  if (!reason || String(reason).trim().length < 10) throw new PartnerKeyError('reason_required', 'A reason (≥ 10 characters) is required');
  const key = await db.partnerApiKey.findUnique({ where: { id: String(keyId) } });
  if (!key) throw new PartnerKeyError('not_found', 'Key not found', 404);
  if (key.status === 'revoked') return keyShape(key);
  const { redactSecrets } = await import('./partner-retention.js');
  const why = redactSecrets(reason).slice(0, 300);
  const updated = await db.partnerApiKey.update({ where: { id: key.id }, data: { status: 'revoked', revokedBy: adminId, revokedAt: new Date(), revokeReason: why } });
  await db.adminAuditLog.create({ data: { adminUserId: adminId, action: 'partner_key.revoke', targetType: 'partner_api_key', targetId: key.id, detailJson: JSON.stringify({ partnerId: key.partnerId, keyPrefix: key.keyPrefix, reason: why }) } });
  return keyShape(updated);
}

// ── Request authentication (central: lib/authz/enforce.js, for every route whose policy actor is `partner`) ──

function extractApiKey(req) {
  const h = req.headers?.['x-api-key'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const auth = req.headers?.authorization;
  const m = typeof auth === 'string' ? auth.match(/^Bearer\s+(.+)$/i) : null;
  return m?.[1]?.trim() || null;
}

/**
 * @returns {Promise<{ ok: true, auth } | { ok: false, status, body }>}
 * auth = { partnerId, credential: 'env'|'db', keyId, scopes: string[]|'*' }
 */
/** J14-F3: a refused attempt by an IDENTIFIED key is a security audit record (no body, no key, no hash). */
async function recordDenial(db, key, routeKey, statusCode) {
  if (!routeKey) return;
  try {
    await db.partnerAuditLog.create({ data: { partnerId: key.partnerId, keyId: key.id, credential: 'db', routeKey, statusCode } });
  } catch (e) {
    console.warn('[partner-audit] denial not recorded', e?.code ?? e?.message);
  }
}

export async function authenticatePartnerRequest(req, perm, db = prisma, { routeKey } = {}) {
  const { partnerMode } = await import('../partner-payments-service.js');
  const { authenticatePartner } = await import('../partner-auth.js');
  const provided = extractApiKey(req);
  if (!provided) return { ok: false, status: 401, body: { error: 'Invalid or missing partner API key', code: 'unauthorized' } };

  let auth = null;
  let key = null;
  if (provided.startsWith('jk_')) {
    key = await db.partnerApiKey.findUnique({ where: { keyHash: hashPartnerKey(provided) } });
    // Constant-time confirmation on the stored hash (the lookup itself is by hash, never by the raw key).
    if (key && !secretsEqual(hashPartnerKey(provided), key.keyHash)) key = null;
    const now = Date.now();
    if (!key || key.status !== 'active' || (key.expiresAt && key.expiresAt.getTime() <= now)) {
      if (key) await recordDenial(db, key, routeKey, 401); // revoked / expired / pending key used
      return { ok: false, status: 401, body: { error: 'Invalid or missing partner API key', code: 'unauthorized' } };
    }
    const scopes = JSON.parse(key.scopesJson);
    if (!perm || !scopes.includes(perm)) {
      await recordDenial(db, key, routeKey, 403);
      return { ok: false, status: 403, body: { error: `This key lacks the scope ${perm ?? '(none)'}`, code: 'scope_required', scope: perm ?? null } };
    }
    const mode = partnerMode();
    if ((key.environment === 'sandbox' && mode === 'live') || (key.environment === 'live' && perm === 'partner.sandbox')) {
      await recordDenial(db, key, routeKey, 403);
      return { ok: false, status: 403, body: { error: key.environment === 'sandbox' ? 'Sandbox key used against the live environment' : 'Sandbox-only route', code: 'environment_mismatch' } };
    }
    auth = { partnerId: key.partnerId, credential: 'db', keyId: key.id, scopes };
    if (!key.lastUsedAt || now - key.lastUsedAt.getTime() > LAST_USED_WRITE_EVERY_MS) {
      db.partnerApiKey.updateMany({ where: { id: key.id }, data: { lastUsedAt: new Date(now) } }).catch(() => {});
    }
  } else {
    const env = authenticatePartner(req);
    if (!env) return { ok: false, status: 401, body: { error: 'Invalid or missing partner API key', code: 'unauthorized' } };
    auth = { partnerId: env.partnerId, credential: 'env', keyId: null, scopes: '*' };
  }

  // J15-D3: shared, atomic counters across every instance; money routes fail closed if unavailable.
  const { enforcePartnerLimits } = await import('./partner-rate-limit.js');
  const lim = await enforcePartnerLimits({ partnerId: auth.partnerId, keyId: key?.id ?? null, keyLimit: key?.rateLimitPerMin ?? null, perm });
  if (!lim.ok) return lim;
  return { ok: true, auth };
}

/** Partner audit trail: one row per mutating call. Never throws into the request. */
export async function recordPartnerAudit(req, statusCode, routeKey, db = prisma) {
  const a = req.partnerAuth;
  if (!a || req.method === 'GET' || !partnerScopedKeysEnabled()) return;
  try {
    await db.partnerAuditLog.create({ data: { partnerId: a.partnerId, keyId: a.keyId, credential: a.credential, routeKey, statusCode: Number(statusCode) || 0 } });
  } catch (e) {
    console.warn('[partner-audit] not recorded', e?.code ?? e?.message);
  }
}
