import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx } from '../business-access.js';
import { emitCommerceEvent } from '../commerce/events.js';
import { runMoneyTransaction } from '../wallet-atomic.js';
import { CUSTODY_OF, FAILURE_REASONS, LogisticsError, TERMINAL, shipmentView } from './contract.js';
import { refundFeeInTx, releaseFeeInTx } from './fees.js';
import { onCancelled, onReceiving, onReturnedToSource, onVerifiedDelivery } from './commerce-adapter.js';

/**
 * J8.5–J8.9, J8.14–J8.21 — the shipment state machine and custody protocol.
 *
 * Custody moves only through a two-party act:
 *   pickup      the SOURCE issues a code bound to the assigned courier; the courier submits it
 *   delivery    the RECEIVER issues a code bound to the assigned courier; the courier submits it
 *               — or the receiving business records receiving itself (receiver-side evidence)
 *   collection  the RECEIVER issues a code; the releasing desk (source / pickup point) submits it
 *   return      the SOURCE issues a code; the courier submits it when the goods are back
 * A courier's own word is never proof: without the receiver, it is a `delivery_exception`
 * for an operator ruling. Codes are single-use, purpose-bound, 10-minute, 5 attempts.
 */
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const hashCode = (shipmentId, purpose, code) => crypto.createHash('sha256').update(`${shipmentId}:${purpose}:${String(code).toUpperCase().trim()}`).digest('hex');
const notFound = () => new LogisticsError('not_found', 'Expédition introuvable', 404);

async function lockShipment(tx, id) {
  await tx.$executeRaw`SELECT id FROM "Shipment" WHERE id = ${id} FOR UPDATE`;
  const sh = await tx.shipment.findUnique({ where: { id } });
  if (!sh) throw notFound();
  const request = await tx.fulfilmentRequest.findUnique({ where: { id: sh.requestId } });
  return { sh, request };
}

async function transition(tx, sh, to, { actorType, actorId, evidence = null, note = null, data = {} }) {
  const custody = CUSTODY_OF[to];
  const r = await tx.shipment.updateMany({ where: { id: sh.id, status: sh.status }, data: { status: to, custody, ...data } });
  if (r.count !== 1) throw new LogisticsError('conflict', 'L’expédition a changé entre-temps', 409);
  await tx.shipmentEvent.create({ data: { shipmentId: sh.id, fromStatus: sh.status, toStatus: to, custodyBefore: sh.custody, custodyAfter: custody, actorType, actorId, evidence, note: note ? String(note).slice(0, 300) : null } });
  await emitCommerceEvent(tx, { type: `shipment.${to}`, businessId: null, aggregateType: 'shipment', aggregateId: sh.id, payload: { from: sh.status, custody, evidence } });
  return tx.shipment.findUnique({ where: { id: sh.id } });
}

const authOr404 = (p) => p.catch((e) => {
  if (e instanceof OrgAccessError) throw notFound();
  throw e;
});
const asSource = (tx, userId, request) => authOr404(assertBusinessAuthorityInTx(tx, userId, request.originBusinessId, 'business.orders.fulfill'));
async function asReceiver(tx, userId, request) {
  if (request.destinationUserId && request.destinationUserId === userId) return true;
  // A return comes back to the seller: its fulfilment staff receive it; everything else is received by purchasing.
  if (request.destinationBusinessId) return authOr404(assertBusinessAuthorityInTx(tx, userId, request.destinationBusinessId, request.purpose === 'return' ? 'business.orders.fulfill' : 'business.purchasing'));
  throw notFound();
}
async function activeAssignment(tx, shipmentId) {
  return tx.courierAssignment.findFirst({ where: { shipmentId, status: 'active' } });
}
/** The ACTIVE assignee, still authorized in their courier role right now (suspension / removal takes effect immediately). */
async function asCourier(tx, userId, sh, request) {
  const a = await activeAssignment(tx, sh.id);
  if (!a || a.courierUserId !== userId) throw notFound();
  if (a.courierKind === 'jokko_courier') {
    const role = await tx.accountRole.findUnique({ where: { userId_role: { userId, role: 'driver' } } });
    if (role?.status !== 'active') throw new LogisticsError('courier_inactive', 'Profil coursier inactif', 403);
  } else {
    await authOr404(assertBusinessAuthorityInTx(tx, userId, request.fulfillerBusinessId, 'business.fleet.drive'));
  }
  return a;
}
/** A courier may never be a party to what they carry. */
async function assertNotParty(tx, courierUserId, request) {
  if (request.destinationUserId === courierUserId) throw new LogisticsError('courier_is_party', 'Le destinataire ne transporte pas son propre envoi', 409);
  // Movement INTO the fulfiller itself (internal transfer, collected return) is carried by its own driver:
  // allowed, but that driver can never also sign the receiving (recordReceiving).
  if (request.destinationBusinessId && request.destinationBusinessId !== request.fulfillerBusinessId) {
    const b = await tx.business.findUnique({ where: { id: request.destinationBusinessId }, select: { ownerId: true } });
    const m = await tx.businessMember.findFirst({ where: { businessId: request.destinationBusinessId, userId: courierUserId, status: 'active' } });
    if (b?.ownerId === courierUserId || m) throw new LogisticsError('courier_is_party', 'Le destinataire ne transporte pas son propre envoi', 409);
  }
}

async function issueChallengeInTx(tx, sh, { purpose, issuedBy, boundUserId }) {
  await tx.custodyChallenge.updateMany({ where: { shipmentId: sh.id, purpose, usedAt: null, expiresAt: { gt: new Date() } }, data: { expiresAt: new Date() } });
  const code = newCode();
  await tx.custodyChallenge.create({ data: { shipmentId: sh.id, purpose, codeHash: hashCode(sh.id, purpose, code), issuedBy, boundUserId, expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
  return { code, expiresInSeconds: CODE_TTL_MS / 1000 };
}
/** Consume a code: right shipment, purpose, counterpart; unexpired; unused; attempt-limited. */
async function consumeChallengeInTx(tx, sh, { purpose, userId, code }) {
  const c = await tx.custodyChallenge.findFirst({ where: { shipmentId: sh.id, purpose, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
  if (!c) throw new LogisticsError('code_invalid', 'Code invalide ou expiré — demande un nouveau code', 409);
  if (c.boundUserId && c.boundUserId !== userId) throw new LogisticsError('code_invalid', 'Code invalide ou expiré — demande un nouveau code', 409);
  if (c.attempts >= MAX_ATTEMPTS) throw new LogisticsError('code_locked', 'Trop d’essais — demande un nouveau code', 423);
  const ok = crypto.timingSafeEqual(Buffer.from(c.codeHash), Buffer.from(hashCode(sh.id, purpose, code)));
  if (!ok) {
    // Counted OUTSIDE the act's transaction: the refusal rolls the transaction back, and an
    // in-transaction increment would roll back with it (unlimited guessing).
    await prisma.custodyChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } });
    throw new LogisticsError('code_invalid', 'Code invalide ou expiré — demande un nouveau code', 409);
  }
  const u = await tx.custodyChallenge.updateMany({ where: { id: c.id, usedAt: null }, data: { usedAt: new Date(), usedBy: userId } });
  if (u.count !== 1) throw new LogisticsError('code_invalid', 'Code déjà utilisé', 409);
  return c;
}
/** Offline / lost-response recovery: the same actor retrying an act that already happened gets the result, not a second handoff. */
async function alreadyDone(tx, sh, { purpose, userId, code }) {
  const used = await tx.custodyChallenge.findFirst({ where: { shipmentId: sh.id, purpose, usedBy: userId, codeHash: hashCode(sh.id, purpose, code ?? '') } });
  return Boolean(used);
}

/* ── reads ─────────────────────────────────────────────────────────────── */

export async function roleFor(db, userId, sh, request) {
  const a = await db.courierAssignment.findFirst({ where: { shipmentId: sh.id, courierUserId: userId, status: 'active' } });
  if (a) return 'courier';
  const can = async (biz, cap) => biz && (await assertBusinessAuthorityInTx(db, userId, biz, cap).then(() => true, () => false));
  if (await can(request.originBusinessId, 'business.orders.fulfill')) return 'source';
  if (request.destinationUserId === userId || (await can(request.destinationBusinessId, request.purpose === 'return' ? 'business.orders.fulfill' : 'business.purchasing'))) return 'receiver';
  if (request.fulfillerBusinessId && (await can(request.fulfillerBusinessId, 'business.fleet.dispatch'))) return 'dispatcher';
  if (request.pickupPointId) {
    const p = await db.pickupPoint.findUnique({ where: { id: request.pickupPointId } });
    if (p && (await can(p.operatorBusinessId, 'business.orders.fulfill'))) return 'pickup_point';
  }
  return null;
}

export async function getShipment(userId, shipmentId) {
  const sh = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!sh) throw notFound();
  const request = await prisma.fulfilmentRequest.findUnique({ where: { id: sh.requestId } });
  const role = await roleFor(prisma, userId, sh, request);
  if (!role) throw notFound();
  const events = await prisma.shipmentEvent.findMany({ where: { shipmentId: sh.id }, orderBy: { createdAt: 'asc' } });
  return { ...shipmentView(sh, { role, events, request }), role };
}

export async function listCourierShipments(userId, { cursor, limit = 50 } = {}) {
  const take = Math.min(Math.max(1, Number(limit) || 50), 200);
  const rows = await prisma.courierAssignment.findMany({ where: { courierUserId: userId, status: 'active' }, orderBy: { id: 'asc' }, take: take + 1, ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}) });
  const page = rows.slice(0, take);
  const ships = await prisma.shipment.findMany({ where: { id: { in: page.map((a) => a.shipmentId) } } });
  return { items: ships.map((s) => shipmentView(s, { role: 'courier' })), nextCursor: rows.length > take ? page[page.length - 1].id : null };
}

export async function listBusinessShipments(userId, businessId, { side = 'origin', status, cursor, limit = 50 } = {}) {
  const cap = side === 'origin' ? 'business.orders.read' : 'business.purchasing';
  await authOr404(assertBusinessAuthorityInTx(prisma, userId, businessId, cap));
  const take = Math.min(Math.max(1, Number(limit) || 50), 200);
  const st = status ? String(status) : null;
  const cur = cursor ? String(cursor) : null;
  // Keyset pagination over the request indexes (origin / destination); never an unbounded IN list.
  const ids = side === 'origin'
    ? await prisma.$queryRaw`SELECT s.id FROM "Shipment" s JOIN "FulfilmentRequest" r ON r.id = s."requestId"
        WHERE r."originBusinessId" = ${businessId} AND (${st}::text IS NULL OR s.status = ${st}::text) AND (${cur}::text IS NULL OR s.id > ${cur}::text)
        ORDER BY s.id ASC LIMIT ${take + 1}`
    : await prisma.$queryRaw`SELECT s.id FROM "Shipment" s JOIN "FulfilmentRequest" r ON r.id = s."requestId"
        WHERE r."destinationBusinessId" = ${businessId} AND (${st}::text IS NULL OR s.status = ${st}::text) AND (${cur}::text IS NULL OR s.id > ${cur}::text)
        ORDER BY s.id ASC LIMIT ${take + 1}`;
  const pageIds = ids.slice(0, take).map((r) => r.id);
  const rows = await prisma.shipment.findMany({ where: { id: { in: pageIds } }, orderBy: { id: 'asc' } });
  return { items: rows.map((s) => shipmentView(s, { role: side === 'origin' ? 'source' : 'receiver' })), nextCursor: ids.length > take ? pageIds[pageIds.length - 1] : null };
}

/* ── fulfiller / dispatcher ─────────────────────────────────────────────── */

/** Jokko Logistics operations accept a request (operator permission logistics.dispatch, checked by the route). */
export async function opsAccept(adminId, shipmentId) {
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    if (request.fulfilmentOwner !== 'JOKKO_LOGISTICS') throw notFound();
    if (sh.status !== 'requested') throw new LogisticsError('invalid_state', 'Déjà traitée');
    return shipmentView(await transition(tx, sh, 'accepted', { actorType: 'admin', actorId: adminId }), { role: 'operator', request });
  });
}

export async function markReady(userId, shipmentId) {
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    await asSource(tx, userId, request);
    if (sh.status !== 'accepted') throw new LogisticsError('invalid_state', 'Transition impossible');
    return shipmentView(await transition(tx, sh, 'ready_for_pickup', { actorType: 'user', actorId: userId }), { role: 'source', request });
  });
}

/**
 * Authoritative assignment. Jokko Logistics: an operator (logistics.dispatch) assigns an ACTIVE Jokko courier.
 * Own fleet: a business dispatcher (business.fleet.dispatch) assigns an active member with business.fleet.drive.
 * One active assignment per shipment (DB partial unique index); a courier never carries what they receive.
 */
export async function assignCourier(actor, shipmentId, { courierUserId }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    let kind;
    if (request.fulfilmentOwner === 'JOKKO_LOGISTICS') {
      if (actor.type !== 'admin') throw notFound();
      const role = await tx.accountRole.findUnique({ where: { userId_role: { userId: courierUserId, role: 'driver' } } });
      if (role?.status !== 'active') throw new LogisticsError('courier_inactive', 'Coursier non agréé ou suspendu', 409);
      kind = 'jokko_courier';
    } else {
      if (actor.type !== 'user') throw notFound();
      if (!['MERCHANT_FULFILLED', 'DISTRIBUTOR_FULFILLED'].includes(request.fulfilmentOwner)) throw new LogisticsError('invalid_state', 'Pas de transport pour un retrait client');
      await authOr404(assertBusinessAuthorityInTx(tx, actor.userId, request.fulfillerBusinessId, 'business.fleet.dispatch'));
      await assertBusinessAuthorityInTx(tx, courierUserId, request.fulfillerBusinessId, 'business.fleet.drive').catch(() => {
        throw new LogisticsError('not_a_driver', 'Ce chauffeur n’est pas membre actif de la flotte', 409);
      });
      kind = 'fleet_driver';
    }
    await assertNotParty(tx, courierUserId, request);
    if (sh.status !== 'ready_for_pickup') throw new LogisticsError('invalid_state', sh.status === 'assigned' ? 'Déjà attribuée — retire d’abord l’attribution' : 'Pas prête pour l’enlèvement');
    await tx.courierAssignment.create({ data: { shipmentId: sh.id, courierUserId, courierKind: kind, assignedBy: actor.type === 'admin' ? actor.adminId : actor.userId, assignedByType: actor.type } });
    return shipmentView(await transition(tx, sh, 'assigned', { actorType: actor.type, actorId: actor.type === 'admin' ? actor.adminId : actor.userId, note: `courier:${kind}` }), { role: 'dispatcher', request });
  });
}

export async function unassignCourier(actor, shipmentId, { reason }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    if (request.fulfilmentOwner === 'JOKKO_LOGISTICS') {
      if (actor.type !== 'admin') throw notFound();
    } else {
      if (actor.type !== 'user') throw notFound();
      await authOr404(assertBusinessAuthorityInTx(tx, actor.userId, request.fulfillerBusinessId, 'business.fleet.dispatch'));
    }
    if (!['assigned', 'pickup_arrived'].includes(sh.status)) throw new LogisticsError('invalid_state', 'Le coursier a déjà la marchandise : passage de relais non pris en charge');
    await tx.courierAssignment.updateMany({ where: { shipmentId: sh.id, status: 'active' }, data: { status: 'ended', endedAt: new Date(), endReason: String(reason ?? 'unassigned').slice(0, 200) } });
    return shipmentView(await transition(tx, sh, 'ready_for_pickup', { actorType: actor.type, actorId: actor.type === 'admin' ? actor.adminId : actor.userId, note: reason }), { role: 'dispatcher', request });
  });
}

/* ── codes ─────────────────────────────────────────────────────────────── */

/** Issue a custody code. pickup / return_delivery: the source; delivery / collection: the receiver. */
export async function issueCode(userId, shipmentId, purpose) {
  return prisma.$transaction(async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    if (purpose === 'pickup') {
      await asSource(tx, userId, request);
      if (!['assigned', 'pickup_arrived'].includes(sh.status)) throw new LogisticsError('invalid_state', 'Aucun coursier attribué');
      const a = await activeAssignment(tx, sh.id);
      return issueChallengeInTx(tx, sh, { purpose, issuedBy: userId, boundUserId: a.courierUserId });
    }
    if (purpose === 'return_delivery') {
      await asSource(tx, userId, request);
      if (sh.status !== 'return_in_transit') throw new LogisticsError('invalid_state', 'Aucun retour en cours');
      const a = await activeAssignment(tx, sh.id);
      return issueChallengeInTx(tx, sh, { purpose, issuedBy: userId, boundUserId: a.courierUserId });
    }
    if (purpose === 'delivery') {
      await asReceiver(tx, userId, request);
      if (!['picked_up', 'in_transit', 'delivery_arrived'].includes(sh.status)) throw new LogisticsError('invalid_state', 'Pas en cours de livraison');
      const a = await activeAssignment(tx, sh.id);
      return issueChallengeInTx(tx, sh, { purpose, issuedBy: userId, boundUserId: a.courierUserId });
    }
    if (purpose === 'collection') {
      await asReceiver(tx, userId, request);
      if (request.fulfilmentOwner !== 'CUSTOMER_PICKUP') throw new LogisticsError('invalid_state', 'Pas un retrait');
      if (!['ready_for_pickup', 'at_pickup_point'].includes(sh.status)) throw new LogisticsError('invalid_state', 'Pas encore prêt au retrait');
      // Collection codes are not bound to a desk person: any authorized desk of the release location may verify.
      return issueChallengeInTx(tx, sh, { purpose, issuedBy: userId, boundUserId: null });
    }
    throw new LogisticsError('invalid', 'Usage de code inconnu', 400);
  });
}

/* ── courier acts ──────────────────────────────────────────────────────── */

export async function courierPickup(userId, shipmentId, { code }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    await asCourierOrReplay(tx, userId, sh, request);
    if (!['assigned', 'pickup_arrived'].includes(sh.status)) {
      if (sh.custodianUserId === userId && (await alreadyDone(tx, sh, { purpose: 'pickup', userId, code }))) return { ...shipmentView(sh, { role: 'courier', request }), replayed: true };
      throw new LogisticsError('invalid_state', 'Enlèvement impossible dans cet état');
    }
    await consumeChallengeInTx(tx, sh, { purpose: 'pickup', userId, code });
    return shipmentView(await transition(tx, sh, 'picked_up', { actorType: 'courier', actorId: userId, evidence: 'source_code', data: { custodianUserId: userId } }), { role: 'courier', request });
  });
}

async function asCourierOrReplay(tx, userId, sh, request) {
  const a = await tx.courierAssignment.findFirst({ where: { shipmentId: sh.id, courierUserId: userId } , orderBy: { createdAt: 'desc' } });
  if (!a) throw notFound();
  if (a.status === 'active') return asCourier(tx, userId, sh, request);
  if (a.status === 'completed') return a; // replay of a finished act
  throw notFound();
}

export async function courierStep(userId, shipmentId, step) {
  const map = { arrive_pickup: ['assigned', 'pickup_arrived'], depart: ['picked_up', 'in_transit'], arrive_delivery: [['picked_up', 'in_transit'], 'delivery_arrived'] };
  const rule = { arrive_pickup: { from: ['assigned'], to: 'pickup_arrived' }, depart: { from: ['picked_up'], to: 'in_transit' }, arrive_delivery: { from: ['picked_up', 'in_transit'], to: 'delivery_arrived' } }[step];
  if (!rule || !map[step]) throw new LogisticsError('invalid', 'Étape inconnue', 400);
  return prisma.$transaction(async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    await asCourier(tx, userId, sh, request);
    if (sh.status === rule.to) return { ...shipmentView(sh, { role: 'courier', request }), replayed: true };
    if (!rule.from.includes(sh.status)) throw new LogisticsError('invalid_state', 'Étape impossible dans cet état');
    return shipmentView(await transition(tx, sh, rule.to, { actorType: 'courier', actorId: userId, data: { custodianUserId: sh.custodianUserId } }), { role: 'courier', request });
  });
}

async function completeDeliveryInTx(tx, sh, request, { proof, actorType, actorId }) {
  const a = await activeAssignment(tx, sh.id);
  const delivered = await transition(tx, sh, 'delivered', { actorType, actorId, evidence: proof, data: { deliveredAt: new Date(), deliveryProof: proof, custodianUserId: null } });
  if (a) await tx.courierAssignment.update({ where: { id: a.id }, data: { status: 'completed', endedAt: new Date(), endReason: 'delivered' } });
  if (request.feeKori > 0 && a) await releaseFeeInTx(tx, request, { shipmentId: sh.id, courierUserId: a.courierUserId });
  await onVerifiedDelivery(tx, request, delivered, proof);
  await tx.fulfilmentRequest.update({ where: { id: request.id }, data: { status: 'delivered' } });
  return delivered;
}

/** Courier submits the code the RECEIVER issued. */
export async function courierDeliver(userId, shipmentId, { code }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    await asCourierOrReplay(tx, userId, sh, request);
    if (sh.status === 'delivered') {
      if (await alreadyDone(tx, sh, { purpose: 'delivery', userId, code })) return { ...shipmentView(sh, { role: 'courier', request }), replayed: true };
      throw new LogisticsError('invalid_state', 'Déjà livrée');
    }
    if (!['picked_up', 'in_transit', 'delivery_arrived'].includes(sh.status)) throw new LogisticsError('invalid_state', 'Livraison impossible dans cet état');
    await consumeChallengeInTx(tx, sh, { purpose: 'delivery', userId, code });
    return shipmentView(await completeDeliveryInTx(tx, sh, request, { proof: 'receiver_challenge', actorType: 'courier', actorId: userId }), { role: 'courier', request });
  });
}

/** The courier could not deliver. Custody stays with the courier until the goods are returned. */
export async function courierFail(userId, shipmentId, { reason, note }) {
  if (!FAILURE_REASONS[reason]) throw new LogisticsError('invalid', 'Motif d’échec inconnu', 400);
  return prisma.$transaction(async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    await asCourier(tx, userId, sh, request);
    if (!['picked_up', 'in_transit', 'delivery_arrived'].includes(sh.status)) throw new LogisticsError('invalid_state', 'Échec impossible dans cet état');
    return shipmentView(await transition(tx, sh, 'delivery_failed', { actorType: 'courier', actorId: userId, evidence: `failure:${reason}`, note, data: { failureReason: reason } }), { role: 'courier', request });
  });
}

/** "I delivered but have no receiver proof": an exception for an operator — never a delivery. */
export async function courierException(userId, shipmentId, { note }) {
  if (!(note && String(note).trim().length >= 10)) throw new LogisticsError('reason_required', 'Décris la situation (10 caractères min.)', 400);
  return prisma.$transaction(async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    await asCourier(tx, userId, sh, request);
    if (!['picked_up', 'in_transit', 'delivery_arrived'].includes(sh.status)) throw new LogisticsError('invalid_state', 'Impossible dans cet état');
    return shipmentView(await transition(tx, sh, 'delivery_exception', { actorType: 'courier', actorId: userId, evidence: 'courier_claim_only', note }), { role: 'courier', request });
  });
}

export async function courierReturnStart(userId, shipmentId) {
  return prisma.$transaction(async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    await asCourier(tx, userId, sh, request);
    if (sh.status === 'return_in_transit') return { ...shipmentView(sh, { role: 'courier', request }), replayed: true };
    if (sh.status !== 'delivery_failed') throw new LogisticsError('invalid_state', 'Aucun échec à retourner');
    return shipmentView(await transition(tx, sh, 'return_in_transit', { actorType: 'courier', actorId: userId }), { role: 'courier', request });
  });
}

/** Goods back at the source: the courier submits the code the SOURCE issued. Stock re-enters the origin once. */
export async function courierReturnComplete(userId, shipmentId, { code }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    await asCourierOrReplay(tx, userId, sh, request);
    if (sh.status === 'returned') {
      if (await alreadyDone(tx, sh, { purpose: 'return_delivery', userId, code })) return { ...shipmentView(sh, { role: 'courier', request }), replayed: true };
      throw new LogisticsError('invalid_state', 'Déjà retournée');
    }
    if (sh.status !== 'return_in_transit') throw new LogisticsError('invalid_state', 'Aucun retour en cours');
    await consumeChallengeInTx(tx, sh, { purpose: 'return_delivery', userId, code });
    const a = await activeAssignment(tx, sh.id);
    const returned = await transition(tx, sh, 'returned', { actorType: 'courier', actorId: userId, evidence: 'source_code', data: { custodianUserId: null } });
    if (a) await tx.courierAssignment.update({ where: { id: a.id }, data: { status: 'completed', endedAt: new Date(), endReason: 'returned' } });
    await onReturnedToSource(tx, request, returned, { actorUserId: userId });
    // Fee: a receiver-side failure consumed the courier's work (fee earned); an operational failure is refunded.
    if (request.feeKori > 0) {
      if (FAILURE_REASONS[sh.failureReason]?.side === 'receiver' && a) await releaseFeeInTx(tx, request, { shipmentId: sh.id, courierUserId: a.courierUserId });
      else await refundFeeInTx(tx, request, { reason: `failed:${sh.failureReason}` });
    }
    await tx.fulfilmentRequest.update({ where: { id: request.id }, data: { status: 'failed' } });
    return shipmentView(returned, { role: 'courier', request });
  });
}

/* ── receiver acts ─────────────────────────────────────────────────────── */

/**
 * B2B receiving: the receiving business records what physically arrived,
 * per line: received / damaged / missing / refused (each line must account
 * for every dispatched unit). If the courier is at the door, this IS the
 * delivery proof (receiver_receiving). Stock moves only from this record.
 */
export async function recordReceiving(userId, shipmentId, { lines, note }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    await asReceiver(tx, userId, request);
    const prior = await tx.receivingRecord.findUnique({ where: { shipmentId: sh.id } });
    if (prior) return { receiving: receivingView(prior), replayed: true };
    const carried = await tx.courierAssignment.findFirst({ where: { shipmentId: sh.id, courierUserId: userId } });
    if (carried) throw new LogisticsError('courier_is_party', 'Celui qui transporte ne signe pas la réception', 403);
    if (!['delivery_arrived', 'delivered'].includes(sh.status)) throw new LogisticsError('invalid_state', sh.status === 'delivery_exception' ? 'En attente d’une décision K21' : 'La marchandise n’est pas arrivée');
    const pkgs = await tx.shipmentPackage.findMany({ where: { shipmentId: sh.id } });
    const expected = new Map();
    for (const p of pkgs) for (const l of JSON.parse(p.linesJson)) expected.set(l.productId, { sku: l.sku, units: (expected.get(l.productId)?.units ?? 0) + l.units });
    if (!Array.isArray(lines) || lines.length !== expected.size) throw new LogisticsError('lines_mismatch', 'Chaque article expédié doit être déclaré', 400);
    const out = [];
    for (const l of lines) {
      const e = expected.get(l.productId);
      const nums = ['received', 'damaged', 'missing', 'refused'].map((k) => l[k] ?? 0);
      if (!e || nums.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new LogisticsError('lines_mismatch', 'Ligne invalide', 400);
      if (nums.reduce((a, b) => a + b, 0) !== e.units) throw new LogisticsError('quantity_mismatch', `${e.sku} : reçu + abîmé + manquant + refusé doit égaler ${e.units}`, 400);
      out.push({ productId: l.productId, sku: e.sku, expected: e.units, received: nums[0], damaged: nums[1], missing: nums[2], refused: nums[3] });
    }
    const outcome = out.every((l) => l.received === l.expected) ? 'full'
      : out.every((l) => l.refused === l.expected) ? 'refused'
        : out.some((l) => l.missing > 0) ? (out.every((l) => l.received === 0 && l.damaged === 0) ? 'missing' : 'partial')
          : out.some((l) => l.damaged > 0) ? 'damaged' : 'partial';
    let cur = sh;
    if (sh.status === 'delivery_arrived') cur = await completeDeliveryInTx(tx, sh, request, { proof: 'receiver_receiving', actorType: 'receiver', actorId: userId });
    const rec = await tx.receivingRecord.create({ data: { shipmentId: sh.id, receiverBusinessId: request.destinationBusinessId, receiverUserId: userId, outcome, linesJson: JSON.stringify(out), note: note ? String(note).slice(0, 300) : null } });
    await onReceiving(tx, request, cur, rec, out);
    await emitCommerceEvent(tx, { type: 'shipment.received', businessId: request.destinationBusinessId, aggregateType: 'shipment', aggregateId: sh.id, payload: { outcome } });
    return { receiving: receivingView(rec), shipment: shipmentView(cur, { role: 'receiver', request }) };
  });
}
const receivingView = (r) => ({ outcome: r.outcome, lines: JSON.parse(r.linesJson), at: r.createdAt.toISOString() });

/** A pickup point records it physically received the parcel from the source (pickup point operator). */
export async function dropAtPoint(userId, shipmentId) {
  return prisma.$transaction(async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    if (!request.pickupPointId) throw notFound();
    const { requirePointOperator } = await import('./pickup-points.js');
    await requirePointOperator(userId, request.pickupPointId, 'customer_pickup', tx).catch(() => { throw notFound(); });
    if (sh.status === 'at_pickup_point') return { ...shipmentView(sh, { role: 'pickup_point', request }), replayed: true };
    if (sh.status !== 'ready_for_pickup') throw new LogisticsError('invalid_state', 'Pas prête');
    return shipmentView(await transition(tx, sh, 'at_pickup_point', { actorType: 'pickup_point', actorId: userId }), { role: 'pickup_point', request });
  });
}

/** The releasing desk (source staff, or the pickup point when one is set) submits the receiver's collection code. Released once. */
export async function releaseCollection(userId, shipmentId, { code }) {
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    if (request.fulfilmentOwner !== 'CUSTOMER_PICKUP') throw notFound();
    if (request.pickupPointId) {
      const { requirePointOperator } = await import('./pickup-points.js');
      await requirePointOperator(userId, request.pickupPointId, 'customer_pickup', tx).catch(() => { throw notFound(); });
      if (sh.status !== 'at_pickup_point' && sh.status !== 'delivered') throw new LogisticsError('invalid_state', 'Le colis n’est pas au point de retrait');
    } else {
      await asSource(tx, userId, request);
    }
    if (sh.status === 'delivered') {
      if (await alreadyDone(tx, sh, { purpose: 'collection', userId, code })) return { ...shipmentView(sh, { role: 'source', request }), replayed: true };
      throw new LogisticsError('invalid_state', 'Déjà remis');
    }
    if (!['ready_for_pickup', 'at_pickup_point'].includes(sh.status)) throw new LogisticsError('invalid_state', 'Pas prêt au retrait');
    if (request.destinationUserId === userId) throw new LogisticsError('forbidden', 'On ne se remet pas son propre colis', 403);
    await consumeChallengeInTx(tx, sh, { purpose: 'collection', userId, code });
    return shipmentView(await completeDeliveryInTx(tx, sh, request, { proof: 'pickup_point_release', actorType: request.pickupPointId ? 'pickup_point' : 'source', actorId: userId }), { role: 'source', request });
  });
}

/* ── cancellation, operator rulings ───────────────────────────────────── */

/** Before pickup only: the source (or ops for Jokko Logistics). The held fee is refunded once. */
export async function cancelShipment(actor, shipmentId, { reason }) {
  if (!(reason && String(reason).trim().length >= 3)) throw new LogisticsError('reason_required', 'Motif requis', 400);
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    if (actor.type === 'admin') {
      if (request.fulfilmentOwner !== 'JOKKO_LOGISTICS') throw notFound();
    } else {
      await asSource(tx, actor.userId, request);
    }
    if (!['requested', 'accepted', 'ready_for_pickup', 'assigned', 'pickup_arrived'].includes(sh.status)) throw new LogisticsError('invalid_state', TERMINAL.has(sh.status) ? 'Expédition terminée' : 'La marchandise est déjà partie — signale un échec ou un retour');
    await tx.courierAssignment.updateMany({ where: { shipmentId: sh.id, status: 'active' }, data: { status: 'ended', endedAt: new Date(), endReason: 'cancelled' } });
    const c = await transition(tx, sh, 'cancelled', { actorType: actor.type, actorId: actor.type === 'admin' ? actor.adminId : actor.userId, note: reason });
    await onCancelled(tx, request, c, { actorUserId: actor.type === 'admin' ? null : actor.userId });
    if (request.feeKori > 0) await refundFeeInTx(tx, request, { reason: 'cancelled' });
    await tx.fulfilmentRequest.update({ where: { id: request.id }, data: { status: 'cancelled' } });
    return shipmentView(c, { role: 'source', request });
  });
}

/** Operator ruling on a courier exception (logistics.exceptions.resolve). Evidence note required; ruling once. */
export async function ruleException(adminId, shipmentId, { outcome, evidence }) {
  if (!['delivered', 'failed'].includes(outcome)) throw new LogisticsError('invalid', 'Décision inconnue', 400);
  if (!(evidence && String(evidence).trim().length >= 10)) throw new LogisticsError('evidence_required', 'Preuve / motif requis', 400);
  return runMoneyTransaction(prisma, async (tx) => {
    const { sh, request } = await lockShipment(tx, shipmentId);
    if (sh.status !== 'delivery_exception') throw new LogisticsError('invalid_state', 'Aucune exception à trancher');
    let out;
    if (outcome === 'delivered') out = await completeDeliveryInTx(tx, sh, request, { proof: 'operator_ruling', actorType: 'admin', actorId: adminId });
    else out = await transition(tx, sh, 'delivery_failed', { actorType: 'admin', actorId: adminId, evidence: 'operator_ruling', note: evidence, data: { failureReason: 'operational' } });
    const { recordIdentityEvent } = await import('../identity/audit.js');
    await recordIdentityEvent(tx, { actorType: 'admin', actorId: adminId, action: 'shipment_exception_ruled', subjectType: 'shipment', subjectId: sh.id, reason: String(evidence).slice(0, 300), after: { outcome } });
    return shipmentView(out, { role: 'operator', request });
  });
}

/** J8.3 retention: precise destination data is removed once a movement is long finished. */
export async function redactPreciseDestinations(db = prisma, now = new Date(), days = 7) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const r = await db.shipment.updateMany({
    where: { status: { in: ['delivered', 'returned', 'cancelled'] }, updatedAt: { lt: cutoff }, preciseRedactedAt: null },
    data: { destPrecise: null, destLat: null, destLng: null, preciseRedactedAt: now },
  });
  return { redacted: r.count };
}
