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

/**
 * Business roles (J5, docs/JOKKO-J5-REPORT.md §2). A role is a NAMED SET OF
 * CAPABILITIES — never a job title that implies authority. Owner
 * (Business.ownerId) may do everything. Legacy J3 roles (staff, sales,
 * warehouse, hr_admin, admin, cfo, ceo) keep exactly the authority they had,
 * expressed as capabilities, so no existing member gains or loses access.
 */
export const BUSINESS_CAPABILITY_LIST = [
  'business.read', // profile, own membership, catalog as staff
  'business.profile.manage', // profile, locations, order settings, settlement switch
  'business.members.manage', // invite / role change / remove (within level)
  'business.catalog.manage', // create / edit / deactivate products & prices
  'business.inventory.adjust', // manual stock adjustments (with reason)
  'business.orders.read',
  'business.orders.fulfill', // accept / prepare / ready / delivered / complete
  'business.orders.cancel', // merchant cancellation (refunds the customer)
  'business.refund', // refunds of paid orders / payments
  'business.charges.create', // accept payments: create / cancel QR charges
  'business.charges.read',
  'business.customers.read', // minimal customer info for fulfilment/support
  'business.activity.read', // business money activity WITHOUT salary detail
  'business.analytics.read',
  'business.wallet.read', // balances + full activity incl. payroll lines
  'business.treasury', // move money out of the business wallet
  'business.pay', // pay employees / suppliers
  'business.admin', // payroll administration (employees, groups)
  'business.payroll.read', // see employees and salaries
  'business.relationships.manage', // accept / end distributor relationships (merchant side)
  'business.distribution.manage', // territories + all merchant relationships (distributor side)
  'business.distribution.invite', // invite / assist merchants; see relationships one introduced
  'business.purchasing', // J7: build / submit / receive purchase orders from connected suppliers (payment still needs business.pay)
];

const OPERATIONS = [
  'business.read', 'business.catalog.manage', 'business.inventory.adjust', 'business.orders.read', 'business.orders.fulfill',
  'business.orders.cancel', 'business.refund', 'business.charges.create', 'business.charges.read', 'business.customers.read',
  'business.activity.read', 'business.analytics.read',
];
const FINANCE = [
  'business.read', 'business.wallet.read', 'business.treasury', 'business.pay', 'business.admin', 'business.payroll.read',
  'business.activity.read', 'business.analytics.read', 'business.refund', 'business.charges.read', 'business.orders.read',
];

export const BUSINESS_ROLES = {
  // J5 operating roles
  manager: { level: 3, ownerOnlyGrant: true, label: 'Gérant·e', caps: [...OPERATIONS, 'business.profile.manage', 'business.members.manage', 'business.relationships.manage', 'business.distribution.manage', 'business.distribution.invite', 'business.purchasing'] },
  distribution_rep: { level: 1, label: 'Commercial·e terrain', caps: ['business.read', 'business.distribution.invite'] },
  cashier: { level: 1, label: 'Caisse', caps: ['business.read', 'business.charges.create', 'business.charges.read', 'business.orders.read'] },
  inventory: { level: 1, label: 'Stock', caps: ['business.read', 'business.catalog.manage', 'business.inventory.adjust', 'business.orders.read', 'business.purchasing'] },
  fulfillment: { level: 1, label: 'Préparation / livraison', caps: ['business.read', 'business.orders.read', 'business.orders.fulfill', 'business.customers.read'] },
  finance: { level: 4, ownerOnlyGrant: true, label: 'Finances / comptabilité', caps: FINANCE },
  viewer: { level: 0, label: 'Lecture', caps: ['business.read'] },
  // Legacy J3 roles — unchanged authority
  staff: { level: 1, legacy: true, label: 'Équipe', caps: ['business.read'] },
  sales: { level: 1, legacy: true, label: 'Ventes', caps: ['business.read', 'business.catalog.manage'] },
  warehouse: { level: 1, legacy: true, label: 'Entrepôt', caps: ['business.read', 'business.catalog.manage'] },
  hr_admin: { level: 2, legacy: true, label: 'RH', caps: ['business.read', 'business.pay', 'business.admin', 'business.payroll.read'] },
  admin: { level: 3, legacy: true, ownerOnlyGrant: true, label: 'Admin', caps: [...new Set([...OPERATIONS, 'business.profile.manage', 'business.members.manage', 'business.relationships.manage', ...FINANCE])] },
  cfo: { level: 4, legacy: true, ownerOnlyGrant: true, label: 'Directeur financier', caps: FINANCE },
  ceo: { level: 4, legacy: true, ownerOnlyGrant: true, label: 'Directeur général', caps: [...new Set([...OPERATIONS, 'business.profile.manage', 'business.members.manage', 'business.relationships.manage', ...FINANCE])] },
};

/** Roles that may be granted through invitations (ownership itself is not a member role). */
export const GRANTABLE_BUSINESS_ROLES = Object.keys(BUSINESS_ROLES);

/** Business staff roles, ordered by authority (higher = more). */
export const BUSINESS_ROLE_LEVEL = { ...Object.fromEntries(Object.entries(BUSINESS_ROLES).map(([k, r]) => [k, r.level])), owner: 5 };

/** capability → roles holding it (owner always included). Derived, never hand-edited. */
export const BUSINESS_CAPABILITIES = Object.fromEntries(
  BUSINESS_CAPABILITY_LIST.map((cap) => [cap, [...Object.entries(BUSINESS_ROLES).filter(([, r]) => r.caps.includes(cap)).map(([k]) => k), 'owner']]),
);

/** Roles only the owner may grant (finance authority and owner-equivalent titles). */
export const OWNER_ONLY_GRANTS = new Set(['owner', ...Object.entries(BUSINESS_ROLES).filter(([, r]) => r.ownerOnlyGrant).map(([k]) => k)]);

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
    'businesses.read',
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
    'deliveries.disputes.resolve',
    'approvals.read',
    'businesses.read',
    'businesses.suspend',
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
    'agents.activate',
    'agents.manage',
    'agents.suspend',
    'couriers.onboard',
    'couriers.suspend',
    'distributors.read',
    'distributors.manage',
    'audit.read',
    'approvals.read',
    'businesses.read',
    'businesses.suspend',
    'merchants.verify',
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
    'finance.commission.propose',
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
    'finance.commission.approve',
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
