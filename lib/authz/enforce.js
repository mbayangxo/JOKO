import { prisma } from '../prisma.js';
import { ROUTE_POLICY } from './route-policy.js';
import { adminCan, loadAdminAuthz } from './admin-authz.js';
import { hasActiveRole } from '../identity/roles.js';
import { evaluate } from '../risk/engine.js';
import { hasFreshStepUp } from '../step-up.js';
import { requestTrust } from '../identity/sessions.js';
import { recordIdentityEventSafe } from '../identity/audit.js';
import { explain } from '../money/user-reasons.js';

/**
 * Central, pre-handler enforcement of the J3 permission matrix
 * (lib/authz/route-policy.js). Returns true to continue, false when a
 * response was sent. Fails closed: a route without a policy is refused.
 */
const FRESH_OTP_MS = 10 * 60 * 1000;

const deny = (res, status, body) => {
  // J4: internal risk signals stay internal (RiskDecision). The client gets a
  // user-safe category, message and next step — never the detection logic.
  if (Array.isArray(body.reasons)) {
    const ex = explain(body.reasons.map((r) => String(r).split(':')[0]));
    delete body.reasons;
    body.category = ex.category;
    body.error = ex.message;
    body.nextStep = ex.nextStep;
  }
  res.status(status).json(body);
  return false;
};
const ROLE_CODES = { driver: 'driver_required', agent: 'agent_required' };

function amountFromBody(body) {
  const b = body ?? {};
  for (const k of ['amountNational', 'amountXof', 'amount']) {
    if (Number.isFinite(b[k])) return Number(b[k]);
  }
  return 0;
}

/** Sensitive account changes: trusted, non-recovery session + step-up (or a fresh OTP login when no PIN exists). */
async function assertSensitiveChange(req, res) {
  const { decision, reasons } = await evaluate(prisma, { userId: req.userId, req, action: 'sensitive_change' });
  if (decision === 'hold' || decision === 'deny') {
    return deny(res, 423, {
      error: 'Changement sensible indisponible pour le moment (sécurité du compte).',
      code: 'sensitive_change_hold',
      reasons,
    });
  }
  if (decision === 'review') {
    return deny(res, 423, { error: 'Changement en attente de vérification par K21.', code: 'review_required', reasons });
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { pinHash: true } });
  if (user?.pinHash) {
    if (!(await hasFreshStepUp(req))) {
      return deny(res, 403, { error: 'Confirme avec ton code PIN.', code: 'step_up_required', reason: 'sensitive_change' });
    }
    return true;
  }
  // No PIN (email-only account, or PIN reset after a credential invalidation):
  // the session itself must be a fresh OTP login.
  const trust = requestTrust(req);
  const s = req.authSession;
  const freshOtp = s && ['otp_phone', 'otp_email'].includes(s.authMethod) && Date.now() - new Date(s.createdAt).getTime() < FRESH_OTP_MS;
  if (!freshOtp && !trust.legacy) {
    return deny(res, 403, { error: 'Reconnecte-toi avec un code (OTP) pour ce changement.', code: 'fresh_login_required' });
  }
  return true;
}

/** Cash leaving the closed loop (cash-out, agent withdrawal, convert). */
async function assertCashOut(req, res) {
  const amountNational = amountFromBody(req.body);
  const { decision, reasons } = await evaluate(prisma, { userId: req.userId, req, action: 'cash_out', amountNational });
  if (decision === 'deny') {
    return deny(res, 403, { error: 'Retrait non autorisé pour ce compte.', code: 'cash_out_denied', reasons });
  }
  if (decision === 'hold') {
    return deny(res, 423, {
      error: 'Retrait temporairement bloqué pour protéger ton compte. Réessaie plus tard ou contacte le support.',
      code: 'cash_out_hold',
      reasons,
    });
  }
  if (!(await hasFreshStepUp(req))) {
    return deny(res, 403, { error: 'Confirme le retrait avec ton code PIN.', code: 'step_up_required', reason: 'cash_out' });
  }
  if (decision === 'review') req.riskReview = { reasons };
  return true;
}

export async function enforceRoutePolicy(req, res, routeKey) {
  const policy = ROUTE_POLICY[routeKey];
  if (!policy) {
    // A route added without a policy is refused, never silently open.
    return deny(res, 403, { error: 'Route not authorized by policy', code: 'policy_missing' });
  }
  req.routePolicy = policy;

  if (policy.actor === 'admin') {
    await loadAdminAuthz(req);
    if (policy.perm && !adminCan(req, policy.perm)) {
      await recordIdentityEventSafe(prisma, {
        actorType: 'admin',
        actorId: req.adminId,
        action: 'permission_denied',
        subjectType: 'route',
        subjectId: routeKey,
        after: { permission: policy.perm, roles: req.adminRoles },
      });
      return deny(res, 403, { error: `Permission opérateur requise : ${policy.perm}`, code: 'permission_denied' });
    }
    return true;
  }

  if (policy.actor !== 'user') return true;

  if (policy.role && !(await hasActiveRole(req.userId, policy.role))) {
    return deny(res, 403, { error: 'Rôle actif requis pour cette action.', code: ROLE_CODES[policy.role] ?? 'role_required', role: policy.role });
  }
  if (policy.risk === 'cash_out') return assertCashOut(req, res);
  if (policy.risk === 'sensitive_change') return assertSensitiveChange(req, res);
  return true;
}
