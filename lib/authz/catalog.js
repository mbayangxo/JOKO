/**
 * J3 identity & permission catalog (docs/JOKKO-J3-DESIGN.md §2–§3).
 *
 * Two separate principal families:
 *  - people using the app (User + AccountRole + BusinessMember + AgentProfile …)
 *  - operators (AdminUser + AdminRoleGrant)
 * plus system identities (cron, signed provider webhooks, partner API keys).
 * A person may hold several roles; no role implies another, and no endpoint
 * grants a role as a side effect.
 */

// ── People ──────────────────────────────────────────────────────────────────

/**
 * AccountRole catalog. `grant` says how a role becomes active:
 *  - 'signup'      created with the account
 *  - 'self'        the user may switch it on (no money privilege attached)
 *  - 'business'    created with a Business the user owns (tier-checked)
 *  - 'application' the user applies (status pending); an operator activates
 */
export const USER_ROLES = {
  personal: { grant: 'signup', label: 'Personal account' },
  promoter: { grant: 'self', label: 'Event promoter (ticketing)' },
  worker: { grant: 'self', label: 'Worker mode container (no privilege by itself)' },
  seller: { grant: 'self', label: 'Seller (lists products; money only via merchant flows)' },
  business_owner: { grant: 'business', label: 'Business owner' },
  cooperative: { grant: 'business', label: 'Cooperative owner' },
  driver: { grant: 'application', label: 'Courier (delivery worker)', approver: 'couriers.onboard' },
  agent: { grant: 'application', label: 'Cash agent', approver: 'agents.onboard' },
};

/** Only these may be switched on by the user themself (POST /roles/:role). */
export const SELF_SERVICE_ROLES = new Set(
  Object.entries(USER_ROLES).filter(([, r]) => r.grant === 'self').map(([k]) => k),
);

/** AccountRole.status values; only 'active' grants anything. */
export const ROLE_STATUS = ['pending', 'active', 'suspended', 'revoked', 'inactive'];

/** Business staff roles, ordered by authority (higher index = more authority). */
export const BUSINESS_ROLE_LEVEL = {
  viewer: 0,
  staff: 1,
  sales: 1,
  warehouse: 1,
  hr_admin: 2,
  admin: 3,
  cfo: 4,
  ceo: 4,
  owner: 5,
};
/** What each business role may do. Owner (Business.ownerId) may do everything. */
export const BUSINESS_CAPABILITIES = {
  'business.read': ['viewer', 'staff', 'sales', 'warehouse', 'hr_admin', 'admin', 'cfo', 'ceo', 'owner'],
  'business.wallet.read': ['admin', 'cfo', 'ceo', 'owner'],
  'business.treasury': ['admin', 'cfo', 'ceo', 'owner'],
  'business.pay': ['hr_admin', 'admin', 'cfo', 'ceo', 'owner'],
  'business.admin': ['hr_admin', 'admin', 'cfo', 'ceo', 'owner'],
  'business.members.manage': ['admin', 'ceo', 'owner'],
  'business.catalog.manage': ['sales', 'warehouse', 'admin', 'ceo', 'owner'],
};
/** Roles only the owner may grant (finance authority and equal-to-owner titles). */
export const OWNER_ONLY_GRANTS = new Set(['owner', 'admin', 'cfo', 'ceo']);

// ── Operators ───────────────────────────────────────────────────────────────

export const ADMIN_ROLES = {
  support: [
    'ops.dashboard.read',
    'support.tickets.read',
    'support.tickets.write',
    'support.calls',
    'users.search',
    'users.read',
    'users.freeze',
    'money.transactions.read',
    'agents.read',
    'distributors.read',
  ],
  risk: [
    'ops.dashboard.read',
    'risk.held.read',
    'risk.held.decide',
    'risk.alerts.read',
    'risk.alerts.ack',
    'users.search',
    'users.read',
    'users.read.sensitive',
    'users.freeze',
    'users.unfreeze.request',
    'users.unfreeze.approve',
    'users.credentials.invalidate',
    'money.transactions.read',
    'audit.read',
    'agents.read',
    'agents.suspend',
    'couriers.suspend',
    'approvals.read',
  ],
  compliance: [
    'ops.dashboard.read',
    'kyc.review',
    'users.search',
    'users.read',
    'users.read.sensitive',
    'users.unfreeze.approve',
    'agents.read',
    'agents.onboard',
    'agents.manage',
    'agents.suspend',
    'couriers.onboard',
    'couriers.suspend',
    'distributors.read',
    'distributors.manage',
    'audit.read',
    'approvals.read',
  ],
  finance_ops: [
    'ops.dashboard.read',
    'money.transactions.read',
    'finance.position.read',
    'finance.statements.import',
    'finance.reports.read',
    'finance.refund',
    'finance.rails.release',
    'finance.adjust.request',
    'finance.adjust.low',
    'finance.agent_float',
    'risk.held.read',
    'agents.read',
    'approvals.read',
  ],
  finance_approver: [
    'ops.dashboard.read',
    'money.transactions.read',
    'finance.position.read',
    'finance.reports.read',
    'finance.adjust.approve',
    'finance.agent_float.approve',
    'finance.refund.approve',
    'approvals.read',
  ],
  sysadmin: ['ops.health.read', 'ops.dashboard.read', 'admin.roles.read', 'admin.roles.manage', 'audit.read', 'approvals.read'],
};

/** Pairs one operator may not hold at the same time. */
export const ADMIN_ROLE_CONFLICTS = [
  ['sysadmin', 'finance_ops'],
  ['sysadmin', 'finance_approver'],
  ['sysadmin', 'risk'],
  ['sysadmin', 'compliance'],
];

export const ALL_ADMIN_PERMISSIONS = new Set(Object.values(ADMIN_ROLES).flat());

export function permissionsForRoles(roles) {
  const out = new Set();
  for (const r of roles ?? []) for (const p of ADMIN_ROLES[r] ?? []) out.add(p);
  return out;
}

export function conflictingRole(existingRoles, newRole) {
  for (const [a, b] of ADMIN_ROLE_CONFLICTS) {
    if (newRole === a && existingRoles.includes(b)) return b;
    if (newRole === b && existingRoles.includes(a)) return a;
  }
  return null;
}

// ── Policy limits (risk-based maker/checker, decision D10) ─────────────────

const envInt = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : dflt;
};
export const LIMITS = {
  /** Single-operator adjustment ceiling (₭) on platform accounts only. */
  adjustmentSingleMaxKori: () => envInt('MONEY_ADJUSTMENT_SINGLE_MAX_KORI', 5_000),
  /** Single-operator support refund ceiling (₭); above → dual authorization. */
  refundSingleMaxKori: () => envInt('MONEY_REFUND_SINGLE_MAX_KORI', 10_000),
  /** Single-operator agent float top-up ceiling (XOF); above → dual authorization. */
  agentFloatSingleMaxXof: () => envInt('AGENT_FLOAT_SINGLE_MAX_XOF', 500_000),
  /** Hours a newly seen device stays "new" for cash-out purposes. */
  newDeviceCoolOffHours: () => envInt('NEW_DEVICE_CASH_OUT_COOL_OFF_HOURS', 24),
  /** Absolute session lifetime (days); rotation never extends past it. */
  sessionMaxDays: () => envInt('SESSION_MAX_DAYS', 60),
};
