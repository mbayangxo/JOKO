import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { reference as makeRef } from '../../api/_lib/auth.js';
import { lockProjections, runMoneyTransaction } from '../wallet-atomic.js';
import {
  agentCashInFromHeld,
  agentCashOutFromHeld,
  agentFloatHold,
  agentFloatRelease,
  cashOutHold,
  cashOutRelease,
  splitAtPeg,
} from '../money-kernel/flows.js';
import { InsufficientFundsError } from '../money-kernel/errors.js';
import { assertWalletWithinCaps, recordDailyCashOut } from '../tier-service.js';
import { requireOperatingAgent, normalizeStatus } from './lifecycle.js';
import { agentTransactionCap, assertAgentDaily, assertAmountShape, assertCustomerDaily, cashLimits } from './limits.js';
import { agentSideSignals } from './risk.js';

/**
 * J6.4–J6.6, J6.15 — the physical-cash state machine and secure handoff.
 *
 * CASH-IN  (customer gives cash, receives ₭)
 *   created ─scan→ agent_bound ─customer confirms→ customer_confirmed ─agent completes (PIN)→ completed
 *   · scan reserves the agent's e-float (agent:<id>:float → float_held)
 *   · the customer is credited ONLY by the agent's PIN-authorized completion,
 *     never because a screen says cash was handed over
 *
 * CASH-OUT (customer receives cash, gives ₭)
 *   funds_held ─scan→ agent_bound ─customer authorizes (PIN)→ customer_authorized ─agent completes (PIN)→ completed
 *   · creation (tier, limits, device, recovery, risk, step-up) HOLDS the ₭
 *     (customer available → held); nothing can spend them twice
 *   · the QR alone is worthless: the customer must authorize THIS agent and
 *     THIS amount on their own device (screenshot / forwarded-QR replay dies here)
 *
 * Terminal: completed | cancelled | declined | expired | released (every
 * non-completed exit releases the hold exactly once). needs_review: the
 * completion window passed after the customer committed — funds stay held,
 * nobody is paid twice, an operator pair resolves it. risk_hold: cash-out held
 * by the risk engine before any agent sees it.
 *
 * Handoff challenge: 144-bit random, only its SHA-256 is stored; the QR is
 * `jokko://cash/<token>` — no amount, name, phone or id. Single binding,
 * expiring, re-issuable (re-issue kills the old QR). The binding (tx, kind,
 * customer, agent, service point, amount, expiry) is hashed once and every
 * later step must present the same hash.
 */
export class CashError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'CashError';
    this.code = code;
    this.status = status;
  }
}

const OPEN_PRE_COMMIT = ['created', 'funds_held', 'agent_bound'];
const COMMITTED = ['customer_confirmed', 'customer_authorized'];
const TERMINAL = new Set(['completed', 'cancelled', 'declined', 'expired', 'released']);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const minutes = (n) => n * 60_000;

export const QR_PREFIX = 'jokko://cash/';
function newChallenge() {
  const token = crypto.randomBytes(18).toString('base64url');
  return { token, hash: sha(`cash:${token}`), qr: `${QR_PREFIX}${token}` };
}
export function tokenFromQr(qr) {
  const s = String(qr ?? '').trim();
  const m = /^jokko:\/\/cash\/([A-Za-z0-9_-]{24})$/.exec(s) ?? /^([A-Za-z0-9_-]{24})$/.exec(s);
  return m ? m[1] : null;
}
const bindingHashOf = (row, agentId, servicePointId) =>
  sha(`bind:${row.id}|${row.kind}|${row.customerId}|${agentId}|${servicePointId}|${row.amountXof}|${row.challengeExpiresAt.toISOString()}`);

async function event(tx, row, to, { actorType, actorId, note }) {
  await tx.agentCashEvent.create({ data: { txId: row.id, fromState: row.state, toState: to, actorType, actorId: actorId ?? null, note: note ? String(note).slice(0, 200) : null } });
}

async function setState(tx, row, to, actor, data = {}) {
  await event(tx, row, to, actor);
  return tx.agentCashTransaction.update({ where: { id: row.id }, data: { state: to, ...(TERMINAL.has(to) ? { terminalAt: new Date() } : {}), ...data } });
}

/** Lock in kernel order: ledger accounts + projection rows (wallet, agent), then the cash row. */
async function lockCash(tx, txId, { agentId } = {}) {
  const peek = await tx.agentCashTransaction.findUnique({ where: { id: txId }, select: { customerId: true, agentId: true } });
  if (!peek) throw new CashError('not_found', 'Opération introuvable', 404);
  const wallet = await tx.wallet.findUnique({ where: { userId: peek.customerId }, select: { id: true } });
  await lockProjections(tx, { Wallet: [wallet?.id], AgentProfile: [peek.agentId ?? agentId] });
  await tx.$executeRaw`SELECT id FROM "AgentCashTransaction" WHERE id = ${txId} FOR UPDATE`;
  return tx.agentCashTransaction.findUnique({ where: { id: txId } });
}

/** Undo the hold of a not-completed transaction (exactly once: deterministic reference). */
async function releaseHold(tx, row, actor, reason) {
  if (row.kind === 'cash_in') {
    if (!row.agentId) return; // nothing was reserved before binding
    const held = await tx.journalEntry.findUnique({ where: { reference: `${row.reference}-HOLD` } });
    if (!held) return;
    await agentFloatRelease(tx, { agentId: row.agentId, amountMinor: row.amountXof, reference: `${row.reference}-RELEASE`, actor, reason });
  } else {
    await cashOutRelease(tx, { userId: row.customerId, amountKori: row.amountKori, reference: `${row.reference}-RELEASE`, reason });
  }
}

// ── Customer: create ────────────────────────────────────────────────────────

async function idempotentExisting(customerId, idempotencyKey, kind, amountXof) {
  if (!idempotencyKey) return null;
  const row = await prisma.agentCashTransaction.findUnique({ where: { customerId_idempotencyKey: { customerId, idempotencyKey } } });
  if (!row) return null;
  if (row.kind !== kind || row.amountXof !== amountXof) throw new CashError('idempotency_conflict', 'Clé déjà utilisée pour une autre opération', 409);
  return row;
}

/** Cash-in intent. No money moves until an agent binds and then completes. */
export async function createCashIn(customerId, { amountXof, idempotencyKey, deviceId }) {
  assertAmountShape('cash_in', amountXof);
  const prior = await idempotentExisting(customerId, idempotencyKey, 'cash_in', amountXof);
  if (prior) return { row: prior, challenge: null, replayed: true };
  const user = await prisma.user.findUnique({ where: { id: customerId }, include: { wallet: true } });
  if (!user?.wallet) throw new CashError('wallet_missing', 'Portefeuille introuvable', 404);
  await assertCustomerDaily(prisma, customerId, 'cash_in', amountXof);
  await assertWalletWithinCaps(user, user.wallet, { incomingNational: amountXof });
  const ch = newChallenge();
  const { kori } = splitAtPeg(amountXof, 'XOF');
  try {
    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.agentCashTransaction.create({
        data: {
          reference: makeRef('JCI'), kind: 'cash_in', customerId, amountXof, amountKori: kori, state: 'created',
          challengeHash: ch.hash, challengeExpiresAt: new Date(Date.now() + minutes(cashLimits().challengeTtlMin)),
          idempotencyKey: idempotencyKey ?? null, customerDeviceId: deviceId ?? null,
        },
      });
      await tx.agentCashEvent.create({ data: { txId: r.id, fromState: null, toState: 'created', actorType: 'user', actorId: customerId } });
      return r;
    });
    return { row, challenge: ch };
  } catch (error) {
    if (error?.code === 'P2002' && idempotencyKey) {
      const again = await idempotentExisting(customerId, idempotencyKey, 'cash_in', amountXof);
      if (again) return { row: again, challenge: null, replayed: true };
    }
    throw error;
  }
}

/**
 * Cash-out request. Router policy already enforced CASH_OUT (risk deny/hold,
 * PIN step-up). Here: tier daily cap, J6 limits, then the ₭ are HELD in the
 * same transaction that creates the request. A risk `review` → risk_hold.
 */
export async function createCashOut(customerId, { amountXof, idempotencyKey, deviceId, riskReasons }) {
  assertAmountShape('cash_out', amountXof);
  const prior = await idempotentExisting(customerId, idempotencyKey, 'cash_out', amountXof);
  if (prior) return { row: prior, challenge: null, replayed: true };
  const user = await prisma.user.findUnique({ where: { id: customerId }, include: { wallet: true } });
  if (!user?.wallet) throw new CashError('wallet_missing', 'Portefeuille introuvable', 404);
  const { assertCanCashOut } = await import('../tier-service.js');
  await assertCanCashOut(prisma, user, amountXof);
  await assertCustomerDaily(prisma, customerId, 'cash_out', amountXof);
  const { kori, residue } = splitAtPeg(amountXof, 'XOF');
  if (residue) throw new CashError('amount_not_multiple', 'Montant en multiples de 10 FCFA', 400);
  const ch = newChallenge();
  const state = riskReasons?.length ? 'risk_hold' : 'funds_held';
  try {
    const row = await runMoneyTransaction(prisma, async (tx) => {
      await lockProjections(tx, { Wallet: [user.wallet.id] });
      const r = await tx.agentCashTransaction.create({
        data: {
          reference: makeRef('JCO'), kind: 'cash_out', customerId, amountXof, amountKori: kori, state,
          challengeHash: ch.hash, challengeExpiresAt: new Date(Date.now() + minutes(cashLimits().challengeTtlMin)),
          idempotencyKey: idempotencyKey ?? null, customerDeviceId: deviceId ?? null,
          riskReasons: riskReasons?.length ? JSON.stringify(riskReasons).slice(0, 1000) : null,
        },
      });
      await cashOutHold(tx, { userId: customerId, amountKori: kori, reference: `${r.reference}-HOLD`, actor: { type: 'user', id: customerId }, authorization: 'customer_cash_out_request' });
      await tx.agentCashEvent.create({ data: { txId: r.id, fromState: null, toState: state, actorType: 'user', actorId: customerId, note: state === 'risk_hold' ? 'risk review' : null } });
      return r;
    });
    return { row, challenge: state === 'funds_held' ? ch : null, riskHeld: state === 'risk_hold' };
  } catch (error) {
    if (error instanceof InsufficientFundsError) throw new CashError('insufficient_funds', 'Solde disponible insuffisant', 400);
    if (error?.code === 'P2002' && idempotencyKey) {
      const again = await idempotentExisting(customerId, idempotencyKey, 'cash_out', amountXof);
      if (again) return { row: again, challenge: null, replayed: true };
    }
    throw error;
  }
}

/** New QR for an un-bound transaction (app restarted, QR lost). The old QR stops working. */
export async function reissueChallenge(customerId, txId) {
  const ch = newChallenge();
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "AgentCashTransaction" WHERE id = ${txId} FOR UPDATE`;
    const r = await tx.agentCashTransaction.findUnique({ where: { id: txId } });
    if (!r || r.customerId !== customerId) throw new CashError('not_found', 'Opération introuvable', 404);
    if (!['created', 'funds_held'].includes(r.state) || r.agentId) throw new CashError('not_reissuable', 'Ce code ne peut plus être renouvelé');
    await event(tx, r, r.state, { actorType: 'user', actorId: customerId, note: 'challenge reissued' });
    return tx.agentCashTransaction.update({ where: { id: r.id }, data: { challengeHash: ch.hash, challengeExpiresAt: new Date(Date.now() + minutes(cashLimits().challengeTtlMin)) } });
  });
  return { row, challenge: ch };
}

// ── Agent: scan + bind ──────────────────────────────────────────────────────

async function noteScanFailure(agentId) {
  const key = `agent-scan:${agentId}`;
  const now = new Date();
  const row = await prisma.authThrottle.findUnique({ where: { key } });
  if (!row || now - row.windowStart > minutes(10)) {
    await prisma.authThrottle.upsert({ where: { key }, create: { key, failures: 1, windowStart: now }, update: { failures: 1, windowStart: now, blockedUntil: null } });
    return;
  }
  const failures = row.failures + 1;
  await prisma.authThrottle.update({ where: { key }, data: { failures, blockedUntil: failures >= cashLimits().maxScanFailures ? new Date(now.getTime() + minutes(10)) : row.blockedUntil } });
}
async function assertScanAllowed(agentId) {
  const row = await prisma.authThrottle.findUnique({ where: { key: `agent-scan:${agentId}` } });
  if (row?.blockedUntil && row.blockedUntil > new Date()) throw new CashError('scan_locked', 'Trop de codes invalides — réessaie dans quelques minutes', 429);
}

/**
 * The agent scans the customer's QR. Binds agent + service point once,
 * checks capacity / limits / self-dealing, and for a cash-in reserves the
 * agent's e-float. A second agent scanning the same QR is refused.
 */
export async function scanAndBind(agentUserId, { qr }) {
  const kindGuess = null;
  const { agent, servicePoint } = await requireOperatingAgent(prisma, agentUserId, kindGuess);
  await assertScanAllowed(agent.id);
  const token = tokenFromQr(qr);
  const row0 = token ? await prisma.agentCashTransaction.findUnique({ where: { challengeHash: sha(`cash:${token}`) } }) : null;
  if (!row0) {
    await noteScanFailure(agent.id);
    throw new CashError('invalid_code', 'Code invalide', 404);
  }
  await requireOperatingAgent(prisma, agentUserId, row0.kind); // service offered at this point
  if (row0.customerId === agent.userId) throw new CashError('self_service_refused', 'Un agent ne sert pas son propre compte', 403);

  const signals = await agentSideSignals(prisma, { agent, customerId: row0.customerId, kind: row0.kind });
  if (row0.kind === 'cash_out' && row0.state === 'funds_held' && !row0.agentId && signals.some((x) => x.severity === 'hold')) {
    // Circular cash at this point: the request stops in risk_hold (₭ stay reserved) for a risk operator.
    await runMoneyTransaction(prisma, async (tx) => {
      const row = await lockCash(tx, row0.id);
      if (row.state !== 'funds_held' || row.agentId) return;
      await setState(tx, row, 'risk_hold', { actorType: 'system', actorId: 'cash-risk', note: 'agent-side risk signal' }, { riskReasons: JSON.stringify(signals.map((x) => x.code)) });
    });
    throw new CashError('risk_review', 'Opération en vérification de sécurité — rien n’a été payé, l’argent du client reste réservé', 423);
  }
  try {
    return await runMoneyTransaction(prisma, async (tx) => {
      const row = await lockCash(tx, row0.id, { agentId: agent.id });
      if (row.agentId && row.agentId !== agent.id) throw new CashError('already_bound', 'Code déjà utilisé par un autre point', 409);
      if (row.agentId === agent.id) return row; // idempotent re-scan: the bound agent just sees the current state
      const expected = row.kind === 'cash_in' ? 'created' : 'funds_held';
      if (row.state !== expected) throw new CashError('not_bindable', TERMINAL.has(row.state) ? 'Opération terminée' : 'Opération déjà en cours', 409);
      if (row.challengeExpiresAt <= new Date()) throw new CashError('expired', 'Code expiré — le client doit en générer un nouveau', 409);

      const fresh = await tx.agentProfile.findUnique({ where: { id: agent.id } });
      if (normalizeStatus(fresh.status) !== 'active') throw new CashError('agent_inactive', 'Profil agent inactif', 403);
      if (row.amountXof > agentTransactionCap(fresh, row.kind)) throw new CashError('amount_too_high', 'Montant trop élevé pour ce point', 400);
      if (row.kind === 'cash_out' && row.amountXof > cashLimits().largeCashOutXof && fresh.tier !== 'business') {
        throw new CashError('business_agent_required', 'Gros retrait — agent business requis', 403);
      }
      await assertAgentDaily(tx, fresh, row.kind, row.amountXof);

      const bindingHash = bindingHashOf(row, agent.id, servicePoint.id);
      const deadline = new Date(Date.now() + minutes(cashLimits().completionWindowMin));
      if (row.kind === 'cash_in') {
        const customer = await tx.user.findUnique({ where: { id: row.customerId }, include: { wallet: true } });
        await assertWalletWithinCaps(customer, customer.wallet, { incomingNational: row.amountXof });
        // Reserve e-float; InsufficientFunds → insufficient_float. Never negative.
        await agentFloatHold(tx, { agentId: agent.id, amountMinor: row.amountXof, reference: `${row.reference}-HOLD`, actor: { type: 'user', id: agentUserId } });
      } else {
        // Capacity: the agent's e-float grows on cash-out and is capped by its limit,
        // counting other cash-outs already bound to this agent.
        const inflight = await tx.agentCashTransaction.aggregate({ where: { agentId: agent.id, kind: 'cash_out', state: { in: ['agent_bound', 'customer_authorized', 'needs_review'] } }, _sum: { amountXof: true } });
        if (fresh.floatBalance + (inflight._sum.amountXof ?? 0) + row.amountXof > fresh.floatLimit) throw new CashError('agent_capacity', 'Capacité du point insuffisante pour ce retrait', 409);
      }
      const riskCodes = signals.map((s) => s.code);
      return setState(tx, row, 'agent_bound', { actorType: 'agent', actorId: agent.id }, {
        agentId: agent.id, servicePointId: servicePoint.id, bindingHash, boundAt: new Date(), reviewDeadline: deadline,
        riskReasons: riskCodes.length ? JSON.stringify(riskCodes) : row.riskReasons,
      });
    });
  } catch (error) {
    if (error instanceof InsufficientFundsError) throw new CashError('insufficient_float', 'Float du point insuffisant', 409);
    throw error;
  }
}

// ── Customer: confirm (cash-in) / authorize (cash-out) / cancel ─────────────

export async function customerCommit(customerId, txId, { bindingHash }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const row = await lockCash(tx, txId);
    if (row.customerId !== customerId) throw new CashError('not_found', 'Opération introuvable', 404);
    const to = row.kind === 'cash_in' ? 'customer_confirmed' : 'customer_authorized';
    if (row.state === to) return row;
    if (row.state !== 'agent_bound') throw new CashError('not_committable', 'Aucun point de service n’a encore scanné ce code', 409);
    if (!bindingHash || bindingHash !== row.bindingHash) throw new CashError('binding_mismatch', 'Les détails ont changé — vérifie le point de service et le montant', 409);
    if (row.reviewDeadline && row.reviewDeadline <= new Date()) throw new CashError('expired', 'Délai dépassé', 409);
    const agent = await tx.agentProfile.findUnique({ where: { id: row.agentId } });
    if (normalizeStatus(agent.status) !== 'active') throw new CashError('agent_inactive', 'Ce point de service n’est plus actif', 409);
    return setState(tx, row, to, { actorType: 'user', actorId: customerId }, {
      customerConfirmedAt: new Date(), reviewDeadline: new Date(Date.now() + minutes(cashLimits().completionWindowMin)),
    });
  });
}

/** The customer may cancel until they have committed (confirmed handing / authorized receiving cash). */
export async function customerCancel(customerId, txId) {
  return runMoneyTransaction(prisma, async (tx) => {
    const row = await lockCash(tx, txId);
    if (row.customerId !== customerId) throw new CashError('not_found', 'Opération introuvable', 404);
    if (row.state === 'cancelled') return row;
    if (!OPEN_PRE_COMMIT.includes(row.state)) throw new CashError('not_cancellable', COMMITTED.includes(row.state) ? 'Déjà confirmé — le point de service doit finaliser ou refuser' : 'Opération terminée', 409);
    await releaseHold(tx, row, { type: 'user', id: customerId }, 'customer_cancelled');
    return setState(tx, row, 'cancelled', { actorType: 'user', actorId: customerId });
  });
}

// ── Agent: complete / decline ───────────────────────────────────────────────

/**
 * The agent completes after the physical handoff, with a PIN step-up
 * (enforced by the handler). One J2 posting; replay returns the same result.
 */
export async function agentComplete(agentUserId, txId, { bindingHash }) {
  const peek = await prisma.agentCashTransaction.findUnique({ where: { id: txId } });
  const agentRow = await prisma.agentProfile.findUnique({ where: { userId: agentUserId } });
  if (!peek || !agentRow || peek.agentId !== agentRow.id) throw new CashError('not_found', 'Opération introuvable', 404);
  if (peek.state === 'completed') return peek;
  await requireOperatingAgent(prisma, agentUserId, peek.kind); // suspended / terminated mid-flow → refused
  const { accrueCommission } = await import('./commission.js');
  return runMoneyTransaction(prisma, async (tx) => {
    const row = await lockCash(tx, txId);
    if (row.state === 'completed') return row;
    const ready = row.kind === 'cash_in' ? 'customer_confirmed' : 'customer_authorized';
    if (row.state !== ready && row.state !== 'needs_review') {
      throw new CashError('not_completable', row.state === 'agent_bound' ? 'Le client doit d’abord confirmer dans son application' : 'Opération non finalisable', 409);
    }
    if (row.state === 'needs_review' && !row.customerConfirmedAt) throw new CashError('not_completable', 'Opération non finalisable', 409);
    if (!bindingHash || bindingHash !== row.bindingHash) throw new CashError('binding_mismatch', 'Détails modifiés', 409);
    const fresh = await tx.agentProfile.findUnique({ where: { id: row.agentId } });
    if (normalizeStatus(fresh.status) !== 'active') throw new CashError('agent_inactive', 'Profil agent inactif', 403);
    await postCompletion(tx, row, { type: 'user', id: agentUserId }, row.kind === 'cash_in' ? 'agent_pin_cash_received' : 'customer_pin_and_agent_pin');
    const done = await setState(tx, row, 'completed', { actorType: 'agent', actorId: row.agentId }, { completedAt: new Date() });
    const commission = await accrueCommission(tx, done);
    return commission ? tx.agentCashTransaction.update({ where: { id: done.id }, data: { commissionKori: commission } }) : done;
  });
}

async function postCompletion(tx, row, actor, authorization) {
  const ref = `${row.reference}-COMPLETE`;
  const agent = await tx.agentProfile.findUnique({ where: { id: row.agentId } });
  const customer = await tx.user.findUnique({ where: { id: row.customerId }, include: { wallet: true } });
  if (row.kind === 'cash_in') {
    await assertWalletWithinCaps(customer, customer.wallet, { incomingNational: row.amountXof });
    const res = await agentCashInFromHeld(tx, { agentId: row.agentId, userId: row.customerId, amountMinor: row.amountXof, reference: ref, actor, authorization, metadata: { txId: row.id, servicePointId: row.servicePointId } });
    if (!res.replayed) {
      await tx.ledgerEntry.create({ data: { walletId: customer.wallet.id, userId: customer.id, type: 'cash_in', amount: res.kori, counterpartyName: agent.displayName, counterpartyHandle: agent.agentCode, note: `Dépôt agent ${agent.agentCode}`, reference: row.reference } });
      await tx.koriTransaction.create({ data: { recipientId: customer.id, amountKori: res.kori, transactionType: 'mint', reference: `${row.reference}-KORI`, note: `Agent ${agent.agentCode}` } });
    }
  } else {
    const res = await agentCashOutFromHeld(tx, { agentId: row.agentId, userId: row.customerId, amountKori: row.amountKori, reference: ref, actor, authorization, metadata: { txId: row.id, servicePointId: row.servicePointId } });
    if (!res.replayed) {
      await tx.ledgerEntry.create({ data: { walletId: customer.wallet.id, userId: customer.id, type: 'agent_withdraw', amount: -row.amountKori, counterpartyName: agent.displayName, counterpartyHandle: agent.agentCode, note: `Retrait agent ${agent.agentCode}`, reference: row.reference } });
      await recordDailyCashOut(tx, row.customerId, row.amountXof);
    }
  }
}

/** The agent refuses (no cash received / cannot pay out). The hold is released once. */
export async function agentDecline(agentUserId, txId, { reason } = {}) {
  const agentRow = await prisma.agentProfile.findUnique({ where: { userId: agentUserId } });
  return runMoneyTransaction(prisma, async (tx) => {
    const row = await lockCash(tx, txId);
    if (!agentRow || row.agentId !== agentRow.id) throw new CashError('not_found', 'Opération introuvable', 404);
    if (row.state === 'declined') return row;
    if (!['agent_bound', ...COMMITTED].includes(row.state)) throw new CashError('not_declinable', 'Opération non refusable', 409);
    await releaseHold(tx, row, { type: 'user', id: agentUserId }, 'agent_declined');
    return setState(tx, row, 'declined', { actorType: 'agent', actorId: row.agentId, note: reason ?? null }, { failureReason: String(reason ?? 'declined').slice(0, 200) });
  });
}

// ── Time: expiry / review (idempotent sweeper) ──────────────────────────────

/** Expire one transaction if its clock ran out. Pre-commit → expired + release; committed → needs_review. */
export async function applyClock(txId, now = new Date()) {
  return runMoneyTransaction(prisma, async (tx) => {
    const row = await lockCash(tx, txId);
    const unboundExpired = ['created', 'funds_held'].includes(row.state) && row.challengeExpiresAt <= now;
    const boundExpired = row.state === 'agent_bound' && row.reviewDeadline && row.reviewDeadline <= now;
    if (unboundExpired || boundExpired) {
      await releaseHold(tx, row, { type: 'system', id: 'cash-clock' }, 'expired');
      return setState(tx, row, 'expired', { actorType: 'system', actorId: 'cash-clock' });
    }
    if (COMMITTED.includes(row.state) && row.reviewDeadline && row.reviewDeadline <= now) {
      return setState(tx, row, 'needs_review', { actorType: 'system', actorId: 'cash-clock', note: 'completion window passed after customer commitment' });
    }
    return row;
  });
}

export async function sweepCash(now = new Date()) {
  const due = await prisma.agentCashTransaction.findMany({
    where: {
      OR: [
        { state: { in: ['created', 'funds_held'] }, challengeExpiresAt: { lte: now } },
        { state: { in: ['agent_bound', ...COMMITTED] }, reviewDeadline: { lte: now } },
      ],
    },
    select: { id: true },
    take: 500,
  });
  const out = { expired: 0, review: 0 };
  for (const { id } of due) {
    const r = await applyClock(id, now);
    if (r.state === 'expired') out.expired += 1;
    if (r.state === 'needs_review') out.review += 1;
  }
  return out;
}

/** Agent suspended / terminated: pre-commit transactions are declined (released); committed ones go to review. */
export async function closeOpenCashForAgent(agentId, { actorId, reason }) {
  const open = await prisma.agentCashTransaction.findMany({ where: { agentId, state: { in: ['agent_bound', ...COMMITTED] } }, select: { id: true } });
  for (const { id } of open) {
    await runMoneyTransaction(prisma, async (tx) => {
      const row = await lockCash(tx, id);
      if (row.state === 'agent_bound') {
        await releaseHold(tx, row, { type: 'admin', id: actorId }, reason);
        await setState(tx, row, 'declined', { actorType: 'admin', actorId, note: reason }, { failureReason: reason });
      } else if (COMMITTED.includes(row.state)) {
        await setState(tx, row, 'needs_review', { actorType: 'admin', actorId, note: reason });
      }
    });
  }
  return open.length;
}

// ── Operators: review resolution (maker-checker executes these) ─────────────

export async function resolveReviewInTx(tx, txId, { outcome, requestedBy, approvedBy, approvalId }) {
  const row = await lockCash(tx, txId);
  if (approvalId) {
    // A retried approval never acts twice.
    const done = await tx.agentCashEvent.findFirst({ where: { txId: row.id, note: { contains: `approval:${approvalId}` } } });
    if (done) return row;
  }
  if (row.state !== 'needs_review' && row.state !== 'risk_hold') throw new CashError('not_in_review', 'Opération non en revue', 409);
  const tag = approvalId ? ` approval:${approvalId}` : '';
  const actor = { type: 'admin', id: approvedBy };
  if (outcome === 'release') {
    await releaseHold(tx, row, actor, `review_release:${requestedBy}+${approvedBy}`);
    return setState(tx, row, 'released', { actorType: 'admin', actorId: approvedBy, note: `release (maker ${requestedBy})${tag}` });
  }
  if (outcome === 'resume' && row.state === 'risk_hold') {
    return setState(tx, row, 'funds_held', { actorType: 'admin', actorId: approvedBy, note: `risk cleared (maker ${requestedBy})${tag}` }, { challengeExpiresAt: new Date(Date.now() + minutes(cashLimits().challengeTtlMin)) });
  }
  if (outcome === 'complete' && row.state === 'needs_review' && row.customerConfirmedAt) {
    await postCompletion(tx, row, actor, `review_complete:${requestedBy}+${approvedBy}`);
    // A disputed transaction resolved by operators earns no commission (decision recorded for reconciliation).
    await tx.agentCommission.upsert({ where: { txId: row.id }, create: { agentId: row.agentId, txId: row.id, amountKori: 0, status: 'ineligible', ineligibleReason: 'resolved_by_review' }, update: {} });
    return setState(tx, row, 'completed', { actorType: 'admin', actorId: approvedBy, note: `completed on evidence (maker ${requestedBy})${tag}` }, { completedAt: new Date() });
  }
  throw new CashError('invalid_outcome', 'Issue non autorisée pour cet état', 400);
}

// ── Views (no internal ids of the other party, no phone, no balances) ───────

const STATUS = {
  created: 'pending', funds_held: 'pending', agent_bound: 'pending', customer_confirmed: 'checking', customer_authorized: 'checking',
  needs_review: 'checking', risk_hold: 'checking', completed: 'completed', cancelled: 'failed_cancelled', declined: 'failed_cancelled',
  expired: 'failed_cancelled', released: 'failed_cancelled',
};
const NEXT = {
  created: 'Montre ce code au point de service.',
  funds_held: 'Montant réservé. Montre ce code au point de service.',
  agent_bound: 'Vérifie le point de service et le montant, puis confirme dans l’application.',
  customer_confirmed: 'En attente de la finalisation par le point de service. Ne refais pas l’opération.',
  customer_authorized: 'En attente de la finalisation par le point de service. Ne refais pas l’opération.',
  needs_review: 'Vérification en cours par Jokko. Ne refais pas l’opération — ton argent est protégé.',
  risk_hold: 'Vérification de sécurité en cours. Ton argent reste réservé, rien n’est perdu.',
  completed: 'Opération terminée.',
  cancelled: 'Opération annulée. Aucun argent n’a été déplacé.',
  declined: 'Le point de service a refusé. Ton argent n’a pas bougé.',
  expired: 'Code expiré. Aucun argent n’a été déplacé.',
  released: 'Opération annulée après vérification. Ton argent t’a été rendu.',
};

export async function cashView(row, perspective) {
  const agent = row.agentId ? await prisma.agentProfile.findUnique({ where: { id: row.agentId }, select: { displayName: true, agentCode: true } }) : null;
  const sp = row.servicePointId ? await prisma.agentServicePoint.findUnique({ where: { id: row.servicePointId }, select: { name: true, publicAddress: true } }) : null;
  const base = {
    id: row.id, reference: row.reference, kind: row.kind, state: row.state, status: STATUS[row.state], nextStep: NEXT[row.state],
    amountXof: row.amountXof, amountKori: row.amountKori,
    bindingHash: ['agent_bound', ...COMMITTED].includes(row.state) ? row.bindingHash : undefined,
    challengeExpiresAt: row.challengeExpiresAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
  if (perspective === 'customer') {
    return { ...base, servicePoint: agent ? { agentName: agent.displayName, agentCode: agent.agentCode, name: sp?.name ?? null, publicAddress: sp?.publicAddress ?? null } : null };
  }
  const c = await prisma.user.findUnique({ where: { id: row.customerId }, select: { name: true, verificationTier: true } });
  const first = String(c?.name ?? '').trim().split(/\s+/);
  return {
    ...base,
    // Enough to recognise the person at the counter; no phone, id or balance.
    customer: { displayName: first[0] ? `${first[0]}${first[1] ? ` ${first[1][0]}.` : ''}` : 'Client', verified: (c?.verificationTier ?? 1) >= 2 },
    commissionKori: row.commissionKori,
  };
}

export function receiptOf(view) {
  if (view.state !== 'completed') return null;
  return { reference: view.reference, kind: view.kind, amountXof: view.amountXof, amountKori: view.amountKori, completedAt: view.completedAt, servicePoint: view.servicePoint ?? null };
}
