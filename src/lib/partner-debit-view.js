/**
 * J15-D2 — pure view model for a partner debit request (S4). The SERVER is the authority: this only decides what
 * the approver is shown and which action is offered. It never lets a decided, expired or underfunded request
 * look approvable, and it never shows money as moved before the server says "executed".
 */
export const STATUS_LABEL = {
  requested: 'En attente de ton approbation',
  executed: 'Approuvée et payée',
  rejected: 'Refusée',
  cancelled: 'Annulée par le partenaire',
  expired: 'Expirée — rien n’a été débité',
  invalidated: 'Invalidée — la demande a changé, rien n’a été débité',
  failed: 'Échouée — rien n’a été débité',
};
export const KIND_LABEL = { payout: 'Paiement', payroll_batch: 'Paie (lot)' };
const FAILURE_LABEL = { insufficient_funds: 'Solde du commerce insuffisant' };
const REASON_LABEL = {
  roster_changed: 'un salarié a changé depuis la demande',
  recipient_frozen: 'un bénéficiaire est suspendu',
  recipient_missing: 'un bénéficiaire n’existe plus',
  business_unlinked: 'le partenaire n’est plus relié au commerce',
  business_inactive: 'le commerce est suspendu',
  integrity_mismatch: 'la demande enregistrée ne correspond plus',
};

export const formatKori = (n) => `${Number(n ?? 0).toLocaleString('fr-FR').replace(/ /g, ' ')} ₭`;

/** Seconds left, from the SERVER clock offset (serverNow) so a wrong phone clock cannot extend the window. */
export function secondsLeft(d, nowMs = Date.now(), fetchedAtMs = nowMs) {
  if (!d?.expiresAt) return 0;
  const serverAtFetch = d.serverNow ? Date.parse(d.serverNow) : fetchedAtMs;
  const serverNow = serverAtFetch + (nowMs - fetchedAtMs);
  return Math.max(0, Math.floor((Date.parse(d.expiresAt) - serverNow) / 1000));
}

export function countdownLabel(sec) {
  if (sec <= 0) return 'Expirée';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `Expire dans ${m} min ${String(s).padStart(2, '0')} s` : `Expire dans ${s} s`;
}

export function explainDecision(d) {
  if (!d) return null;
  if (d.status === 'failed') return FAILURE_LABEL[d.failureCode] ?? 'Le paiement n’a pas pu être exécuté';
  if (d.status === 'invalidated' && d.decisionReason) {
    const parts = String(d.decisionReason).split(',').map((x) => {
      const key = Object.keys(REASON_LABEL).find((k) => x.endsWith(k));
      return key ? REASON_LABEL[key] : null;
    }).filter(Boolean);
    return parts.length ? `Invalidée : ${[...new Set(parts)].join(' ; ')}` : 'Invalidée';
  }
  if (d.status === 'rejected' && d.decisionReason) return `Motif : ${d.decisionReason}`;
  return null;
}

/**
 * What can the approver do now? approve only while requested, not expired, funded, every recipient reviewed
 * (explicit confirmation) — and never for themself (the server re-checks every one of these).
 */
export function approvalState(d, { sec, confirmed, meUserHandle } = {}) {
  if (!d) return { canApprove: false, canReject: false, blocker: 'loading' };
  if (d.status !== 'requested') return { canApprove: false, canReject: false, blocker: 'decided' };
  if (sec <= 0) return { canApprove: false, canReject: false, blocker: 'expired' };
  if (!d.sufficientFunds) return { canApprove: false, canReject: true, blocker: 'insufficient_funds' };
  if (meUserHandle && (d.recipients ?? []).some((r) => r.handle === meUserHandle)) return { canApprove: false, canReject: true, blocker: 'self' };
  if (!confirmed) return { canApprove: false, canReject: true, blocker: 'confirm_required' };
  return { canApprove: true, canReject: true, blocker: null };
}

export const BLOCKER_TEXT = {
  expired: 'Le délai de 15 minutes est dépassé : la demande ne peut plus être approuvée.',
  insufficient_funds: 'Le solde du commerce ne couvre pas ce paiement. Approuver est impossible ; tu peux refuser.',
  self: 'Tu fais partie des bénéficiaires : un autre responsable financier doit approuver.',
  confirm_required: 'Vérifie chaque bénéficiaire et chaque montant, puis confirme.',
};

/** Recipients flagged for attention first (handle changed since the partner sent it), then by line. */
export function sortedRecipients(d) {
  return [...(d?.recipients ?? [])].sort((a, b) => Number(b.handleChanged) - Number(a.handleChanged) || a.line - b.line);
}
