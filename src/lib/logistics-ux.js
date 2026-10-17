/**
 * J8 wording shared by the logistics screens. Status is shown exactly as the
 * server reports it — no invented ETA, map or "on its way" animation. Proof
 * labels say what was actually verified (D34): a code from the receiver is
 * proof; a seller's own record is labelled self-reported.
 */
export const SHIPMENT_STATUS = {
  requested: 'Demandée — en attente de K21',
  accepted: 'Acceptée — préparation chez l’expéditeur',
  ready_for_pickup: 'Prête à enlever',
  assigned: 'Livreur attribué',
  pickup_arrived: 'Livreur arrivé à l’enlèvement',
  picked_up: 'Enlevée — chez le livreur',
  in_transit: 'En route',
  delivery_arrived: 'Livreur arrivé à destination',
  delivered: 'Livrée (preuve vérifiée)',
  delivery_failed: 'Échec de livraison — marchandise chez le livreur',
  delivery_exception: 'Exception — décision K21 en attente',
  return_requested: 'Retour demandé',
  return_in_transit: 'Retour en route vers l’expéditeur',
  returned: 'Revenue chez l’expéditeur',
  at_pickup_point: 'Au point de retrait',
  cancelled: 'Annulée',
};

export const CUSTODY = {
  source: 'Chez l’expéditeur',
  courier: 'Chez le livreur',
  receiver: 'Chez le destinataire',
  pickup_point: 'Au point de retrait',
};

export const PROOF = {
  receiver_challenge: 'Code donné par le destinataire',
  receiver_receiving: 'Réception déclarée par le destinataire',
  pickup_point_release: 'Remis au comptoir contre le code du client',
  operator_ruling: 'Décision d’un opérateur K21 (pas de code destinataire)',
};

export const SELF_REPORTED = 'Déclarée par le vendeur — non vérifiée';

export const FAILURE_REASONS = [
  { key: 'receiver_unavailable', label: 'Destinataire absent', side: 'receiver' },
  { key: 'address_problem', label: 'Adresse introuvable', side: 'receiver' },
  { key: 'refused', label: 'Refusé à la livraison', side: 'receiver' },
  { key: 'merchant_closed', label: 'Commerce destinataire fermé', side: 'receiver' },
  { key: 'source_not_ready', label: 'Marchandise pas prête / erronée', side: 'source' },
  { key: 'courier_issue', label: 'Problème de mon côté (livreur)', side: 'courier' },
  { key: 'damaged', label: 'Colis abîmé en route', side: 'courier' },
  { key: 'unsafe', label: 'Livraison dangereuse', side: 'safety' },
];

export const FAILURE_EVIDENCE = {
  receiver_confirmed: 'Confirmé par le destinataire',
  receiver_contested: 'Contesté par le destinataire — décision K21',
  source_confirmed: 'Confirmé par l’expéditeur',
  source_contested: 'Contesté par l’expéditeur — décision K21',
  operator_confirmed: 'Confirmé par un opérateur K21',
  operator_rejected: 'Rejeté par un opérateur K21',
};

export const ROLE_LABEL = {
  courier: 'Tu livres',
  source: 'Tu expédies',
  receiver: 'Tu reçois',
  dispatcher: 'Tu planifies',
  pickup_point: 'Ton point de retrait',
  previous_courier: 'Tu détiens encore la marchandise',
};

export const isTerminal = (status) => ['delivered', 'returned', 'cancelled'].includes(status);
export const newActionKey = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
