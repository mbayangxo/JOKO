import { z } from 'zod';
import { prisma } from './prisma.js';
import { validationError } from '../api/_lib/http.js';
import { logAdminAction } from './admin-audit.js';
import {
  MoneyAdminError,
  approveAdjustment,
  importProviderStatement,
  moneyPosition,
  rejectAdjustment,
  requestAdjustment,
} from './money-kernel/admin.js';
import { RailUnavailableError } from './runtime-safety.js';
import { adminCan } from './authz/admin-authz.js';

const json = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));

function handle(res, error) {
  if (error instanceof MoneyAdminError || error instanceof RailUnavailableError) {
    res.status(error.status ?? 400).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

/** GET admin/money/position — owed vs real backing, integrity, exceptions. */
export async function adminMoneyPosition(_req, res) {
  res.json(json(await moneyPosition(prisma)));
}

/** GET admin/money/exceptions */
export async function adminMoneyExceptions(req, res) {
  const status = req.query?.status === 'all' ? undefined : 'open';
  const rows = await prisma.reconciliationException.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json(json(rows));
}

/** POST admin/money/statements — import a provider settlement statement. */
export async function adminMoneyImportStatement(req, res) {
  const parsed = z
    .object({ provider: z.enum(['julaya', 'stripe']), statementId: z.string().min(3).max(120), rows: z.array(z.record(z.unknown())).max(5000) })
    .safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const result = await importProviderStatement(prisma, parsed.data);
    await logAdminAction(req.adminId, 'import_statement', { targetType: 'provider', targetId: parsed.data.provider, detail: { statementId: parsed.data.statementId, ...result } });
    res.status(201).json(result);
  } catch (error) {
    if (handle(res, error)) return;
    throw error;
  }
}

/** GET/POST admin/money/adjustments — list / request (first admin). */
export async function adminMoneyAdjustments(req, res) {
  if (req.method === 'GET') {
    res.json(json(await prisma.moneyAdjustmentRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 200 })));
    return;
  }
  const parsed = z
    .object({
      debitAccount: z.string().min(3),
      creditAccount: z.string().min(3),
      amount: z.number().int().positive(),
      reason: z.string().min(10).max(500),
      originalReference: z.string().max(200).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const idempotencyKey = req.headers['idempotency-key'];
  try {
    const row = await requestAdjustment(prisma, req.adminId, {
      ...parsed.data,
      idempotencyKey,
      singleOperatorAllowed: adminCan(req, 'finance.adjust.low'),
    });
    await logAdminAction(req.adminId, 'request_money_adjustment', { targetType: 'ledger', targetId: row.id, detail: { amount: parsed.data.amount, debit: parsed.data.debitAccount, credit: parsed.data.creditAccount } });
    res.status(201).json(json(row));
  } catch (error) {
    if (handle(res, error)) return;
    throw error;
  }
}

/** POST admin/money/adjustments/:id/approve — second, different admin posts it. */
export async function adminMoneyAdjustmentApprove(req, res) {
  try {
    const row = await approveAdjustment(prisma, req.adminId, String(req.query.id));
    await logAdminAction(req.adminId, 'approve_money_adjustment', { targetType: 'ledger', targetId: row.id, detail: { entryId: row.entryId } });
    res.json(json(row));
  } catch (error) {
    if (handle(res, error)) return;
    throw error;
  }
}

export async function adminMoneyAdjustmentReject(req, res) {
  try {
    const row = await rejectAdjustment(prisma, req.adminId, String(req.query.id));
    await logAdminAction(req.adminId, 'reject_money_adjustment', { targetType: 'ledger', targetId: row.id });
    res.json(json(row));
  } catch (error) {
    if (handle(res, error)) return;
    throw error;
  }
}

// ── J6.0 partner settlement held for review ─────────────────────────────────

/** GET admin/partner-payments/held — collections held in partner unallocated. */
export async function adminPartnerHeldList(_req, res) {
  const rows = await prisma.partnerPayment.findMany({
    where: { settlementTarget: 'held_for_review' },
    orderBy: { completedAt: 'desc' },
    take: 200,
    select: { id: true, partnerId: true, reference: true, amountXof: true, externalBusinessId: true, settlementBusinessId: true, settlementReference: true, completedAt: true },
  });
  res.json(json(rows));
}

/** POST admin/partner-payments/:id/release — maker: release to the BOUND business only. */
export async function adminPartnerHeldRelease(req, res) {
  const parsed = z.object({ reason: z.string().min(10).max(500) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const { requestHeldPartnerRelease } = await import('./integrations/partner-settlement-admin.js');
    const row = await requestHeldPartnerRelease(req.adminId, String(req.query.id), parsed.data);
    await logAdminAction(req.adminId, 'request_partner_release', { targetType: 'partner_payment', targetId: String(req.query.id), detail: { requestId: row.id } });
    res.status(201).json(json(row));
  } catch (error) {
    if (handle(res, error)) return;
    throw error;
  }
}

/** POST admin/partner-payments/:id/release/approve — checker (a different operator). */
export async function adminPartnerHeldReleaseApprove(req, res) {
  try {
    const { approveHeldPartnerRelease } = await import('./integrations/partner-settlement-admin.js');
    const row = await approveHeldPartnerRelease(req.adminId, String(req.query.id));
    await logAdminAction(req.adminId, 'approve_partner_release', { targetType: 'partner_payment', targetId: String(req.query.id), detail: { requestId: row.id, entryId: row.entryId } });
    res.json(json(row));
  } catch (error) {
    if (handle(res, error)) return;
    throw error;
  }
}

/** POST admin/businesses/:id/status — compliance/risk: suspend | reactivate | close. */
export async function adminBusinessStatus(req, res) {
  const parsed = z.object({ status: z.enum(['active', 'suspended', 'closed']), reason: z.string().min(10).max(300) }).safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const { setBusinessStatus } = await import('./integrations/partner-settlement-admin.js');
    const out = await setBusinessStatus(req.adminId, String(req.query.id), parsed.data);
    await logAdminAction(req.adminId, 'business_status', { targetType: 'business', targetId: String(req.query.id), detail: { status: parsed.data.status } });
    res.json(out);
  } catch (error) {
    if (handle(res, error)) return;
    throw error;
  }
}
