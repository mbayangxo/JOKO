import { prisma } from '../prisma.js';
import { OrgAccessError, requireBusinessCapability } from '../business-access.js';
import { emitCommerceEvent } from './events.js';

/**
 * J5 payment-acceptance abstraction (docs/JOKKO-ECONOMIC-OS-ARCHITECTURE.md §5).
 *
 * Every way a business is paid maps into ONE model — a PaymentRecord tied to
 * the order / charge / receipt — and declares how it settles:
 *
 *   jokko_ledger     electronic Jokko money; `ledgerReference` is the J2 entry
 *   off_ledger_cash  recorded for operations only; NEVER Jokko money, never
 *                    in the business wallet, never in ledger-based totals
 *   external         settled outside Jokko (partner / provider rail)
 *
 * Card acceptance is never home-made: SoftPOS / contactless card requires a
 * licensed, certified acquirer + SoftPOS provider (PCI scope stays with them)
 * and is DORMANT until such a partner is contracted.
 */
export const METHODS = {
  wallet: { status: 'ACTIVE', settlement: 'jokko_ledger', label: 'Portefeuille Jokko' },
  static_qr: { status: 'ACTIVE', settlement: 'jokko_ledger', label: 'QR marchand (montant saisi par le client)' },
  charge_qr: { status: 'ACTIVE', settlement: 'jokko_ledger', label: 'QR à montant fixe (référence)' },
  payment_link: { status: 'ACTIVE', settlement: 'jokko_ledger', label: 'Lien de paiement (même référence que le QR)' },
  partner_checkout: { status: 'ACTIVE', settlement: 'jokko_ledger', label: 'Paiement via système partenaire (Kabu), réglé au portefeuille du commerce' },
  cash: { status: 'ACTIVE', settlement: 'off_ledger_cash', label: 'Espèces (enregistrement uniquement)' },
  manual: { status: 'ACTIVE', settlement: 'off_ledger_cash', label: 'Autre paiement hors Jokko (enregistrement uniquement)' },
  online_checkout: { status: 'DORMANT', settlement: 'jokko_ledger', label: 'Paiement en ligne (checkout hébergé)' },
  provider_rail: { status: 'DORMANT', settlement: 'external', label: 'Mobile money / banque direct au commerce' },
  device_tap: { status: 'DORMANT', settlement: 'jokko_ledger', label: 'Paiement par contact téléphone-à-téléphone' },
  softpos_card: { status: 'DORMANT', settlement: 'external', label: 'Carte sans contact (SoftPOS, acquéreur agréé requis)' },
};

export class AcceptanceError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'AcceptanceError';
    this.code = code;
    this.status = status;
  }
}

/** Write the canonical record for a payment accepted inside a money transaction. */
export async function recordPayment(tx, { businessId, method, sourceChannel, sourceSystem = 'jokko', amountKori, ledgerReference = null, orderId = null, chargeCode = null, externalRef = null, recordedBy = null, note = null }) {
  const m = METHODS[method];
  if (!m) throw new AcceptanceError('unknown_method', `Moyen de paiement inconnu : ${method}`, 400);
  if (m.status !== 'ACTIVE') throw new AcceptanceError('method_not_activated', `${m.label} : pas encore activé`);
  if (m.settlement === 'jokko_ledger' && !ledgerReference) throw new AcceptanceError('ledger_reference_required', 'Paiement Jokko sans écriture comptable', 500);
  if (m.settlement !== 'jokko_ledger' && ledgerReference) throw new AcceptanceError('not_jokko_money', 'Un paiement hors Jokko ne peut pas référencer le grand livre', 500);
  const row = await tx.paymentRecord.create({
    data: { businessId, method, sourceChannel, sourceSystem, settlement: m.settlement, amountKori, ledgerReference, orderId, chargeCode, externalRef, recordedBy, note },
  });
  await emitCommerceEvent(tx, { type: 'payment.recorded', businessId, aggregateType: 'payment', aggregateId: row.id, payload: { method, settlement: m.settlement, amountKori, orderId, sourceChannel } });
  return row;
}

/**
 * A cash / manual sale, recorded by staff who accept payments. It is an
 * operational record ONLY: no ledger entry, no wallet movement, shown apart
 * from Jokko money everywhere.
 */
export async function recordManualSale(userId, businessId, { method = 'cash', amountKori, note, externalRef }) {
  if (!['cash', 'manual'].includes(method)) throw new AcceptanceError('invalid_method', 'Seuls espèces / autre hors Jokko peuvent être saisis à la main', 400);
  if (!Number.isSafeInteger(amountKori) || amountKori <= 0) throw new AcceptanceError('invalid_amount', 'Montant invalide', 400);
  await requireBusinessCapability(userId, businessId, 'business.charges.create');
  return prisma.$transaction((tx) => recordPayment(tx, { businessId, method, sourceChannel: 'pos_manual', amountKori, recordedBy: userId, note: note ?? null, externalRef: externalRef ?? null }));
}

/** Business payments list (any method), with Jokko money and off-ledger records kept apart. */
export async function listBusinessPayments(userId, businessId, { limit = 50 } = {}) {
  await requireBusinessCapability(userId, businessId, 'business.charges.read').catch(async () => {
    await requireBusinessCapability(userId, businessId, 'business.activity.read').catch(() => {
      throw new OrgAccessError('Not authorized for this business');
    });
  });
  const rows = await prisma.paymentRecord.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: Math.min(Number(limit) || 50, 200) });
  const items = rows.map((r) => ({
    id: r.id,
    method: r.method,
    methodLabel: METHODS[r.method]?.label ?? r.method,
    settlement: r.settlement,
    isJokkoMoney: r.settlement === 'jokko_ledger',
    amountKori: r.amountKori,
    sourceChannel: r.sourceChannel,
    reference: r.ledgerReference ?? r.chargeCode ?? r.externalRef ?? null,
    orderId: r.orderId,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));
  const sum = (f) => items.filter(f).reduce((s, i) => s + i.amountKori, 0);
  return {
    items,
    totals: {
      jokkoMoneyKori: sum((i) => i.isJokkoMoney),
      recordedOffLedgerKori: sum((i) => i.settlement === 'off_ledger_cash'),
      note: 'Les ventes en espèces sont enregistrées pour le suivi ; ce n’est pas de l’argent Jokko.',
    },
  };
}

export function acceptanceCatalog() {
  return Object.entries(METHODS).map(([key, m]) => ({ key, ...m }));
}
