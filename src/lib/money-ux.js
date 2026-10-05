/**
 * J4 — money UX rules, kept free of React / React Native so they are unit
 * tested in Node (tests/j4/money-ux.test.js). Screens use these to decide
 * what the user sees; the server stays authoritative.
 *
 * The one rule: NEVER encourage a second payment when the outcome of the
 * first is unknown. A payment attempt gets ONE intent key (Idempotency-Key)
 * that is reused for every retry of that attempt; when the response is lost
 * (timeout, network, app kill, 5xx), the app asks the server what happened
 * (GET /api/money/intents/:key) instead of letting the user tap "pay" again.
 */

export function newIntentKey() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `intent-${uuid}`;
  return `intent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * Classify the result of submitting a money write.
 * @returns {{ state: 'done'|'accepted_pending'|'checking'|'needs_pin'|'blocked'|'failed_safe',
 *             message: string, nextStep?: string|null, canRetrySameIntent: boolean, newIntentAllowed: boolean }}
 */
export function classifySubmission({ response, error }) {
  if (response) {
    if (response.status === 'completed' || response.code === 'completed_response_lost') {
      return { state: 'done', message: 'Paiement effectué.', canRetrySameIntent: false, newIntentAllowed: true };
    }
    if (response.rail?.status === 'pending' || response.status === 'pending' || response.held) {
      return { state: 'accepted_pending', message: 'Opération enregistrée — en attente de confirmation. Ne la renouvelle pas.', canRetrySameIntent: false, newIntentAllowed: false };
    }
    return { state: 'done', message: 'Opération effectuée.', canRetrySameIntent: false, newIntentAllowed: true };
  }
  const e = error ?? {};
  if (e.status === 202) {
    return { state: 'accepted_pending', message: e.message ?? 'Opération en vérification. Ne la renouvelle pas.', canRetrySameIntent: false, newIntentAllowed: false };
  }
  // Outcome unknown: the request may or may not have executed.
  if (e.code === 'outcome_unknown' || e.code === 'timeout' || e.code === 'network' || e.code === 'idempotency_in_progress' || (e.status >= 500 && e.status !== 503)) {
    return { state: 'checking', message: 'Vérification du paiement en cours… Ne le renouvelle pas.', canRetrySameIntent: false, newIntentAllowed: false };
  }
  if (e.code === 'step_up_required') {
    return { state: 'needs_pin', message: 'Confirme avec ton code PIN.', canRetrySameIntent: true, newIntentAllowed: false };
  }
  // A definite refusal: nothing was debited. Server-provided, user-safe text.
  return {
    state: e.category ? 'blocked' : 'failed_safe',
    message: e.message ?? 'Opération refusée — aucun argent n’a été débité.',
    nextStep: e.data?.nextStep ?? null,
    category: e.category ?? e.data?.category ?? null,
    canRetrySameIntent: e.status === 503,
    newIntentAllowed: true,
  };
}

/** Interpret GET /api/money/intents/:key while the screen shows "checking". */
export function classifyIntent(intent) {
  switch (intent?.state) {
    case 'completed':
      return { state: 'done', message: 'Paiement effectué.', references: intent.references ?? [], stopPolling: true };
    case 'accepted_pending':
      return { state: 'accepted_pending', message: intent.message, references: intent.references ?? [], stopPolling: true };
    case 'refused':
      return { state: 'failed_safe', message: 'Opération refusée — aucun argent n’a été débité.', stopPolling: true, newIntentAllowed: true };
    case 'not_found':
      // Nothing reached the server: retrying with the SAME intent key is safe.
      return { state: 'safe_to_retry', message: 'Le paiement n’a pas été reçu. Tu peux réessayer sans risque de double paiement.', stopPolling: true, canRetrySameIntent: true };
    case 'in_progress':
    default:
      return { state: 'checking', message: 'Vérification du paiement en cours…', stopPolling: false };
  }
}

const TONES = { completed: 'ok', pending: 'pending', in_review: 'pending', failed: 'muted', reversed: 'muted', refunded: 'muted', partially_refunded: 'muted' };

/** One history row for display (no ledger jargon; reversal/refund links kept). */
export function activityRow(item) {
  const sign = item.direction === 'in' ? '+' : '−';
  const linked = item.links?.reverses
    ? 'Annulation d’une opération précédente'
    : item.links?.refundOf
      ? 'Remboursement d’un paiement'
      : item.links?.reversedBy
        ? 'Cette opération a été annulée'
        : item.links?.refundedBy?.length
          ? `Remboursé : ${item.links.refundedKori} ₭`
          : null;
  return {
    key: item.reference,
    title: item.title,
    amountLabel: `${sign}${item.amountKori} ₭`,
    statusLabel: item.statusLabel,
    tone: TONES[item.status] ?? 'ok',
    spendable: item.status === 'completed' || item.direction === 'out',
    linkedNote: linked,
    pendingNote: item.status === 'pending' && item.type === 'cash_in' ? 'Pas encore disponible' : item.held ? 'Montant réservé' : null,
  };
}

/** A Money-home action as a button state: enabled, or disabled with the server's reason. */
export function actionButton(action) {
  if (!action) return { enabled: false, reason: null };
  if (action.allowed) return { enabled: true, reason: null, requiresPin: Boolean(action.requiresPin) };
  return { enabled: false, reason: action.message ?? null, nextStep: action.nextStep ?? null, category: action.category ?? null };
}

/** Balance block: only `availableKori` is spendable; held and pending are shown separately. */
export function balanceView(home) {
  const b = home?.balance ?? { availableKori: 0, heldKori: 0, pendingInKori: 0 };
  return {
    spendableKori: b.availableKori,
    lines: [
      b.heldKori ? { label: 'Réservé (retrait en cours)', kori: b.heldKori } : null,
      b.pendingInKori ? { label: 'En attente (rechargement)', kori: b.pendingInKori } : null,
    ].filter(Boolean),
  };
}
