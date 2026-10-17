import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { ORDER_LABELS } from '../commerce/orders.js';
import { unreadSummary } from './notify.js';

/**
 * J10-S1 "Aujourd'hui": one honest list of what needs this person now, built ONLY from their own
 * real objects (no suggestions, no fabricated content, no engagement bait). Each item names the
 * object, why it matters and where to act; acting always happens in the object's own flow.
 * Read-only: nothing here changes state. Compact for low-bandwidth use; an ETag lets the client
 * skip unchanged payloads.
 */
const DAY = 86_400_000;
const OPEN_ORDER = ['pending_payment', 'confirmed', 'pending_delivery', 'preparing', 'ready_for_pickup', 'out_for_delivery'];
const OPEN_SHIPMENT = ['requested', 'accepted', 'ready_for_pickup', 'assigned', 'pickup_arrived', 'picked_up', 'in_transit', 'delivery_arrived', 'delivery_failed', 'delivery_exception', 'at_pickup_point'];
const SHIPMENT_LABEL = {
  requested: 'Préparation', accepted: 'Préparation', ready_for_pickup: 'Prêt chez le vendeur', assigned: 'Livreur assigné', pickup_arrived: 'Livreur chez le vendeur',
  picked_up: 'En route', in_transit: 'En route', delivery_arrived: 'Livreur arrivé', delivery_failed: 'Livraison manquée', delivery_exception: 'Incident de livraison', at_pickup_point: 'À retirer au point relais',
};
async function openShipmentsFor(userId) {
  const reqs = await prisma.fulfilmentRequest.findMany({ where: { destinationUserId: userId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, reference: true } });
  if (!reqs.length) return [];
  const ref = new Map(reqs.map((r) => [r.id, r.reference]));
  const sh = await prisma.shipment.findMany({ where: { requestId: { in: [...ref.keys()] }, status: { in: OPEN_SHIPMENT } }, orderBy: { updatedAt: 'desc' }, take: 10, select: { id: true, status: true, requestId: true } });
  return sh.map((s) => ({ ...s, request: { reference: ref.get(s.requestId) } }));
}
async function activeAssignmentsFor(userId) {
  const as = await prisma.workAssignment.findMany({ where: { workerUserId: userId, status: 'active' }, take: 10, select: { id: true, reference: true } });
  if (!as.length) return [];
  const ms = await prisma.workMilestone.findMany({ where: { assignmentId: { in: as.map((a) => a.id) }, status: 'pending' }, orderBy: { seq: 'asc' }, select: { assignmentId: true, seq: true, title: true } });
  return as.map((a) => ({ ...a, milestones: ms.filter((m) => m.assignmentId === a.id) }));
}
const name = (u) => u?.name?.split(' ')[0] ?? (u?.handle ? `@${u.handle}` : 'Quelqu’un');

export async function todayFor(userId, now = new Date()) {
  const soon = new Date(now.getTime() + 14 * DAY);
  const [moneyReqs, friendReqs, msgReqs, orders, shipments, offers, assignments, releasable, fees, tickets, tontines, unread] = await Promise.all([
    prisma.moneyRequest.findMany({ where: { payerId: userId, status: 'pending', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: { createdAt: 'desc' }, take: 10, include: { requester: { select: { name: true, handle: true } } } }),
    prisma.friendRequest.count({ where: { toId: userId, status: 'pending' } }),
    prisma.mboloMember.count({ where: { userId, status: 'requested' } }),
    prisma.order.findMany({ where: { buyerId: userId, status: { in: OPEN_ORDER } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, orderReference: true, status: true, totalAmount: true, business: { select: { name: true } } } }),
    openShipmentsFor(userId),
    prisma.workOffer.findMany({ where: { workerUserId: userId, status: 'sent', expiresAt: { gt: now } }, orderBy: { expiresAt: 'asc' }, take: 5, select: { id: true, reference: true, totalKori: true, expiresAt: true } }),
    activeAssignmentsFor(userId),
    prisma.workEarning.aggregate({ where: { workerUserId: userId, status: 'releasable' }, _sum: { amountKori: true } }),
    prisma.schoolFeePayment.findMany({ where: { parentUserId: userId, status: 'pending' }, take: 10, select: { id: true, amount: true, period: { select: { label: true, dueDate: true } }, student: { select: { studentName: true } } } }),
    prisma.ticket.findMany({ where: { buyerId: userId, status: 'paid', event: { startsAt: { gte: now, lte: soon } } }, take: 5, select: { id: true, quantity: true, event: { select: { title: true, startsAt: true, venue: true } } } }),
    prisma.tontineMembership.findMany({ where: { userId, status: 'accepted', group: { status: 'active', nextDueAt: { lte: new Date(now.getTime() + 7 * DAY) } } }, take: 5, select: { group: { select: { id: true, name: true, nextDueAt: true, contributionKori: true, amountPerMember: true } } } }),
    unreadSummary(userId),
  ]);

  const items = [];
  for (const r of moneyReqs) items.push({ type: 'money_request', id: r.id, priority: 1, title: `${name(r.requester)} te demande ${r.amount.toLocaleString('fr-FR')}`, detail: r.expiresAt ? `Expire le ${r.expiresAt.toLocaleDateString('fr-SN')}` : 'Demande d’argent', route: 'Receive', params: { mode: 'inbox', requestId: r.id } });
  for (const o of offers) items.push({ type: 'work_offer', id: o.id, priority: 1, title: 'Offre de travail à accepter', detail: `${o.reference} · avant le ${o.expiresAt.toLocaleDateString('fr-SN')}`, route: 'Work' });
  for (const f of fees) items.push({ type: 'school_fee', id: f.id, priority: f.period?.dueDate && f.period.dueDate < now ? 1 : 2, title: `Frais de scolarité · ${f.student?.studentName ?? 'élève'}`, detail: `${f.period?.label ?? ''} · ${f.amount.toLocaleString('fr-FR')}${f.period?.dueDate ? ` · échéance ${f.period.dueDate.toLocaleDateString('fr-SN')}` : ''}`, route: 'Wallet' });
  for (const t of tontines) items.push({ type: 'tontine_due', id: t.group.id, priority: 2, title: `Natt « ${t.group.name} »`, detail: `Cotisation ${(t.group.contributionKori ?? t.group.amountPerMember).toLocaleString('fr-FR')} · ${t.group.nextDueAt.toLocaleDateString('fr-SN')}`, route: 'Tontine' });
  for (const s of shipments) items.push({ type: 'delivery', id: s.id, priority: ['delivery_arrived', 'at_pickup_point', 'delivery_failed'].includes(s.status) ? 1 : 3, title: SHIPMENT_LABEL[s.status] ?? 'Livraison en cours', detail: s.request?.reference ?? '', route: 'Shipment', params: { shipmentId: s.id } });
  for (const o of orders) items.push({ type: 'order', id: o.id, priority: o.status === 'ready_for_pickup' ? 1 : 3, title: `${o.business?.name ?? 'Commande'} · ${ORDER_LABELS[o.status] ?? o.status}`, detail: `${o.orderReference ?? ''} · ${o.totalAmount.toLocaleString('fr-FR')}`, route: null });
  for (const a of assignments) {
    if (a.milestones.length) items.push({ type: 'work_todo', id: a.id, priority: 2, title: `Mission ${a.reference}`, detail: `${a.milestones.length} étape(s) à envoyer · ${a.milestones[0].title}`, route: 'Work' });
  }
  const earn = releasable._sum.amountKori ?? 0;
  if (earn > 0) items.push({ type: 'work_earnings', id: 'earnings', priority: 2, title: 'Gains disponibles', detail: `${earn.toLocaleString('fr-FR')} à verser sur ton portefeuille`, route: 'Work' });
  if (friendReqs) items.push({ type: 'connection_requests', id: 'friends', priority: 3, title: `${friendReqs} demande(s) de contact`, detail: 'Accepte ou ignore', route: 'Friends' });
  if (msgReqs) items.push({ type: 'message_requests', id: 'mbolo-requests', priority: 3, title: `${msgReqs} demande(s) de message`, detail: 'De personnes que tu ne connais pas encore', route: 'Main', params: { screen: 'MbooloTab' } });
  for (const t of tickets) items.push({ type: 'ticket', id: t.id, priority: 4, title: t.event.title, detail: `${t.event.startsAt.toLocaleString('fr-SN', { dateStyle: 'medium', timeStyle: 'short' })}${t.event.venue ? ` · ${t.event.venue}` : ''} · ${t.quantity} billet(s)`, route: 'MyTickets' });

  items.sort((a, b) => a.priority - b.priority);
  const body = { items, unread: { total: unread.total, byCategory: unread.byCategory }, empty: items.length === 0 };
  const etag = `"${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 20)}"`;
  return { body, etag };
}
