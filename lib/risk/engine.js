import { prisma } from '../prisma.js';
import { LIMITS } from '../authz/catalog.js';
import { requestTrust } from '../identity/sessions.js';
import { effectiveTier, limitsForTier } from '../tier-limits.js';
import { safeError } from '../log-redact.js';
import { otpKeysForPhone } from '../auth-otp.js';

/**
 * J3 risk engine FOUNDATION (docs/JOKKO-J3-DESIGN.md §10).
 *
 * Deliberately simple and explainable: a fixed set of behavioural/security
 * signals → a rule table per action → one decision with explicit reasons,
 * recorded append-only in RiskDecision. It is not a fraud model.
 *
 * Decisions: allow | step_up | hold | review | deny
 *   hold    refuse now; the condition clears with time (cool-off) or a fix
 *   review  route to human review (held transaction / support)
 *   deny    the actor is not eligible (e.g. tier)
 *
 * FAIRNESS: signals may only use the account's own security/behaviour facts
 * (sessions, devices, credential events, money velocity, verification tier).
 * They must NEVER use ethnicity, nationality, language, name, neighbourhood /
 * arrondissement, country of birth or similar proxies. tests/j3/risk-engine
 * statically checks this module for such fields.
 */
const HOUR = 60 * 60 * 1000;
export const RECOVERY_COOL_OFF_MS = 24 * HOUR;
export const CONTACT_CHANGE_COOL_OFF_MS = 24 * HOUR;
const CONTACT_CHANGE_ACTIONS = ['phone_changed', 'email_changed', 'password_set', 'device_revoked_all'];

export const RULES = {
  cash_out: {
    deny: ['tier_insufficient', 'credential_reset_required'],
    hold: ['recent_recovery', 'recent_contact_change', 'untrusted_session', 'new_device'],
    review: ['rapid_cash_in_out', 'velocity_hour', 'account_changes_burst', 'repeated_auth_failures'],
  },
  sensitive_change: {
    deny: [],
    hold: ['recent_recovery', 'untrusted_session'],
    review: ['account_changes_burst'],
  },
  agent_operation: {
    deny: [],
    hold: [],
    review: ['agent_velocity'],
  },
};

const ORDER = ['deny', 'hold', 'review'];

/** Collect the signals relevant to `action` for this request. */
export async function collectSignals(db, { userId, req, action, amountNational = 0 }) {
  const signals = [];
  const add = (code, detail) => signals.push({ code, detail });
  const now = Date.now();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      verificationTier: true,
      cniVerifiedAt: true,
      addressVerifiedAt: true,
      accountRecoveredAt: true,
      credentialResetRequiredAt: true,
      pinFailedAttempts: true,
      phone: true,
    },
  });
  if (!user) {
    add('user_missing', 'account not found');
    return { signals, user: null };
  }

  if (user.credentialResetRequiredAt) add('credential_reset_required', 'credentials must be re-established first');
  if (user.accountRecoveredAt && now - user.accountRecoveredAt.getTime() < RECOVERY_COOL_OFF_MS) {
    add('recent_recovery', `account recovered ${Math.round((now - user.accountRecoveredAt.getTime()) / 60000)} min ago`);
  }

  const since24h = new Date(now - CONTACT_CHANGE_COOL_OFF_MS);
  const changes = await db.identityAuditEvent.findMany({
    where: { subjectType: 'user', subjectId: userId, createdAt: { gte: since24h } },
    select: { action: true },
  });
  if (changes.some((c) => CONTACT_CHANGE_ACTIONS.includes(c.action))) {
    add('recent_contact_change', 'phone, email or password changed in the last 24 h');
  }
  if (changes.length >= 8) add('account_changes_burst', `${changes.length} identity changes in 24 h`);

  const trust = requestTrust(req);
  if (trust.trust !== 'trusted') add('untrusted_session', `session trust: ${trust.trust}`);
  if (trust.deviceId) {
    const device = await db.userDevice.findUnique({ where: { userId_deviceId: { userId, deviceId: trust.deviceId } } });
    const coolOff = LIMITS.newDeviceCoolOffHours() * HOUR;
    if (!device || device.revokedAt || !device.verifiedAt) add('new_device', 'device not verified for this account');
    else if (now - device.firstSeenAt.getTime() < coolOff) add('new_device', `device first seen < ${LIMITS.newDeviceCoolOffHours()} h ago`);
  } else if (!trust.legacy) {
    add('new_device', 'no device identifier on this session');
  }

  if ((user.pinFailedAttempts ?? 0) >= 3) add('repeated_auth_failures', `${user.pinFailedAttempts} recent wrong PINs`);
  const otpThrottle = await db.authThrottle.findUnique({ where: { key: `otp:${otpKeysForPhone(user.phone)[0]}` } }).catch(() => null);
  if (otpThrottle && otpThrottle.failures >= 5 && now - otpThrottle.windowStart.getTime() < 24 * HOUR) {
    add('repeated_auth_failures', `${otpThrottle.failures} wrong OTPs in 24 h`);
  }

  if (action === 'cash_out') {
    const tier = effectiveTier(user);
    if (!limitsForTier(tier).canCashOut) add('tier_insufficient', `tier ${tier} cannot cash out`);

    // Rapid cash-in → cash-out (classic mule / stolen-card pattern).
    const customerCode = `customer:${userId}:available`;
    const recentIn = await db.$queryRaw`
      SELECT COALESCE(SUM(p.amount), 0)::bigint AS kori
        FROM "Posting" p
        JOIN "LedgerAccount" a ON a.id = p."accountId"
        JOIN "JournalEntry" j ON j.id = p."entryId"
       WHERE a.code = ${customerCode} AND p.side = 'credit'
         AND j.kind IN ('cash_in_confirmed', 'agent_cash_in')
         AND j."createdAt" > ${new Date(now - 2 * HOUR)}`;
    const inKori = Number(recentIn?.[0]?.kori ?? 0);
    const outKori = Math.floor(amountNational / 10);
    if (inKori > 0 && outKori >= inKori * 0.8) add('rapid_cash_in_out', `cash-out of ≥ 80 % of a cash-in made < 2 h ago`);

    const outbound = await db.$queryRaw`
      SELECT COUNT(*)::int AS n
        FROM "Posting" p
        JOIN "LedgerAccount" a ON a.id = p."accountId"
        JOIN "JournalEntry" j ON j.id = p."entryId"
       WHERE a.code = ${customerCode} AND p.side = 'debit' AND j."createdAt" > ${new Date(now - HOUR)}`;
    if (Number(outbound?.[0]?.n ?? 0) >= 10) add('velocity_hour', '≥ 10 outbound movements in 1 h');
  }

  if (action === 'agent_operation') {
    const agent = await db.agentProfile.findUnique({ where: { userId }, select: { id: true } });
    if (agent) {
      const since = new Date(now - HOUR);
      const [deps, wds] = await Promise.all([
        db.agentDeposit.count({ where: { agentId: agent.id, createdAt: { gte: since } } }),
        db.agentWithdrawal.count({ where: { agentId: agent.id, createdAt: { gte: since } } }),
      ]);
      if (deps + wds >= 40) add('agent_velocity', `${deps + wds} agent operations in 1 h`);
    }
  }

  return { signals, user };
}

export function decide(action, signals) {
  const rules = RULES[action];
  if (!rules) return { decision: 'allow', reasons: [] };
  const codes = new Set(signals.map((s) => s.code));
  for (const level of ORDER) {
    const hit = rules[level].filter((c) => codes.has(c));
    if (hit.length) {
      return { decision: level, reasons: signals.filter((s) => hit.includes(s.code)).map((s) => `${s.code}: ${s.detail}`) };
    }
  }
  return { decision: 'allow', reasons: [] };
}

export async function recordDecision(db, { userId, action, decision, reasons, signals, sessionId, reference }) {
  try {
    await db.riskDecision.create({
      data: {
        userId: userId ?? null,
        action,
        decision,
        reasonsJson: JSON.stringify(reasons ?? []),
        signalsJson: JSON.stringify((signals ?? []).map((s) => s.code)),
        sessionId: sessionId ?? null,
        reference: reference ?? null,
      },
    });
  } catch (err) {
    console.error('[risk] decision not recorded', safeError(err));
  }
}

/** Evaluate + record. */
export async function evaluate(db, { userId, req, action, amountNational = 0, reference = null }) {
  const { signals } = await collectSignals(db ?? prisma, { userId, req, action, amountNational });
  const { decision, reasons } = decide(action, signals);
  await recordDecision(db ?? prisma, {
    userId,
    action,
    decision,
    reasons,
    signals,
    sessionId: req?.authSession?.id ?? null,
    reference,
  });
  return { decision, reasons, signals };
}
