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


/** Routes for the kinds handled generically (the screen keeps its own cases for the older kinds). */
export function routeForKind(kind, refId) {
  switch (kind) {
    case 'parcel':
      return refId ? { screen: 'HubParcelDetail', params: { parcelId: refId } } : { screen: 'HubParcel', params: undefined };
    case 'order':
      return { screen: 'MerchantOrders', params: undefined };
    case 'stock':
    case 'business':
      return { screen: 'BusinessMain', params: undefined };
    case 'support':
      return { screen: 'Support', params: undefined };
    case 'trade':
      return { screen: 'TradeInvoices', params: undefined };
    case 'scheduled':
      return { screen: 'ScheduledPayments', params: undefined };
    case 'agent':
      return { screen: 'AgentHome', params: undefined };
    default:
      return null;
  }
}
