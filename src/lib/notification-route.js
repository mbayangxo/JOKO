/**
 * J13 — which kind a notification is, and where it opens. Pure (unit-tested). Every kind the server emits
 * should lead somewhere useful; a kind with no route shows no action button rather than a dead one.
 */
export function inferKind(notification) {
  if (String(notification.kind ?? '').startsWith('shipment_')) return 'delivery';
  if (String(notification.kind ?? '').startsWith('work_')) return 'work';
  if (notification.kind === 'alert') return 'alert';
  if (notification.kind === 'friend') return 'friend';
  if (notification.kind === 'call') return 'call';
  if (notification.kind === 'gift_receive') return 'gift';
  if (notification.kind === 'affiliate') return 'affiliate';
  if (notification.kind === 'money_request') return 'money';
  if (notification.kind === 'hub_parcel') return 'parcel';
  if (notification.kind === 'marketplace_order') return 'order';
  if (notification.kind === 'low_stock') return 'stock';
  if (notification.kind === 'support_ticket') return 'support';
  if (String(notification.kind ?? '').startsWith('trade_')) return 'trade';
  if (String(notification.kind ?? '').startsWith('scheduled_')) return 'scheduled';
  if (String(notification.kind ?? '').startsWith('agent_')) return 'agent';
  if (notification.kind === 'business_invitation' || notification.kind === 'distribution_invitation') return 'business';
  // J13-F3: Jëkkal notifications (new donation, goal reached) were mapped to 'generic' and opened nothing.
  if (notification.kind === 'jekkal') return 'jekkal';
  const t = `${notification.title} ${notification.body}`
    .toLowerCase()
    .replace(/[''`´]/g, "'");
  if (t.includes("demande d'ami") || t.includes('ajouter sur k21')) return 'friend';
  if (t.includes('appel entrant') || t.includes('appel vidéo') || t.includes('t’appelle sur mboolo')) return 'call';
  if (t.includes('demande')) return 'money';
  if (t.includes('mboolo') || t.includes('message')) return 'mboolo';
  if (t.includes('événement') || t.includes('event') || t.includes('concert')) return 'event';
  if (t.includes('tontine')) return 'tontine';
  if (t.includes('ngor') || t.includes('kersa') || t.includes('wakhna')) return 'ngor';
  return 'generic';
}


// Screens registered only inside the Marketplace tab's stack: from the root-level Notifications screen they
// must be reached through Main → MarketplaceTab (a bare navigate('TradeInvoices') silently does nothing —
// found by the J13 browser suite).
export const MARKETPLACE_STACK_SCREENS = new Set(['HubParcel', 'HubParcelDetail', 'MerchantOrders', 'TradeInvoices']);

function to(target, params) {
  if (MARKETPLACE_STACK_SCREENS.has(target)) {
    return { screen: 'Main', params: { screen: 'MarketplaceTab', params: { screen: target, params } }, target, targetParams: params };
  }
  return { screen: target, params, target, targetParams: params };
}

/**
 * Routes for the kinds handled generically (the screen keeps its own cases for the older kinds).
 * Only a parcel carries the notification's refId; the destination loads it through the normal
 * authenticated endpoint, so the server — not the notification — decides what the viewer may see.
 */
export function routeForKind(kind, refId) {
  switch (kind) {
    case 'parcel':
      return refId ? to('HubParcelDetail', { parcelId: refId }) : to('HubParcel', undefined);
    case 'order':
      return to('MerchantOrders', undefined);
    case 'stock':
    case 'business':
      return to('BusinessMain', undefined);
    case 'support':
      return to('Support', undefined);
    case 'trade':
      return to('TradeInvoices', undefined);
    case 'scheduled':
      return to('ScheduledPayments', undefined);
    case 'agent':
      return to('AgentHome', undefined);
    default:
      return null;
  }
}
