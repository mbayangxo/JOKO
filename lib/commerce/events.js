/**
 * J5 commerce event outbox (docs/JOKKO-ECONOMIC-OS-ARCHITECTURE.md §8, §11).
 *
 * Written in the SAME transaction as the state change, so an event exists if
 * and only if the change committed. Consumers read the outbox and mark rows
 * published: future Jokko Logistics (fulfilment / delivery), Kabu webhooks,
 * and the privacy-preserving demand aggregates. Logistics never lives in
 * payment or order handlers — it reacts to these events.
 *
 * Event types (contract, version 2026-10-j5):
 *   order.placed · order.paid · order.accepted · order.ready_for_fulfillment
 *   order.out_for_delivery · order.delivered · order.completed
 *   order.cancelled · order.refunded · payment.recorded
 *   fulfillment.requested (DORMANT consumer: Jokko Logistics)
 *   relationship.invited · relationship.accepted · relationship.ended
 * Payloads carry ids and amounts only — never names, phones or addresses.
 */
export async function emitCommerceEvent(tx, { type, businessId = null, aggregateType, aggregateId, payload = {} }) {
  return tx.commerceEvent.create({
    data: { type, businessId, aggregateType, aggregateId: String(aggregateId), payloadJson: JSON.stringify(payload) },
  });
}

export const ORDER_STATUS_EVENTS = {
  preparing: 'order.accepted',
  ready_for_pickup: 'order.ready_for_fulfillment',
  out_for_delivery: 'order.out_for_delivery',
  delivered: 'order.delivered',
  completed: 'order.completed',
};
