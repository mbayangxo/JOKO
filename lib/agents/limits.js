/**
 * J6.9 — centralized, configurable cash-network limits.
 *
 * One table, read by every check (creation, binding, completion, discovery).
 * Defaults below; `AGENT_CASH_LIMITS_JSON` may override any leaf (validated:
 * positive integers only, unknown keys ignored). Amounts in XOF.
 *
 * Customer-tier daily caps (tier-service: assertCanCashOut / balance caps) and
 * the J3 risk engine apply ON TOP of these — a limit here never loosens them.
 */
const DEFAULTS = {
  minXof: 500,
  stepXof: 10, // the peg (10 XOF = 1 ₭): amounts are exact ₭
  perTransaction: {
    cash_in: { standard: 500_000, business: 2_000_000 },
    cash_out: { standard: 500_000, business: 5_000_000 },
  },
  customerDaily: { cash_in: 2_000_000, cash_out: 1_000_000 },
  customerDailyCount: { cash_in: 10, cash_out: 6 },
  agentDaily: { cash_in: { standard: 5_000_000, business: 50_000_000 }, cash_out: { standard: 5_000_000, business: 50_000_000 } },
  /** Above this a cash-out needs a business agent. */
  largeCashOutXof: 500_000,
  /** Agent e-float below this is "low float" in liquidity views. */
  lowFloatXof: 50_000,
  /** Handoff challenge lifetime (minutes) before an agent binds it. */
  challengeTtlMin: 15,
  /** After the customer confirms / authorizes, the agent completes within this window, else → needs_review. */
  completionWindowMin: 30,
  /** Invalid scans per agent per 10 minutes before scanning is locked (anti-enumeration). */
  maxScanFailures: 5,
};

function merge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) continue;
    if (base[k] && typeof base[k] === 'object') out[k] = merge(base[k], v);
    else if (Number.isSafeInteger(v) && v > 0) out[k] = v;
  }
  return out;
}

let cached;
let cachedRaw;
export function cashLimits() {
  const raw = process.env.AGENT_CASH_LIMITS_JSON ?? '';
  if (cached && raw === cachedRaw) return cached;
  let over = null;
  try {
    over = raw ? JSON.parse(raw) : null;
  } catch {
    over = null;
  }
  cached = merge(DEFAULTS, over);
  cachedRaw = raw;
  return cached;
}

export class CashLimitError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CashLimitError';
    this.code = code;
    this.status = status;
  }
}

const fmt = (n) => `${Math.round(n).toLocaleString('fr-FR')} FCFA`;

/** Shape checks for a requested amount (before any party is known). */
export function assertAmountShape(kind, amountXof) {
  const L = cashLimits();
  if (!Number.isSafeInteger(amountXof) || amountXof <= 0) throw new CashLimitError('invalid_amount', 'Montant invalide');
  if (amountXof % L.stepXof !== 0) throw new CashLimitError('amount_not_multiple', `Montant en multiples de ${L.stepXof} FCFA`);
  if (amountXof < L.minXof) throw new CashLimitError('amount_too_low', `Minimum ${fmt(L.minXof)}`);
  const max = Math.max(...Object.values(L.perTransaction[kind]));
  if (amountXof > max) throw new CashLimitError('amount_too_high', `Maximum ${fmt(max)} par opération`);
}

/** Per-agent per-transaction cap (tier-based, never above the agent's own configured max). */
export function agentTransactionCap(agent, kind) {
  const L = cashLimits();
  const tier = agent.tier === 'business' ? 'business' : 'standard';
  const own = kind === 'cash_in' ? agent.maxDepositXof : agent.maxWithdrawXof;
  return Math.min(L.perTransaction[kind][tier], own ?? Infinity);
}

/** Dakar calendar day start (UTC+0, no DST). */
export function dayStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const ACTIVE_OR_DONE = ['funds_held', 'agent_bound', 'customer_confirmed', 'customer_authorized', 'completed', 'needs_review', 'risk_hold'];

/** Customer daily amount / count caps for this kind (counts open + completed). */
export async function assertCustomerDaily(db, customerId, kind, amountXof) {
  const L = cashLimits();
  const agg = await db.agentCashTransaction.aggregate({
    where: { customerId, kind, state: { in: kind === 'cash_in' ? ['created', ...ACTIVE_OR_DONE] : ACTIVE_OR_DONE }, createdAt: { gte: dayStart() } },
    _sum: { amountXof: true },
    _count: true,
  });
  if ((agg._sum.amountXof ?? 0) + amountXof > L.customerDaily[kind]) throw new CashLimitError('customer_daily_limit', `Limite journalière : ${fmt(L.customerDaily[kind])}`, 403);
  if ((agg._count ?? 0) + 1 > L.customerDailyCount[kind]) throw new CashLimitError('customer_daily_count', 'Nombre maximum d’opérations aujourd’hui atteint', 403);
}

/** Agent daily volume cap (completed + in-flight bound to this agent). */
export async function assertAgentDaily(db, agent, kind, amountXof) {
  const L = cashLimits();
  const tier = agent.tier === 'business' ? 'business' : 'standard';
  const agg = await db.agentCashTransaction.aggregate({
    where: { agentId: agent.id, kind, state: { in: ['agent_bound', 'customer_confirmed', 'customer_authorized', 'completed', 'needs_review'] }, createdAt: { gte: dayStart() } },
    _sum: { amountXof: true },
  });
  if ((agg._sum.amountXof ?? 0) + amountXof > L.agentDaily[kind][tier]) throw new CashLimitError('agent_daily_limit', 'Limite journalière du point atteinte', 403);
}
