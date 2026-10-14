/**
 * J14-S6 operator endpoints for partner credentials. Issue / rotate = maker (returns the key ONCE + the
 * approval to be decided by a different operator via POST admin/approvals/:id/approve). Revoke = immediate.
 * Everything answers 403 `disabled` unless PARTNER_SCOPED_KEYS_ENABLED=true.
 */
import { prisma } from '../prisma.js';
import { AdminAuthzError } from '../authz/admin-authz.js';
import { PartnerKeyError, issuePartnerKey, keyShape, partnerScopedKeysEnabled, partnerScopes, revokePartnerKey, rotatePartnerKey } from './partner-keys.js';

function fail(res, e) {
  if (e instanceof PartnerKeyError || e instanceof AdminAuthzError) {
    res.status(e.status ?? 403).json({ error: e.message, code: e.code });
    return true;
  }
  return false;
}
const off = (res) => res.status(403).json({ error: 'Scoped partner keys are not enabled', code: 'disabled' });

export async function adminPartnerKeyIssue(req, res) {
  try {
    res.status(201).json(await issuePartnerKey(req, req.query.id, req.body ?? {}));
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function adminPartnerKeyRotate(req, res) {
  if (!partnerScopedKeysEnabled()) return off(res);
  try {
    res.status(201).json(await rotatePartnerKey(req, req.query.id, req.body ?? {}));
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function adminPartnerKeyRevoke(req, res) {
  if (!partnerScopedKeysEnabled()) return off(res);
  try {
    res.json(await revokePartnerKey(req.adminId, req.query.id, req.body?.reason));
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function adminPartnerKeysList(req, res) {
  if (!partnerScopedKeysEnabled()) return off(res);
  const rows = await prisma.partnerApiKey.findMany({ where: { partnerId: String(req.query.id ?? '').toLowerCase() }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ keys: rows.map(keyShape), scopes: partnerScopes() });
}

export async function adminPartnerAudit(req, res) {
  if (!partnerScopedKeysEnabled()) return off(res);
  const rows = await prisma.partnerAuditLog.findMany({ where: { partnerId: String(req.query.id ?? '').toLowerCase() }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ entries: rows.map((r) => ({ id: r.id, key_id: r.keyId, credential: r.credential, route: r.routeKey, status_code: r.statusCode, created_at: r.createdAt.toISOString() })) });
}
