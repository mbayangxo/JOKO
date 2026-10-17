/**
 * J9 — shared wording for the work screens. Honest labels: who pays, how, and on what proof.
 */
export const ARRANGEMENT = {
  contract: 'Mission indépendante',
  employment: 'Emploi salarié',
  apprenticeship: 'Apprentissage',
  coop_member: 'Travail coopératif',
};

export const FUNDING = {
  prepaid: 'Paiement bloqué avant le début : versé quand le travail est validé',
  payroll: 'Salaire versé par l’employeur (paie) — engagement enregistré',
  outcome: 'Commission sur résultat vérifié, selon budget approuvé',
  j8: 'Payé par livraison prouvée',
};

export const PAY_KIND = { fixed: 'forfait', per_unit: 'par unité', hourly: 'de l’heure', stipend: 'indemnité', wage: 'salaire', commission: 'commission', fee: 'par colis' };

export const OFFER_STATUS = { sent: 'À répondre', accepted: 'Acceptée', declined: 'Refusée', withdrawn: 'Retirée', expired: 'Expirée' };
export const APP_STATUS = { submitted: 'Envoyée', invited: 'Invitation reçue', shortlisted: 'Présélectionnée', declined: 'Non retenue', withdrawn: 'Retirée', offered: 'Offre reçue', hired: 'Engagé·e' };
export const ASSIGNMENT_STATUS = { active: 'En cours', completed: 'Terminée', cancelled: 'Annulée' };
export const MILESTONE_STATUS = { pending: 'À faire', submitted: 'Envoyée — en validation', accepted: 'Validée', disputed: 'En litige', refunded: 'Annulée (remboursée)', split: 'Partagée (décision)' };
export const EARNING_STATUS = { accrued: 'Retenu (délai ou litige)', releasable: 'Disponible', paid: 'Versé', reversed: 'Annulé après décision' };
export const CLASSIFICATION = {
  contractor_payment: 'Paiement de mission',
  apprenticeship_stipend: 'Indemnité d’apprentissage',
  member_work_payment: 'Rémunération de travail coopératif',
  commission: 'Commission',
  service_fee: 'Frais de service',
  reimbursement: 'Remboursement de frais',
  payroll_wage: 'Salaire (paie de l’employeur)',
};

export const INELIGIBLE = {
  minor_restricted: 'Interdit aux mineurs (travail dangereux ou de nuit)',
  age_ineligible: 'Âge minimum non atteint',
  age_verification_required: 'Vérification d’identité requise',
};
