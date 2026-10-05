import { requestContext } from '../request-context.js';
import { createHash } from 'node:crypto';
import { isProduction } from '../runtime-safety.js';
import {
  InsufficientFundsError,
  LedgerAuthorizationError,
  LedgerConflictError,
  LedgerInvariantError,
} from './errors.js';
import { ensureAccount as ensureAccountRaw, specs } from './accounts.js';

/**
 * Money Kernel core: the ONLY way value moves.
 *
 *   post(tx, { reference, kind, lines, actor, authorization?, reason?, metadata?,
 *              externalOperationId?, reversesId? })
 *
 * - `lines`: [{ account, side: 'debit'|'credit', amount }] with ledger account rows.
 * - Exactly-once per `reference`: replay of the same postings returns the
 *   existing entry; a different payload under the same reference throws
 *   LedgerConflictError. Concurrent posts of one reference serialize on a
 *   transaction-scoped advisory lock.
 * - Accounts are locked FOR UPDATE in sorted id order (no deadlocks) and
 *   funds are checked before insert; the DB CHECK is the backstop.
 * - Balances/projections are written by the database trigger, never here.
 * - Debiting a customer's funds requires that customer as actor or an explicit
 *   authorization basis (consent, escrow rule, provider confirmation, admin
 *   dual approval…).
 */

const CUSTOMER_TYPES = new Set(['customer_available', 'customer_held']);

export const toNumber = (v) => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  if (!Number.isSafeInteger(n)) throw new LedgerInvariantError(`Unsafe money value ${v}`);
  return n;
};

function canonicalHash(kind, lines) {
  const rows = lines
    .map((l) => `${l.account.code}|${l.side}|${l.amount}|${l.account.currency}`)
    .sort();
  return createHash('sha256').update(`${kind}\n${rows.join('\n')}`).digest('hex');
}

function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) throw new LedgerInvariantError('An entry needs at least two postings');
  const net = new Map();
  for (const l of lines) {
    if (!l.account?.id) throw new LedgerInvariantError('Posting without a resolved account');
    if (l.side !== 'debit' && l.side !== 'credit') throw new LedgerInvariantError(`Bad side ${l.side}`);
    if (!Number.isSafeInteger(l.amount) || l.amount <= 0) {
      throw new LedgerInvariantError(`Posting amount must be a positive integer (got ${l.amount})`, 'bad_amount');
    }
    const cur = l.account.currency;
    net.set(cur, (net.get(cur) ?? 0) + (l.side === 'debit' ? l.amount : -l.amount));
  }
  for (const [cur, n] of net) {
    if (n !== 0) throw new LedgerInvariantError(`Entry does not balance in ${cur} (net ${n})`, 'unbalanced');
  }
}

function assertAuthorized(lines, actor, authorization) {
  for (const l of lines) {
    const t = l.account.type;
    if (!CUSTOMER_TYPES.has(t)) continue;
    const decreases = l.side !== l.account.normalSide;
    if (!decreases) continue;
    const owner = l.account.ownerId;
    if (actor?.type === 'user' && actor.id === owner) continue;
    if (authorization) continue;
    throw new LedgerAuthorizationError(`Debit of ${l.account.code} needs the owner or an authorization basis`);
  }
}

/** Lock accounts and verify no non-negative account would go below zero. */
async function lockAndCheckFunds(tx, lines) {
  const ids = [...new Set(lines.map((l) => l.account.id))].sort();
  const locked = new Map();
  for (const id of ids) {
    const rows = await tx.$queryRaw`
      SELECT "id","code","balance","allowNegative","normalSide","status","type","currency","ownerId"
      FROM "LedgerAccount" WHERE "id" = ${id} FOR UPDATE`;
    if (!rows[0]) throw new LedgerInvariantError(`Account ${id} vanished`);
    locked.set(id, rows[0]);
  }
  const delta = new Map();
  for (const l of lines) {
    const acc = locked.get(l.account.id);
    const d = l.side === acc.normalSide ? l.amount : -l.amount;
    delta.set(acc.id, (delta.get(acc.id) ?? 0) + d);
  }
  for (const [id, d] of delta) {
    const acc = locked.get(id);
    if (acc.status !== 'active') throw new LedgerInvariantError(`Account ${acc.code} is ${acc.status}`, 'account_frozen');
    const after = toNumber(acc.balance) + d;
    if (!acc.allowNegative && after < 0) {
      throw new InsufficientFundsError(
        CUSTOMER_TYPES.has(acc.type) || acc.type === 'business_wallet' ? 'Insufficient Kori balance' : `Insufficient balance in ${acc.type}`,
        { account: acc.code, balance: toNumber(acc.balance), needed: -d },
      );
    }
  }
}

export async function post(tx, params) {
  const {
    reference,
    kind,
    lines,
    actor,
    authorization,
    reason,
    metadata,
    externalOperationId,
    reversesId,
  } = params;
  if (!reference || !kind) throw new LedgerInvariantError('reference and kind are required');
  if (!actor?.type) throw new LedgerInvariantError('actor is required');
  validateLines(lines);
  if (isProduction() && lines.some((l) => l.account.type === 'test_faucet')) {
    throw new LedgerInvariantError('test faucet is never available in production', 'faucet_forbidden');
  }
  assertAuthorized(lines, actor, authorization);

  const payloadHash = canonicalHash(kind, lines);

  // Serialize concurrent posts of the same business reference.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`j2:${reference}`}, 0))`;
  const existing = await tx.journalEntry.findUnique({ where: { reference } });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new LedgerConflictError(reference);
    return { entry: existing, replayed: true };
  }

  await lockAndCheckFunds(tx, lines);

  const entry = await tx.journalEntry.create({
    data: {
      reference,
      kind,
      payloadHash,
      reversesId: reversesId ?? null,
      externalOperationId: externalOperationId ?? null,
      actorType: actor.type,
      actorId: actor.id ?? null,
      reason: reason ?? null,
      metadata: {
        ...(metadata ?? {}),
        ...(authorization ? { authorization } : {}),
        ...(requestContext()?.clientKey ? { clientKey: requestContext().clientKey } : {}),
      },
    },
  });
  await tx.posting.createMany({
    data: lines.map((l) => ({
      entryId: entry.id,
      accountId: l.account.id,
      side: l.side,
      amount: BigInt(l.amount),
      currency: l.account.currency,
    })),
  });
  return { entry, replayed: false };
}

/** Opening balance from the legacy system (explicit provenance, never invented history). */
export async function postOpening(tx, account, value) {
  const opening = await ensureAccountRaw(tx, specs.migrationOpening(account.currency));
  const credit = account.normalSide === 'credit';
  return post(tx, {
    reference: `opening:${account.code}`,
    kind: 'opening_balance',
    actor: { type: 'migration' },
    authorization: 'legacy_snapshot',
    reason: 'Opening balance from legacy balance column (J2 migration)',
    metadata: { legacy: { table: account.projTable ?? account.type, id: account.projId ?? account.ownerId, value }, snapshotAt: new Date().toISOString() },
    lines: credit
      ? [
          { account: opening, side: 'debit', amount: value },
          { account, side: 'credit', amount: value },
        ]
      : [
          { account, side: 'debit', amount: value },
          { account: opening, side: 'credit', amount: value },
        ],
  });
}

/** Resolve/create an account; projection accounts get their legacy opening balance. */
export function ensureAccount(tx, spec) {
  return ensureAccountRaw(tx, spec, { postOpening });
}

/** Move `amount` out of `from` into `to` (both liability/credit-normal accounts of the same currency). */
export function transfer(tx, { from, to, amount, ...rest }) {
  if (from.normalSide !== to.normalSide) {
    throw new LedgerInvariantError('transfer() needs two accounts of the same normal side; post explicit lines instead');
  }
  return post(tx, {
    ...rest,
    lines: [
      { account: from, side: from.normalSide === 'credit' ? 'debit' : 'credit', amount },
      { account: to, side: to.normalSide === 'credit' ? 'credit' : 'debit', amount },
    ],
  });
}

/**
 * Compensating entry: exact inverse of `entryId`, linked by `reversesId`
 * (unique → at most one reversal). Never edits or deletes the original.
 */
export async function reverse(tx, entryId, { reference, reason, actor, authorization, kind = 'reversal' }) {
  const original = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { postings: { include: { account: true } } } });
  if (!original) throw new LedgerInvariantError(`Entry ${entryId} not found`);
  if (original.reversesId) throw new LedgerInvariantError('A reversal cannot itself be reversed', 'reversal_of_reversal');
  return post(tx, {
    reference: reference ?? `reversal:${original.reference}`,
    kind,
    actor,
    authorization,
    reason,
    reversesId: original.id,
    metadata: { originalReference: original.reference },
    lines: original.postings.map((p) => ({
      account: p.account,
      side: p.side === 'debit' ? 'credit' : 'debit',
      amount: toNumber(p.amount),
    })),
  });
}

export async function balanceOf(tx, code) {
  const acc = await tx.ledgerAccount.findUnique({ where: { code } });
  return acc ? toNumber(acc.balance) : 0;
}
