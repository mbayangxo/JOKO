/**
 * J5 omnichannel contract (docs/JOKKO-ECONOMIC-OS-ARCHITECTURE.md §4).
 *
 * One canonical business, catalog, inventory, order, payment and fulfilment
 * model. Every channel enters through an ADAPTER that maps its input into
 * that model — no channel gets its own merchant silo. A channel is either
 * ACTIVE (operable now) or DORMANT (architected, refused at runtime, never
 * shown as available in production UI).
 *
 * `system`: which system is the source of truth for the ORDER workflow.
 *  - 'jokko'  — Jokko Business Lite owns the order (lib/commerce/orders.js).
 *  - 'kabu'   — Kabu Shop owns the order; Jokko only holds references
 *               (payment, payout, logistics) via ExternalLink + events.
 *  - 'marketplace' — the marketplace surface (Askaan/Askoo) originates the
 *               order; the SELLER's system of record owns it (Kabu or Jokko).
 */
export const CHANNELS = {
  jokko_app: { status: 'ACTIVE', system: 'jokko', label: 'Application Jokko (catalogue du commerce)' },
  jokko_qr: { status: 'ACTIVE', system: 'jokko', label: 'QR Jokko (paiement / référence marchand)' },
  mbolo: { status: 'ACTIVE', system: 'jokko', label: 'Mbolo (commande depuis une conversation)' },
  pos_manual: { status: 'ACTIVE', system: 'jokko', label: 'Caisse / vente manuelle' },
  payment_link: { status: 'ACTIVE', system: 'jokko', label: 'Lien de paiement (référence QR partageable)' },
  kabu_shop: { status: 'DORMANT', system: 'kabu', label: 'Kabu Shop (via contrat d’intégration)' },
  marketplace_askaan: { status: 'DORMANT', system: 'marketplace', label: 'Askaan / Askoo' },
  external_web: { status: 'DORMANT', system: 'external', label: 'Site externe (via API partenaire)' },
  whatsapp: { status: 'DORMANT', system: 'external', label: 'WhatsApp / messagerie business' },
  restaurant_ordering: { status: 'DORMANT', system: 'jokko', label: 'Commande restaurant' },
};

export class ChannelError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.status = status;
  }
}

/** Refuse a channel that is not operable (never fake an integration). */
export function assertChannelActive(channel) {
  const c = CHANNELS[channel];
  if (!c) throw new ChannelError('unknown_channel', `Canal inconnu : ${channel}`, 400);
  if (c.status !== 'ACTIVE') throw new ChannelError('channel_not_activated', `${c.label} : pas encore activé`, 409);
  return c;
}

/**
 * Adapter contract every future channel implements: normalize its own order
 * into the canonical input of placeMarketplaceOrder / recordPayment, keeping
 * its own id as `externalOrderRef`. Kabu-owned orders do NOT become Jokko
 * orders: only the Jokko component (payment, payout, fulfilment request) is
 * created, referencing the Kabu id through ExternalLink.
 *
 * @typedef {{ channel: string, sourceSystem: string, externalOrderRef?: string,
 *   businessId: string, buyerId?: string, items?: {productId: string, quantity: number}[],
 *   fulfillmentType?: 'pickup'|'delivery', fulfillmentOwner?: 'merchant'|'jokko' }} CanonicalOrderInput
 */
export const ADAPTER_CONTRACT_VERSION = '2026-10-j5';
