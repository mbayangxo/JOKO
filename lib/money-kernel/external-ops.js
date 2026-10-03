import { createHash } from 'node:crypto';
import { LedgerInvariantError } from './errors.js';
import { splitAtPeg, cashInConfirmed, cashInSettled, cashOutConfirmed, cashOutHold, cashOutRelease, cashOutSettled } from './flows.js';
import { reverse } from './ledger.js';
import { isProduction } from '../runtime-safety.js';

/**
 * External operation state machine (docs/JOKKO-J2-DESIGN.md §4).
 *
 *   created → authorized → submitted → confirmed → settled
 *   terminal/exception: failed · cancelled · reversed · refunded
 *   expired = outcome overdue → REVIEW (late confirm/fail still allowed);
 *             a timeout is never a confirmation.
 *
 * Each transition that moves value posts its journal entry in the SAME
 * transaction, linked by externalOperationId; the database refuses invalid
 * transitions (j2_external_op_guard) and the invariant checker cross-checks
 * state ↔ entries. Duplicate or out-of-order signals are no-ops.
 */

export const TRANSITIONS = {
  created: ['authorized', 'submitted', 'failed', 'cancelled'],
  authorized: ['submitted', 'failed', 'cancelled', 'expired'],
  submitted: ['confirmed', 'failed', 'expired'],
  expired: ['confirmed', 'failed'],
  confirmed: ['settled', 'reversed', 'refunded'],
  settled: ['reversed', 'refunded'],
  failed: [],
  cancelled: [],
  reversed: [],
  refunded: [],
};
const RANK = { created: 0, authorized: 1, submitted: 2, expired: 2, confirmed: 3, settled: 4, failed: 5, cancelled: 5, reversed: 5, refunded: 5 };

export class ExternalOperationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ExternalOperationError';
    this.code = code;
    this.status = status;
  }
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** A provider reference may belong to exactly one operation. */
async function assertProviderReferenceFree(tx, op, providerReference) {
  if (!providerReference) return;
  const other = await tx.externalOperation.findUnique({
    where: { provider_providerReference: { provider: op.provider, providerReference } },
    select: { id: true, reference: true },
  });
  if (other && other.id !== op.id) {
    throw new ExternalOperationError(
      'provider_reference_conflict',
      `Provider reference already belongs to operation ${other.reference}`,
    );
  }
}

async function lockOp(tx, id) {
  await tx.$executeRaw`SELECT id FROM "ExternalOperation" WHERE id = ${id} FOR UPDATE`;
  return tx.externalOperation.findUniqueOrThrow({ where: { id } });
}

export async function createOperation(tx, params) {
  const {
    provider, direction, reference, idempotencyKey, amountMinor, currency, userId, accountCode, providerMode,
    feeMinor = 0, outcomeDeadline, legacyTable, legacyId, metadata,
  } = params;
  if (isProduction() && providerMode !== 'live') {
    throw new ExternalOperationError('provider_not_live', `Provider ${provider} is not live — refusing in production`, 503);
  }
  const existing = await tx.externalOperation.findUnique({ where: { reference } });
  if (existing) return existing;
  const { kori } = splitAtPeg(amountMinor, currency);
  return tx.externalOperation.create({
    data: {
      provider,
      direction,
      reference,
      idempotencyKey: idempotencyKey ?? null,
      amountMinor: BigInt(amountMinor),
      currency,
      amountKori: BigInt(kori),
      feeMinor: BigInt(feeMinor),
      userId: userId ?? null,
      accountCode,
      providerMode,
      outcomeDeadline: outcomeDeadline ?? null,
      legacyTable: legacyTable ?? null,
      legacyId: legacyId ?? null,
      metadata: metadata ?? undefined,
    },
  });
}

/**
 * Inverse of a confirmed cash-in. If the customer has already spent part of
 * the ₭, the unrecoverable remainder is booked to suspense (visible, with a
 * ReconciliationException) — a wallet never goes negative.
 */
async function reverseCashIn(tx, op, confirmation, to, reason) {
  const lines = confirmation.postings.map((p) => ({
    account: p.account,
    side: p.side === 'debit' ? 'credit' : 'debit',
    amount: Number(p.amount),
  }));
  const custLine = lines.find((l) => l.account.type === 'customer_available');
  let shortfall = 0;
  if (custLine) {
    const fresh = await tx.ledgerAccount.findUnique({ where: { id: custLine.account.id } });
    const available = Number(fresh.balance);
    if (available < custLine.amount) {
      shortfall = custLine.amount - available;
      custLine.amount = available;
      const { specs } = await import('./accounts.js');
      const { ensureAccount } = await import('./ledger.js');
      lines.push({ account: await ensureAccount(tx, specs.suspense('KRI')), side: 'debit', amount: shortfall });
    }
  }
  const { post } = await import('./ledger.js');
  await post(tx, {
    reference: `${op.reference}-${to.toUpperCase()}`,
    kind: 'reversal',
    reversesId: confirmation.id,
    actor: { type: 'provider', id: op.provider },
    authorization: `provider_${to}`,
    reason: reason ?? `provider ${to}`,
    metadata: { originalReference: confirmation.reference, shortfallKori: shortfall },
    lines: lines.filter((l) => l.amount > 0),
  });
  if (shortfall > 0) {
    await tx.reconciliationException.upsert({
      where: { kind_provider_providerReference: { kind: 'reversal_shortfall', provider: op.provider, providerReference: op.providerReference ?? op.reference } },
      create: {
        kind: 'reversal_shortfall', provider: op.provider, providerReference: op.providerReference ?? op.reference,
        operationId: op.id, amountMinor: BigInt(shortfall), currency: 'KRI',
        detail: `Customer had spent ${shortfall} ₭ of a reversed cash-in — booked to suspense`,
      },
      update: {},
    });
  }
}

const evidenceHash = (evidence) => (evidence == null ? null : createHash('sha256').update(JSON.stringify(evidence)).digest('hex'));

/**
 * Move an operation to `to`, posting the ledger effect of that transition.
 * Returns { op, changed }. Stale / duplicate signals → changed=false.
 */
export async function transition(tx, opId, to, { source, signatureOk = false, evidence, note, providerReference, failureReason, reviewReason } = {}) {
  const op = await lockOp(tx, opId);
  if (op.state === to) return { op, changed: false };
  if (!canTransition(op.state, to)) {
    // A signal that is behind the current state (e.g. "submitted" after
    // "confirmed", or anything after a terminal state) is ignored.
    if ((RANK[to] ?? 0) <= (RANK[op.state] ?? 0) || TRANSITIONS[op.state].length === 0) return { op, changed: false, stale: true };
    throw new ExternalOperationError('invalid_transition', `Cannot move ${op.reference} from ${op.state} to ${to}`);
  }
  if (!source) throw new LedgerInvariantError('transition source required');
  if (providerReference && !op.providerReference) await assertProviderReferenceFree(tx, op, providerReference);

  const amountKori = Number(op.amountKori);
  const amountMinor = Number(op.amountMinor);
  const feeMinor = Number(op.feeMinor);
  const userId = op.userId;
  const base = { externalOperationId: op.id };
  const holdRef = `${op.reference}-HOLD`;

  // --- ledger effects ---------------------------------------------------
  if (op.direction === 'out' && to === 'authorized') {
    await cashOutHold(tx, { userId, amountKori, reference: holdRef, actor: { type: 'user', id: userId }, ...base });
  }
  if (to === 'confirmed') {
    if (op.direction === 'in') {
      await cashInConfirmed(tx, { provider: op.provider, currency: op.currency, amountMinor, userId, reference: `${op.reference}-CONFIRM`, ...base });
    } else {
      await cashOutConfirmed(tx, { userId, provider: op.provider, currency: op.currency, amountKori, feeMinor, reference: `${op.reference}-CONFIRM`, ...base });
    }
  }
  if (to === 'settled') {
    if (op.direction === 'in') {
      await cashInSettled(tx, { provider: op.provider, currency: op.currency, amountMinor, reference: `${op.reference}-SETTLE`, ...base });
    } else {
      await cashOutSettled(tx, { provider: op.provider, currency: op.currency, amountMinor: amountMinor - feeMinor, reference: `${op.reference}-SETTLE`, ...base });
    }
  }
  if ((to === 'failed' || to === 'cancelled') && op.direction === 'out') {
    const held = await tx.journalEntry.findUnique({ where: { reference: holdRef } });
    if (held) await cashOutRelease(tx, { userId, amountKori, reference: `${op.reference}-RELEASE`, reason: failureReason, ...base });
  }
  if (to === 'reversed' || to === 'refunded') {
    const confirmation = await tx.journalEntry.findUnique({
      where: { reference: `${op.reference}-CONFIRM` },
      include: { postings: { include: { account: true } } },
    });
    if (!confirmation) throw new LedgerInvariantError(`No confirmation entry to reverse for ${op.reference}`);
    if (op.direction === 'in') {
      await reverseCashIn(tx, op, confirmation, to, failureReason);
    } else {
      // Payout came back: undo the confirmation (₭ return to held), then release to spendable.
      await reverse(tx, confirmation.id, {
        reference: `${op.reference}-${to.toUpperCase()}`,
        reason: failureReason ?? `provider ${to}`,
        actor: { type: 'provider', id: op.provider },
        authorization: `provider_${to}`,
      });
      await cashOutRelease(tx, { userId, amountKori, reference: `${op.reference}-RELEASE`, reason: `provider_${to}`, ...base });
    }
  }

  const now = new Date();
  const data = {
    state: to,
    ...(providerReference && !op.providerReference ? { providerReference } : {}),
    ...(to === 'submitted' ? { submittedAt: now } : {}),
    ...(to === 'confirmed' ? { confirmedAt: now } : {}),
    ...(to === 'settled' ? { settledAt: now } : {}),
    ...(['failed', 'cancelled', 'reversed', 'refunded'].includes(to) ? { terminalAt: now } : {}),
    ...(failureReason ? { failureReason: String(failureReason).slice(0, 300) } : {}),
    ...(reviewReason ? { reviewReason: String(reviewReason).slice(0, 300) } : {}),
  };
  const updated = await tx.externalOperation.update({ where: { id: op.id }, data });
  await tx.externalOperationEvent.create({
    data: { operationId: op.id, fromState: op.state, toState: to, source, signatureOk, evidenceHash: evidenceHash(evidence), note: note ?? null },
  });
  return { op: updated, changed: true };
}

/** Attach the provider's reference (once) without changing state. */
export async function setProviderReference(tx, opId, providerReference) {
  const op = await lockOp(tx, opId);
  if (!providerReference || op.providerReference === providerReference) return op;
  if (op.providerReference) {
    throw new ExternalOperationError('provider_reference_conflict', `${op.reference} already has a provider reference`);
  }
  await assertProviderReferenceFree(tx, op, providerReference);
  return tx.externalOperation.update({ where: { id: op.id }, data: { providerReference } });
}

/** Flag for review without changing financial state (amount mismatch, etc.). */
export async function flagReview(tx, opId, reviewReason) {
  return tx.externalOperation.update({ where: { id: opId }, data: { reviewReason: String(reviewReason).slice(0, 300) } });
}

/**
 * Deadline job: operations past their outcome deadline go to 'expired'
 * (review). Nothing is credited or released — a timeout is not an outcome.
 */
export async function expireOverdue(db, now = new Date()) {
  const due = await db.externalOperation.findMany({
    where: { state: { in: ['authorized', 'submitted'] }, outcomeDeadline: { lt: now } },
    select: { id: true },
    take: 500,
  });
  let expired = 0;
  for (const { id } of due) {
    const r = await db.$transaction((tx) => transition(tx, id, 'expired', { source: 'job', reviewReason: 'outcome_deadline_passed' }));
    if (r.changed) expired += 1;
  }
  return { expired };
}
