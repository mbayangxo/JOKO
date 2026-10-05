/**
 * J4 — user-facing explanations for money restrictions (docs/JOKKO-J4-REPORT.md §12).
 *
 * Internal codes (risk signals, tier errors, provider errors) are mapped to a
 * small set of CATEGORIES with a plain French message and a next step. The
 * category never reveals fraud-detection logic: every behavioural risk signal
 * (velocity, rapid cash-in/out, repeated failures, bursts) maps to the same
 * generic "under_review". Only conditions the user can act on or must wait
 * out are named (tier, limits, new device, recent security change).
 */
export const CATEGORIES = {
  verify_phone: {
    message: 'Pour envoyer ou retirer de l’argent, vérifie d’abord ton numéro de téléphone.',
    nextStep: 'Ajoute et confirme ton numéro dans Moi → Sécurité.',
  },
  verify_identity: {
    message: 'Les retraits demandent une pièce d’identité vérifiée.',
    nextStep: 'Vérifie ta CNI dans Moi → Vérification.',
  },
  limit_reached: {
    message: 'Tu as atteint ta limite pour aujourd’hui.',
    nextStep: 'Réessaie demain, ou augmente tes limites en vérifiant ton identité.',
  },
  insufficient_funds: {
    message: 'Solde disponible insuffisant.',
    nextStep: 'Recharge ton compte ou choisis un montant plus petit.',
  },
  new_device: {
    message: 'Pour ta sécurité, les retraits depuis un nouvel appareil sont possibles 24 h après ta première connexion sur cet appareil.',
    nextStep: 'Tu peux envoyer et recevoir normalement en attendant, ou retirer depuis ton appareil habituel.',
  },
  security_change: {
    message: 'Suite à une modification de sécurité récente sur ton compte, les retraits sont suspendus pendant 24 h.',
    nextStep: 'Si tu n’es pas à l’origine de cette modification, contacte le support K21 immédiatement.',
  },
  credentials_reset: {
    message: 'Ton code PIN doit être redéfini avant tout paiement sortant.',
    nextStep: 'Reconnecte-toi avec un code SMS puis crée un nouveau PIN.',
  },
  step_up: {
    message: 'Confirme avec ton code PIN.',
    nextStep: 'Saisis ton PIN pour continuer.',
  },
  under_review: {
    message: 'Cette opération nécessite une vérification de notre part.',
    nextStep: 'Aucune action n’est nécessaire : tu seras notifié. Ne renouvelle pas l’opération.',
  },
  account_suspended: {
    message: 'Ton compte est temporairement suspendu.',
    nextStep: 'Contacte le support K21.',
  },
  provider_unavailable: {
    message: 'Ce service de paiement est momentanément indisponible. Aucun argent n’a été débité.',
    nextStep: 'Réessaie plus tard.',
  },
  recipient_unavailable: {
    message: 'Ce destinataire ne peut pas recevoir ce paiement.',
    nextStep: 'Vérifie le destinataire.',
  },
  not_available: {
    message: 'Cette fonction n’est pas disponible.',
    nextStep: null,
  },
};

/** Internal signal / error code → category. Unknown codes fail to the generic review category. */
const CODE_TO_CATEGORY = {
  tier_insufficient: 'verify_identity',
  tier_cash_out_blocked: 'verify_identity',
  tier_send_blocked: 'verify_phone',
  tier_send_daily_limit: 'limit_reached',
  tier_cash_out_daily_limit: 'limit_reached',
  tier_balance_cap: 'limit_reached',
  tier_receive_cap: 'recipient_unavailable',
  insufficient: 'insufficient_funds',
  insufficient_funds: 'insufficient_funds',
  new_device: 'new_device',
  untrusted_session: 'new_device',
  recent_recovery: 'security_change',
  recent_contact_change: 'security_change',
  credential_reset_required: 'credentials_reset',
  step_up_required: 'step_up',
  account_frozen: 'account_suspended',
  rail_unavailable: 'provider_unavailable',
  provider_unavailable: 'provider_unavailable',
  kyc_unavailable: 'provider_unavailable',
  conversion_disabled: 'not_available',
};

export function categoryFor(code) {
  return CODE_TO_CATEGORY[code] ?? 'under_review';
}

/** The user-facing restriction for a list of internal reason codes (most actionable first). */
export function explain(codes = []) {
  const order = ['account_suspended', 'credentials_reset', 'verify_phone', 'verify_identity', 'security_change', 'new_device', 'limit_reached', 'insufficient_funds', 'provider_unavailable', 'under_review'];
  const cats = [...new Set(codes.map(categoryFor))];
  const category = order.find((c) => cats.includes(c)) ?? cats[0] ?? 'under_review';
  return { category, ...CATEGORIES[category] };
}
