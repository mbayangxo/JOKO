import { z } from 'zod';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import { moneyHome } from './money/home.js';
import { listActivity, receiptFor } from './money/activity.js';
import { FLOW_LIMITS, preview } from './money/policy.js';
import { intentOutcome } from './api-idempotency.js';

/**
 * J4 Money read model for the app (docs/JOKKO-J4-REPORT.md §1–2).
 * All amounts in ₭; every route is the caller's own data (policy: self).
 */
export async function moneyHomeHandler(req, res) {
  res.json(await moneyHome(req.userId, req));
}

export async function moneyActivityHandler(req, res) {
  res.json(await listActivity(req.userId, { limit: req.query.limit, before: req.query.before }));
}

export async function moneyReceiptHandler(req, res) {
  const receipt = await receiptFor(req.userId, String(req.query.reference ?? ''));
  if (!receipt) {
    res.status(404).json({ error: 'Reçu introuvable', code: 'receipt_not_found' });
    return;
  }
  res.json(receipt);
}

const previewBody = z.object({
  flow: z.enum(['p2p', 'request_payment', 'merchant_pay', 'cash_in', 'cash_out']),
  amountKori: z.number().int().positive(),
});

/** Server-authoritative amount / fee / total preview (nothing is executed). */
export async function moneyPreviewHandler(req, res) {
  const parsed = previewBody.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const { flow, amountKori } = parsed.data;
  const min = { p2p: FLOW_LIMITS.p2p.minKori, request_payment: 1, merchant_pay: FLOW_LIMITS.merchant_pay.minKori, cash_in: FLOW_LIMITS.cash_in.minKori, cash_out: FLOW_LIMITS.cash_out.minKori }[flow];
  const home = await moneyHome(req.userId, req);
  const p = preview(flow, amountKori);
  const actionKey = { p2p: 'send', request_payment: 'send', merchant_pay: 'merchantPay', cash_in: 'cashIn', cash_out: 'cashOut' }[flow];
  const action = home.actions[actionKey];
  const problems = [];
  if (amountKori < min) problems.push({ category: 'below_minimum', message: `Montant minimum : ${min} ₭.` });
  if (flow === 'cash_in' && amountKori > FLOW_LIMITS.cash_in.maxKori) problems.push({ category: 'above_maximum', message: `Montant maximum : ${FLOW_LIMITS.cash_in.maxKori} ₭.` });
  if (flow !== 'cash_in' && p.payerPaysKori > home.balance.availableKori) problems.push({ category: 'insufficient_funds', message: 'Solde disponible insuffisant.' });
  if (flow === 'cash_out' && home.limits.cashOutRemainingTodayKori != null && amountKori > home.limits.cashOutRemainingTodayKori) {
    problems.push({ category: 'limit_reached', message: 'Au-delà de ta limite de retrait du jour.' });
  }
  if (['p2p', 'merchant_pay', 'request_payment'].includes(flow) && home.limits.sendRemainingTodayKori != null && amountKori > home.limits.sendRemainingTodayKori) {
    problems.push({ category: 'limit_reached', message: 'Au-delà de ta limite d’envoi du jour.' });
  }
  res.json({
    ...p,
    allowed: Boolean(action?.allowed) && problems.length === 0,
    restriction: action?.allowed ? null : { category: action?.category, message: action?.message, nextStep: action?.nextStep },
    problems,
    requiresPin: flow === 'cash_out' || amountKori >= home.limits.stepUpAtOrAboveKori,
    availableAfterKori: flow === 'cash_in' ? home.balance.availableKori : home.balance.availableKori - p.payerPaysKori,
  });
}

/**
 * "Did my payment go through?" — outcome of a client intent (Idempotency-Key)
 * after a timeout, network loss or app kill. The app shows a "checking" state
 * and polls this instead of letting the user pay again.
 */
export async function moneyIntentHandler(req, res) {
  const out = await intentOutcome(req.userId, String(req.query.key ?? req.query.id ?? ''));
  if (out.state === 'invalid') {
    res.status(400).json({ error: 'Clé invalide', code: 'invalid_key' });
    return;
  }
  const message = {
    completed: 'Paiement effectué. Ne le renouvelle pas.',
    accepted_pending: 'Opération enregistrée, en attente de confirmation. Ne la renouvelle pas — suis-la dans ton historique.',
    in_progress: 'Opération en cours de traitement. Patiente, ne la renouvelle pas.',
    refused: 'Opération refusée — aucun argent n’a été débité.',
    not_found: 'Aucune opération reçue avec cette clé — aucun argent n’a été débité. Tu peux réessayer.',
  }[out.state];
  res.json({ ...out, message, safeToRetry: out.state === 'not_found' || out.state === 'refused' });
}

export { prisma };

// ── Merchant charges (QR / payment references) ──────────────────────────────
import { ChargeError, cancelCharge, createCharge, payCharge, viewCharge } from './money/charges.js';
import { RefundError, refundReceivedPayment } from './money/refunds.js';
import { OrgAccessError } from './business-access.js';
import { isMoneyError, moneyErrorStatus } from './wallet-atomic.js';
import { limitsUsage, lookupMoneyReference } from './money/support.js';
import { CATEGORIES } from './money/user-reasons.js';

function moneyFail(res, error) {
  if (error instanceof ChargeError || error instanceof RefundError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof OrgAccessError) {
    res.status(error.status).json({ error: error.message, code: 'not_authorized' });
    return true;
  }
  if (isMoneyError(error)) {
    const insufficient = error.code === 'insufficient';
    res.status(moneyErrorStatus(error)).json({
      error: insufficient ? CATEGORIES.insufficient_funds.message : error.message,
      code: insufficient ? 'insufficient_funds' : error.code,
      ...(insufficient ? { category: 'insufficient_funds', nextStep: CATEGORIES.insufficient_funds.nextStep } : {}),
    });
    return true;
  }
  return false;
}

export async function moneyChargeCreateHandler(req, res) {
  const parsed = z.object({ businessId: z.string().min(1), amountKori: z.number().int().positive(), label: z.string().max(80).optional(), externalRef: z.string().max(60).optional(), orderId: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    res.status(201).json(await createCharge(req.userId, parsed.data));
  } catch (error) {
    if (moneyFail(res, error)) return;
    throw error;
  }
}

export async function moneyChargeViewHandler(req, res) {
  try {
    res.json(await viewCharge(req.query.id));
  } catch (error) {
    if (moneyFail(res, error)) return;
    throw error;
  }
}

export async function moneyChargePayHandler(req, res) {
  const parsed = z.object({ expectedAmountKori: z.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const { assertStepUpForAmount } = await import('./step-up.js');
    const charge = await viewCharge(req.query.id).catch(() => null);
    if (charge) await assertStepUpForAmount(req, charge.amountKori * 10);
    const out = await payCharge(req.userId, req.query.id, parsed.data);
    res.status(out.replayed ? 200 : 201).json({ ...out.charge, replayed: out.replayed });
  } catch (error) {
    if (error?.code === 'step_up_required') {
      res.status(403).json({ error: CATEGORIES.step_up.message, code: 'step_up_required', category: 'step_up' });
      return;
    }
    if (moneyFail(res, error)) return;
    throw error;
  }
}

export async function moneyChargeCancelHandler(req, res) {
  try {
    res.json(await cancelCharge(req.userId, req.query.id));
  } catch (error) {
    if (moneyFail(res, error)) return;
    throw error;
  }
}

// ── Refund of a received payment (compensating entry) ───────────────────────
export async function moneyRefundHandler(req, res) {
  const parsed = z.object({ amountKori: z.number().int().positive(), reason: z.string().min(3).max(300) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    res.status(201).json(await refundReceivedPayment(req.userId, String(req.query.reference ?? ''), parsed.data));
  } catch (error) {
    if (moneyFail(res, error)) return;
    throw error;
  }
}

// ── Operator supportability (read-only) ─────────────────────────────────────
export async function adminMoneyLookupHandler(req, res) {
  const out = await lookupMoneyReference(req.query.reference ?? req.query.q);
  if (!out) {
    res.status(404).json({ error: 'Reference not found' });
    return;
  }
  res.json(out);
}

export async function adminMoneyLimitsUsageHandler(req, res) {
  res.json(await limitsUsage(prisma, { days: Math.min(Number(req.query.days) || 30, 365) }));
}
