import { prisma } from '../prisma.js';
import { OrgAccessError } from '../business-access.js';
import { businessAccess } from './identity.js';
import { ORDER_LABELS } from '../commerce/orders.js';
import { dakarDateString } from '../tier-service.js';

/**
 * J5 business operating views (docs/JOKKO-J5-REPORT.md §3, §10, §11).
 * Financial truth is the J2 ledger (`business:<id>:wallet`); orders,
 * charges and stock are the operational sources. No second ledger, no
 * cached totals: every figure is computed from those rows.
 *
 * Visibility by capability:
 *  - business.wallet.read  → balance + every movement (incl. payroll lines)
 *  - business.activity.read→ sales / refunds / fees; other movements
 *                            (payroll, owner draws, transfers, capital) are
 *                            listed as "réservé" WITHOUT amount or party
 *  - business.payroll.read → payroll lines with amounts
 */
const CATEGORY = {
  sale: { label: 'Vente', visible: 'activity' },
  refund: { label: 'Remboursement', visible: 'activity' },
  fee: { label: 'Frais', visible: 'activity' },
  payroll: { label: 'Paie', visible: 'payroll' },
  payout: { label: 'Retrait / virement', visible: 'wallet' },
  capital: { label: 'Apport', visible: 'wallet' },
  adjustment: { label: 'Ajustement', visible: 'wallet' },
  other: { label: 'Autre mouvement', visible: 'wallet' },
};

export function categorize(kind, direction) {
  const k = String(kind ?? '');
  if (/refund|reversal|undo/.test(k)) return 'refund';
  if (/payroll/.test(k)) return 'payroll';
  if (/fee/.test(k)) return 'fee';
  if (/capital_in/.test(k)) return 'capital';
  if (/owner_draw|transfer|payout|b2b_out|cooperative_payout/.test(k)) return direction === 'in' && /transfer/.test(k) ? 'other' : 'payout';
  if (/adjust|opening/.test(k)) return 'adjustment';
  if (direction === 'in' && /payment|purchase|sale|charge|order|invoice|cod|school|ticket/.test(k)) return 'sale';
  return 'other';
}

function canSee(category, caps) {
  const v = CATEGORY[category].visible;
  if (caps.has('business.wallet.read')) return true;
  if (v === 'activity') return caps.has('business.activity.read');
  if (v === 'payroll') return caps.has('business.payroll.read');
  return false;
}

async function businessAccountId(businessId, db = prisma) {
  const acc = await db.ledgerAccount.findUnique({ where: { code: `business:${businessId}:wallet` }, select: { id: true, balance: true } });
  return acc;
}

async function capsFor(userId, businessId) {
  const access = await businessAccess(userId, businessId);
  return { access, caps: new Set(access.capabilities) };
}

/** Business money: balance (wallet.read), pending to collect, and categorized activity. */
export async function businessMoney(userId, businessId, { limit = 40, before } = {}) {
  const { caps } = await capsFor(userId, businessId);
  if (!caps.has('business.activity.read') && !caps.has('business.wallet.read')) throw new OrgAccessError('Not authorized for this business');
  const acc = await businessAccountId(businessId);
  const postings = acc
    ? await prisma.posting.findMany({
        where: { accountId: acc.id, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Number(limit) || 40, 100),
        include: { entry: { select: { reference: true, kind: true, createdAt: true, metadata: true } } },
      })
    : [];
  const items = postings.map((p) => {
    const direction = p.side === 'credit' ? 'in' : 'out';
    const category = categorize(p.entry.kind, direction);
    const visible = canSee(category, caps);
    return {
      reference: visible ? p.entry.reference : null,
      category: visible ? category : 'restricted',
      label: visible ? CATEGORY[category].label : 'Mouvement réservé',
      direction,
      amountKori: visible ? Number(p.amount) : null,
      createdAt: p.entry.createdAt.toISOString(),
    };
  });
  const openCharges = caps.has('business.charges.read') || caps.has('business.wallet.read')
    ? await prisma.merchantCharge.aggregate({ where: { businessId, status: 'open', expiresAt: { gt: new Date() } }, _sum: { amountKori: true }, _count: true })
    : null;
  const awaitingPayment = await prisma.order.aggregate({ where: { businessId, status: 'pending_payment', paymentStatus: { not: 'paid' } }, _sum: { totalAmount: true }, _count: true });
  return {
    balance: caps.has('business.wallet.read')
      ? { availableKori: acc ? Number(acc.balance) : 0, heldKori: 0, note: 'Les fonds du commerce ne sont jamais bloqués : un remboursement est payé immédiatement depuis ce solde.' }
      : null,
    pending: {
      openChargesKori: openCharges ? openCharges._sum.amountKori ?? 0 : null,
      openChargesCount: openCharges ? openCharges._count : null,
      ordersAwaitingPaymentKori: awaitingPayment._sum.totalAmount ?? 0,
      ordersAwaitingPaymentCount: awaitingPayment._count,
      note: 'À encaisser : pas encore de l’argent du commerce.',
    },
    items,
  };
}

const PERIODS = { today: 0, '7d': 7, '30d': 30, '90d': 90 };

function periodStart(period) {
  const days = PERIODS[period] ?? 30;
  if (days === 0) return new Date(`${dakarDateString()}T00:00:00Z`);
  return new Date(Date.now() - days * 86_400_000);
}

/** Strip the kernel suffix used by business payments (`<ref>-J`). */
const baseRef = (r) => r.replace(/-J$/, '');

/**
 * Analytics from real events, with a reconciliation block proving that the
 * sales/refund totals equal the ledger and that every ledger sale maps to an
 * order, a charge, or a direct payment with the same amount.
 */
export async function businessAnalytics(userId, businessId, { period = '30d' } = {}) {
  const { caps } = await capsFor(userId, businessId);
  if (!caps.has('business.analytics.read')) throw new OrgAccessError('Not authorized for this business');
  const since = periodStart(period);
  const acc = await businessAccountId(businessId);

  const postings = acc
    ? await prisma.posting.findMany({ where: { accountId: acc.id, createdAt: { gte: since } }, include: { entry: { select: { reference: true, kind: true } } } })
    : [];
  const sales = postings.filter((p) => p.side === 'credit' && categorize(p.entry.kind, 'in') === 'sale');
  const refunds = postings.filter((p) => p.side === 'debit' && categorize(p.entry.kind, 'out') === 'refund');
  const sum = (rows) => rows.reduce((s, p) => s + Number(p.amount), 0);

  // Map each ledger sale to its source document.
  const refs = sales.map((p) => baseRef(p.entry.reference));
  const [orders, charges] = await Promise.all([
    prisma.order.findMany({ where: { businessId, orderReference: { in: refs } }, select: { orderReference: true, paidAmount: true } }),
    prisma.merchantCharge.findMany({ where: { businessId, paymentRef: { in: refs } }, select: { paymentRef: true, amountKori: true } }),
  ]);
  const orderByRef = new Map(orders.map((o) => [o.orderReference, o.paidAmount]));
  const chargeByRef = new Map(charges.map((c) => [c.paymentRef, c.amountKori]));
  const bySource = { order: 0, charge: 0, direct: 0 };
  const mismatches = [];
  for (const p of sales) {
    const r = baseRef(p.entry.reference);
    const amt = Number(p.amount);
    if (orderByRef.has(r)) {
      bySource.order += amt;
      if (orderByRef.get(r) !== amt && p.entry.kind !== 'marketplace_purchase') mismatches.push(r);
    } else if (chargeByRef.has(r)) {
      bySource.charge += amt;
      if (chargeByRef.get(r) !== amt) mismatches.push(r);
    } else bySource.direct += amt;
  }

  // Operational order metrics (all orders of the period, whatever the settlement).
  const periodOrders = await prisma.order.findMany({
    where: { businessId, createdAt: { gte: since } },
    select: { status: true, paymentStatus: true, paidAmount: true, settledTo: true, items: { select: { productId: true, quantity: true, unitPrice: true, product: { select: { title: true } } } } },
  });
  const paidOrders = periodOrders.filter((o) => o.paymentStatus === 'paid' && !['cancelled', 'refunded'].includes(o.status));
  const paidOrdersKori = paidOrders.reduce((s, o) => s + o.paidAmount, 0);
  const byStatus = {};
  for (const o of periodOrders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  const products = new Map();
  for (const o of paidOrders) {
    for (const li of o.items) {
      const cur = products.get(li.productId) ?? { productId: li.productId, title: li.product?.title ?? null, units: 0, revenueKori: 0 };
      cur.units += li.quantity;
      cur.revenueKori += li.quantity * li.unitPrice;
      products.set(li.productId, cur);
    }
  }
  const movements = await prisma.stockMovement.groupBy({ by: ['reason'], where: { businessId, createdAt: { gte: since } }, _sum: { delta: true }, _count: true });

  return {
    period,
    since: since.toISOString(),
    sales: {
      grossKori: sum(sales),
      refundsKori: sum(refunds),
      netKori: sum(sales) - sum(refunds),
      bySource: { ordersKori: bySource.order, qrChargesKori: bySource.charge, directPaymentsKori: bySource.direct },
      ownerSettledOrdersKori: paidOrders.filter((o) => o.settledTo === 'owner').reduce((s, o) => s + o.paidAmount, 0),
    },
    orders: {
      count: periodOrders.length,
      paidCount: paidOrders.length,
      averageOrderKori: paidOrders.length ? Math.round(paidOrdersKori / paidOrders.length) : 0,
      byStatus: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, { count: v, label: ORDER_LABELS[k] ?? k }])),
    },
    topProducts: [...products.values()].sort((a, b) => b.units - a.units).slice(0, 10),
    inventoryMovement: movements.map((m) => ({ reason: m.reason, count: m._count, netUnits: m._sum.delta ?? 0 })),
    reconciliation: {
      ledgerSalesKori: sum(sales),
      sourcedSalesKori: bySource.order + bySource.charge + bySource.direct,
      unmatchedReferences: mismatches,
      ok: mismatches.length === 0,
      note: 'Chaque vente du grand livre correspond à une commande, une référence QR ou un paiement direct du même montant.',
    },
  };
}

/** Customers: only what is needed to serve them — name/handle and their history WITH THIS business. */
export async function businessCustomers(userId, businessId, { limit = 50 } = {}) {
  const { caps } = await capsFor(userId, businessId);
  if (!caps.has('business.customers.read')) throw new OrgAccessError('Not authorized for this business');
  const [orders, charges] = await Promise.all([
    prisma.order.groupBy({ by: ['buyerId'], where: { businessId, paymentStatus: 'paid' }, _count: true, _sum: { paidAmount: true }, _max: { createdAt: true } }),
    prisma.merchantCharge.groupBy({ by: ['paidBy'], where: { businessId, status: 'paid', paidBy: { not: null } }, _count: true, _sum: { amountKori: true }, _max: { paidAt: true } }),
  ]);
  const agg = new Map();
  for (const o of orders) agg.set(o.buyerId, { orders: o._count, payments: 0, totalKori: o._sum.paidAmount ?? 0, lastAt: o._max.createdAt });
  for (const c of charges) {
    const cur = agg.get(c.paidBy) ?? { orders: 0, payments: 0, totalKori: 0, lastAt: null };
    cur.payments += c._count;
    cur.totalKori += c._sum.amountKori ?? 0;
    if (!cur.lastAt || (c._max.paidAt && c._max.paidAt > cur.lastAt)) cur.lastAt = c._max.paidAt;
    agg.set(c.paidBy, cur);
  }
  const ids = [...agg.keys()];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, handle: true } });
  return users
    .map((u) => ({ name: u.name || null, handle: u.handle || null, ...agg.get(u.id), lastAt: agg.get(u.id).lastAt?.toISOString() ?? null }))
    .sort((a, b) => b.totalKori - a.totalKori)
    .slice(0, Math.min(Number(limit) || 50, 200));
}

/** "Today" for the merchant home: counts, not secrets. */
export async function businessToday(userId, businessId) {
  const { access, caps } = await capsFor(userId, businessId);
  const since = periodStart('today');
  const [newOrders, toPrepare, ready, openCharges] = await Promise.all([
    caps.has('business.orders.read') ? prisma.order.count({ where: { businessId, status: 'confirmed' } }) : null,
    caps.has('business.orders.read') ? prisma.order.count({ where: { businessId, status: 'preparing' } }) : null,
    caps.has('business.orders.read') ? prisma.order.count({ where: { businessId, status: { in: ['ready_for_pickup', 'out_for_delivery'] } } }) : null,
    caps.has('business.charges.read') ? prisma.merchantCharge.count({ where: { businessId, status: 'open', expiresAt: { gt: new Date() } } }) : null,
  ]);
  const lowStock = caps.has('business.catalog.manage') || caps.has('business.inventory.adjust')
    ? await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM "Product" WHERE "businessId" = ${businessId} AND "active" AND "kind" = 'product' AND "trackInventory" AND "inventory" <= "lowStockThreshold"`
    : null;
  let salesToday = null;
  if (caps.has('business.activity.read') || caps.has('business.wallet.read')) {
    const acc = await businessAccountId(businessId);
    if (acc) {
      const rows = await prisma.posting.findMany({ where: { accountId: acc.id, side: 'credit', createdAt: { gte: since } }, include: { entry: { select: { kind: true } } } });
      const s = rows.filter((p) => categorize(p.entry.kind, 'in') === 'sale');
      salesToday = { count: s.length, amountKori: s.reduce((a, p) => a + Number(p.amount), 0) };
    } else salesToday = { count: 0, amountKori: 0 };
  }
  return { me: access, orders: { new: newOrders, preparing: toPrepare, readyOrOut: ready }, openCharges, lowStock: lowStock ? lowStock[0].n : null, salesToday };
}
