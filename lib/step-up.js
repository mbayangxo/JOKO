import { koriToNational } from './kori.js';
import {
  HIGH_VALUE_XOF,
  STEP_UP_VALID_MS,
  isStepUpFresh,
  signStepUpToken,
  verifyStepUpToken,
} from './session-security.js';
import { prisma } from './prisma.js';
import { requestTrust } from './identity/sessions.js';

export class StepUpRequiredError extends Error {
  constructor(reason = 'amount') {
    super('Re-authentication required for this transaction');
    this.code = 'step_up_required';
    this.status = 403;
    this.name = 'StepUpRequiredError';
    this.reason = reason;
  }
}

export function amountToNationalXof(amount, currency, country) {
  if (currency === 'kori') return koriToNational(amount, country);
  return amount;
}

/** Was step-up (PIN) proven in THIS session within the validity window? */
export async function hasFreshStepUp(req) {
  const trust = requestTrust(req);
  const headerToken = req.headers?.['x-step-up-token'];
  if (typeof headerToken === 'string' && verifyStepUpToken(headerToken, req.userId, trust.sessionId)) {
    return true;
  }
  if (trust.sessionId) {
    const at = req.authSession?.stepUpAt;
    if (at && Date.now() - new Date(at).getTime() <= STEP_UP_VALID_MS) return true;
    const live = await prisma.authSession.findUnique({ where: { id: trust.sessionId }, select: { stepUpAt: true } });
    return Boolean(live?.stepUpAt && Date.now() - live.stepUpAt.getTime() <= STEP_UP_VALID_MS);
  }
  if (!trust.legacy) return false;
  // Session-less legacy context (direct handler calls outside production).
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { stepUpVerifiedAt: true } });
  return Boolean(user && isStepUpFresh(user.stepUpVerifiedAt));
}

/**
 * Step-up for outbound money. Required at/above HIGH_VALUE_XOF, and for ANY
 * amount when the session is not trusted (new device, recovery): a 6-digit
 * PIN plus a trusted device is the transaction factor, never the PIN alone
 * and never a fresh untrusted login alone.
 */
export async function assertStepUpForAmount(req, amountNational) {
  const trust = requestTrust(req);
  const untrusted = trust.trust !== 'trusted';
  if (amountNational < HIGH_VALUE_XOF && !untrusted) return;
  if (await hasFreshStepUp(req)) return;
  throw new StepUpRequiredError(untrusted ? 'untrusted_session' : 'amount');
}

/** Unconditional step-up (cash-out, credential and contact changes). */
export async function assertStepUp(req, reason = 'sensitive_action') {
  if (await hasFreshStepUp(req)) return;
  throw new StepUpRequiredError(reason);
}

export { HIGH_VALUE_XOF, signStepUpToken };
