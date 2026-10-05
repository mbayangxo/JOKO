import { prisma } from './prisma.js';

/**
 * Atomic fixed-window counter in Postgres (works across serverless instances).
 * Returns the number of hits in the current window, including this one.
 */
export async function hitBucket(key, windowMs) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "RateLimitBucket" ("key", "windowStart", "count", "updatedAt")
    VALUES (${key}, now(), 1, now())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitBucket"."windowStart" < now() - (${windowMs}::int * interval '1 millisecond') THEN 1
        ELSE "RateLimitBucket"."count" + 1 END,
      "windowStart" = CASE
        WHEN "RateLimitBucket"."windowStart" < now() - (${windowMs}::int * interval '1 millisecond') THEN now()
        ELSE "RateLimitBucket"."windowStart" END,
      "updatedAt" = now()
    RETURNING "count"`;
  return Number(rows?.[0]?.count ?? 0);
}

/** Client IP as seen by the platform edge (Vercel overwrites these headers). */
export function clientIp(req) {
  const h = req.headers ?? {};
  const first = (v) => (typeof v === 'string' ? v.split(',')[0].trim() : null);
  return (
    first(h['x-vercel-forwarded-for']) ||
    first(h['x-real-ip']) ||
    first(h['x-forwarded-for']) ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const TEN_MIN = 10 * 60 * 1000;
const ONE_MIN = 60 * 1000;

/** Unauthenticated auth endpoints: per-IP and per-identifier budgets. */
const AUTH_POLICIES = {
  'POST auth/phone': { ip: ['RL_OTP_SEND_IP', 20], id: ['RL_OTP_SEND_ID', 5], idField: 'phone' },
  'POST auth/email': { ip: ['RL_OTP_SEND_IP', 20], id: ['RL_OTP_SEND_ID', 5], idField: 'email' },
  'POST auth/recover': { ip: ['RL_OTP_SEND_IP', 20], id: ['RL_OTP_SEND_ID', 5], idField: 'phone' },
  'POST auth/verify': { ip: ['RL_OTP_VERIFY_IP', 40], id: ['RL_OTP_VERIFY_ID', 10], idField: ['phone', 'email'] },
  'POST auth/password/login': { ip: ['RL_LOGIN_IP', 30], id: ['RL_LOGIN_ID', 10], idField: 'email' },
  'POST auth/password/set-with-otp': { ip: ['RL_OTP_VERIFY_IP', 40], id: ['RL_OTP_VERIFY_ID', 10], idField: 'email' },
  'POST auth/refresh': { ip: ['RL_REFRESH_IP', 120] },
  'POST admin/auth/login': { ip: ['RL_ADMIN_LOGIN_IP', 10] },
  'POST admin/auth/verify-2fa': { ip: ['RL_ADMIN_LOGIN_IP', 10] },
  'POST admin/auth/bootstrap': { ip: ['RL_ADMIN_LOGIN_IP', 10] },
};

/** Money-moving / credential routes: tighter per-user budget on top of the global one. */
const SENSITIVE_ROUTE = /^(POST|PATCH) (transfers\/|cash\/|deposits\/|withdrawals\/|merchants\/[^/]+\/pay|money\/charges\/[^/]+\/pay|money\/payments\/[^/]+\/refund|marketplace\/orders$|kori\/convert|tontine\/|agent\/(deposits|withdrawals)\/|businesses\/[^/]+\/(transfer|payroll\/(pay|run)|school\/pay|cooperative\/payout)|payment-funds|scheduled-payments|distribution\/invoices\/[^/]+\/pay|jekkal\/campaigns\/[^/]+\/contribute|events\/[^/]+\/tickets|auth\/pin\/|auth\/password\/set$|auth\/device\/verify|me\/phone)/;

export function isSensitiveRoute(routeKey) {
  return SENSITIVE_ROUTE.test(routeKey);
}

export class TooManyRequestsError extends Error {
  constructor(scope) {
    super('Trop de tentatives — réessaie dans quelques minutes.');
    this.code = 'rate_limited';
    this.status = 429;
    this.scope = scope;
  }
}

function identifierFrom(body, field) {
  const fields = Array.isArray(field) ? field : [field];
  for (const f of fields) {
    const v = body?.[f];
    if (typeof v === 'string' && v.trim()) return `${f}:${v.replace(/\s/g, '').toLowerCase()}`;
  }
  return null;
}

/** Enforce limits for unauthenticated auth routes. Throws TooManyRequestsError. */
export async function enforceAuthRouteLimits(routeKey, req) {
  const policy = AUTH_POLICIES[routeKey];
  if (!policy) return;
  if (policy.ip) {
    const [env, def] = policy.ip;
    if ((await hitBucket(`ip:${routeKey}:${clientIp(req)}`, TEN_MIN)) > envInt(env, def)) {
      throw new TooManyRequestsError('ip');
    }
  }
  if (policy.id) {
    const ident = identifierFrom(req.body, policy.idField);
    if (ident) {
      const [env, def] = policy.id;
      if ((await hitBucket(`id:${routeKey}:${ident}`, TEN_MIN)) > envInt(env, def)) {
        throw new TooManyRequestsError('identifier');
      }
    }
  }
}

/** Per-user budget for money-moving and credential routes. */
export async function enforceSensitiveRouteLimit(routeKey, userId) {
  if (!SENSITIVE_ROUTE.test(routeKey)) return;
  if ((await hitBucket(`user-sensitive:${userId}`, ONE_MIN)) > envInt('RL_SENSITIVE_PER_MIN', 20)) {
    throw new TooManyRequestsError('user_sensitive');
  }
}
