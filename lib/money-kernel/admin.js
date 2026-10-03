import { LedgerInvariantError } from './errors.js';
import { post } from './ledger.js';
import { customer } from './flows.js';
import { transition } from './external-ops.js';
import { importStatement, ledgerPosition } from './reconciliation.js';
import { checkInvariants } from './invariants.js';
import { getProvider, providers } from './providers.js';

/**
 * Admin & support money controls (docs/JOKKO-J2-DESIGN.md §12).
 *
 * There is NO "set balance". An operational correction is a ledger
 * adjustment between two existing accounts that:
 *  - needs a reason, an idempotency key and an authenticated admin;
 *  - is REQUESTED by one admin and APPROVED by a different admin
 *    (dual authorization, every amount) — the legacy shared API key can do
 *    neither;
 *  - is capped (MONEY_ADJUSTMENT_MAX_KORI, default 1 000 000);
 *  - posts as kind 'adjustment' with full provenance and can be reversed
 *    only by another adjustment/reversal (never edited or deleted).
 */

export class MoneyAdminError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MoneyAdminError';
    this.code = code;
    this.status = status;
  }
}

const maxAdjustment = () => {
  const n = Number(process.env.MONEY_ADJUSTMENT_MAX_KORI);
  return Number.isFinite(n) && n > 0 ? n : 1_000_000;
};

function assertRealAdmin(adminId) {
  if (!adminId || adminId === 'legacy-api-key') {
    throw new MoneyAdminError('admin_identity_required', 'Money adjustments need a named, TOTP-verified admin', 403);
  }
}

export async function requestAdjustment(db, adminId, { idempotencyKey, debitAccount, creditAccount, amount, reason, originalReference }) {
  assertRealAdmin(adminId);
  if (!idempotencyKey) throw new MoneyAdminError('idempotency_required', 'Idempotency key required');
  if (!reason || String(reason).trim().length < 10) throw new MoneyAdminError('reason_required', 'A reason (≥ 10 characters) is required');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new MoneyAdminError('invalid_amount', 'Amount must be a positive integer');
  if (amount > maxAdjustment()) throw new MoneyAdminError('amount_over_policy', `Adjustments are capped at ${maxAdjustment()}`);
  if (debitAccount === creditAccount) throw new MoneyAdminError('same_account', 'Debit and credit accounts must differ');

  const existing = await db.moneyAdjustmentRequest.findUnique({ where: { idempotencyKey } });
  if (existing) {
    const same = existing.debitAccount === debitAccount && existing.creditAccount === creditAccount && Number(existing.amount) === amount;
    if (!same) throw new MoneyAdminError('idempotency_conflict', 'Idempotency key reused with a different adjustment', 409);
    return existing;
  }
  // Customer accounts are opened through the normal resolver (lazy opening
  // balance included); any other account must already exist.
  const open = async (code) => {
    const m = /^customer:([^:]+):available$/.exec(code);
    if (m) {
      const user = await db.user.findUnique({ where: { id: m[1] }, select: { id: true } });
      if (!user) return null;
      return db.$transaction((tx) => customer(tx, user.id));
    }
    return db.ledgerAccount.findUnique({ where: { code } });
  };
  const debit = await open(debitAccount);
  const credit = await open(creditAccount);
  if (!debit || !credit) throw new MoneyAdminError('unknown_account', 'Both ledger accounts must already exist', 404);
  if (debit.currency !== credit.currency) throw new MoneyAdminError('currency_mismatch', 'Accounts must share a currency');
  if ([debit.type, credit.type].includes('test_faucet')) throw new MoneyAdminError('forbidden_account', 'Test faucet is never adjustable');

  return db.moneyAdjustmentRequest.create({
    data: {
      idempotencyKey,
      debitAccount,
      creditAccount,
      amount: BigInt(amount),
      currency: debit.currency,
      reason: String(reason).slice(0, 500),
      originalReference: originalReference ?? null,
      requestedBy: adminId,
    },
  });
}

export async function approveAdjustment(db, adminId, requestId) {
  assertRealAdmin(adminId);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "MoneyAdjustmentRequest" WHERE id = ${requestId} FOR UPDATE`;
    const req = await tx.moneyAdjustmentRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new MoneyAdminError('not_found', 'Adjustment request not found', 404);
    if (req.status === 'posted') return req;
    if (req.status !== 'requested') throw new MoneyAdminError('not_pending', `Request is ${req.status}`, 409);
    if (req.requestedBy === adminId) {
      throw new MoneyAdminError('dual_authorization', 'A second, different admin must approve', 403);
    }
    const debit = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: req.debitAccount } });
    const credit = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: req.creditAccount } });
    const { entry } = await post(tx, {
      reference: `adjustment:${req.id}`,
      kind: 'adjustment',
      actor: { type: 'admin', id: adminId },
      authorization: `admin_dual_approval:${req.requestedBy}+${adminId}`,
      reason: req.reason,
      metadata: { requestId: req.id, requestedBy: req.requestedBy, approvedBy: adminId, originalReference: req.originalReference },
      lines: [
        { account: debit, side: 'debit', amount: Number(req.amount) },
        { account: credit, side: 'credit', amount: Number(req.amount) },
      ],
    });
    return tx.moneyAdjustmentRequest.update({
      where: { id: req.id },
      data: { status: 'posted', approvedBy: adminId, entryId: entry.id, decidedAt: new Date() },
    });
  });
}

export async function rejectAdjustment(db, adminId, requestId) {
  assertRealAdmin(adminId);
  const r = await db.moneyAdjustmentRequest.updateMany({
    where: { id: requestId, status: 'requested' },
    data: { status: 'rejected', rejectedBy: adminId, decidedAt: new Date() },
  });
  if (r.count === 0) throw new MoneyAdminError('not_pending', 'Request is not pending', 409);
  return db.moneyAdjustmentRequest.findUnique({ where: { id: requestId } });
}

/** Position + integrity + exceptions — what finance looks at every morning. */
export async function moneyPosition(db) {
  const [position, integrity, openExceptions, review] = await Promise.all([
    ledgerPosition(db),
    checkInvariants(db),
    db.reconciliationException.count({ where: { status: 'open' } }),
    db.externalOperation.count({ where: { OR: [{ state: 'expired' }, { reviewReason: { not: null }, state: { in: ['submitted', 'authorized'] } }] } }),
  ]);
  return {
    position,
    integrity: { ok: integrity.ok, violations: integrity.violations.map(({ id, detail, count }) => ({ id, detail, count })), stats: integrity.stats },
    openExceptions,
    operationsInReview: review,
    providers: Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, p.mode()])),
  };
}

/** Import a provider statement: matched confirmed operations become settled. */
export async function importProviderStatement(db, { provider, statementId, rows }) {
  if (!statementId) throw new MoneyAdminError('statement_id_required', 'statementId required');
  const adapter = getProvider(provider);
  const lines = adapter.parseStatement(rows ?? []);
  return importStatement(db, { provider, statementId, lines }, {
    settle: (op) => db.$transaction((tx) => transition(tx, op.id, 'settled', { source: 'reconciliation', evidence: { statementId } })),
  });
}

export { LedgerInvariantError };
