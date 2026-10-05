/**
 * Legacy wallet helpers — now thin adapters over the J2 Money Kernel.
 *
 * Value moves ONLY through balanced journal entries (lib/money-kernel); the
 * database writes Wallet.koriBalance from postings and rejects any direct
 * change. These helpers keep their historical signatures and still write the
 * user-facing statement rows (LedgerEntry) in the same transaction.
 *
 * debitNational / creditNational used to touch one wallet only (half an
 * entry). They now REQUIRE the counter-account (`to` / `from`), so no value can
 * appear or disappear.
 */
import {
  InsufficientFundsError,
  WalletNotFoundError,
  LedgerConflictError,
  LedgerAuthorizationError,
} from './money-kernel/errors.js';
import { customerByWallet, move } from './money-kernel/flows.js';

export { InsufficientFundsError, WalletNotFoundError };

/**
 * Lock legacy projection rows for callers that lock before reading, in the
 * Money Kernel's lock order: their ledger accounts first (sorted by id, as
 * `post()` does), then the projection rows (sorted). `post()` locks
 * LedgerAccount rows and its trigger then updates the projection row; taking
 * the projection row first here inverted that order and deadlocked (40P01)
 * under concurrency (J4 soak, item P).
 */
const PROJECTION_TABLES = new Set(['Wallet', 'BusinessWallet', 'AgentProfile', 'TontineGroup', 'PaymentFund', 'MerchantVoucher']);

export async function lockProjections(tx, byTable = {}) {
  const pairs = [];
  for (const [table, ids] of Object.entries(byTable)) {
    if (!PROJECTION_TABLES.has(table)) throw new Error(`lockProjections: unknown projection table ${table}`);
    for (const id of [...new Set((ids ?? []).filter(Boolean))].sort()) pairs.push([table, id]);
  }
  if (!pairs.length) return;
  const accounts = await tx.$queryRaw`
    SELECT a."id" FROM "LedgerAccount" a
    JOIN unnest(${pairs.map((p) => p[0])}::text[], ${pairs.map((p) => p[1])}::text[]) AS k(t, i)
      ON a."projTable" = k.t AND a."projId" = k.i
    ORDER BY a."id"`;
  for (const acc of accounts) {
    await tx.$executeRaw`SELECT "id" FROM "LedgerAccount" WHERE "id" = ${acc.id} FOR UPDATE`;
  }
  for (const [table, id] of pairs) {
    // table is from the fixed allow-list above.
    await tx.$executeRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
  }
}

/** Lock wallet rows (kernel lock order: ledger accounts, then wallets). */
export function lockWallets(tx, walletIds) {
  return lockProjections(tx, { Wallet: walletIds });
}

function statementRow(tx, { walletId, userId, ledger, amount, reference }) {
  return tx.ledgerEntry.create({
    data: {
      walletId,
      userId,
      type: ledger.type,
      amount,
      counterpartyName: ledger.counterpartyName ?? null,
      counterpartyHandle: ledger.counterpartyHandle ?? null,
      note: ledger.note ?? null,
      reference,
    },
  });
}

/**
 * Customer → customer transfer (₭). Journal reference = `reference`.
 */
export async function transferNational(tx, params) {
  const {
    amount,
    senderWalletId,
    recipientWalletId,
    senderUserId,
    recipientUserId,
    reference,
    senderLedger,
    recipientLedger,
    actor,
    authorization,
    kind,
    reversesReference,
  } = params;

  const from = await customerByWallet(tx, senderWalletId);
  const to = await customerByWallet(tx, recipientWalletId);
  let reversesId;
  if (reversesReference) {
    const original = await tx.journalEntry.findUnique({ where: { reference: reversesReference }, select: { id: true } });
    reversesId = original?.id;
  }
  await move(tx, {
    reversesId,
    from,
    to,
    amount,
    reference,
    kind: kind ?? senderLedger.type ?? 'transfer',
    actor: actor ?? { type: 'user', id: senderUserId },
    authorization,
  });

  const outgoing = await statementRow(tx, { walletId: senderWalletId, userId: senderUserId, ledger: senderLedger, amount: -amount, reference });
  await statementRow(tx, {
    walletId: recipientWalletId,
    userId: recipientUserId,
    ledger: recipientLedger,
    amount,
    reference: recipientLedger.reference ?? `${reference}-R`,
  });
  return outgoing;
}

/** Customer → customer ₭ transfer recorded in KoriTransaction (legacy shape). */
export async function transferKori(tx, params) {
  const { amountKori, senderWalletId, recipientWalletId, senderId, recipientId, reference, note, transactionType = 'send' } = params;
  await move(tx, {
    from: await customerByWallet(tx, senderWalletId),
    to: await customerByWallet(tx, recipientWalletId),
    amount: amountKori,
    reference,
    kind: transactionType === 'send' ? 'p2p_transfer' : transactionType,
    actor: params.actor ?? { type: 'user', id: senderId },
    authorization: params.authorization,
  });
  await tx.koriTransaction.create({
    data: { senderId, recipientId, amountKori, transactionType, reference, note: note ?? null },
  });
}

/**
 * Debit a customer wallet INTO a named counter-account (escrow, pot, fund,
 * held funds…). `to` is a resolved ledger account.
 */
export async function debitNational(tx, params) {
  const { walletId, userId, amount, reference, ledger, to, kind, actor, authorization } = params;
  if (!to) throw new Error('debitNational requires a counter-account (to)');
  const from = await customerByWallet(tx, walletId);
  await move(tx, {
    from,
    to,
    amount,
    reference,
    kind: kind ?? ledger.type,
    actor: actor ?? { type: 'user', id: userId },
    authorization,
  });
  return statementRow(tx, { walletId, userId, ledger, amount: -amount, reference });
}

/**
 * Credit a customer wallet FROM a named counter-account. Idempotent on
 * `reference` (statement row and journal entry both unique).
 */
export async function creditNational(tx, params) {
  const existing = await tx.ledgerEntry.findUnique({ where: { reference: params.reference } });
  if (existing) return existing;

  const { walletId, userId, amount, reference, ledger, from, kind, actor, authorization } = params;
  if (!from) throw new Error('creditNational requires a counter-account (from)');
  const to = await customerByWallet(tx, walletId);
  await move(tx, {
    from,
    to,
    amount,
    reference,
    kind: kind ?? ledger.type,
    actor: actor ?? { type: 'system', id: 'credit' },
    authorization: authorization ?? 'system_credit',
  });
  return statementRow(tx, { walletId, userId, ledger, amount, reference });
}

/**
 * Run a money-moving callback inside a database transaction.
 * Integration tests share one local Prisma dev DB — allow a longer window under load.
 */
export async function runMoneyTransaction(db, fn) {
  const timeout = process.env.NODE_ENV === 'test' ? 60_000 : 15_000;
  const maxWait = process.env.NODE_ENV === 'test' ? 15_000 : 5_000;
  // Already inside a transaction (an interactive tx client has no
  // $transaction): join it instead of crashing — atomicity is the caller's.
  if (typeof db.$transaction !== 'function') return fn(db);
  return db.$transaction(fn, { maxWait, timeout });
}

export function isMoneyError(error) {
  return (
    error instanceof InsufficientFundsError ||
    error instanceof WalletNotFoundError ||
    error instanceof LedgerConflictError ||
    error instanceof LedgerAuthorizationError
  );
}

export function moneyErrorStatus(error) {
  if (error instanceof InsufficientFundsError) return 400;
  if (error instanceof WalletNotFoundError) return 400;
  if (error instanceof LedgerConflictError) return 409;
  if (error instanceof LedgerAuthorizationError) return 403;
  return 500;
}
