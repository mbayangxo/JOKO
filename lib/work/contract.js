import crypto from 'node:crypto';

/**
 * J9 Work & Opportunity — the contract: types, arrangements, classifications,
 * protection rules. docs/JOKKO-J9-WORK.md is the narrative.
 *
 * Hard rules encoded here:
 * - Employment and independent contract work are distinct arrangements; contract terms that look
 *   like a job (≥ 30 h/week for > 12 weeks) are refused as `classification_requires_employment`.
 * - Employment wages are paid by the employer through payroll (J5) — never through J9 contractor
 *   rails. Missing prefunding never removes the employer's obligation (a nonpayment dispute stands).
 * - Paid contract work (gig, shift, apprenticeship stipend, coop work) is FUNDED before a worker can
 *   accept it. Commissions / fees are paid only from a prefunded, approved rule budget.
 * - Every J9 rate starts at 0 / disabled. Platform fee is 0 (not configurable in J9).
 * - No live J9 money moves unless JOKKO_WORK_MONEY_ENABLED=true (off by default; the production P0 is open).
 * - A worker never pays to get work (no fee field exists; postings that ask for one are held for review).
 */
export class WorkError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WorkError';
    this.code = code;
    this.status = status;
  }
}

export const workMoneyEnabled = () => process.env.JOKKO_WORK_MONEY_ENABLED === 'true';
export function assertWorkMoneyEnabled() {
  if (!workMoneyEnabled()) throw new WorkError('work_money_not_activated', 'Paiements du travail : pas encore activés', 409);
}

export const PLATFORM_FEE_BPS = 0;
export const OFFER_TTL_HOURS = 72;

/**
 * J9 settlement policy (P-J9-1 — TEST CONFIGURATION until finance / legal approve; J9 money is off).
 * Five distinct moments, never conflated:
 *   completion        the worker submits evidence
 *   acceptance        the business accepts — or DEEMED acceptance when it stays silent past the
 *                     agreed acceptance window (protects the worker against indefinite withholding)
 *   contest window    after acceptance the payer may still dispute false completion: short after an
 *                     explicit acceptance (a correction window), longer after a deemed one
 *   payout eligibility  never before the contest window closes: releasableAt = max(hold, contestableUntil)
 *   finality          paid. A paid earning is never clawed back automatically (P-J9-9).
 * A ruling's money executes only after the appeal window, or once an appeal is decided.
 * Employee wages are NOT governed here: they are owed by the employer through payroll (J5) and are
 * never held by a contractor dispute.
 * Override (local / staging only): WORK_SETTLEMENT_JSON, each value bounded; invalid values are ignored.
 */
const POLICY_BOUNDS = {
  holdHours: [1, 168, 24],
  explicitContestHours: [0, 168, 24],
  deemedContestHours: [24, 336, 72],
  commissionHoldHours: [24, 720, 168],
  appealHours: [0, 168, 48],
  disputeSlaHours: [24, 336, 72],
};
export const SETTLEMENT = (() => {
  const out = Object.fromEntries(Object.entries(POLICY_BOUNDS).map(([k, [, , d]]) => [k, d]));
  try {
    const o = JSON.parse(process.env.WORK_SETTLEMENT_JSON ?? '{}');
    for (const [k, [lo, hi]] of Object.entries(POLICY_BOUNDS)) if (Number.isSafeInteger(o[k]) && o[k] >= lo && o[k] <= hi) out[k] = o[k];
  } catch {
    /* invalid override ignored: defaults stand */
  }
  return Object.freeze(out);
})();
export const EARNING_HOLD_HOURS = SETTLEMENT.holdHours;
export const COMMISSION_HOLD_HOURS = SETTLEMENT.commissionHoldHours;

/** Contest window (hours) after acceptance, by who accepted. A ruling is already a contested decision. */
export const contestHoursFor = (acceptedBy) => (acceptedBy === 'auto' ? SETTLEMENT.deemedContestHours : acceptedBy === 'ruling' ? 0 : SETTLEMENT.explicitContestHours);

/** type → allowed arrangements and how each is funded. */
export const TYPES = {
  courier: { label: 'Livraison (flotte de l’entreprise)', arrangements: { contract: 'prepaid', employment: 'payroll' }, grantsRole: 'fleet_driver' },
  rep: { label: 'Commercial·e terrain', arrangements: { contract: 'outcome', employment: 'payroll' }, grantsRole: 'distribution_rep' },
  pickup_point: { label: 'Point relais', arrangements: { contract: 'outcome' } },
  staffing: { label: 'Renfort en boutique', arrangements: { contract: 'prepaid', employment: 'payroll' } },
  gig: { label: 'Mission courte', arrangements: { contract: 'prepaid' } },
  apprenticeship: { label: 'Apprentissage', arrangements: { apprenticeship: 'prepaid' } },
  coop_work: { label: 'Travail coopératif', arrangements: { coop_member: 'prepaid' } },
};

export const CLASSIFICATION = { contract: 'contractor_payment', apprenticeship: 'apprenticeship_stipend', coop_member: 'member_work_payment' };
export const EVIDENCE_KINDS = ['note', 'photo_ref', 'document_ref', 'attendance', 'receipt_ref'];
export const DISPUTE_KINDS = ['nonpayment', 'false_completion', 'terms_breach', 'harassment', 'other'];

const FEE_SCAM = /(frais\s+d['’]?(inscription|dossier|adh[ée]sion|formation)|payer\s+pour\s+(postuler|travailler|commencer)|paiement\s+pr[ée]alable|caution\s+(de|à)|avance\s+de\s+frais|registration\s+fee|application\s+fee|pay\s+to\s+(apply|work|start)|deposit\s+required)/i;
export function reviewFlags({ title, description }) {
  const flags = [];
  if (FEE_SCAM.test(`${title} ${description}`)) flags.push('worker_fee_language');
  return flags;
}

/** Contract terms that describe a job are employment. Conservative rule — the legal threshold is for counsel (P-J9-2). */
export function assertClassification({ arrangement, hoursPerWeek, durationWeeks }) {
  if (arrangement === 'contract' && (hoursPerWeek ?? 0) >= 30 && (durationWeeks ?? 0) > 12) {
    throw new WorkError('classification_requires_employment', 'Temps plein durable : c’est un emploi (salaire via la paie), pas une mission', 422);
  }
}

/** Verified age (KYC tier ≥ 2 with a date of birth) or null. */
export function verifiedAge(user, now = new Date()) {
  if (!user?.dateOfBirth || (user.verificationTier ?? 1) < 2) return null;
  const d = new Date(user.dateOfBirth);
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

/**
 * Minors and hazardous work. Under 16: no work. 16–17 (verified): non-hazardous, no night work,
 * within minAge. Unknown age: hazardous work refused (verification required); otherwise the worker
 * attests minAge at acceptance (`ageAttested`).
 */
export function assertAgeEligible(opp, user, { ageAttested = false, atAcceptance = false } = {}) {
  const age = verifiedAge(user);
  if (age !== null) {
    if (age < 16) throw new WorkError('age_ineligible', 'Travail non autorisé avant 16 ans', 403);
    if (age < 18 && (opp.hazardous || opp.nightWork)) throw new WorkError('minor_restricted', 'Travail dangereux ou de nuit interdit aux mineurs', 403);
    if (age < opp.minAge) throw new WorkError('age_ineligible', `Âge minimum : ${opp.minAge} ans`, 403);
    return;
  }
  if (opp.hazardous) throw new WorkError('age_verification_required', 'Travail dangereux : vérification d’identité (date de naissance) requise', 403);
  if (atAcceptance && !ageAttested) throw new WorkError('age_attestation_required', `Confirme avoir au moins ${opp.minAge} ans`, 422);
}

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const ref = (prefix) => `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
export const parseJson = (s, d) => {
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};
