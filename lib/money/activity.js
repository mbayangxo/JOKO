import { prisma } from '../prisma.js';
import { UNIT } from './policy.js';

/**
 * J4 — ONE transaction history and immutable receipts, read from the Money
 * Kernel (JournalEntry / Posting / ExternalOperation). The legacy statement
 * rows (LedgerEntry) are not the source.
 *
 * Users see plain states — pending, completed, failed, reversed, refunded,
 * partially_refunded, in_review — never ledger jargon. A reversal or refund
 * is its own item, visibly linked to the original (and the original shows
 * it was reversed/refunded). Pending money is never shown as available: a
 * pending cash-in has no posting on the available account until confirmed,
 * and a pending cash-out sits in the held account.
 */

const OP_STATE = {
  in: {
    created: 'pending', authorized: 'pending', submitted: 'pending', expired: 'in_review',
    confirmed: 'completed', settled: 'completed', failed: 'failed', cancelled: 'failed', reversed: 'reversed', refunded: 'refunded',
  },
  out: {
    created: 'pending', authorized: 'pending', submitted: 'pending', expired: 'in_review',
    confirmed: 'completed', settled: 'completed', failed: 'failed', cancelled: 'failed', reversed: 'reversed', refunded: 'refunded',
  },
};

const STATUS_LABEL = {
  pending: 'En cours',
  in_review: 'En vérification',
  completed: 'Effectué',
  failed: 'Échoué',
  reversed: 'Annulé',
  refunded: 'Remboursé',
  partially_refunded: 'Partiellement remboursé',
};

/** kind → { type, out: title, in: title } (counterparty name appended where known). */
const KINDS = {
  send: { type: 'transfer', out: 'Envoi à', in: 'Reçu de' },
  p2p_transfer: { type: 'transfer', out: 'Envoi à', in: 'Reçu de' },
  transfer: { type: 'transfer', out: 'Envoi à', in: 'Reçu de' },
  money_request_payment: { type: 'request_payment', out: 'Demande payée à', in: 'Demande payée par' },
  pay_merchant: { type: 'merchant_payment', out: 'Paiement à', in: 'Paiement reçu de' },
  merchant_payment: { type: 'merchant_payment', out: 'Paiement à', in: 'Paiement reçu de' },
  charge_payment: { type: 'merchant_payment', out: 'Paiement à', in: 'Paiement reçu de' },
  business_payment: { type: 'merchant_payment', out: 'Paiement à', in: 'Paiement reçu de' },
  marketplace_purchase: { type: 'merchant_payment', out: 'Achat chez', in: 'Vente à' },
  voucher_fund: { type: 'voucher', out: 'Bon marchand', in: 'Bon marchand' },
  voucher_spend: { type: 'merchant_payment', out: 'Paiement par bon chez', in: 'Paiement par bon de' },
  merchant_refund: { type: 'refund', out: 'Remboursement à', in: 'Remboursement de' },
  support_refund: { type: 'refund', out: 'Remboursement', in: 'Remboursement K21' },
  reward: { type: 'reward', out: 'Récompense', in: 'Récompense' },
  reversal: { type: 'reversal', out: 'Annulation', in: 'Annulation' },
  p2p_undo: { type: 'reversal', out: 'Envoi annulé', in: 'Envoi annulé' },
  merchant_pay_undo: { type: 'reversal', out: 'Paiement annulé', in: 'Paiement annulé' },
  escrow_hold: { type: 'delivery', out: 'Course — frais réservés', in: 'Course' },
  escrow_release: { type: 'delivery', out: 'Course', in: 'Course payée' },
  escrow_refund: { type: 'delivery', out: 'Course', in: 'Course remboursée' },
  tontine_contribution: { type: 'tontine', out: 'Cotisation tontine', in: 'Tontine' },
  tontine_payout: { type: 'tontine', out: 'Tontine', in: 'Tour de tontine reçu' },
  tontine_refund: { type: 'tontine', out: 'Tontine', in: 'Tontine remboursée' },
  fund_deposit: { type: 'savings', out: 'Vers mon épargne', in: 'Épargne' },
  fund_withdraw: { type: 'savings', out: 'Épargne', in: 'Depuis mon épargne' },
  agent_cash_in: { type: 'cash_in', out: 'Dépôt agent', in: 'Dépôt chez un agent' },
  agent_cash_out: { type: 'cash_out', out: 'Retrait chez un agent', in: 'Retrait agent' },
  ticket_purchase: { type: 'ticket', out: 'Billet', in: 'Vente de billet' },
  solidarity_donate: { type: 'donation', out: 'Don Jekkal', in: 'Don reçu' },
  payroll_payment: { type: 'salary', out: 'Salaire versé', in: 'Salaire de' },
  business_transfer: { type: 'business', out: 'Paiement commerce', in: 'Paiement commerce' },
  business_owner_draw: { type: 'business', out: 'Retrait commerce', in: 'Depuis mon commerce' },
  business_capital_in: { type: 'business', out: 'Vers mon commerce', in: 'Commerce' },
  adjustment: { type: 'adjustment', out: 'Correction K21', in: 'Correction K21' },
  opening_balance: { type: 'opening', out: 'Solde reporté', in: 'Solde reporté' },
  test_funding: { type: 'test', out: 'Crédit de test', in: 'Crédit de test' },
};
const OP_TITLES = { in: 'Rechargement', out: 'Retrait' };
const HIDDEN_KINDS = new Set(['cash_out_hold', 'cash_out_release', 'cash_out_confirmed', 'cash_in_confirmed', 'cash_in_settled', 'cash_out_settled', 'legacy_cash_out_refund']);

async function userAccounts(db, userId) {
  return db.ledgerAccount.findMany({
    where: { code: { in: [`customer:${userId}:available`, `customer:${userId}:held`] } },
    select: { id: true, code: true },
  });
}

async function counterpartyNames(db, entryIds, ownAccountIds) {
  if (!entryIds.length) return new Map();
  const rows = await db.posting.findMany({
    where: { entryId: { in: entryIds }, accountId: { notIn: ownAccountIds } },
    select: { entryId: true, account: { select: { type: true, ownerType: true, ownerId: true } } },
  });
  const userIds = new Set();
  const bizIds = new Set();
  for (const r of rows) {
    if (r.account.ownerType === 'user' && r.account.ownerId) userIds.add(r.account.ownerId);
    if (r.account.type === 'business_wallet' && r.account.ownerId) bizIds.add(r.account.ownerId);
  }
  const [users, biz] = await Promise.all([
    userIds.size ? db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, handle: true } }) : [],
    bizIds.size ? db.business.findMany({ where: { id: { in: [...bizIds] } }, select: { id: true, name: true } }) : [],
  ]);
  const u = new Map(users.map((x) => [x.id, { name: x.name ?? null, handle: x.handle ?? null }]));
  const b = new Map(biz.map((x) => [x.id, { name: x.name, handle: null, isBusiness: true }]));
  const out = new Map();
  for (const r of rows) {
    if (out.has(r.entryId)) continue;
    const who = r.account.type === 'business_wallet' ? b.get(r.account.ownerId) : r.account.ownerType === 'user' ? u.get(r.account.ownerId) : null;
    if (who) out.set(r.entryId, who);
  }
  return out;
}

function titleFor(kind, direction, counterparty) {
  const k = KINDS[kind];
  const base = k ? k[direction] : direction === 'in' ? 'Crédit' : 'Débit';
  const who = counterparty?.name ?? (counterparty?.handle ? `@${counterparty.handle}` : null);
  return /à$|de$|par$|chez$/.test(base) && who ? `${base} ${who}` : base;
}

/** Build user-facing items from the ledger, newest first. */
export async function listActivity(userId, { limit = 30, before = null, reference = null, db = prisma } = {}) {
  const accounts = await userAccounts(db, userId);
  const accountIds = accounts.map((a) => a.id);
  const availableId = accounts.find((a) => a.code.endsWith(':available'))?.id;
  const take = Math.min(Math.max(Number(limit) || 30, 1), 100);

  const postings = accountIds.length
    ? await db.posting.findMany({
        where: {
          accountId: { in: accountIds },
          ...(reference ? { entry: { reference } } : before ? { entry: { createdAt: { lt: new Date(before) } } } : {}),
        },
        orderBy: { id: 'desc' },
        take: take * 4,
        select: { accountId: true, side: true, amount: true, entry: { select: { id: true, reference: true, kind: true, createdAt: true, reversesId: true, externalOperationId: true, metadata: true } } },
      })
    : [];
  const ops = await db.externalOperation.findMany({
    where: { userId, ...(reference ? { reference } : before ? { createdAt: { lt: new Date(before) } } : {}) },
    orderBy: { createdAt: 'desc' },
    take,
  });

  const byEntry = new Map();
  for (const p of postings) {
    if (p.entry.externalOperationId || HIDDEN_KINDS.has(p.entry.kind)) continue;
    const e = byEntry.get(p.entry.id) ?? { entry: p.entry, delta: 0, touchedAvailable: false };
    if (p.accountId === availableId) {
      e.delta += (p.side === 'credit' ? 1 : -1) * Number(p.amount);
      e.touchedAvailable = true;
    }
    byEntry.set(p.entry.id, e);
  }
  const entryIds = [...byEntry.keys()];
  const [names, reversals, refunds] = await Promise.all([
    counterpartyNames(db, entryIds, accountIds),
    entryIds.length ? db.journalEntry.findMany({ where: { reversesId: { in: entryIds } }, select: { reversesId: true, reference: true } }) : [],
    entryIds.length
      ? db.journalEntry.findMany({
          where: { kind: 'merchant_refund', OR: [...byEntry.values()].map((x) => ({ metadata: { path: ['originalReference'], equals: x.entry.reference } })) },
          select: { reference: true, metadata: true, postings: { select: { amount: true, side: true } } },
        })
      : [],
  ]);
  const reversedBy = new Map(reversals.map((r) => [r.reversesId, r.reference]));
  const refundedBy = new Map();
  for (const r of refunds) {
    const orig = r.metadata?.originalReference;
    const amt = r.postings.filter((p) => p.side === 'debit').reduce((s, p) => s + Number(p.amount), 0);
    const cur = refundedBy.get(orig) ?? { refs: [], kori: 0 };
    cur.refs.push(r.reference);
    cur.kori += amt;
    refundedBy.set(orig, cur);
  }
  const originalsById = new Map();
  const reversesIds = [...byEntry.values()].map((x) => x.entry.reversesId).filter(Boolean);
  if (reversesIds.length) {
    for (const o of await db.journalEntry.findMany({ where: { id: { in: reversesIds } }, select: { id: true, reference: true } })) {
      originalsById.set(o.id, o.reference);
    }
  }

  const items = [];
  for (const { entry, delta, touchedAvailable } of byEntry.values()) {
    if (!touchedAvailable || delta === 0) continue;
    const direction = delta > 0 ? 'in' : 'out';
    const amountKori = Math.abs(delta);
    const refund = refundedBy.get(entry.reference);
    let status = 'completed';
    if (reversedBy.has(entry.id)) status = 'reversed';
    else if (refund) status = refund.kori >= amountKori ? 'refunded' : 'partially_refunded';
    const counterparty = names.get(entry.id) ?? null;
    items.push({
      reference: entry.reference,
      type: KINDS[entry.kind]?.type ?? 'other',
      direction,
      amountKori,
      status,
      statusLabel: STATUS_LABEL[status],
      title: titleFor(entry.kind, direction, counterparty),
      counterparty,
      createdAt: entry.createdAt.toISOString(),
      links: {
        reverses: entry.reversesId ? originalsById.get(entry.reversesId) ?? null : null,
        reversedBy: reversedBy.get(entry.id) ?? null,
        refundOf: entry.metadata?.originalReference ?? null,
        refundedBy: refund?.refs ?? [],
        refundedKori: refund?.kori ?? 0,
      },
    });
  }
  for (const op of ops) {
    const status = OP_STATE[op.direction]?.[op.state] ?? 'pending';
    items.push({
      reference: op.reference,
      type: op.direction === 'in' ? 'cash_in' : 'cash_out',
      direction: op.direction,
      amountKori: Number(op.amountKori),
      status,
      statusLabel: STATUS_LABEL[status],
      title: OP_TITLES[op.direction],
      counterparty: { name: providerLabel(op.provider), handle: null },
      createdAt: op.createdAt.toISOString(),
      updatedAt: op.updatedAt.toISOString(),
      // A pending cash-out's money is HELD (not spendable); a pending cash-in is not yet credited.
      held: op.direction === 'out' && ['authorized', 'submitted', 'expired'].includes(op.state),
      creditedToAvailable: op.direction === 'in' && ['confirmed', 'settled'].includes(op.state),
      links: { reverses: null, reversedBy: null, refundOf: null, refundedBy: [], refundedKori: 0 },
    });
  }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { unit: UNIT, items: items.slice(0, take), nextBefore: items.length > take ? items[take - 1].createdAt : null };
}

export function providerLabel(provider) {
  if (provider === 'julaya') return 'Mobile money';
  if (provider === 'stripe') return 'Carte bancaire';
  if (provider === 'beta') return 'Crédit de test';
  if (String(provider).startsWith('partner')) return 'Partenaire';
  return 'Prestataire';
}

/**
 * Immutable receipt for one transaction reference, visible ONLY to a party
 * (the reference touches one of the user's accounts, or is the user's op).
 * Contains no internal ids, account codes or provider secrets.
 */
export async function receiptFor(userId, reference, db = prisma) {
  const ref = String(reference ?? '').slice(0, 120);
  const op = await db.externalOperation.findUnique({ where: { reference: ref } });
  if (op) {
    if (op.userId !== userId) return null;
    const status = OP_STATE[op.direction]?.[op.state] ?? 'pending';
    return {
      reference: op.reference,
      type: op.direction === 'in' ? 'cash_in' : 'cash_out',
      title: OP_TITLES[op.direction],
      direction: op.direction,
      amountKori: Number(op.amountKori),
      feeKori: Math.floor(Number(op.feeMinor) / UNIT.xofPerUnit),
      amountXof: Number(op.amountMinor),
      unit: UNIT,
      status,
      statusLabel: STATUS_LABEL[status],
      channel: providerLabel(op.provider),
      createdAt: op.createdAt.toISOString(),
      completedAt: (op.confirmedAt ?? op.terminalAt)?.toISOString() ?? null,
      explanation:
        status === 'pending'
          ? op.direction === 'out'
            ? 'Montant réservé (non disponible) en attendant la confirmation du prestataire.'
            : 'En attente de confirmation du prestataire — pas encore disponible.'
          : status === 'in_review'
            ? 'Le prestataire n’a pas encore confirmé — vérification en cours. Ne renouvelle pas l’opération.'
            : status === 'failed' && op.direction === 'out'
              ? 'Retrait échoué — le montant réservé a été rendu à ton solde.'
              : null,
      links: { reverses: null, reversedBy: null, refundOf: null, refundedBy: [], refundedKori: 0 },
    };
  }
  const entry = await db.journalEntry.findUnique({
    where: { reference: ref },
    select: { id: true, reference: true, kind: true, createdAt: true, reversesId: true, metadata: true, postings: { select: { side: true, amount: true, accountId: true, account: { select: { code: true } } } } },
  });
  if (!entry) return null;
  const mine = entry.postings.filter((p) => p.account.code === `customer:${userId}:available` || p.account.code === `customer:${userId}:held`);
  if (!mine.length) return null;
  const list = await listActivity(userId, { reference: ref, db });
  const item = list.items.find((i) => i.reference === ref);
  if (!item) return null;
  return { ...item, unit: UNIT, feeKori: 0, channel: 'K21', completedAt: item.createdAt };
}
