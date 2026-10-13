import { tierShape } from './tier-limits.js';

function arrondissement(user) {
  return {
    key: user.arrondissementKey ?? '',
    icon: user.arrondissementIcon ?? '📍',
    name: user.arrondissementName ?? '',
  };
}

export function profileShape(user, extras = {}) {
  return {
    id: user.id,
    name: user.name ?? '',
    handle: user.handle ?? '',
    phone: user.phone ?? '',
    email: user.email ?? '',
    afriId: user.afriId ?? '',
    arrondissement: arrondissement(user),
    avatarEmoji: user.avatarEmoji ?? null,
    avatarUrl: user.avatarUrl ?? null,
    verification: tierShape(user),
    smsBalanceQueryEnabled: user.smsBalanceQueryEnabled ?? true,
    statusText: user.statusText ?? null,
    currentSong: user.currentSong ?? null,
    pinnedPhotos: Array.isArray(user.pinnedPhotos) ? user.pinnedPhotos : [],
    ...extras,
  };
}

/** What OTHER members see — only what the user chose to show. Never phone,
 * email, AFRI ID, or anything financial. */
export function publicProfileShape(user, extras = {}) {
  return {
    name: user.name ?? '',
    handle: user.handle ?? '',
    arrondissement: arrondissement(user),
    avatarEmoji: user.avatarEmoji ?? null,
    avatarUrl: user.avatarUrl ?? null,
    verified: (tierShape(user)?.tier ?? 1) >= 2,
    statusText: user.statusText ?? null,
    currentSong: user.currentSong ?? null,
    pinnedPhotos: Array.isArray(user.pinnedPhotos) ? user.pinnedPhotos : [],
    ...extras,
  };
}

/** Public card shown before sending money (safety screen). */
/**
 * Recipient preview. The full phone is returned only when the searcher already
 * typed that phone number; a handle lookup gets a masked number (last 4) so a
 * public handle can't be turned into someone's phone number.
 */
export function recipientLookupShape(user, { revealPhone = false } = {}) {
  const tier = tierShape(user)?.tier ?? 1;
  const phone = String(user.phone ?? '');
  return {
    name: user.name ?? '',
    handle: user.handle ?? '',
    phone: phone.startsWith('e:') ? '' : revealPhone ? phone : phone ? `•••• ${phone.slice(-4)}` : '',
    avatarEmoji: user.avatarEmoji ?? null,
    avatarUrl: user.avatarUrl ?? null,
    arrondissement: arrondissement(user),
    verified: tier >= 2,
    verificationTier: tier,
  };
}

/** Public merchant card for QR scan → pay (no owner PII). */
export function merchantPublicShape(business) {
  return {
    id: business.id,
    name: business.name,
    category: business.category ?? null,
    arrondissement: business.arrondissement ?? null,
    kebuId: business.kebuId ?? null,
    verified: Boolean(business.verified),
    type: business.type ?? 'merchant',
  };
}

function relativeTimeFr(date) {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "À l'instant";
  if (minutes < 60) return `Il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Il y a ${hours}h`;
  if (hours < 48) return 'Hier';
  return `Il y a ${Math.floor(hours / 24)} jours`;
}

const txMeta = {
  external_topup: { icon: '💰', iconBg: 'rgba(26,240,96,0.08)', title: () => 'Dépôt initial' },
  cash_in: { icon: '💰', iconBg: 'rgba(26,240,96,0.08)', title: () => 'Dépôt K21' },
  cash_out: { icon: '🏧', iconBg: 'rgba(232,92,26,0.08)', title: () => 'Retrait K21' },
  send: { icon: '💸', iconBg: 'rgba(26,240,96,0.08)', title: (tx) => `Envoyé à ${tx.counterpartyName ?? 'K21'}` },
  receive: { icon: '📥', iconBg: 'rgba(26,240,96,0.08)', title: (tx) => `Reçu de ${tx.counterpartyName ?? 'K21'}` },
  send_undo: { icon: '↩️', iconBg: 'rgba(250,216,54,0.10)', title: (tx) => `Annulation · ${tx.counterpartyName ?? 'K21'}` },
  receive_undo: { icon: '↩️', iconBg: 'rgba(26,240,96,0.08)', title: (tx) => `Remboursement annulation` },
  pay_merchant: { icon: '🏪', iconBg: 'rgba(255,138,0,0.10)', title: (tx) => tx.counterpartyName ?? 'Paiement marchand' },
  kebu_capital_in: { icon: '🏢', iconBg: 'rgba(250,216,54,0.10)', title: (tx) => `Apport KEBU · ${tx.counterpartyName ?? 'Commerce'}` },
  kebu_owner_draw: { icon: '🏢', iconBg: 'rgba(26,240,96,0.08)', title: (tx) => `Retrait KEBU · ${tx.counterpartyName ?? 'Commerce'}` },
  payroll: { icon: '🏢', iconBg: 'rgba(250,216,54,0.10)', title: (tx) => `Salaire · ${tx.counterpartyName ?? 'Entreprise'}` },
  marketplace_purchase: { icon: '🛒', iconBg: 'rgba(255,138,0,0.10)', title: (tx) => tx.counterpartyName ?? 'Achat marketplace' },
  marketplace_sale: { icon: '📦', iconBg: 'rgba(26,240,96,0.08)', title: (tx) => tx.counterpartyName ?? 'Vente marketplace' },
  delivery_payout: { icon: '🛵', iconBg: 'rgba(26,240,96,0.08)', title: () => 'Paiement livraison' },
  delivery_escrow_hold: { icon: '🔒', iconBg: 'rgba(250,216,54,0.10)', title: () => 'Fonds livraison réservés' },
  delivery_escrow_refund: { icon: '↩️', iconBg: 'rgba(26,240,96,0.08)', title: () => 'Remboursement livraison' },
  ticket_purchase: { icon: '🎟️', iconBg: 'rgba(250,216,54,0.10)', title: (tx) => tx.counterpartyName ?? 'Billet événement' },
  ticket_sale: { icon: '🎟️', iconBg: 'rgba(26,240,96,0.08)', title: (tx) => tx.counterpartyName ?? 'Vente billet' },
  tontine_contribution: { icon: '🏆', iconBg: 'rgba(250,216,54,0.10)', title: (tx) => tx.counterpartyName ?? 'Cotisation tontine' },
  tontine_payout: { icon: '🏆', iconBg: 'rgba(26,240,96,0.08)', title: (tx) => tx.counterpartyName ?? 'Versement tontine' },
};

export function txShape(tx) {
  const meta = txMeta[tx.type] ?? txMeta.send;
  return {
    key: tx.id,
    icon: meta.icon,
    iconBg: meta.iconBg,
    title: meta.title(tx),
    subtitle: relativeTimeFr(tx.createdAt),
    amount: tx.amount,
    type: tx.type,
    counterpartyName: tx.counterpartyName,
    counterpartyHandle: tx.counterpartyHandle,
    note: tx.note,
    giftCardTheme: tx.giftCardTheme ?? null,
    reference: tx.reference,
    createdAt: tx.createdAt.toISOString(),
  };
}
