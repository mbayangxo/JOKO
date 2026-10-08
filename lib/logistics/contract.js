/**
 * J8 logistics contract (docs/JOKKO-J8-LOGISTICS.md).
 *
 * commerce ≠ logistics ≠ money:
 *   - J5 / J7 own the commercial obligation (order, purchase order, return).
 *   - J8 owns PHYSICAL movement: who holds the goods, where, and the proof.
 *   - J2 owns money (delivery fee escrow, courier earnings).
 * A FulfilmentRequest REFERENCES its source (sourceSystem + sourceId); it never
 * copies the order. J8 reaches commerce only through lib/logistics/commerce-adapter.js.
 */
export class LogisticsError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'LogisticsError';
    this.code = code;
    this.status = status;
  }
}

export const FULFILMENT_OWNERS = {
  MERCHANT_FULFILLED: { status: 'ACTIVE', label: 'Livré par le commerçant' },
  DISTRIBUTOR_FULFILLED: { status: 'ACTIVE', label: 'Livré par le distributeur (sa flotte)' },
  CUSTOMER_PICKUP: { status: 'ACTIVE', label: 'Retrait par le client' },
  JOKKO_LOGISTICS: { status: 'GATED', label: 'Jokko Logistics (coursiers agréés K21)' },
  JOKKO_FULFILLMENT_CENTER: { status: 'DORMANT', label: 'Centre de préparation Jokko (n’existe pas)' },
};

/** Jokko Logistics is code-complete but OPERATIONALLY NOT ACTIVATED unless explicitly enabled. */
export const jokkoLogisticsEnabled = () => process.env.JOKKO_LOGISTICS_ENABLED === 'true';

export const SERVICE_TYPES = {
  local: { status: 'ACTIVE', label: 'Local (même ville)' },
  intercity: { status: 'DORMANT', label: 'Interurbain' },
  regional: { status: 'DORMANT', label: 'Régional' },
};

/** Status → who must hold the goods (the DB trigger enforces the same map). */
export const CUSTODY_OF = {
  requested: 'source', accepted: 'source', ready_for_pickup: 'source', assigned: 'source', pickup_arrived: 'source',
  picked_up: 'courier', in_transit: 'courier', delivery_arrived: 'courier', delivery_failed: 'courier', delivery_exception: 'courier',
  return_requested: 'courier', return_in_transit: 'courier',
  at_pickup_point: 'pickup_point',
  delivered: 'receiver',
  returned: 'source', cancelled: 'source',
};
export const TERMINAL = new Set(['delivered', 'returned', 'cancelled']);
export const COURIER_ACTIVE = new Set(['assigned', 'pickup_arrived', 'picked_up', 'in_transit', 'delivery_arrived', 'delivery_failed', 'delivery_exception', 'return_requested', 'return_in_transit']);

/** Who may perform each transition (enforced in shipments.js). */
export const TRANSITIONS = {
  accept: { from: ['requested'], to: 'accepted', actor: 'fulfiller' },
  ready: { from: ['accepted'], to: 'ready_for_pickup', actor: 'source' },
  assign: { from: ['ready_for_pickup'], to: 'assigned', actor: 'dispatcher' },
  unassign: { from: ['assigned', 'pickup_arrived'], to: 'ready_for_pickup', actor: 'dispatcher' },
  arrive_pickup: { from: ['assigned'], to: 'pickup_arrived', actor: 'courier' },
  pickup: { from: ['assigned', 'pickup_arrived'], to: 'picked_up', actor: 'courier+source_code' },
  depart: { from: ['picked_up'], to: 'in_transit', actor: 'courier' },
  arrive_delivery: { from: ['picked_up', 'in_transit'], to: 'delivery_arrived', actor: 'courier' },
  deliver: { from: ['picked_up', 'in_transit', 'delivery_arrived'], to: 'delivered', actor: 'courier+receiver_code | receiver' },
  fail: { from: ['picked_up', 'in_transit', 'delivery_arrived'], to: 'delivery_failed', actor: 'courier' },
  exception: { from: ['picked_up', 'in_transit', 'delivery_arrived'], to: 'delivery_exception', actor: 'courier' },
  rule: { from: ['delivery_exception'], to: 'delivered | delivery_failed', actor: 'operator' },
  return_start: { from: ['delivery_failed'], to: 'return_in_transit', actor: 'courier' },
  return_complete: { from: ['return_in_transit'], to: 'returned', actor: 'courier+source_code' },
  drop_at_point: { from: ['ready_for_pickup'], to: 'at_pickup_point', actor: 'pickup_point_operator' },
  collect: { from: ['ready_for_pickup', 'at_pickup_point'], to: 'delivered', actor: 'releaser+receiver_code' },
  cancel: { from: ['requested', 'accepted', 'ready_for_pickup', 'assigned', 'pickup_arrived'], to: 'cancelled', actor: 'requester | fulfiller' },
};

export const FAILURE_REASONS = {
  receiver_unavailable: { side: 'receiver', label: 'Destinataire absent' },
  address_problem: { side: 'receiver', label: 'Adresse introuvable' },
  refused: { side: 'receiver', label: 'Refusé à la livraison' },
  merchant_closed: { side: 'receiver', label: 'Commerce fermé' },
  unsafe: { side: 'operational', label: 'Livraison dangereuse' },
  damaged: { side: 'operational', label: 'Colis endommagé' },
  courier_issue: { side: 'operational', label: 'Problème coursier' },
  operational: { side: 'operational', label: 'Annulation opérationnelle' },
};

/** Precise destination is visible to the assigned courier only while the movement is live. */
export const PRECISE_RETENTION_DAYS = 7;

export function shipmentView(sh, { role, events = null, request = null }) {
  const base = {
    id: sh.id,
    reference: sh.reference,
    status: sh.status,
    custody: sh.custody,
    deliveryProof: sh.deliveryProof,
    deliveredAt: sh.deliveredAt?.toISOString() ?? null,
    failureReason: sh.failureReason,
    destination: { area: sh.destArea ?? null },
    ...(request ? { fulfilmentOwner: request.fulfilmentOwner, serviceType: request.serviceType, feeKori: role === 'courier' ? undefined : request.feeKori } : {}),
  };
  if (role === 'courier' && COURIER_ACTIVE.has(sh.status) && !sh.preciseRedactedAt) {
    base.destination = { area: sh.destArea ?? null, precise: sh.destPrecise ?? null, lat: sh.destLat ?? null, lng: sh.destLng ?? null };
  }
  if (events) base.history = events.map((e) => ({ from: e.fromStatus, to: e.toStatus, at: e.createdAt.toISOString(), evidence: e.evidence ?? null }));
  return base;
}
