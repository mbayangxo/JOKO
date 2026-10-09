import crypto from 'node:crypto';

/**
 * J11 collective money — contract (docs/JOKKO-J11-0-AUDIT.md §3).
 *
 *  Model A `rotating` tontine and model B `goal` group savings share one lifecycle:
 *    create → invite → consent (join) → rules proposed (hashed) → every member approves the exact hash
 *    → active (schedule + obligations created; no money moved) → contribute (each member, explicitly)
 *    → obligations verified → payout by the RULES (A) / own withdrawal (B) → reconcile → completed | cancelled.
 *
 *  Non-negotiable:
 *   - Nobody is ever debited without pressing "cotiser" themself. Missed payments are recorded, never auto-debited.
 *   - The organizer has NO money power: no payout choice, no withdrawal, no unilateral cancel after activation.
 *   - Rules are locked after activation (database trigger). Exceptions only by member vote, never by one person.
 *   - Group money sits in its own J2 account (collective:<id>:pot / :share:<user>), never in a person's wallet.
 *   - This is a closed-loop Kori arrangement between members. No insurance, guarantee, interest or return is promised.
 *   - Everything is dark unless JOKKO_COLLECTIVE_ENABLED=true (off in production until approved).
 */
export class CollectiveError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'CollectiveError';
    this.code = code;
    this.status = status;
  }
}

export const collectiveEnabled = () => process.env.JOKKO_COLLECTIVE_ENABLED === 'true';
export function assertEnabled() {
  if (!collectiveEnabled()) throw new CollectiveError('collective_not_enabled', 'Les groupes d’épargne ne sont pas encore ouverts.', 503);
}

export const KINDS = ['rotating', 'goal'];
export const FREQUENCIES = { weekly: { days: 7 }, biweekly: { days: 14 }, monthly: { months: 1 } };
export const LIMITS = {
  minContributionKori: 10, // 100 XOF
  maxContributionKori: 500_000, // 5 000 000 XOF (the J1 tontine cap)
  minMembers: 2,
  maxMembers: 30,
  maxGoalCycles: 52,
  maxGraceDays: 14,
  voteDays: 7,
};

export function addPeriod(date, frequency, n = 1) {
  const f = FREQUENCIES[frequency];
  const d = new Date(date);
  if (f.days) d.setUTCDate(d.getUTCDate() + f.days * n);
  else d.setUTCMonth(d.getUTCMonth() + f.months * n);
  return d;
}

/** The policies every member accepts, written into the hashed rules (shown in plain French in the app). */
export const POLICIES = {
  consent: 'chaque cotisation est faite par le membre lui-même ; aucun prélèvement automatique',
  missed: 'un retard est enregistré comme dette envers le groupe ; aucun prélèvement forcé ; rappels privés seulement',
  payout: 'le pot du cycle va au membre prévu par l’ordre accepté, seulement quand toutes les cotisations du cycle sont payées',
  partialRelease: 'versement partiel seulement si tous les membres à jour du cycle (dont le bénéficiaire) votent oui',
  extendGrace: 'prolongation du délai par vote de la majorité des membres',
  cancel: 'annulation seulement par vote unanime des membres qui n’ont pas encore reçu le pot ; le pot en cours est remboursé à ceux qui l’ont payé',
  exit: 'sortie en cours de route seulement avant d’avoir reçu le pot, et avec l’accord unanime des autres membres',
  organizer: 'l’organisateur n’a aucun pouvoir sur l’argent',
  disputes: 'un litige bloque le versement du cycle ; un opérateur K21 tranche, un second opérateur exécute toute conséquence financière',
  transparency: 'chaque membre voit l’échéancier, les statuts de paiement du groupe et l’historique',
  goalOwnership: 'en épargne objectif, chaque membre ne peut retirer que sa propre épargne',
  disclaimer: 'arrangement entre membres en Kori : pas de garantie, pas d’assurance, pas d’intérêt, pas de rendement',
};

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  if (v instanceof Date) return v.toISOString();
  return v;
}
export const rulesHashOf = (rules) => crypto.createHash('sha256').update(JSON.stringify(canonical(rules))).digest('hex');
export const canonicalJson = (rules) => JSON.stringify(canonical(rules));

/** Deterministic, recorded draw: anyone can recompute the order from the seed in the accepted rules. */
export function drawOrder(userIds, seed) {
  return [...userIds].sort((a, b) => {
    const ha = crypto.createHash('sha256').update(`${seed}:${a}`).digest('hex');
    const hb = crypto.createHash('sha256').update(`${seed}:${b}`).digest('hex');
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
}
