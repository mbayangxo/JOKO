import { getRailStatus, initiateCashIn, initiateCashOut, julayaMode } from './julaya.js';
import { julayaOperational } from './payment-config.js';
import { RailUnavailableError } from './runtime-safety.js';
import { RAIL_PROCESSING_MESSAGE } from './external-fetch.js';
import { mintKoriFromNationalDeposit, burnKoriForCashOut } from './kori-service.js';
import { countryConfig, nationalToKori } from './kori.js';
import { cashOutConfirmed, cashOutRelease, legacyCashOutRefund } from './money-kernel/flows.js';
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

  let debitLedger = null;
  if (direction === 'out') {
    // Hold the funds first: burn the ₭ in the same transaction that marks the rail debited.
    try {
      const held = await runMoneyTransaction(db, async (tx) => {
        const locked = await lockRail(tx, rail.id);
        const burned = await burnKoriForCashOut(tx, {
          userId: params.userId,
          walletId: params.wallet.id,
          koriAmount: nationalToKori(params.amount, params.country ?? 'SN'),
          country: params.country ?? 'SN',
          reference: params.reference,
          note: params.operator ? `Retrait via ${params.operator}` : 'Retrait K21',
        });
        const updated = await tx.railTransaction.update({
          where: { id: locked.id },
          data: { walletDebited: true },
        });
        return { rail: updated, ledger: burned.ledger };
      });
      rail = held.rail;
      debitLedger = held.ledger;
    } catch (error) {
      await db.railTransaction.update({
        where: { id: rail.id },
        data: { status: 'failed', failureReason: error?.code === 'insufficient' ? 'insufficient_funds' : 'debit_failed' },
      });
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
      if (direction === 'out' && locked.walletDebited && locked.status === 'pending') {
        const user = await tx.user.findUniqueOrThrow({ where: { id: params.userId }, include: { wallet: true } });
        return refundCashOutInTx(tx, locked, user, partner.message);
      }
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

  rail = await db.railTransaction.update({
    where: { id: rail.id },
    data: { externalId: partner.externalId ?? null },
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
          const { mint, ledger } = await completeCashIn(tx, {
            userId: params.userId,
            walletId: params.wallet.id,
            country: params.country,
            amount: params.amount,
            reference: params.reference,
            sourceNote: `Deposit via Julaya (${params.operator})`,
          });
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
        const user = await tx.user.findUniqueOrThrow({ where: { id: params.userId }, include: { wallet: true } });
        await confirmCashOutInTx(tx, locked, user);
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

  return runMoneyTransaction(db, async (tx) => {
    const locked = await lockRail(tx, rail.id);
    if (!settleable.includes(locked.status)) return locked; // already final → no-op (replay safe)

    const user = await tx.user.findUniqueOrThrow({ where: { id: locked.userId }, include: { wallet: true } });
    if (!user.wallet) throw new RailError('wallet_missing', 'Wallet not found');

    if (params.amount != null && Number(params.amount) !== locked.amount) {
      return tx.railTransaction.update({
        where: { id: locked.id },
        data: {
          status: 'review',
          failureReason: `amount_mismatch:provider=${params.amount},rail=${locked.amount}`,
        },
      });
    }

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
