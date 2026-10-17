/**
 * J13-F17 — attributing a final answer to the RIGHT payment attempt.
 *
 * A screen may open after the app-wide reconciler already resolved earlier attempts. Rules:
 *   - an earlier outcome is NEVER applied to a screen that has started (or is checking) an attempt of its own;
 *   - an unknown attempt still pending for this account + operation is resumed (looked up), not replaced;
 *   - otherwise the most recently STARTED earlier attempt is shown, labelled with its own start time, and the
 *     number of other earlier attempts is stated — never merged, never presented as the current one;
 *   - wording points to the history (the ledger) as the source of truth.
 */
const pad = (n) => String(n).padStart(2, '0');

export function attemptLabel(createdAt, now = Date.now()) {
  const d = new Date(Number(createdAt));
  if (!Number.isFinite(d.getTime())) return 'Paiement précédent';
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? `Paiement commencé à ${t}` : `Paiement commencé le ${pad(d.getDate())}/${pad(d.getMonth() + 1)} à ${t}`;
}

/**
 * @param {{ phaseState: string, pending?: object|null, recent?: object[] , now?: number }} input
 * @returns {null | { kind: 'resume', rec } | { kind: 'show', phase }}
 */
export function handoffDecision({ phaseState, pending = null, recent = [], now = Date.now() }) {
  if (phaseState && phaseState !== 'idle') return null; // this screen already has its own attempt
  if (pending) return { kind: 'resume', rec: pending };
  if (!recent.length) return null;
  const latest = recent[recent.length - 1];
  return {
    kind: 'show',
    phase: { ...latest, afterCheck: true, resumed: true, attemptKey: latest.key, attemptLabel: attemptLabel(latest.createdAt, now), earlierCount: recent.length - 1 },
  };
}

/** Banner / toast text for an earlier attempt: always names which attempt it is about. */
export function attributedText(phase, text) {
  if (!phase?.attemptLabel) return text;
  const more = phase.earlierCount > 0
    ? ` (${phase.earlierCount} autre${phase.earlierCount > 1 ? 's' : ''} paiement${phase.earlierCount > 1 ? 's' : ''} précédent${phase.earlierCount > 1 ? 's' : ''} vérifié${phase.earlierCount > 1 ? 's' : ''} — consulte ton historique.)`
    : '';
  return `${phase.attemptLabel} : ${text}${more}`;
}
