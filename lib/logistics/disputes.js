import { prisma } from '../prisma.js';
import { recordIdentityEvent } from '../identity/audit.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { LogisticsError } from './contract.js';
import { reverseEarningInTx } from './fees.js';
import { roleFor } from './shipments.js';

/**
 * J8.20 — shipment disputes.
 *
 *   open      a PARTY (source, receiver, courier) — within the window, once per shipment
 *   evidence  parties add append-only evidence (DB trigger) while the dispute is open
 *   resolve   an OPERATOR (logistics.disputes.resolve), reason required, audited, once:
 *               rejected        no consequence
 *               upheld          finding recorded; the commercial remedy belongs to J7
 *                               (return / credit memo), never to logistics
 *               upheld_reverse  finding + the courier earning / delivery revenue must be
 *                               reversed → maker/checker: a SECOND operator holding
 *                               logistics.disputes.reverse (finance) approves; the money
 *                               consequence runs once (deterministic J2 references)
 * A courier, customer, merchant, pickup point or rep can never resolve a dispute.
 * While a dispute is open the courier earning cannot become releasable or be paid.
 */
export const DISPUTE_WINDOW_DAYS = 7;
const DISPUTABLE = new Set(['delivered', 'returned', 'delivery_failed']);
const notFound = () => new LogisticsError('not_found', 'Litige introuvable', 404);

async function partyRole(db, userId, shipmentId) {
  const sh = await db.shipment.findUnique({ where: { id: shipmentId } });
  if (!sh) throw new LogisticsError('not_found', 'Expédition introuvable', 404);
  const request = await db.fulfilmentRequest.findUnique({ where: { id: sh.requestId } });
  let role = await roleFor(db, userId, sh, request);
  if (!role) {
    // The courier's assignment is completed after delivery: they remain a party.
    const a = await db.courierAssignment.findFirst({ where: { shipmentId, courierUserId: userId } });
    if (a) role = 'courier';
  }
  if (!['source', 'receiver', 'courier'].includes(role)) throw new LogisticsError('not_found', 'Expédition introuvable', 404);
  return { sh, request, role };
}

export async function openDispute(userId, shipmentId, { reason }) {
  if (!(reason && String(reason).trim().length >= 10)) throw new LogisticsError('reason_required', 'Explique le problème (10 caractères min.)', 400);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Shipment" WHERE id = ${shipmentId} FOR UPDATE`;
    const { sh, role } = await partyRole(tx, userId, shipmentId);
    const prior = await tx.shipmentDispute.findUnique({ where: { shipmentId } });
    if (prior) {
      if (prior.openedBy === userId) return { ...disputeView(prior), replayed: true };
      throw new LogisticsError('dispute_exists', 'Un litige existe déjà pour cette expédition', 409);
    }
    if (!DISPUTABLE.has(sh.status)) throw new LogisticsError('invalid_state', 'Litige possible après livraison, échec ou retour');
    const since = sh.deliveredAt ?? sh.updatedAt;
    if (Date.now() - since.getTime() > DISPUTE_WINDOW_DAYS * 86_400_000) throw new LogisticsError('window_closed', `Délai de litige dépassé (${DISPUTE_WINDOW_DAYS} jours)`);
    const d = await tx.shipmentDispute.create({ data: { shipmentId, openedBy: userId, openedByRole: role, reason: String(reason).slice(0, 500) } });
    // An open dispute freezes the courier earning: releasable goes back to accrued (paid stays paid).
    await tx.courierEarning.updateMany({ where: { shipmentId, status: 'releasable' }, data: { status: 'accrued' } });
    return disputeView(d);
  });
}

export async function addEvidence(userId, disputeId, { kind = 'note', content }) {
  if (!['note', 'photo_ref', 'document_ref'].includes(kind)) throw new LogisticsError('invalid', 'Type de pièce inconnu', 400);
  if (!(content && String(content).trim().length >= 3)) throw new LogisticsError('invalid', 'Pièce vide', 400);
  const d = await prisma.shipmentDispute.findUnique({ where: { id: disputeId } });
  if (!d) throw notFound();
  const { role } = await partyRole(prisma, userId, d.shipmentId).catch(() => { throw notFound(); });
  if (d.status !== 'open') throw new LogisticsError('invalid_state', 'Litige clos');
  const e = await prisma.shipmentDisputeEvidence.create({ data: { disputeId, userId, role, kind, content: String(content).slice(0, 1000) } });
  return { id: e.id, role, kind, at: e.createdAt.toISOString() };
}

export async function getDisputeForParty(userId, disputeId) {
  const d = await prisma.shipmentDispute.findUnique({ where: { id: disputeId } });
  if (!d) throw notFound();
  await partyRole(prisma, userId, d.shipmentId).catch(() => { throw notFound(); });
  const ev = await prisma.shipmentDisputeEvidence.findMany({ where: { disputeId }, orderBy: { createdAt: 'asc' } });
  // Parties see roles and content, not other parties' user ids.
  return { ...disputeView(d), evidence: ev.map((e) => ({ role: e.role, kind: e.kind, content: e.content, at: e.createdAt.toISOString() })) };
}

/** Operator ruling. `upheld_reverse` only records the finding and returns the approval to request. */
export async function resolveDispute(adminId, disputeId, { outcome, note }) {
  if (!['rejected', 'upheld', 'upheld_reverse'].includes(outcome)) throw new LogisticsError('invalid', 'Décision inconnue', 400);
  if (!(note && String(note).trim().length >= 10)) throw new LogisticsError('reason_required', 'Motif requis (10 caractères min.)', 400);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "ShipmentDispute" WHERE id = ${disputeId} FOR UPDATE`;
    const d = await tx.shipmentDispute.findUnique({ where: { id: disputeId } });
    if (!d) throw notFound();
    if (d.status !== 'open') {
      if (d.resolvedBy === adminId && d.resolution === outcome) return { ...disputeView(d), replayed: true };
      throw new LogisticsError('already_resolved', 'Litige déjà tranché', 409);
    }
    const status = outcome === 'upheld_reverse' ? 'awaiting_reversal' : 'resolved';
    const u = await tx.shipmentDispute.update({ where: { id: d.id }, data: { status, resolution: outcome, resolvedBy: adminId, resolvedAt: new Date() } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'shipment_dispute_resolved', subjectType: 'shipment', subjectId: d.shipmentId, reason: String(note).slice(0, 300), after: { outcome, disputeId: d.id } });
    return disputeView(u);
  });
}

/** Executor of the `shipment_earning_reverse` approval (second operator). Runs once. */
export async function executeEarningReversal(db, { disputeId }, ctx) {
  return runMoneyTransaction(db, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "ShipmentDispute" WHERE id = ${disputeId} FOR UPDATE`;
    const d = await tx.shipmentDispute.findUnique({ where: { id: disputeId } });
    if (!d) throw notFound();
    if (d.status === 'resolved' && d.resolution === 'upheld_reverse') return { disputeId, reversed: 0, replayed: true };
    if (d.status !== 'awaiting_reversal') throw new LogisticsError('invalid_state', 'Aucune reprise en attente pour ce litige');
    if (ctx.approvedBy === d.resolvedBy) throw new LogisticsError('dual_authorization', 'Un second opérateur doit valider', 403);
    const r = await reverseEarningInTx(tx, d.shipmentId, { reason: `dispute:${d.id}` });
    await tx.shipmentDispute.update({ where: { id: d.id }, data: { status: 'resolved' } });
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: ctx.approvedBy, action: 'shipment_earning_reversed', subjectType: 'shipment', subjectId: d.shipmentId, reason: ctx.reason, after: { ...r, requestedBy: ctx.requestedBy, approvedBy: ctx.approvedBy } });
    return { disputeId, ...r };
  });
}

export async function listOpenDisputes({ cursor, limit = 50 } = {}) {
  const take = Math.min(Math.max(1, Number(limit) || 50), 200);
  const rows = await prisma.shipmentDispute.findMany({ where: { status: { in: ['open', 'awaiting_reversal'] } }, orderBy: { id: 'asc' }, take: take + 1, ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}) });
  const page = rows.slice(0, take);
  return { items: page.map(disputeView), nextCursor: rows.length > take ? page[page.length - 1].id : null };
}

export const disputeView = (d) => ({ id: d.id, shipmentId: d.shipmentId, openedByRole: d.openedByRole, reason: d.reason, status: d.status, resolution: d.resolution, resolvedAt: d.resolvedAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString() });
