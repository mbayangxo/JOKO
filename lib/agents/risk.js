import { cashLimits } from './limits.js';

/**
 * J6.9 — cash-network risk signals (behaviour only).
 *
 * FAIRNESS (same rule as lib/risk/engine.js): only the account's own
 * transaction behaviour, devices and counterparties. Never ethnicity,
 * nationality, language, name, neighbourhood / service-point area, diaspora
 * status or any proxy for them.
 *
 * Severity:
 *   hold  — the transaction stops in risk_hold (funds stay reserved) for a risk operator
 *   flag  — the transaction proceeds; it earns NO commission and is visible to risk
 */
const HOUR = 3_600_000;

export async function agentSideSignals(db, { agent, customerId, kind, now = new Date() }) {
  const out = [];
  const since24 = new Date(now.getTime() - 24 * HOUR);
  const [pair, declines, lastHour] = await Promise.all([
    db.agentCashTransaction.count({ where: { agentId: agent.id, customerId, createdAt: { gte: since24 }, state: { notIn: ['cancelled', 'expired'] } } }),
    db.agentCashTransaction.count({ where: { agentId: agent.id, state: 'declined', terminalAt: { gte: since24 } } }),
    db.agentCashTransaction.count({ where: { agentId: agent.id, boundAt: { gte: new Date(now.getTime() - HOUR) } } }),
  ]);
  if (pair >= 5) out.push({ code: 'agent_customer_pair_frequency', severity: 'flag', detail: `${pair} operations with the same customer in 24 h` });
  if (declines >= 5) out.push({ code: 'agent_declines', severity: 'flag', detail: `${declines} declined operations in 24 h` });
  if (lastHour >= 40) out.push({ code: 'agent_velocity', severity: 'flag', detail: `${lastHour} operations in 1 h` });
  // Circular cash: cash in then cash out (or the reverse) by the same customer
  // at the same agent within 2 h — commission farming / mule pattern.
  const opposite = kind === 'cash_out' ? 'cash_in' : 'cash_out';
  const circular = await db.agentCashTransaction.count({ where: { agentId: agent.id, customerId, kind: opposite, state: 'completed', completedAt: { gte: new Date(now.getTime() - 2 * HOUR) } } });
  if (circular > 0) out.push({ code: 'circular_cash', severity: kind === 'cash_out' ? 'hold' : 'flag', detail: `${opposite} at the same point < 2 h ago` });
  return out;
}

/** Customer-side signals feeding the J3 engine's cash_out rule table (review → risk_hold). */
export async function customerCashSignals(db, { userId, deviceId, amountNational, now = new Date() }) {
  const out = [];
  const since24 = new Date(now.getTime() - 24 * HOUR);
  const L = cashLimits();
  const [cancels, nearLimit] = await Promise.all([
    db.agentCashTransaction.count({ where: { customerId: userId, state: { in: ['cancelled', 'declined', 'expired'] }, terminalAt: { gte: since24 } } }),
    db.agentCashTransaction.count({ where: { customerId: userId, kind: 'cash_out', createdAt: { gte: since24 }, amountXof: { gte: Math.floor(L.perTransaction.cash_out.standard * 0.9) } } }),
  ]);
  if (cancels >= 3) out.push({ code: 'cash_cancellations', detail: `${cancels} cancelled / declined / expired cash operations in 24 h` });
  if (nearLimit >= 2 && amountNational >= L.perTransaction.cash_out.standard * 0.9) out.push({ code: 'near_limit_repetition', detail: 'repeated cash-outs just under the per-operation limit' });
  if (deviceId) {
    const accounts = await db.agentCashTransaction.findMany({
      where: { customerDeviceId: deviceId, kind: 'cash_out', createdAt: { gte: new Date(now.getTime() - 7 * 24 * HOUR) } },
      select: { customerId: true }, distinct: ['customerId'], take: 10,
    });
    if (accounts.filter((a) => a.customerId !== userId).length >= 2) out.push({ code: 'shared_device_accounts', detail: 'one device requesting cash-outs for several accounts' });
  }
  return out;
}
