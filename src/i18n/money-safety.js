/**
 * J12 (P-J12-2) — payment-safety status text, by language.
 *
 * French is the REVIEWED reference and the fallback. A translation is used ONLY when it carries a native-
 * speaker review record (`reviewedBy`, `reviewedAt`, `checkedAgainst: 'fr'`). Unreviewed financial wording
 * is never shown: an entry without a review record falls back to French. Engineering does not write these
 * translations; they are added by reviewed native speakers (Wolof first, then Pulaar, then Serer).
 *
 * Every message must keep the safety meaning of the French: whether money moved, and "do not repeat".
 */
export const SAFETY_LANGS = ['wo', 'ff', 'srr'];

export const MONEY_SAFETY = {
  checking: { fr: 'Vérification du paiement en cours… Ne le renouvelle pas.' },
  resumed_checking: { fr: 'Un paiement précédent est en vérification… Ne le renouvelle pas.' },
  still_checking: { fr: 'Toujours en vérification. Consulte ton historique avant de renouveler.' },
  done: { fr: 'Paiement effectué.' },
  pending: { fr: 'Opération enregistrée — en attente de confirmation. Ne la renouvelle pas.' },
  refused: { fr: 'Opération refusée — aucun argent n’a été débité.' },
  not_received: { fr: 'Le paiement n’a pas été reçu — aucun argent n’a été débité. Tu peux recommencer.' },
  // Shape of a reviewed translation (none exist yet):
  //   wo: { text: '…', reviewedBy: 'name/role of the native reviewer', reviewedAt: '2026-…', checkedAgainst: 'fr' }
};

export const isReviewed = (t) => Boolean(t && typeof t === 'object' && t.text && t.reviewedBy && t.reviewedAt && t.checkedAgainst === 'fr');

/** Reviewed text in `lang`, else the reviewed French. Never an unreviewed translation. */
export function safetyText(id, lang = 'fr') {
  const entry = MONEY_SAFETY[id];
  if (!entry) return null;
  const t = entry[lang];
  return lang !== 'fr' && isReviewed(t) ? t.text : entry.fr;
}

/** Which state of a money attempt maps to which safety message. */
export function safetyIdFor(phase) {
  if (!phase) return null;
  switch (phase.state) {
    case 'checking':
      return phase.resumed ? 'resumed_checking' : phase.stopPolling ? 'still_checking' : 'checking';
    case 'done':
      return 'done';
    case 'accepted_pending':
      return 'pending';
    case 'failed_safe':
    case 'blocked':
      return 'refused';
    case 'safe_to_retry':
      return 'not_received';
    default:
      return null;
  }
}
