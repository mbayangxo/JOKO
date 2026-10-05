import { InsufficientFundsError, LedgerInvariantError } from './errors.js';
import { KRI, pegFor, resolveBusiness as resolveBusinessRaw, resolveCustomer as resolveCustomerRaw, resolveCustomerByWallet as resolveByWalletRaw, specs } from './accounts.js';
import { ensureAccount, post, postOpening } from './ledger.js';

/**
 * Business recipes (docs/JOKKO-J2-DESIGN.md §3). Each is ONE balanced journal
 * entry identified by a deterministic business reference.
 */

const opts = { postOpening };
export const customer = (tx, userId) => resolveCustomerRaw(tx, userId, opts);
export const customerByWallet = (tx, walletId) => resolveByWalletRaw(tx, walletId, opts);
export const customerHeld = (tx, userId) => ensureAccount(tx, specs.customerHeld(userId));
export const business = (tx, businessId) => resolveBusinessRaw(tx, businessId, opts);
export const account = (tx, specName, ...args) => {
  const spec = specs[specName];
  if (!spec) throw new LedgerInvariantError(`Unknown account spec ${specName}`);
  return ensureAccount(tx, spec(...args));
};

/** Value moves between two liability accounts (customer, business, pot, escrow, voucher, fund…). */
export async function move(tx, { from, to, amount, reference, kind, actor, authorization, reason, metadata, externalOperationId, reversesId }) {
  if (from.currency !== to.currency) throw new LedgerInvariantError('move() needs one currency');
  if (from.id === to.id) throw new LedgerInvariantError('move() between the same account', 'self_move');
  // Value leaves `from` and lands in `to`. Debit the source / credit the
  // destination — except between two asset (debit-normal) accounts, where the
  // asset that loses value is credited and the one that gains is debited.
  const bothAssets = from.normalSide === 'debit' && to.normalSide === 'debit';
  return post(tx, {
    reference, kind, actor, authorization, reason, metadata, externalOperationId, reversesId,
    lines: [
      { account: from, side: bothAssets ? 'credit' : 'debit', amount },
      { account: to, side: bothAssets ? 'debit' : 'credit', amount },
    ],
  });
}

/** Customer → customer (P2P, merchant pay to owner wallet, tickets, jekkal…). */
export async function customerToCustomer(tx, { fromUserId, toUserId, amount, reference, kind, actor, authorization, metadata }) {
  const from = await customer(tx, fromUserId);
  const to = await customer(tx, toUserId);
  return move(tx, { from, to, amount, reference, kind, actor: actor ?? { type: 'user', id: fromUserId }, authorization, metadata });
}

// ---------------------------------------------------------------------------
// External boundary: cash-in / cash-out through providers (peg bridge)
// ---------------------------------------------------------------------------

/** Split an external amount into ₭ at the peg plus a sub-₭ residue (booked as rounding revenue). */
export function splitAtPeg(amountMinor, currency) {
  const peg = pegFor(currency);
  const kori = Math.floor(amountMinor / peg);
  return { peg, kori, converted: kori * peg, residue: amountMinor - kori * peg };
}

/**
 * Provider-confirmed collection: the provider owes us `amountMinor` (clearing),
 * the customer is credited the ₭ equivalent. `to` defaults to the user's wallet.
 */
export async function cashInConfirmed(tx, { provider, currency, amountMinor, userId, to, reference, externalOperationId, actor, metadata }) {
  const { kori, converted, residue } = splitAtPeg(amountMinor, currency);
  const target = to ?? (await customer(tx, userId));
  const clearing = await account(tx, 'providerClearingIn', provider, currency);
  const convExt = await account(tx, 'conversionExternal', currency);
  const convKri = await account(tx, 'conversionKori', currency);
  const lines = [{ account: clearing, side: 'debit', amount: amountMinor }];
  if (converted > 0) lines.push({ account: convExt, side: 'credit', amount: converted });
  if (residue > 0) lines.push({ account: await account(tx, 'revenue', 'rounding', currency), side: 'credit', amount: residue });
  if (kori > 0) {
    lines.push({ account: convKri, side: 'debit', amount: kori });
    lines.push({ account: target, side: 'credit', amount: kori });
  }
  const res = await post(tx, {
    reference,
    kind: 'cash_in_confirmed',
    lines,
    actor: actor ?? { type: 'provider', id: provider },
    authorization: 'provider_confirmed',
    externalOperationId,
    metadata,
  });
  return { ...res, kori, residue };
}

/** Provider statement shows the collected funds landed in our account. */
export async function cashInSettled(tx, { provider, currency, amountMinor, reference, externalOperationId }) {
  return post(tx, {
    reference,
    kind: 'cash_in_settled',
    actor: { type: 'job', id: 'reconciliation' },
    externalOperationId,
    lines: [
      { account: await account(tx, 'providerSettlement', provider, currency), side: 'debit', amount: amountMinor },
      { account: await account(tx, 'providerClearingIn', provider, currency), side: 'credit', amount: amountMinor },
    ],
  });
}

/** Cash-out authorized: move ₭ from spendable to held (not spendable, still the customer's). */
export async function cashOutHold(tx, { userId, from, amountKori, reference, actor, externalOperationId, authorization }) {
  const avail = from ?? (await customer(tx, userId));
  const held = await customerHeld(tx, from ? from.ownerId : userId);
  return move(tx, {
    from: avail,
    to: held,
    amount: amountKori,
    reference,
    kind: 'cash_out_hold',
    actor: actor ?? { type: 'user', id: userId },
    authorization,
    externalOperationId,
  });
}

/** Cash-out failed/cancelled before confirmation: release the hold once. */
export async function cashOutRelease(tx, { userId, ownerId, amountKori, reference, externalOperationId, reason }) {
  const uid = ownerId ?? userId;
  const held = await customerHeld(tx, uid);
  const avail = await customer(tx, uid);
  return move(tx, {
    from: held,
    to: avail,
    amount: amountKori,
    reference,
    kind: 'cash_out_release',
    actor: { type: 'system', id: 'cash_out' },
    authorization: 'provider_failure_release',
    reason,
    externalOperationId,
  });
}

/**
 * Provider confirmed the payout: ₭ retired from the customer's held funds;
 * we now owe the provider the net amount it paid (clearing_out); fee is revenue.
 */
export async function cashOutConfirmed(tx, { userId, ownerId, provider, currency, amountKori, feeMinor = 0, reference, externalOperationId }) {
  const uid = ownerId ?? userId;
  const peg = pegFor(currency);
  const gross = amountKori * peg;
  const net = gross - feeMinor;
  if (net < 0) throw new LedgerInvariantError('fee exceeds payout');
  const lines = [
    { account: await customerHeld(tx, uid), side: 'debit', amount: amountKori },
    { account: await account(tx, 'conversionKori', currency), side: 'credit', amount: amountKori },
    { account: await account(tx, 'conversionExternal', currency), side: 'debit', amount: gross },
  ];
  if (net > 0) lines.push({ account: await account(tx, 'providerClearingOut', provider, currency), side: 'credit', amount: net });
  if (feeMinor > 0) lines.push({ account: await account(tx, 'revenue', 'cash_out', currency), side: 'credit', amount: feeMinor });
  return post(tx, {
    reference,
    kind: 'cash_out_confirmed',
    lines,
    actor: { type: 'provider', id: provider },
    authorization: 'provider_confirmed',
    externalOperationId,
  });
}

/** Provider statement shows the payout deducted from our settlement account. */
export async function cashOutSettled(tx, { provider, currency, amountMinor, reference, externalOperationId }) {
  return post(tx, {
    reference,
    kind: 'cash_out_settled',
    actor: { type: 'job', id: 'reconciliation' },
    externalOperationId,
    lines: [
      { account: await account(tx, 'providerClearingOut', provider, currency), side: 'debit', amount: amountMinor },
      { account: await account(tx, 'providerSettlement', provider, currency), side: 'credit', amount: amountMinor },
    ],
  });
}

/**
 * Refund of a cash-out the LEGACY system already burned (no J2 hold exists).
 * The ₭ was destroyed outside the ledger, so restoring it is booked against
 * the migration account — visible in reconciliation, never hidden.
 */
export async function legacyCashOutRefund(tx, { userId, amountKori, reference }) {
  return post(tx, {
    reference,
    kind: 'legacy_cash_out_refund',
    actor: { type: 'system', id: 'cash_out' },
    authorization: 'provider_failure_release',
    lines: [
      { account: await account(tx, 'migrationOpening', KRI), side: 'debit', amount: amountKori },
      { account: await customer(tx, userId), side: 'credit', amount: amountKori },
    ],
  });
}

// ---------------------------------------------------------------------------
// Agents (float is XOF owed to the agent)
// ---------------------------------------------------------------------------


/** Agent float history row, written with the posting so the two can never diverge (I15). */
async function floatEntry(tx, agentId, { type, amountXof, reference, note, depositId, withdrawalId, adminId }) {
  const agent = await tx.agentProfile.findUniqueOrThrow({ where: { id: agentId }, select: { floatBalance: true } });
  return tx.agentFloatEntry.create({
    data: { agentId, type, amountXof, balanceAfter: agent.floatBalance, reference, note: note ?? null, depositId: depositId ?? null, withdrawalId: withdrawalId ?? null, adminId: adminId ?? null },
  });
}

/** User handed cash to the agent: agent float (XOF) → ₭ in the user's wallet. */
export async function agentCashIn(tx, { agentId, userId, amountMinor, currency = 'XOF', reference, agentUserId, history }) {
  const { kori, converted, residue } = splitAtPeg(amountMinor, currency);
  const lines = [{ account: await account(tx, 'agentFloat', agentId, currency), side: 'debit', amount: amountMinor }];
  if (converted > 0) lines.push({ account: await account(tx, 'conversionExternal', currency), side: 'credit', amount: converted });
  if (residue > 0) lines.push({ account: await account(tx, 'revenue', 'rounding', currency), side: 'credit', amount: residue });
  if (kori > 0) {
    lines.push({ account: await account(tx, 'conversionKori', currency), side: 'debit', amount: kori });
    lines.push({ account: await customer(tx, userId), side: 'credit', amount: kori });
  }
  const res = await post(tx, {
    reference,
    kind: 'agent_cash_in',
    lines,
    actor: { type: 'user', id: agentUserId ?? agentId },
    authorization: 'agent_attested_cash',
  });
  if (!res.replayed) await floatEntry(tx, agentId, { type: 'deposit_payout', amountXof: -amountMinor, reference: `${reference}-FLOAT`, ...history });
  return { ...res, kori };
}

/** Agent paid cash to the user: ₭ leaves the user's wallet, agent float (XOF) grows. */
export async function agentCashOut(tx, { agentId, userId, amountKori, currency = 'XOF', reference, actor, authorization, history }) {
  const peg = pegFor(currency);
  const res = await post(tx, {
    reference,
    kind: 'agent_cash_out',
    actor: actor ?? { type: 'user', id: userId },
    authorization,
    lines: [
      { account: await customer(tx, userId), side: 'debit', amount: amountKori },
      { account: await account(tx, 'conversionKori', currency), side: 'credit', amount: amountKori },
      { account: await account(tx, 'conversionExternal', currency), side: 'debit', amount: amountKori * peg },
      { account: await account(tx, 'agentFloat', agentId, currency), side: 'credit', amount: amountKori * peg },
    ],
  });
  if (!res.replayed) await floatEntry(tx, agentId, { type: 'withdraw_collect', amountXof: amountKori * peg, reference: `${reference}-FLOAT`, ...history });
  return res;
}

// ---------------------------------------------------------------------------
// J6 cash network: holds, completions, releases, commissions
// ---------------------------------------------------------------------------

/** Cash-in bound to an agent: reserve the agent's e-float (still owed to the agent). */
export async function agentFloatHold(tx, { agentId, amountMinor, currency = 'XOF', reference, actor }) {
  const res = await move(tx, {
    from: await account(tx, 'agentFloat', agentId, currency),
    to: await account(tx, 'agentFloatHeld', agentId, currency),
    amount: amountMinor, reference, kind: 'agent_float_hold', actor, authorization: 'agent_bound_cash_in',
  });
  // Available float history (I15): the reservation leaves the available float.
  if (!res.replayed) await floatEntry(tx, agentId, { type: 'cash_in_hold', amountXof: -amountMinor, reference: `${reference}-FLOAT`, note: 'Réservé (dépôt en cours)' });
  return res;
}

/** Bound cash-in cancelled / declined / expired: the reserved e-float returns, once. */
export async function agentFloatRelease(tx, { agentId, amountMinor, currency = 'XOF', reference, actor, reason }) {
  const res = await move(tx, {
    from: await account(tx, 'agentFloatHeld', agentId, currency),
    to: await account(tx, 'agentFloat', agentId, currency),
    amount: amountMinor, reference, kind: 'agent_float_release', actor, reason, authorization: 'cash_in_not_completed',
  });
  if (!res.replayed) await floatEntry(tx, agentId, { type: 'cash_in_release', amountXof: amountMinor, reference: `${reference}-FLOAT`, note: 'Réservation libérée' });
  return res;
}

/** Completed cash-in: the reserved e-float → ₭ in the customer's wallet (peg bridge). */
export async function agentCashInFromHeld(tx, { agentId, userId, amountMinor, currency = 'XOF', reference, actor, authorization, metadata }) {
  const { kori, converted, residue } = splitAtPeg(amountMinor, currency);
  const lines = [{ account: await account(tx, 'agentFloatHeld', agentId, currency), side: 'debit', amount: amountMinor }];
  if (converted > 0) lines.push({ account: await account(tx, 'conversionExternal', currency), side: 'credit', amount: converted });
  if (residue > 0) lines.push({ account: await account(tx, 'revenue', 'rounding', currency), side: 'credit', amount: residue });
  if (kori > 0) {
    lines.push({ account: await account(tx, 'conversionKori', currency), side: 'debit', amount: kori });
    lines.push({ account: await customer(tx, userId), side: 'credit', amount: kori });
  }
  // The available float already moved at the hold (its entry is there); the held float is consumed here.
  const res = await post(tx, { reference, kind: 'agent_cash_in', lines, actor, authorization, metadata });
  return { ...res, kori };
}

/** Completed cash-out: the customer's held ₭ leave the loop as cash; the agent's e-float grows by the peg value. */
export async function agentCashOutFromHeld(tx, { agentId, userId, amountKori, currency = 'XOF', reference, actor, authorization, metadata }) {
  const peg = pegFor(currency);
  const res = await post(tx, {
    reference, kind: 'agent_cash_out', actor, authorization, metadata,
    lines: [
      { account: await customerHeld(tx, userId), side: 'debit', amount: amountKori },
      { account: await account(tx, 'conversionKori', currency), side: 'credit', amount: amountKori },
      { account: await account(tx, 'conversionExternal', currency), side: 'debit', amount: amountKori * peg },
      { account: await account(tx, 'agentFloat', agentId, currency), side: 'credit', amount: amountKori * peg },
    ],
  });
  if (!res.replayed) await floatEntry(tx, agentId, { type: 'withdraw_collect', amountXof: amountKori * peg, reference: `${reference}-FLOAT`, note: 'Cash-out' });
  return res;
}

/**
 * J6.7: accrue a commission from the FUNDED budget. Returns 0 (nothing
 * accrued, nothing minted) when the budget cannot cover it.
 */
export async function agentCommissionAccrue(tx, { agentId, amountKori, reference, txId }) {
  if (!amountKori || amountKori <= 0) return 0;
  const budget = await account(tx, 'agentCommissionBudget');
  const fresh = await tx.ledgerAccount.findUnique({ where: { id: budget.id } });
  if (Number(fresh.balance) < amountKori) return 0;
  await move(tx, {
    from: budget, to: await account(tx, 'agentCommission', agentId), amount: amountKori, reference,
    kind: 'agent_commission_accrual', actor: { type: 'system', id: 'commission' }, authorization: 'commission_rule', metadata: { txId },
  });
  return amountKori;
}

/** Commission owed → the agent's own wallet. */
export async function agentCommissionSettle(tx, { agentId, agentUserId, amountKori, reference, actor }) {
  return move(tx, {
    from: await account(tx, 'agentCommission', agentId), to: await customer(tx, agentUserId), amount: amountKori, reference,
    kind: 'agent_commission_settlement', actor, authorization: 'commission_settlement',
  });
}

/** Legitimate clawback of an unsettled commission back to the budget. */
export async function agentCommissionClawback(tx, { agentId, amountKori, reference, actor, reason }) {
  return move(tx, {
    from: await account(tx, 'agentCommission', agentId), to: await account(tx, 'agentCommissionBudget'), amount: amountKori, reference,
    kind: 'agent_commission_clawback', actor, reason, authorization: 'commission_clawback',
  });
}

/** Admin attests the agent's cash payment for float (TOTP-gated upstream). */
export async function agentFloatTopUp(tx, { agentId, amountMinor, currency = 'XOF', reference, adminId, office = 'office', note }) {
  const res = await post(tx, {
    reference,
    kind: 'agent_float_topup',
    actor: { type: 'admin', id: adminId ?? null },
    authorization: 'admin_attested_cash',
    lines: [
      { account: await account(tx, 'cashOffice', office, currency), side: 'debit', amount: amountMinor },
      { account: await account(tx, 'agentFloat', agentId, currency), side: 'credit', amount: amountMinor },
    ],
  });
  if (!res.replayed) await floatEntry(tx, agentId, { type: 'top_up', amountXof: amountMinor, reference: `${reference}-FLOAT`, note: note ?? 'Recharge float', adminId });
  return res;
}

// ---------------------------------------------------------------------------
// Rewards & budgets — never value from nothing
// ---------------------------------------------------------------------------

/**
 * Pay a reward from the funded incentive budget. If the budget can't cover it,
 * the reward is NOT paid (returns 0) — no mint, no overdraft.
 */
export async function reward(tx, { userId, amount, reference, rewardType }) {
  if (!amount || amount <= 0) return 0;
  const pool = await account(tx, 'incentivesFunded');
  const fresh = await tx.ledgerAccount.findUnique({ where: { id: pool.id } });
  if (Number(fresh.balance) < amount) return 0;
  try {
    await move(tx, {
      from: pool,
      to: await customer(tx, userId),
      amount,
      reference,
      kind: 'reward',
      actor: { type: 'system', id: 'incentives' },
      metadata: { rewardType },
    });
    return amount;
  } catch (error) {
    if (error instanceof InsufficientFundsError) return 0;
    throw error;
  }
}

/** Fund the incentive (or support-refund) budget with real money from the treasury. */
export async function fundBudget(tx, { budget = 'incentivesFunded', amountKori, currency = 'XOF', reference, adminId }) {
  const peg = pegFor(currency);
  return post(tx, {
    reference,
    kind: 'budget_funding',
    actor: { type: 'admin', id: adminId ?? null },
    authorization: 'treasury_funding',
    lines: [
      { account: await account(tx, 'treasury', currency), side: 'debit', amount: amountKori * peg },
      { account: await account(tx, 'conversionExternal', currency), side: 'credit', amount: amountKori * peg },
      { account: await account(tx, 'conversionKori', currency), side: 'debit', amount: amountKori },
      { account: await account(tx, budget), side: 'credit', amount: amountKori },
    ],
  });
}

/** Non-production test funding (the kernel refuses the faucet in production). */
export async function testFund(tx, { userId, to, amount, reference }) {
  const target = to ?? (await customer(tx, userId));
  if (target.normalSide !== 'credit') throw new LedgerInvariantError('testFund targets liability accounts only');
  return post(tx, {
    reference,
    kind: 'test_funding',
    actor: { type: 'system', id: 'test' },
    lines: [
      { account: await account(tx, 'testFaucet'), side: 'debit', amount },
      { account: target, side: 'credit', amount },
    ],
  });
}

export { KRI };
