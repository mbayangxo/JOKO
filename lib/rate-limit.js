import { prisma } from './prisma.js';

const MAX_REQUESTS_PER_MINUTE = 100;
const SUSPICIOUS_THRESHOLD = 80;
const BLOCK_DURATION_MS = 15 * 60 * 1000;
const WINDOW_MS = 60 * 1000;

export class RateLimitError extends Error {
  constructor(message = 'Too many requests') {
    super(message);
    this.code = 'rate_limited';
    this.status = 429;
    this.name = 'RateLimitError';
  }
}

export class SecurityBlockError extends Error {
  constructor(message = 'Account temporarily blocked due to suspicious activity') {
    super(message);
    this.code = 'security_block';
    this.status = 403;
    this.name = 'SecurityBlockError';
  }
}

/**
 * D42 — role/action-aware limits (no blanket bypass).
 *
 * A request is classified by its ROUTE PATTERN:
 *   read      GET (no state change)                    → budget/min, targeted 429 only
 *   dispatch  logistics / PO-fulfilment operations     → budget/min (batch items count), targeted 429 only
 *   custody   entering a custody code (guessing surface) → tight budget/min, targeted 429 only
 *             (each code also locks itself after 5 wrong attempts — J8)
 *   default   everything else — incl. ALL money and credential routes
 *             → the original account-wide limiter (80/min flags + 15-min block, 100/min hard)
 * Dispatch and read traffic never count toward the account-wide block, so a busy
 * depot cannot lock its own account, while money routes keep the strict guard (and
 * the separate J4 sensitive-route limit, 20/min, still applies to them).
 */
const CLASS_BUDGETS = { read: 300, dispatch: 300, custody: 60, work_accept: 200 };
/** Money batch (A6): the request ALSO counts once on the strict account-wide limiter. */
const WORK_ACCEPT_BATCH = /^POST businesses\/:id\/work\/milestones\/accept-batch$/;
const CUSTODY_CODE = /^POST logistics\/shipments\/:id\/(pickup|deliver|return\/complete|release|handoff)$/;
const DISPATCH = [
  /^POST logistics\/shipments\/:id\/(codes|assign|unassign|ready|step|receiving|respond|drop|cancel|fail|exception|return\/start|failure\/respond|handoff-code|emergency-reassign)$/,
  /^POST logistics\/shipments\/batch\/codes$/,
  /^POST businesses\/:id\/logistics\/(routes|transfers)$/,
  /^POST businesses\/:id\/b2b\/purchase-orders\/:subId\/(accept|advance)$/,
  /^POST businesses\/:id\/b2b\/purchase-orders\/batch$/,
  /^POST businesses\/:id\/b2b\/depots\/:subId\/stock$/,
];

export function actionClass(policyKey) {
  if (!policyKey) return 'default';
  if (policyKey.startsWith('GET ')) return 'read';
  if (CUSTODY_CODE.test(policyKey)) return 'custody';
  if (WORK_ACCEPT_BATCH.test(policyKey)) return 'work_accept';
  if (DISPATCH.some((r) => r.test(policyKey))) return 'dispatch';
  return 'default';
}

/** Per-class budget (targeted): `units` lets a batch count every item it touches. */
export async function enforceActionBudget(userId, policyKey, units = 1) {
  const cls = actionClass(policyKey);
  if (cls === 'default') return enforceRateLimit(userId);
  if (cls === 'work_accept') await enforceRateLimit(userId); // money: the account-wide guard still applies
  const { hitBucket } = await import('./request-limits.js');
  const used = await hitBucket(`user-${cls}:${userId}`, WINDOW_MS, units);
  const budget = Number(process.env[`RL_${cls.toUpperCase()}_PER_MIN`] ?? CLASS_BUDGETS[cls]);
  if (used > budget) {
    const e = new RateLimitError(cls === 'custody' ? 'Trop de codes saisis — attends une minute' : 'Trop d’opérations d’un coup — réessaie dans une minute');
    e.scope = cls;
    throw e;
  }
  // A security block earned elsewhere (money / credential abuse) still applies everywhere.
  const state = await prisma.userRateLimit.findUnique({ where: { userId } });
  if (state?.blockedUntil && state.blockedUntil > new Date()) throw new SecurityBlockError();
}

export async function enforceRateLimit(userId) {
  const now = new Date();
  const state = await prisma.userRateLimit.findUnique({ where: { userId } });

  if (state?.blockedUntil && state.blockedUntil > now) {
    throw new SecurityBlockError();
  }

  const windowStart = state?.windowStart ?? now;
  const elapsed = now.getTime() - windowStart.getTime();
  let requestCount = state?.requestCount ?? 0;
  let flagCount = state?.flagCount ?? 0;
  let nextWindowStart = windowStart;

  if (elapsed >= WINDOW_MS) {
    requestCount = 0;
    nextWindowStart = now;
  }

  requestCount += 1;

  if (requestCount > MAX_REQUESTS_PER_MINUTE) {
    throw new RateLimitError();
  }

  if (requestCount >= SUSPICIOUS_THRESHOLD) {
    flagCount += 1;
    const blockedUntil = new Date(now.getTime() + BLOCK_DURATION_MS);
    await prisma.userRateLimit.upsert({
      where: { userId },
      create: { userId, windowStart: nextWindowStart, requestCount, flagCount, blockedUntil },
      update: { windowStart: nextWindowStart, requestCount, flagCount, blockedUntil },
    });
    throw new SecurityBlockError();
  }

  await prisma.userRateLimit.upsert({
    where: { userId },
    create: { userId, windowStart: nextWindowStart, requestCount, flagCount },
    update: { windowStart: nextWindowStart, requestCount, flagCount },
  });
}
