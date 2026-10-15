/**
 * J14-F1 — S4: partner-requested business-wallet debits (decision D-J14-1 option A, policy 2026-10-14).
 * DORMANT unless PARTNER_DEBIT_INSTRUCTIONS_ENABLED=true.
 *
 * A partner may only REQUEST a debit of a linked business's wallet (a payout, or a payroll batch). Nothing moves
 * until an authorized business financial approver (business.pay) approves THAT instruction inside Jokko:
 *   - fresh authentication (step-up) on the approval itself;
 *   - immutable request details: recipients are bound to account ids at request time, the whole instruction is
 *     hashed (detailsHash) and the approver must echo the hash of what they were shown; the row is
 *     DB-guarded against edits; a re-post with different details is refused;
 *   - 15-minute approval expiry;
 *   - recipient binding: a handle that changed owner in the last 30 days is refused at request time; at
 *     approval the bound accounts are re-checked (frozen / missing wallet → invalidated);
 *   - payroll batches expose EVERY recipient; any change to the roster (employee removed, re-pointed, moved)
 *     between request and approval invalidates the instruction — approval never applies to a changed batch;
 *   - risk checks: business active and still linked, approver is not a recipient, per-instruction and daily
 *     limits per business, sufficient balance (else nothing moves, status failed);
 *   - exactly-once: one money transaction for all lines, under the instruction lock, deterministic references
 *     (`pdi-<id>-<i>`), a decided instruction never changes state again (DB-guarded); an approval replay by the
 *     same approver returns the same result.
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { runMoneyTransaction, InsufficientFundsError } from '../wallet-atomic.js';
import { assertBusinessAuthorityInTx } from '../business-access.js';
import { emitCommerceEvent } from '../commerce/events.js';
import { pegFor } from '../money-kernel/accounts.js';

export const APPROVAL_WINDOW_MS = 15 * 60_000;
export const MAX_LINES = 200;
export const partnerDebitsEnabled = () => process.env.PARTNER_DEBIT_INSTRUCTIONS_ENABLED === 'true';
const envInt = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : dflt;
};
/**
 * J15 decision 1: PROVISIONAL LOCAL TEST LIMITS ONLY — NOT approved production limits. Expressed in XOF (the
 * business's national currency) and converted to ₭ through the ledger peg, so a peg change can never silently
 * move a limit: 500 000 XOF per line, 5 000 000 XOF per request, 10 000 000 XOF or 20 payments per business
 * per 24 h. Override (also provisional) with PARTNER_DEBIT_*_MAX_XOF / PARTNER_DEBIT_DAILY_MAX_COUNT.
 */
export const LIMITS_STATUS = 'provisional_local_test_limits';
const xofToKori = (xof) => Math.floor(xof / pegFor('XOF'));
export const LIMITS = {
  lineMaxXof: () => envInt('PARTNER_DEBIT_LINE_MAX_XOF', 500_000),
  instructionMaxXof: () => envInt('PARTNER_DEBIT_INSTRUCTION_MAX_XOF', 5_000_000),
  dailyMaxXof: () => envInt('PARTNER_DEBIT_DAILY_MAX_XOF', 10_000_000),
  dailyMaxCount: () => envInt('PARTNER_DEBIT_DAILY_MAX_COUNT', 20),
  lineMaxKori: () => xofToKori(LIMITS.lineMaxXof()),
  instructionMaxKori: () => xofToKori(LIMITS.instructionMaxXof()),
  dailyMaxKori: () => xofToKori(LIMITS.dailyMaxXof()),
};

export class PartnerDebitError extends Error {
  constructor(code, message, status = 409, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const REF_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const canonicalLines = (lines) => lines.map((l) => ({ i: l.i, recipientUserId: l.recipientUserId, employeeId: l.employeeId ?? null, amountKori: l.amountKori, reference: l.reference ?? null }));
export function computeDetailsHash(row) {
  const lines = typeof row.linesJson === 'string' ? JSON.parse(row.linesJson).lines : row.lines;
  const body = JSON.stringify({ id: row.id, partnerId: row.partnerId, businessId: row.businessId, kind: row.kind, totalKori: row.totalKori, lines: canonicalLines(lines) });
  return crypto.createHash('sha256').update(body).digest('hex');
}
const requestFingerprint = (b) => crypto.createHash('sha256').update(JSON.stringify({ k: b.kind, l: (b.lines ?? []).map((x) => [String(x.recipient_handle ?? '').toLowerCase().replace(/^@/, ''), x.amount_kori, x.reference ?? null]), m: b.memo ?? null })).digest('hex');

function partnerShape(r) {
  return { id: r.id, external_ref: r.externalRef, kind: r.kind, status: r.status, total_kori: r.totalKori, line_count: r.lineCount, expires_at: r.expiresAt.toISOString(), executed_at: r.executedAt?.toISOString() ?? null, failure_code: r.failureCode ?? null };
}

// ── Partner side ───────────────────────────────────────────────────────────────────────────────────────────

export async function createPartnerDebit(partnerId, body, db = prisma) {
  if (!partnerDebitsEnabled()) throw new PartnerDebitError('disabled', 'Partner debit instructions are not enabled', 403);
  const kind = body?.kind;
  if (!['payout', 'payroll_batch'].includes(kind)) throw new PartnerDebitError('invalid_kind', 'kind must be payout or payroll_batch', 400);
  const externalRef = String(body?.external_ref ?? '');
  if (!REF_RE.test(externalRef)) throw new PartnerDebitError('invalid', 'external_ref is required', 400);
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  if (!lines.length || lines.length > MAX_LINES || (kind === 'payout' && lines.length !== 1)) throw new PartnerDebitError('invalid_lines', kind === 'payout' ? 'A payout has exactly one line' : `1–${MAX_LINES} lines`, 400);
  for (const l of lines) {
    if (!l?.recipient_handle || !Number.isSafeInteger(l?.amount_kori) || l.amount_kori < 1 || l.amount_kori > LIMITS.lineMaxKori()) throw new PartnerDebitError('invalid_lines', `Each line needs recipient_handle and an integer amount_kori between 1 and ${LIMITS.lineMaxKori()} (${LIMITS.lineMaxXof()} XOF, provisional)`, 400);
    if (l.reference !== undefined && !REF_RE.test(String(l.reference))) throw new PartnerDebitError('invalid_lines', 'line reference malformed', 400);
  }
  const total = lines.reduce((s, l) => s + l.amount_kori, 0);
  if (total > LIMITS.instructionMaxKori()) throw new PartnerDebitError('limit_exceeded', `Instruction total above ${LIMITS.instructionMaxKori()} ₭ (${LIMITS.instructionMaxXof()} XOF, provisional)`, 422);
  const fp = requestFingerprint(body);

  // Idempotent on (partner, external_ref) — and IMMUTABLE: the same ref with different details is refused.
  const prior = await db.partnerDebitInstruction.findUnique({ where: { partnerId_externalRef: { partnerId, externalRef } } });
  if (prior) {
    if (JSON.parse(prior.linesJson).fp !== fp) throw new PartnerDebitError('instruction_immutable', 'This external_ref already names a different instruction — details can never change', 409);
    return { instruction: partnerShape(prior), created: false };
  }

  const biz = await db.externalLink.findUnique({ where: { system_objectType_externalId: { system: partnerId, objectType: 'business', externalId: String(body?.external_business_id ?? '') } } });
  if (!biz || biz.status !== 'active') throw new PartnerDebitError('business_not_linked', 'Business not linked', 404);
  const business = await db.business.findUnique({ where: { id: biz.jokkoId }, select: { id: true, status: true } });
  if (!business || business.status !== 'active') throw new PartnerDebitError('business_inactive', 'This business cannot be debited', 409);

  const { LEGACY_HANDLE_STABILITY_MS } = await import('../recipient-binding-policy.js');
  const resolved = [];
  const problems = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const handle = String(l.recipient_handle).replace(/^@/, '').trim().toLowerCase();
    const user = await db.user.findUnique({ where: { handle }, include: { wallet: true } });
    if (!user?.wallet) { problems.push({ i, handle, problem: 'recipient_not_found' }); continue; }
    if (user.frozenByAdminAt) { problems.push({ i, handle, problem: 'recipient_frozen' }); continue; }
    // Recipient binding: a recently re-assigned handle cannot be trusted to name who the partner meant.
    const released = await db.handleRelease.findFirst({ where: { handle, releasedAt: { gt: new Date(Date.now() - LEGACY_HANDLE_STABILITY_MS) } }, select: { id: true } });
    if (released) { problems.push({ i, handle, problem: 'recipient_unverifiable' }); continue; }
    let employeeId = null;
    if (kind === 'payroll_batch') {
      const emp = await db.payrollEmployee.findFirst({ where: { businessId: business.id, userId: user.id, status: 'active' }, select: { id: true } });
      if (!emp) { problems.push({ i, handle, problem: 'not_an_employee' }); continue; }
      employeeId = emp.id;
    }
    if (seen.has(user.id)) { problems.push({ i, handle, problem: 'duplicate_recipient' }); continue; }
    seen.add(user.id);
    resolved.push({ i, recipientUserId: user.id, employeeId, handleAtRequest: handle, amountKori: l.amount_kori, reference: l.reference ?? null });
  }
  if (problems.length) throw new PartnerDebitError('recipients_refused', 'Some recipients cannot be bound — nothing was requested', 422, { problems: problems.slice(0, 50) });

  const id = `pdi_${crypto.randomBytes(12).toString('hex')}`;
  const row = { id, partnerId, businessId: business.id, kind, totalKori: total, lines: resolved };
  try {
    const created = await db.partnerDebitInstruction.create({
      data: {
        id, partnerId, businessId: business.id, externalLinkId: biz.id, externalRef, kind,
        linesJson: JSON.stringify({ fp, lines: resolved }), lineCount: resolved.length, totalKori: total,
        detailsHash: computeDetailsHash(row), memo: body.memo ? String(body.memo).slice(0, 200) : null,
        expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS),
      },
    });
    await emitCommerceEvent(db, { type: 'debit_instruction.requested', businessId: business.id, aggregateType: 'partner_debit', aggregateId: id, payload: { status: 'requested', totalKori: total, externalRef } });
    return { instruction: partnerShape(created), created: true };
  } catch (e) {
    if (e?.code === 'P2002') return createPartnerDebit(partnerId, body, db); // concurrent identical create → the winner
    throw e;
  }
}
const linesOf = (row) => JSON.parse(row.linesJson).lines;
const hashOf = (row) => computeDetailsHash({ ...row, lines: linesOf(row), linesJson: undefined });

export async function getPartnerDebit(partnerId, id, db = prisma) {
  if (!partnerDebitsEnabled()) throw new PartnerDebitError('disabled', 'Partner debit instructions are not enabled', 403);
  const r = await expireIfDue(db, await db.partnerDebitInstruction.findUnique({ where: { id: String(id) } }));
  if (!r || r.partnerId !== partnerId) throw new PartnerDebitError('not_found', 'Instruction not found', 404);
  return partnerShape(r);
}

export async function cancelPartnerDebit(partnerId, id, db = prisma) {
  if (!partnerDebitsEnabled()) throw new PartnerDebitError('disabled', 'Partner debit instructions are not enabled', 403);
  return runMoneyTransaction(db, async (tx) => {
    const r = await lock(tx, id);
    if (!r || r.partnerId !== partnerId) throw new PartnerDebitError('not_found', 'Instruction not found', 404);
    if (r.status !== 'requested') return partnerShape(r);
    return partnerShape(await decide(tx, r, 'cancelled', { by: `partner:${partnerId}` }));
  });
}

// ── Business side (Jokko app) ──────────────────────────────────────────────────────────────────────────────

async function lock(tx, id) {
  await tx.$executeRaw`SELECT id FROM "PartnerDebitInstruction" WHERE id = ${String(id)} FOR UPDATE`;
  return tx.partnerDebitInstruction.findUnique({ where: { id: String(id) } });
}

async function decide(tx, r, status, { by = null, reason = null, failureCode = null, executedAt = null } = {}) {
  const u = await tx.partnerDebitInstruction.updateMany({
    where: { id: r.id, status: 'requested' },
    data: { status, decidedBy: by, decidedAt: new Date(), decisionReason: reason ? String(reason).slice(0, 300) : null, failureCode, executedAt },
  });
  if (u.count !== 1) throw new PartnerDebitError('conflict', 'The instruction changed meanwhile', 409);
  await emitCommerceEvent(tx, { type: `debit_instruction.${status}`, businessId: r.businessId, aggregateType: 'partner_debit', aggregateId: r.id, payload: { status, totalKori: r.totalKori, externalRef: r.externalRef } });
  return tx.partnerDebitInstruction.findUnique({ where: { id: r.id } });
}

async function expireIfDue(db, r, now = Date.now()) {
  if (!r || r.status !== 'requested' || r.expiresAt.getTime() > now) return r;
  return runMoneyTransaction(db, async (tx) => {
    const fresh = await lock(tx, r.id);
    if (fresh.status !== 'requested' || fresh.expiresAt.getTime() > now) return fresh;
    return decide(tx, fresh, 'expired', { by: 'system:expiry' });
  });
}

/** Sweep (cron or on read): every requested instruction past its 15 minutes → expired. */
export async function expirePartnerDebits(db = prisma, { now = Date.now() } = {}) {
  if (!partnerDebitsEnabled()) return { enabled: false };
  const due = await db.partnerDebitInstruction.findMany({ where: { status: 'requested', expiresAt: { lte: new Date(now) } }, take: 500 });
  for (const r of due) await expireIfDue(db, r, now);
  return { enabled: true, expired: due.length };
}

async function requireApprover(tx, userId, businessId) {
  await assertBusinessAuthorityInTx(tx, userId, businessId, 'business.pay').catch(() => {
    throw new PartnerDebitError('not_found', 'Instruction not found', 404);
  });
}

/** The approver's view: EVERY recipient (current name / handle vs. the handle the partner sent), the hash to approve. */
export async function businessDebitDetail(userId, businessId, id, db = prisma) {
  if (!partnerDebitsEnabled()) throw new PartnerDebitError('disabled', 'Partner debit instructions are not enabled', 403);
  const r = await expireIfDue(db, await db.partnerDebitInstruction.findUnique({ where: { id: String(id) } }));
  if (!r || r.businessId !== businessId) throw new PartnerDebitError('not_found', 'Instruction not found', 404);
  await requireApprover(db, userId, businessId);
  const lines = linesOf(r);
  const users = await db.user.findMany({ where: { id: { in: lines.map((l) => l.recipientUserId) } }, select: { id: true, name: true, handle: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  return {
    id: r.id, partner: r.partnerId, kind: r.kind, status: r.status, totalKori: r.totalKori, memo: r.memo, expiresAt: r.expiresAt.toISOString(),
    detailsHash: r.detailsHash,
    recipients: lines.map((l) => ({ line: l.i, name: byId.get(l.recipientUserId)?.name ?? null, handle: byId.get(l.recipientUserId)?.handle ?? null, handleSentByPartner: l.handleAtRequest, handleChanged: byId.get(l.recipientUserId)?.handle !== l.handleAtRequest, amountKori: l.amountKori, employee: Boolean(l.employeeId), reference: l.reference })),
  };
}

export async function listBusinessDebits(userId, businessId, { status } = {}, db = prisma) {
  if (!partnerDebitsEnabled()) throw new PartnerDebitError('disabled', 'Partner debit instructions are not enabled', 403);
  await requireApprover(db, userId, businessId);
  await expirePartnerDebits(db);
  const rows = await db.partnerDebitInstruction.findMany({ where: { businessId, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
  return rows.map((r) => ({ id: r.id, partner: r.partnerId, kind: r.kind, status: r.status, totalKori: r.totalKori, lineCount: r.lineCount, expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString() }));
}

export async function rejectBusinessDebit(userId, businessId, id, { reason } = {}, db = prisma) {
  if (!partnerDebitsEnabled()) throw new PartnerDebitError('disabled', 'Partner debit instructions are not enabled', 403);
  if (!reason || String(reason).trim().length < 3) throw new PartnerDebitError('reason_required', 'Motif requis', 400);
  return runMoneyTransaction(db, async (tx) => {
    const r = await lock(tx, id);
    if (!r || r.businessId !== businessId) throw new PartnerDebitError('not_found', 'Instruction not found', 404);
    await requireApprover(tx, userId, businessId);
    if (r.status !== 'requested') throw new PartnerDebitError('not_pending', `Instruction is ${r.status}`, 409);
    return { id: r.id, status: (await decide(tx, r, 'rejected', { by: userId, reason })).status };
  });
}

/**
 * Approve + execute, exactly once. The caller (HTTP handler) has ALREADY required a fresh step-up.
 * Returns { id, status, executed:[{line, reference, amountKori}] } or throws (nothing moved).
 */
export async function approveBusinessDebit(userId, businessId, id, { detailsHash, now = Date.now() } = {}, db = prisma) {
  if (!partnerDebitsEnabled()) throw new PartnerDebitError('disabled', 'Partner debit instructions are not enabled', 403);
  const { ensureBusinessWallet, transferBusinessToPersonalPayout, transferBusinessToPersonalPayroll } = await import('../business-wallet-service.js');
  let outcome;
  try {
    outcome = await runMoneyTransaction(db, async (tx) => {
      const r = await lock(tx, id);
      if (!r || r.businessId !== businessId) throw new PartnerDebitError('not_found', 'Instruction not found', 404);
      await requireApprover(tx, userId, businessId);
      if (r.status === 'executed') {
        if (r.decidedBy === userId) return { replay: true, row: r };
        throw new PartnerDebitError('already_executed', 'Already executed', 409);
      }
      if (r.status !== 'requested') throw new PartnerDebitError('not_pending', `Instruction is ${r.status}`, 409);
      if (r.expiresAt.getTime() <= now) return { terminal: await decide(tx, r, 'expired', { by: 'system:expiry' }), code: 'expired' };
      // Immutable details: the approver approves exactly what they were shown, and the stored row is intact.
      if (hashOf(r) !== r.detailsHash) return { terminal: await decide(tx, r, 'invalidated', { by: userId, reason: 'integrity_mismatch' }), code: 'integrity_mismatch' };
      if (!detailsHash || detailsHash !== r.detailsHash) throw new PartnerDebitError('details_mismatch', 'Ce que tu approuves ne correspond pas à la demande — recharge-la', 409);

      const lines = linesOf(r);
      if (lines.some((l) => l.recipientUserId === userId)) throw new PartnerDebitError('approver_is_recipient', 'Tu ne peux pas approuver un paiement dont tu es bénéficiaire', 403);

      // Re-validate everything the request was bound to; any change invalidates it (never "approve anyway").
      const reasons = [];
      const link = await tx.externalLink.findUnique({ where: { id: r.externalLinkId } });
      if (!link || link.status !== 'active' || link.system !== r.partnerId || link.jokkoId !== businessId) reasons.push('business_unlinked');
      await tx.$executeRaw`SELECT id FROM "Business" WHERE id = ${businessId} FOR SHARE`;
      const business = await tx.business.findUnique({ where: { id: businessId } });
      if ((business?.status ?? 'missing') !== 'active') reasons.push('business_inactive');
      const recipients = new Map((await tx.user.findMany({ where: { id: { in: lines.map((l) => l.recipientUserId) } }, include: { wallet: true } })).map((u) => [u.id, u]));
      for (const l of lines) {
        const u = recipients.get(l.recipientUserId);
        if (!u?.wallet) reasons.push(`line_${l.i}_recipient_missing`);
        else if (u.frozenByAdminAt) reasons.push(`line_${l.i}_recipient_frozen`);
        if (r.kind === 'payroll_batch') {
          const emp = await tx.payrollEmployee.findUnique({ where: { id: l.employeeId } });
          if (!emp || emp.status !== 'active' || emp.userId !== l.recipientUserId || emp.businessId !== businessId) reasons.push(`line_${l.i}_roster_changed`);
        }
      }
      if (reasons.length) return { terminal: await decide(tx, r, 'invalidated', { by: userId, reason: reasons.slice(0, 10).join(',') }), code: 'invalidated', reasons };

      // Risk: daily velocity per business (count and amount of executed partner debits in 24 h).
      const since = new Date(now - 24 * 3600_000);
      const day = await tx.partnerDebitInstruction.aggregate({ where: { businessId, status: 'executed', executedAt: { gte: since } }, _sum: { totalKori: true }, _count: true });
      if (day._count + 1 > LIMITS.dailyMaxCount() || (day._sum.totalKori ?? 0) + r.totalKori > LIMITS.dailyMaxKori()) {
        throw new PartnerDebitError('risk_limit', 'Plafond quotidien des paiements partenaires atteint pour ce commerce', 409);
      }

      const bw = await ensureBusinessWallet(businessId, tx);
      const executed = [];
      for (const l of lines) {
        const u = recipients.get(l.recipientUserId);
        const reference = `pdi-${r.id}-${l.i}`;
        const common = { amount: l.amountKori, businessWalletId: bw.id, businessId, userWalletId: u.wallet.id, userId: u.id, reference, businessName: business.name, note: `Partenaire ${r.partnerId} · ${r.externalRef}`.slice(0, 120), actingUserId: userId };
        if (r.kind === 'payroll_batch') {
          await transferBusinessToPersonalPayroll(tx, { ...common, employeeName: u.name, employeeHandle: u.handle, actor: { type: 'user', id: userId } });
          await tx.payrollRun.create({ data: { businessId, employeeId: l.employeeId, amount: l.amountKori, reference, note: common.note, status: 'completed', completedAt: new Date() } });
        } else {
          await transferBusinessToPersonalPayout(tx, { ...common, recipientName: u.name, recipientHandle: u.handle });
        }
        executed.push({ line: l.i, reference, amountKori: l.amountKori });
      }
      const done = await decide(tx, r, 'executed', { by: userId, executedAt: new Date(now) });
      return { row: done, executed };
    });
  } catch (e) {
    if (e instanceof InsufficientFundsError || e?.name === 'InsufficientFundsError') {
      // Nothing moved (the money transaction rolled back as a whole). Record the failure once.
      await runMoneyTransaction(db, async (tx) => {
        const r = await lock(tx, id);
        if (r?.status === 'requested') await decide(tx, r, 'failed', { by: userId, failureCode: 'insufficient_funds' });
      });
      throw new PartnerDebitError('insufficient_funds', 'Solde du commerce insuffisant — rien n’a été débité', 409);
    }
    throw e;
  }
  if (outcome.terminal) throw new PartnerDebitError(outcome.code, outcome.code === 'expired' ? 'Demande expirée (15 min) — rien n’a été débité' : 'La demande a changé depuis sa création — rien n’a été débité', 409, { reasons: outcome.reasons });
  if (!outcome.replay) {
    const { notifyMoneyReceived } = await import('../notify-service.js');
    for (const l of linesOf(outcome.row)) await notifyMoneyReceived(l.recipientUserId, { amount: l.amountKori, currency: 'kori', senderLabel: 'Paiement commerce' }).catch(() => {});
  }
  return { id: outcome.row.id, status: outcome.row.status, replayed: Boolean(outcome.replay), executed: outcome.executed ?? linesOf(outcome.row).map((l) => ({ line: l.i, reference: `pdi-${outcome.row.id}-${l.i}`, amountKori: l.amountKori })) };
}
