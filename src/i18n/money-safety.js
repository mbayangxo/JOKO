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
  // J13-F17: an UNKNOWN outcome never says whether money moved — only that it is being checked.
  checking: { fr: 'Nous vérifions le statut de ce paiement. Ne le renouvelle pas pour le moment.' },
  resumed_checking: { fr: 'Nous vérifions le statut d’un paiement précédent. Ne le renouvelle pas pour le moment.' },
  still_checking: { fr: 'Nous vérifions toujours le statut de ce paiement. Ne le renouvelle pas : ton historique se mettra à jour dès que nous aurons la réponse.' },
  done: { fr: 'Paiement effectué.' },
  pending: { fr: 'Opération enregistrée — en attente de confirmation. Ne la renouvelle pas.' },
  refused: { fr: 'Opération refusée — aucun argent n’a été débité.' },
  // Only after the server CLOSED the attempt (nothing ran, and nothing can run later under that key).
  not_received: { fr: 'Le paiement n’a pas été reçu : il a été annulé et aucun argent n’a été débité. Tu peux recommencer.' },
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
      return phase.voided ? 'not_received' : 'refused';
    case 'blocked':
      return 'refused';
    case 'safe_to_retry':
      // J13-F17: no longer produced; if it ever appears it is treated as UNKNOWN, never as "not debited".
      return 'checking';
    default:
      return null;
  }
}
