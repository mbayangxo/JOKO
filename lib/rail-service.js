import { getRailStatus, initiateCashIn, initiateCashOut, julayaMode } from './julaya.js';
import { julayaOperational } from './payment-config.js';
import { RailUnavailableError } from './runtime-safety.js';
import { RAIL_PROCESSING_MESSAGE } from './external-fetch.js';
import { mintKoriFromNationalDeposit, burnKoriForCashOut } from './kori-service.js';
import { countryConfig, nationalToKori } from './kori.js';
import { cashOutConfirmed, cashOutRelease, legacyCashOutRefund } from './money-kernel/flows.js';
import { ExternalOperationError, createOperation, setProviderReference, transition, flagReview } from './money-kernel/external-ops.js';
import { providerModeLabel } from './money-kernel/providers.js';
import { assertConversionsAllowed } from './kori-reserve.js';
import { formatKori } from './kori-primary.js';
import { applyCirculationIncrease } from './kori-reserve.js';
import {
  claimIdempotencyKey,
  findIdempotentResponse,
  generateIdempotencyKey,
  saveIdempotentResponse,
} from './idempotency.js';
import { runMoneyTransaction } from './wallet-atomic.js';

export async function completeCashIn(db, params) {
  const mint = await mintKoriFromNationalDeposit(db, {
    userId: params.userId,
    walletId: params.walletId,
    country: params.country,
    nationalAmount: params.amount,
    reference: params.reference,
    note: params.sourceNote,
    provider: params.provider ?? 'julaya',
    externalOperationId: params.externalOperationId,
  });

  const ledger = await db.ledgerEntry.create({
    data: {
      walletId: params.walletId,
      userId: params.userId,
      type: 'cash_in',
      amount: mint.koriMinted,
      note: `+${formatKori(mint.koriMinted)}`,
      reference: params.reference,
    },
  });

  return { mint, ledger };
}

export function railShape(rail, wallet, extra = {}) {
  return {
    id: rail.id,
    provider: rail.provider,
    direction: rail.direction,
    amount: rail.amount,
    operator: rail.operator,
    phone: rail.phone,
    status: rail.status,
    externalId: rail.externalId,
    reference: rail.reference,
    idempotencyKey: rail.idempotencyKey,
    walletDebited: rail.walletDebited,
    failureReason: rail.failureReason,
    mode: julayaMode(),
    completedAt: rail.completedAt?.toISOString() ?? null,
    createdAt: rail.createdAt.toISOString(),
    wallet: wallet
      ? { balance: wallet.balance, koriBalance: wallet.koriBalance, currency: wallet.currency }
      : undefined,
    ...extra,
  };
}

function buildRailResponse({ rail, wallet, mint, ledger, userMessage, cached }) {
  return {
    rail,
    wallet: wallet ?? null,
    mint: mint ?? null,
    ledger: ledger ?? null,
    userMessage: userMessage ?? null,
    cached: Boolean(cached),
  };
}

/**
 * Rail settlement rules (J1 financial safety):
 * - An initiation response is NEVER treated as settlement for cash-in. Value is
 *   credited only after a provider-confirmed status (signed webhook or a
 *   server-side status query whose amount matches the rail).
 * - Cash-out funds are debited (held) BEFORE the provider is called, so a
 *   pending payout can never be double-spent. An explicit provider failure
 *   refunds exactly once; an ambiguous outcome is parked for review, never
 *   auto-refunded and never auto-completed.
 * - In production there is no mock rail: an unconfigured rail throws
 *   RailUnavailableError before anything is written.
 */
async function refundCashOutInTx(tx, rail, user, reason) {
  const koriRefund = nationalToKori(rail.amount, user.country ?? 'SN');
  const hold = await tx.journalEntry.findUnique({ where: { reference: `${rail.reference}-HOLD` } });
  if (hold) {
    // J2: release the held ₭ back to spendable — exactly once (unique reference).
    await cashOutRelease(tx, {
      userId: user.id,
      amountKori: koriRefund,
      reference: `${rail.reference}-REFUND`,
      reason: reason ?? 'provider_failure',
    });
  } else {
    // Pre-J2 rail: the legacy system already destroyed the ₭ (not part of any
    // opening balance). Restoring it is a legacy correction, booked visibly
    // against the migration account.
    await legacyCashOutRefund(tx, { userId: user.id, amountKori: koriRefund, reference: `${rail.reference}-REFUND` });
  }
  await tx.ledgerEntry.create({
    data: {
      walletId: user.wallet.id,
      userId: user.id,
      type: 'cash_out_refund',
      amount: koriRefund,
      note: 'Remboursement retrait échoué',
      reference: `${rail.reference}-REFUND`,
    },
  });
  await applyCirculationIncrease(tx, koriRefund);
  return tx.railTransaction.update({
    where: { id: rail.id },
    data: { status: 'failed', failureReason: reason ?? 'Partner reported failure' },
  });
}

/** Provider confirmed a payout: retire the held ₭ (no-op for pre-J2 burned rails). */
async function confirmCashOutInTx(tx, rail, user) {
  const hold = await tx.journalEntry.findUnique({ where: { reference: `${rail.reference}-HOLD` } });
  if (!hold) return null;
  const { currency } = countryConfig(user.country ?? 'SN');
  return cashOutConfirmed(tx, {
    userId: user.id,
    provider: rail.provider ?? 'julaya',
    currency,
    amountKori: nationalToKori(rail.amount, user.country ?? 'SN'),
    reference: `${rail.reference}-CONFIRM`,
  });
}


// ---------------------------------------------------------------------------
// J2: ExternalOperation is the authoritative state; RailTransaction keeps the
// display/business row. Every value movement is the ledger effect of a state
// transition (lib/money-kernel/external-ops.js).
// ---------------------------------------------------------------------------
const OUTCOME_DEADLINE_MS = 24 * 3600 * 1000;

async function opForRail(tx, rail) {
  return tx.externalOperation.findUnique({ where: { reference: rail.reference } });
}

async function createRailOperation(db, rail, params, direction) {
  const { currency } = countryConfig(params.country ?? 'SN');
  const mode = providerModeLabel('julaya');
  return createOperation(db, {
    provider: 'julaya',
    direction,
    reference: rail.reference,
    idempotencyKey: rail.idempotencyKey,
    amountMinor: rail.amount,
    currency,
    userId: params.userId,
    accountCode: `customer:${params.userId}:available`,
    providerMode: mode,
    outcomeDeadline: new Date(Date.now() + OUTCOME_DEADLINE_MS),
    legacyTable: 'RailTransaction',
    legacyId: rail.id,
  });
}

/** Statement rows for a confirmed cash-in (the money moved in the transition). */
async function cashInStatement(tx, { userId, walletId, reference, kori, note }) {
  const existing = await tx.ledgerEntry.findUnique({ where: { reference } });
  if (existing) return existing;
  await tx.koriTransaction.create({
    data: { recipientId: userId, amountKori: kori, transactionType: 'mint', reference: `${reference}-KORI`, note: note ?? 'Dépôt confirmé' },
  });
  return tx.ledgerEntry.create({
    data: { walletId, userId, type: 'cash_in', amount: kori, note: `+${formatKori(kori)}`, reference },
  });
}

async function cashOutRefundStatement(tx, { userId, walletId, reference, kori }) {
  const existing = await tx.ledgerEntry.findUnique({ where: { reference } });
  if (existing) return existing;
  return tx.ledgerEntry.create({
    data: { walletId, userId, type: 'cash_out_refund', amount: kori, note: 'Remboursement retrait échoué', reference },
  });
}

/** Confirm a rail through its operation (posting happens in the transition). */
async function confirmRailInTx(tx, rail, op, { source, providerReference, signatureOk, evidence }) {
  if (op.state === 'created' || op.state === 'authorized') {
    await transition(tx, op.id, 'submitted', { source, providerReference });
  } else if (providerReference && !op.providerReference) {
    await setProviderReference(tx, op.id, providerReference);
  }
  const r = await transition(tx, op.id, 'confirmed', { source, signatureOk, evidence });
  if (r.changed && rail.direction === 'in') {
    const user = await tx.user.findUniqueOrThrow({ where: { id: rail.userId }, include: { wallet: true } });
    await cashInStatement(tx, { userId: user.id, walletId: user.wallet.id, reference: rail.reference, kori: Number(op.amountKori), note: `Dépôt via Julaya (${rail.operator ?? 'mobile money'})` });
  }
  return r;
}

async function failRailInTx(tx, rail, op, { source, failureReason, signatureOk }) {
  const r = await transition(tx, op.id, 'failed', { source, failureReason, signatureOk });
  if (r.changed && rail.direction === 'out' && rail.walletDebited) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: rail.userId }, include: { wallet: true } });
    await cashOutRefundStatement(tx, { userId: user.id, walletId: user.wallet.id, reference: `${rail.reference}-REFUND`, kori: Number(op.amountKori) });
  }
  return r;
}

async function lockRail(tx, railId) {
  await tx.$executeRaw`SELECT id FROM "RailTransaction" WHERE id = ${railId} FOR UPDATE`;
  return tx.railTransaction.findUniqueOrThrow({ where: { id: railId } });
}

/** Ask the provider (server-side) whether a cash-in really settled. */
async function confirmCashInWithProvider(rail, partner) {
  if (partner.mode === 'sandbox' && String(partner.externalId ?? '').startsWith('sandbox-')) {
    // Dev-only mock rail (sandboxResult refuses to exist in production).
    return { confirmed: true };
  }
  if (!partner.externalId) return { confirmed: false };
  const status = await getRailStatus(partner.externalId);
  if (status.status !== 'completed') return { confirmed: false, status: status.status };
  if (status.amount != null && status.amount !== rail.amount) {
    return { confirmed: false, mismatch: true, providerAmount: status.amount };
  }
  if (status.currency && status.currency !== 'XOF') {
    return { confirmed: false, mismatch: true, providerCurrency: status.currency };
  }
  return { confirmed: true };
}

async function executeRailOperation(db, params, direction, initiateFn) {
  if (!julayaOperational()) throw new RailUnavailableError('julaya');

  const idempotencyKey =
    params.idempotencyKey ?? generateIdempotencyKey(params.userId, params.amount, params.reference);

  const cached = await findIdempotentResponse(db, idempotencyKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  const claim = await claimIdempotencyKey(db, {
    key: idempotencyKey,
    provider: 'julaya',
    userId: params.userId,
    operation: direction === 'in' ? 'cash_in' : 'cash_out',
    reference: params.reference,
  });

  if (claim.duplicate) {
    if (claim.cached) return { ...claim.cached, cached: true };
    const wallet = await db.wallet.findUniqueOrThrow({ where: { id: params.wallet.id } });
    const pendingRail = claim.row?.reference
      ? await db.railTransaction.findUnique({ where: { reference: claim.row.reference } })
      : null;
    return buildRailResponse({
      rail: pendingRail ?? { status: 'pending', reference: params.reference },
      wallet,
      userMessage: RAIL_PROCESSING_MESSAGE,
      cached: true,
    });
  }

  let rail = await db.railTransaction.create({
    data: {
      userId: params.userId,
      provider: 'julaya',
      direction,
      amount: params.amount,
      operator: params.operator,
      phone: params.phone,
      status: 'pending',
      reference: params.reference,
      idempotencyKey,
    },
  });
  const op = await createRailOperation(db, rail, params, direction);

  let debitLedger = null;
  if (direction === 'out') {
    // Hold the funds first: burn the ₭ in the same transaction that marks the rail debited.
    try {
      const held = await runMoneyTransaction(db, async (tx) => {
        const locked = await lockRail(tx, rail.id);
        await assertConversionsAllowed(tx);
        // J2: authorization holds the ₭ (spendable → held) as the ledger
        // effect of created → authorized.
        await transition(tx, op.id, 'authorized', { source: 'api' });
        const kori = Number(op.amountKori);
        await tx.koriTransaction.create({
          data: { senderId: params.userId, amountKori: kori, transactionType: 'cash_out', reference: params.reference, note: `Cash-out ${params.amount} XOF` },
        });
        const ledger = await tx.ledgerEntry.create({
          data: {
            walletId: params.wallet.id,
            userId: params.userId,
            type: 'cash_out',
            amount: -kori,
            note: params.operator ? `Retrait via ${params.operator}` : 'Retrait K21',
            reference: params.reference,
          },
        });
        const updated = await tx.railTransaction.update({
          where: { id: locked.id },
          data: { walletDebited: true },
        });
        return { rail: updated, ledger };
      });
      rail = held.rail;
      debitLedger = held.ledger;
    } catch (error) {
      await db.railTransaction.update({
        where: { id: rail.id },
        data: { status: 'failed', failureReason: error?.code === 'insufficient' ? 'insufficient_funds' : 'debit_failed' },
      });
      await db.$transaction((tx) => transition(tx, op.id, 'cancelled', { source: 'api', failureReason: error?.code ?? 'debit_failed' }));
      const failedResponse = buildRailResponse({
        rail: await db.railTransaction.findUniqueOrThrow({ where: { id: rail.id } }),
        wallet: await db.wallet.findUniqueOrThrow({ where: { id: params.wallet.id } }),
      });
      await saveIdempotentResponse(db, idempotencyKey, failedResponse);
      if (error?.code === 'insufficient') throw new RailError('insufficient', 'Insufficient Kori balance');
      throw error;
    }
  }

  let partner;
  try {
    partner = await initiateFn({
      reference: params.reference,
      amount: params.amount,
      phone: params.phone,
      operator: params.operator,
      callbackUrl: params.callbackUrl,
      idempotencyKey,
    });
  } catch (error) {
    // The request may or may not have reached the provider: keep it pending
    // (cash-out stays held) — the resolver/admin settles it. Never refund here.
    partner = { status: 'pending', externalId: null, message: error?.message ?? 'initiation error', ambiguous: true };
  }

  if (partner.status === 'failed') {
    const failed = await runMoneyTransaction(db, async (tx) => {
      const locked = await lockRail(tx, rail.id);
      await failRailInTx(tx, locked, op, { source: 'api', failureReason: partner.message ?? 'provider_rejected' });
      return tx.railTransaction.update({
        where: { id: locked.id },
        data: { status: 'failed', externalId: partner.externalId, failureReason: partner.message ?? 'failed' },
      });
    });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { id: params.wallet.id } });
    const response = buildRailResponse({ rail: failed, wallet });
    await saveIdempotentResponse(db, idempotencyKey, response);
    return response;
  }

  rail = await db.$transaction(async (tx) => {
    // Provider accepted (or the outcome is unknown): submitted — NOT settlement.
    await transition(tx, op.id, 'submitted', { source: 'api', providerReference: partner.externalId ?? undefined });
    return tx.railTransaction.update({
      where: { id: rail.id },
      data: { externalId: partner.externalId ?? null },
    });
  });

  if (partner.status === 'completed') {
    if (direction === 'in') {
      const confirmation = await confirmCashInWithProvider(rail, partner);
      if (confirmation.confirmed) {
        const settled = await runMoneyTransaction(db, async (tx) => {
          const locked = await lockRail(tx, rail.id);
          if (locked.status !== 'pending') {
            return buildRailResponse({ rail: locked, wallet: await tx.wallet.findUniqueOrThrow({ where: { id: params.wallet.id } }) });
          }
          await confirmRailInTx(tx, locked, op, { source: 'status_poll', providerReference: partner.externalId, evidence: { status: 'completed', externalId: partner.externalId } });
          const ledger = await tx.ledgerEntry.findUnique({ where: { reference: params.reference } });
          const mint = { koriMinted: Number(op.amountKori), reserveXof: Number(op.amountKori) * 10 };
          const updatedRail = await tx.railTransaction.update({
            where: { id: rail.id },
            data: { status: 'completed', completedAt: new Date(), externalId: partner.externalId },
          });
          const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: params.wallet.id } });
          return buildRailResponse({ rail: updatedRail, wallet, mint, ledger });
        });
        await saveIdempotentResponse(db, idempotencyKey, settled);
        return settled;
      }
      if (confirmation.mismatch) {
        await flagReview(db, op.id, `provider_mismatch:${JSON.stringify(confirmation)}`);
        rail = await db.railTransaction.update({
          where: { id: rail.id },
          data: { status: 'review', failureReason: `provider_mismatch:${JSON.stringify(confirmation)}` },
        });
      }
      // Unconfirmed → stays pending; nothing credited.
    } else {
      const done = await runMoneyTransaction(db, async (tx) => {
        const locked = await lockRail(tx, rail.id);
        if (locked.status !== 'pending') return locked;
        await confirmRailInTx(tx, locked, op, { source: 'api', providerReference: partner.externalId, evidence: { status: 'completed' } });
        return tx.railTransaction.update({
          where: { id: rail.id },
          data: { status: 'completed', completedAt: new Date() },
        });
      });
      const wallet = await db.wallet.findUniqueOrThrow({ where: { id: params.wallet.id } });
      const response = buildRailResponse({ rail: done, wallet, ledger: debitLedger });
      await saveIdempotentResponse(db, idempotencyKey, response);
      return response;
    }
  }

  // pending / ambiguous / unconfirmed — cash-in credits nothing; cash-out stays held.
  const wallet = await db.wallet.findUniqueOrThrow({ where: { id: params.wallet.id } });
  const response = buildRailResponse({
    rail,
    wallet,
    ledger: debitLedger,
    userMessage: RAIL_PROCESSING_MESSAGE,
  });
  await saveIdempotentResponse(db, idempotencyKey, response);
  return response;
}

export async function startCashIn(db, params) {
  return executeRailOperation(db, params, 'in', initiateCashIn);
}

export async function startCashOut(db, params) {
  return executeRailOperation(db, params, 'out', initiateCashOut);
}

/**
 * Settle a rail from an authenticated provider signal (signed webhook, a
 * server-side status poll, or an audited admin action). Row-locked and
 * idempotent: a duplicate or out-of-order signal can never credit twice.
 */
export async function settleRailFromWebhook(db, params) {
  const rail = await db.railTransaction.findUnique({ where: { reference: params.reference } });
  if (!rail) return rail;

  const normalized = String(params.status ?? '').toLowerCase();
  const failed = ['failed', 'error', 'rejected', 'cancelled'].includes(normalized);
  const completed = ['completed', 'success', 'succeeded', 'paid'].includes(normalized);
  const settleable = ['pending', 'review'];

  if (!failed && !completed) {
    if (!settleable.includes(rail.status)) return rail;
    if (!params.externalId || params.externalId === rail.externalId) return rail;
    return db.railTransaction.update({ where: { id: rail.id }, data: { externalId: params.externalId } });
  }

  try {
    return await settleRailInTx(db, rail, params, { normalized, failed, settleable });
  } catch (error) {
    if (error instanceof ExternalOperationError && error.code === 'provider_reference_conflict') {
      // Two operations can never claim one provider transaction: refuse, move
      // nothing, record it for reconciliation.
      await db.reconciliationException.upsert({
        where: { kind_provider_providerReference: { kind: 'provider_reference_conflict', provider: rail.provider ?? 'julaya', providerReference: String(params.externalId) } },
        create: { kind: 'provider_reference_conflict', provider: rail.provider ?? 'julaya', providerReference: String(params.externalId), detail: `Signal for ${rail.reference} reused a provider reference owned by another operation` },
        update: {},
      });
      return db.railTransaction.findUnique({ where: { id: rail.id } });
    }
    throw error;
  }
}

async function settleRailInTx(db, rail, params, { normalized, failed, settleable }) {
  return runMoneyTransaction(db, async (tx) => {
    const locked = await lockRail(tx, rail.id);
    if (!settleable.includes(locked.status)) return locked; // already final → no-op (replay safe)

    const user = await tx.user.findUniqueOrThrow({ where: { id: locked.userId }, include: { wallet: true } });
    if (!user.wallet) throw new RailError('wallet_missing', 'Wallet not found');
    const op = await opForRail(tx, locked);

    if (params.amount != null && Number(params.amount) !== locked.amount) {
      if (op) await flagReview(tx, op.id, `amount_mismatch:provider=${params.amount},rail=${locked.amount}`);
      return tx.railTransaction.update({
        where: { id: locked.id },
        data: {
          status: 'review',
          failureReason: `amount_mismatch:provider=${params.amount},rail=${locked.amount}`,
        },
      });
    }

    if (op) {
      // J2 path: the operation's transition posts the money.
      const signal = { source: params.source ?? 'webhook', signatureOk: params.signatureOk ?? true, evidence: { status: normalized, externalId: params.externalId } };
      if (failed) {
        await failRailInTx(tx, locked, op, { ...signal, failureReason: params.failureReason ?? 'Partner reported failure' });
        return tx.railTransaction.update({
          where: { id: locked.id },
          data: { status: 'failed', externalId: params.externalId ?? locked.externalId, failureReason: params.failureReason ?? 'Partner reported failure' },
        });
      }
      await confirmRailInTx(tx, locked, op, { ...signal, providerReference: params.externalId ?? locked.externalId });
      return tx.railTransaction.update({
        where: { id: locked.id },
        data: { status: 'completed', externalId: params.externalId ?? locked.externalId, completedAt: new Date() },
      });
    }

    // Legacy rails (created before J2 operations) keep their explicit path.
    if (failed) {
      if (locked.direction === 'out' && locked.walletDebited) {
        return refundCashOutInTx(tx, { ...locked, externalId: params.externalId ?? locked.externalId }, user, params.failureReason);
      }
      return tx.railTransaction.update({
        where: { id: locked.id },
        data: {
          status: 'failed',
          externalId: params.externalId ?? locked.externalId,
          failureReason: params.failureReason ?? 'Partner reported failure',
        },
      });
    }

    if (locked.direction === 'in') {
      await completeCashIn(tx, {
        userId: user.id,
        walletId: user.wallet.id,
        country: user.country,
        amount: locked.amount,
        reference: locked.reference,
        sourceNote: `Deposit via Julaya (${locked.operator ?? 'mobile money'})`,
      });
    } else if (locked.walletDebited) {
      await confirmCashOutInTx(tx, locked, user);
    } else if (!locked.walletDebited) {
      // Legacy rail created before debit-first: try to collect now; if the
      // user already spent the funds, park for review instead of failing open.
      try {
        await burnKoriForCashOut(tx, {
          userId: user.id,
          walletId: user.wallet.id,
          koriAmount: nationalToKori(locked.amount, user.country ?? 'SN'),
          country: user.country ?? 'SN',
          reference: locked.reference,
          note: locked.operator ? `Retrait via ${locked.operator}` : 'Retrait K21',
        });
        await confirmCashOutInTx(tx, locked, user);
      } catch (error) {
        if (error?.code !== 'insufficient') throw error;
        return tx.railTransaction.update({
          where: { id: locked.id },
          data: { status: 'review', failureReason: 'payout_completed_but_wallet_insufficient' },
        });
      }
    }

    return tx.railTransaction.update({
      where: { id: locked.id },
      data: {
        status: 'completed',
        walletDebited: locked.direction === 'out' ? true : locked.walletDebited,
        externalId: params.externalId ?? locked.externalId,
        completedAt: new Date(),
      },
    });
  });
}

export class RailError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'RailError';
  }
}
