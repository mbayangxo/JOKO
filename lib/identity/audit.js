import { prisma } from '../prisma.js';
import { safeError } from '../log-redact.js';

/**
 * Append-only identity / trust / permission audit (IdentityAuditEvent; the
 * table refuses UPDATE/DELETE at the database level).
 *
 * `before`/`after` must be minimal, non-secret state: never hashes, tokens,
 * full identity numbers or document images. `redactState` strips the obvious
 * secret-bearing keys as a second line of defence.
 */
const SECRET_KEY = /hash|secret|token|password|pin|otp|cni|document|image|selfie/i;

export function redactState(state) {
  if (state == null) return null;
  if (typeof state !== 'object') return state;
  const out = Array.isArray(state) ? [] : {};
  for (const [k, v] of Object.entries(state)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = v && typeof v === 'object' && !(v instanceof Date) ? redactState(v) : v;
  }
  return out;
}

/**
 * @param {object} db prisma client or transaction
 * @param {{ actorType: string, actorId?: string|null, action: string, subjectType: string,
 *           subjectId?: string|null, reason?: string|null, caseRef?: string|null,
 *           before?: object|null, after?: object|null, sessionId?: string|null, ip?: string|null }} e
 */
export async function recordIdentityEvent(db, e) {
  return (db ?? prisma).identityAuditEvent.create({
    data: {
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      action: e.action,
      subjectType: e.subjectType,
      subjectId: e.subjectId ?? null,
      reason: e.reason ? String(e.reason).slice(0, 500) : null,
      caseRef: e.caseRef ? String(e.caseRef).slice(0, 120) : null,
      beforeJson: e.before ? JSON.stringify(redactState(e.before)) : null,
      afterJson: e.after ? JSON.stringify(redactState(e.after)) : null,
      sessionId: e.sessionId ?? null,
      ip: e.ip ?? null,
    },
  });
}

/** Best-effort variant for paths where the audit row must not break the response. */
export async function recordIdentityEventSafe(db, e) {
  try {
    return await recordIdentityEvent(db, e);
  } catch (err) {
    console.error('[identity-audit] write failed', safeError(err));
    return null;
  }
}

/** Actor fields derived from an authenticated request. */
export function actorFromReq(req) {
  if (req?.adminId) return { actorType: 'admin', actorId: req.adminId, sessionId: req.adminSessionId ?? null };
  if (req?.userId) return { actorType: 'user', actorId: req.userId, sessionId: req.authSession?.id ?? null };
  return { actorType: 'system', actorId: null, sessionId: null };
}
