import { HIGH_VALUE_XOF } from '../session-security.js';
import { TIER_LIMITS, effectiveTier, limitsForTier } from '../tier-limits.js';
import { koriToNational, nationalToKori } from '../kori.js';

/**
 * J4 — the ONE place money limits and fees are defined (docs/JOKKO-J4-REPORT.md §10).
 * Handlers, previews and the client read from here; the server is authoritative.
 *
 * Unit: the closed-loop ₭ (Kori). Fixed peg: 1 ₭ = 10 XOF (lib/kori.js).
 *
 * FEES (decision D18): 0 on every flow — P2P, requests, merchant payments,
 * internal transfers and cash-out. No schedule is invented without real
 * provider / agent / unit-economics data. A future fee must be server-
 * authoritative, disclosed in the preview before confirmation, posted as a
 * SEPARATE ledger line to the right revenue / funded account, and shown on
 * the receipt. A flow joins FEE_WIRED only once its handler passes the fee
 * into that kernel posting (the kernel already has the cash-out fee line,
 * `feeMinor` → revenue, but the rail service does not pass it yet). Until
 * then any MONEY_FEES_BPS override is ignored, so a previewed fee can never
 * differ from what is committed.
 */
export const UNIT = { code: 'KRI', symbol: '₭', name: 'Kori', xofPerUnit: 10 };

const FEE_WIRED = new Set([]);
const FEE_DEFAULTS = { p2p: 0, request_payment: 0, merchant_pay: 0, cash_in: 0, cash_out: 0 };

/** Fee schedule in basis points per flow; MONEY_FEES_BPS='{"cash_out":100}' overrides. */
export function feeScheduleBps() {
  let override = {};
  try {
    override = JSON.parse(process.env.MONEY_FEES_BPS ?? '{}');
  } catch {
    override = {};
  }
  const out = { ...FEE_DEFAULTS };
  for (const [flow, bps] of Object.entries(override)) {
    if (!(flow in FEE_DEFAULTS) || !Number.isInteger(bps) || bps < 0 || bps > 1000) continue;
    if (bps > 0 && !FEE_WIRED.has(flow)) continue; // fail closed: never preview a fee the ledger would not charge
    out[flow] = bps;
  }
  return out;
}

/** Fee for a flow, in ₭ (cash-out fees are charged in XOF minor units at the peg). */
export function feeFor(flow, amountKori) {
  const bps = feeScheduleBps()[flow] ?? 0;
  const feeKori = Math.floor((amountKori * bps) / 10_000);
  return { feeKori, feeXof: koriToNational(feeKori, 'SN'), bps, basis: bps ? 'schedule' : 'no_fee' };
}

/** Per-flow limits, all in ₭ (XOF thresholds converted at the peg). */
export const FLOW_LIMITS = {
  p2p: { minKori: 1 },
  request: { minKori: 1, maxPendingOutgoing: 20, maxToSamePayerPer24h: 3, expiresAfterDays: 7 },
  merchant_pay: { minKori: 1 },
  cash_in: { minKori: nationalToKori(500, 'SN'), maxKori: nationalToKori(1_000_000, 'SN') },
  cash_out: { minKori: nationalToKori(500, 'SN') },
  charge: { minKori: 1, maxKori: nationalToKori(2_000_000, 'SN'), expiresAfterMinutes: 30 },
  stepUpAtOrAboveKori: nationalToKori(HIGH_VALUE_XOF, 'SN'),
};

/** What this user may do today, with remaining daily allowances (₭). */
export function limitsFor(user, usage = { sentNational: 0, cashOutNational: 0 }) {
  const tier = effectiveTier(user);
  const t = limitsForTier(tier);
  const toK = (xof) => (xof == null ? null : nationalToKori(xof, 'SN'));
  return {
    tier,
    tierLabel: t.label,
    maxBalanceKori: t.maxKoriBalance,
    sendPerDayKori: toK(t.maxSendPerDay),
    sendRemainingTodayKori: t.maxSendPerDay == null ? null : Math.max(0, toK(t.maxSendPerDay - (usage.sentNational ?? 0))),
    cashOutAllowed: t.canCashOut,
    cashOutPerDayKori: toK(t.maxCashOutPerDay),
    cashOutRemainingTodayKori: t.canCashOut ? Math.max(0, toK(t.maxCashOutPerDay - (usage.cashOutNational ?? 0))) : 0,
    stepUpAtOrAboveKori: FLOW_LIMITS.stepUpAtOrAboveKori,
    nextTier: tier < 3 ? { tier: tier + 1, label: TIER_LIMITS[tier + 1].label } : null,
  };
}

/** Server-side preview: what the payer pays and what the other side receives. */
export function preview(flow, amountKori) {
  const { feeKori, bps, basis } = feeFor(flow, amountKori);
  const payerPaysKori = flow === 'cash_out' ? amountKori : amountKori + feeKori;
  const recipientGetsKori = flow === 'cash_out' ? amountKori - feeKori : amountKori;
  return {
    flow,
    unit: UNIT,
    amountKori,
    feeKori,
    feeBps: bps,
    feeBasis: basis,
    payerPaysKori,
    recipientGetsKori,
    ...(flow === 'cash_out' ? { payoutXof: koriToNational(recipientGetsKori, 'SN') } : {}),
  };
}
