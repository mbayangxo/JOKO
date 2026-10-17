/**
 * J5 — merchant-mode UX rules, free of React so they are unit tested in Node
 * (tests/j5/business-ux.test.js). The server re-checks every action; these
 * rules only decide what a person is shown, from THEIR capabilities.
 */

/** Sections of merchant mode, in the order a small merchant uses them. */
export const SECTIONS = [
  { key: 'today', label: "Aujourd'hui", needs: [] },
  { key: 'payments', label: 'Encaisser', needs: ['business.charges.create', 'business.charges.read'] },
  { key: 'orders', label: 'Commandes', needs: ['business.orders.read'] },
  { key: 'products', label: 'Produits', needs: ['business.catalog.manage'] },
  { key: 'stock', label: 'Stock', needs: ['business.inventory.adjust'] },
  { key: 'customers', label: 'Clients', needs: ['business.customers.read'] },
  { key: 'team', label: 'Équipe', needs: ['business.members.manage'] },
  { key: 'activity', label: 'Activité', needs: ['business.activity.read', 'business.wallet.read', 'business.analytics.read'] },
  { key: 'settings', label: 'Réglages', needs: ['business.profile.manage'] },
];

/** Sections visible for a capability list (any one of `needs` is enough). */
export function visibleSections(capabilities = []) {
  const caps = new Set(capabilities);
  return SECTIONS.filter((s) => s.needs.length === 0 || s.needs.some((c) => caps.has(c)));
}

export function can(access, capability) {
  return Boolean(access?.capabilities?.includes(capability));
}

const NEXT_LABEL = {
  preparing: 'Accepter et préparer',
  ready_for_pickup: 'Prête à retirer',
  out_for_delivery: 'Partie en livraison',
  delivered: 'Livrée',
  completed: 'Terminer',
};

/** Buttons for one order (from the server's `actions`, filtered by capability). */
export function orderButtons(order, access) {
  const out = [];
  if (can(access, 'business.orders.fulfill')) {
    for (const to of order.actions?.next ?? []) out.push({ kind: 'move', to, label: NEXT_LABEL[to] ?? to, primary: true });
  }
  if (order.actions?.cancel && can(access, 'business.orders.cancel')) out.push({ kind: 'cancel', label: 'Annuler (rembourse le client)', needsReason: true });
  if (order.actions?.refund && can(access, 'business.refund')) out.push({ kind: 'refund', label: 'Rembourser', needsReason: true });
  return out;
}

/** One business money line: never invent an amount the server withheld. */
export function moneyLine(item) {
  if (item.category === 'restricted') return { label: item.label, amount: '—', tone: 'muted' };
  const sign = item.direction === 'in' ? '+' : '−';
  return { label: item.label, amount: `${sign}${item.amountKori} ₭`, tone: item.direction === 'in' ? 'in' : 'out' };
}

/** Stock badge for a catalog item. */
export function stockBadge(item) {
  if (item.kind === 'service' || !item.trackInventory) return { label: 'Service / sans stock', tone: 'muted' };
  if (item.inventory < 0) return { label: `${-item.inventory} en commande (rupture)`, tone: 'warn' };
  if (item.inventory === 0) return { label: 'Rupture', tone: 'warn' };
  if (item.lowStock) return { label: `Stock bas : ${item.inventory}`, tone: 'warn' };
  return { label: `En stock : ${item.inventory}`, tone: 'ok' };
}

/** Charge state for the cashier (pending / paid / expired / cancelled). */
export function chargeState(charge, now = new Date()) {
  if (charge.status === 'paid') return { label: 'Payé', tone: 'ok', showQr: false };
  if (charge.status === 'cancelled') return { label: 'Annulé', tone: 'muted', showQr: false };
  if (charge.status === 'expired' || new Date(charge.expiresAt) <= now) return { label: 'Expiré', tone: 'muted', showQr: false };
  return { label: 'En attente du paiement', tone: 'pending', showQr: true };
}

/** Validates a reason before calling cancel/refund (the server re-validates). */
export function reasonProblem(reason) {
  return String(reason ?? '').trim().length >= 3 ? null : 'Indique un motif (3 caractères minimum).';
}
