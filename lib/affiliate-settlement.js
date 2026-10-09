import { prisma } from './prisma.js';
import { account, business as businessAccount, customer as customerAccount, move } from './money-kernel/flows.js';
import { lockProjections, runMoneyTransaction } from './wallet-atomic.js';
import { ensureBusinessWallet } from './business-wallet-service.js';

/**
 * Refund-aware affiliate commissions (A4, after the J9 audit F4). INACTIVE unless
 * AFFILIATE_DEFERRED_SETTLEMENT=true — production keeps the legacy immediate behaviour until the
 * owner approves (P-J9-4). No historical record is changed.
 *
 *   purchase            buyer pays the merchant the full price (normal J4/J5 settlement)
 *   provisional         in the SAME transaction the commission moves merchant → escrow:affiliate:<id>
 *   settlement window   the order must reach delivered / completed; the window (default 7 days) starts
 *                       the first time the settlement job sees it there
 *   earned              after the window: escrow → affiliate:<user>:earnings, scaled by what was NOT
 *                       refunded (partial refunds reduce it; the unearned part returns to the merchant)
 *   reversed            cancelled / fully refunded before earning → the whole escrow returns to the merchant
 *   paid                the affiliate moves earned commission to their wallet (idempotent per key)
 *   review              refunded AFTER earning, or an order still open after 60 days: flagged, never
 *                       silently clawed back
 * Fraud controls (deferred mode): no commission when the affiliate is the buyer, owns or works for the
 * selling business, or exceeds 3 attributions per buyer in 24 h; one commission per order.
 */
export const affiliateDeferredEnabled = () => process.env.AFFILIATE_DEFERRED_SETTLEMENT === 'true';
export const SETTLEMENT_WINDOW_DAYS = 7;
export const STALE_ORDER_DAYS = 60;
const VELOCITY_PER_DAY = 3;
const DONE = ['delivered', 'completed'];

const escrow = (tx, id) => account(tx, 'affiliateEscrow', id);
const earnings = (tx, userId) => account(tx, 'affiliateEarnings', userId);

/** Deferred-mode attribution checks (null = attribute, else the refusal reason). */
export async function affiliateFraudReason(db, { attribution, buyerId, business }) {
  if (attribution.affiliateUserId === buyerId) return 'self_purchase';
  if (business.ownerId === attribution.affiliateUserId) return 'affiliate_owns_business';
  if (await db.businessMember.findFirst({ where: { businessId: business.id, userId: attribution.affiliateUserId, status: 'active' } })) return 'affiliate_works_for_business';
  const recent = await db.affiliateCommission.count({ where: { affiliateId: attribution.affiliateId, buyerId, createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
  if (recent >= VELOCITY_PER_DAY) return 'velocity';
  return null;
}

async function merchantAccountFor(tx, order, business) {
  if (order.settledTo === 'business') {
    const w = await ensureBusinessWallet(business.id, tx);
    await lockProjections(tx, { BusinessWallet: [w.id] });
    return businessAccount(tx, business.id);
  }
  const w = await tx.wallet.findUnique({ where: { userId: business.ownerId } });
  await lockProjections(tx, { Wallet: [w.id] });
  return customerAccount(tx, business.ownerId);
}

/** Inside the purchase transaction, after the merchant was paid in full. */
export async function holdAffiliateCommissionInTx(tx, { order, business, attribution, buyerId, amountKori, source, reference }) {
  if (await tx.affiliateCommission.findFirst({ where: { orderId: order.id } })) return null; // one per order
  const row = await tx.affiliateCommission.create({
    data: {
      affiliateId: attribution.affiliateId, orderId: order.id, buyerId, amount: amountKori, orderTotal: order.totalAmount, commissionBps: attribution.commissionBps,
      source, linkCode: attribution.linkCode, productId: attribution.productId, businessId: business.id, reference, status: 'provisional', settlementMode: 'deferred',
    },
  });
  await move(tx, { from: await merchantAccountFor(tx, order, business), to: await escrow(tx, row.id), amount: amountKori, reference: `AFF-HOLD-${row.id}`, kind: 'affiliate_commission_hold', actor: { type: 'system', id: 'affiliate' }, authorization: 'affiliate_attribution' });
  return row;
}

/**
 * Inside a full order refund / cancellation transaction (the order row is already locked): a
 * still-provisional deferred commission goes back to the merchant first, so the merchant is never
 * short of funds the escrow holds. Commissions already earned or paid are left alone (review flag
 * later, never a silent clawback). Returns the Kori released (0 when nothing was held).
 */
export async function releaseAffiliateHoldForRefundInTx(tx, order) {
  const c = await tx.affiliateCommission.findFirst({ where: { orderId: order.id, settlementMode: 'deferred' } });
  if (!c) return 0;
  await tx.$executeRaw`SELECT id FROM "AffiliateCommission" WHERE id = ${c.id} FOR UPDATE`;
  const cur = await tx.affiliateCommission.findUnique({ where: { id: c.id } });
  if (!['provisional', 'review'].includes(cur.status) || cur.settledAt) return 0;
  const business = await tx.business.findUnique({ where: { id: cur.businessId } });
  await move(tx, { from: await escrow(tx, cur.id), to: await merchantAccountFor(tx, order, business), amount: cur.amount, reference: `AFF-BACK-${cur.id}`, kind: 'affiliate_commission_reversal', actor: { type: 'system', id: 'affiliate' }, authorization: 'order_refunded_before_eligibility' });
  await tx.affiliateCommission.update({ where: { id: cur.id }, data: { status: 'reversed', reversedKori: cur.amount, settledAt: new Date() } });
  return cur.amount;
}

/** Kori refunded on an order: full order refund, or partial merchant refunds of its payment. */
async function refundedKoriFor(tx, order) {
  if (order.refundedAt || order.status === 'refunded') return order.totalAmount;
  const rows = await tx.$queryRaw`
    SELECT COALESCE(SUM(p.amount), 0)::bigint AS kori FROM "JournalEntry" j JOIN "Posting" p ON p."entryId" = j.id
     WHERE j.kind = 'merchant_refund' AND p.side = 'debit'
       AND j.metadata->>'originalReference' IN (${order.orderReference}, ${`${order.orderReference}-J`})`;
  return Math.min(Number(rows[0]?.kori ?? 0), order.totalAmount);
}

/** Settlement job (cron). Idempotent; each commission settles once under a row lock. */
export async function settleAffiliateCommissions(db = prisma, now = new Date()) {
  const out = { earned: 0, reversed: 0, partiallyReversed: 0, review: 0, waiting: 0 };
  const rows = await db.affiliateCommission.findMany({ where: { status: 'provisional', settlementMode: 'deferred' }, take: 500 });
  for (const c of rows) {
    await runMoneyTransaction(db, async (tx) => {
      await tx.$executeRaw`SELECT id FROM "AffiliateCommission" WHERE id = ${c.id} FOR UPDATE`;
      const cur = await tx.affiliateCommission.findUnique({ where: { id: c.id } });
      if (cur.status !== 'provisional') return;
      const order = await tx.order.findUnique({ where: { id: cur.orderId } });
      const business = await tx.business.findUnique({ where: { id: cur.businessId } });
      const profile = await tx.affiliateProfile.findUnique({ where: { id: cur.affiliateId } });
      const back = async (amount, why) => {
        if (amount > 0) await move(tx, { from: await escrow(tx, cur.id), to: await merchantAccountFor(tx, order, business), amount, reference: `AFF-BACK-${cur.id}`, kind: 'affiliate_commission_reversal', actor: { type: 'system', id: 'affiliate' }, authorization: why });
      };
      if (['cancelled', 'refunded'].includes(order.status) || order.refundedAt) {
        await back(cur.amount, 'order_cancelled_or_refunded_before_eligibility');
        await tx.affiliateCommission.update({ where: { id: cur.id }, data: { status: 'reversed', reversedKori: cur.amount, settledAt: now } });
        out.reversed += 1;
        return;
      }
      if (!DONE.includes(order.status)) {
        if (cur.createdAt.getTime() + STALE_ORDER_DAYS * 86_400_000 < now.getTime()) {
          await tx.affiliateCommission.update({ where: { id: cur.id }, data: { status: 'review', reviewReason: 'order_not_completed' } });
          out.review += 1;
        } else out.waiting += 1;
        return;
      }
      if (!cur.completedSeenAt) {
        await tx.affiliateCommission.update({ where: { id: cur.id }, data: { completedSeenAt: now, eligibleAt: new Date(now.getTime() + SETTLEMENT_WINDOW_DAYS * 86_400_000) } });
        out.waiting += 1;
        return;
      }
      if (cur.eligibleAt > now) { out.waiting += 1; return; }
      const refunded = await refundedKoriFor(tx, order);
      const earned = Math.floor((cur.amount * (order.totalAmount - refunded)) / Math.max(order.totalAmount, 1));
      if (earned > 0) await move(tx, { from: await escrow(tx, cur.id), to: await earnings(tx, profile.userId), amount: earned, reference: `AFF-EARN-${cur.id}`, kind: 'affiliate_commission_earned', actor: { type: 'system', id: 'affiliate' }, authorization: 'settlement_window_passed' });
      await back(cur.amount - earned, 'partial_refund_before_eligibility');
      await tx.affiliateCommission.update({ where: { id: cur.id }, data: { status: earned > 0 ? 'earned' : 'reversed', earnedKori: earned, reversedKori: cur.amount - earned, settledAt: now } });
      if (earned > 0) await tx.affiliateProfile.update({ where: { id: profile.id }, data: { totalEarned: { increment: earned } } });
      if (earned > 0 && earned < cur.amount) out.partiallyReversed += 1;
      else if (earned > 0) out.earned += 1;
      else out.reversed += 1;
    });
  }
  // Refunds AFTER earning: never clawed back automatically — flagged for a reviewed adjustment.
  const late = await db.$queryRaw`
    SELECT c.id FROM "AffiliateCommission" c JOIN "Order" o ON o.id = c."orderId"
     WHERE c."settlementMode" = 'deferred' AND c.status IN ('earned','paid') AND c."reviewReason" IS NULL
       AND (o."refundedAt" > c."settledAt" OR o.status = 'refunded')`;
  for (const { id } of late) {
    await db.affiliateCommission.update({ where: { id }, data: { reviewReason: 'refunded_after_earned' } });
    out.review += 1;
  }
  return out;
}

/** The affiliate moves earned (deferred) commission to their own wallet. Idempotent per key. */
export async function payoutAffiliateEarnings(userId, { idempotencyKey }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) throw Object.assign(new Error('Clé d’idempotence requise'), { status: 400, code: 'idempotency_key_required' });
  const reference = `AFP-${userId}-${idempotencyKey}`.slice(0, 120);
  return runMoneyTransaction(prisma, async (tx) => {
    const done = await tx.affiliateCommission.findMany({ where: { payoutReference: { startsWith: `${reference}#` } } });
    if (done.length) return { paidKori: done.reduce((s, c) => s + (c.earnedKori ?? 0), 0), count: done.length, replayed: true };
    const profile = await tx.affiliateProfile.findUnique({ where: { userId } });
    if (!profile) return { paidKori: 0, count: 0 };
    await tx.$executeRaw`SELECT id FROM "AffiliateCommission" WHERE "affiliateId" = ${profile.id} AND status = 'earned' FOR UPDATE`;
    const rows = await tx.affiliateCommission.findMany({ where: { affiliateId: profile.id, status: 'earned', reviewReason: null }, orderBy: { createdAt: 'asc' }, take: 200 });
    const total = rows.reduce((s, c) => s + (c.earnedKori ?? 0), 0);
    if (!total) return { paidKori: 0, count: 0 };
    const w = await tx.wallet.findUnique({ where: { userId } });
    await lockProjections(tx, { Wallet: [w.id] });
    await move(tx, { from: await earnings(tx, userId), to: await customerAccount(tx, userId), amount: total, reference, kind: 'affiliate_commission_payout', actor: { type: 'user', id: userId }, authorization: 'affiliate_own_earned_commission' });
    let i = 0;
    for (const c of rows) {
      const u = await tx.affiliateCommission.updateMany({ where: { id: c.id, status: 'earned' }, data: { status: 'paid', paidAt: new Date(), payoutReference: `${reference}#${i++}` } });
      if (u.count !== 1) throw Object.assign(new Error('Commissions modifiées entre-temps'), { status: 409, code: 'conflict' });
    }
    return { paidKori: total, count: rows.length };
  });
}

/** A1-style invariant: escrow = provisional amounts; earnings account = earned (unpaid) amounts. */
export async function checkAffiliateInvariants(db = prisma) {
  const v = [];
  const escrowBad = await db.$queryRaw`
    SELECT c.id FROM "AffiliateCommission" c LEFT JOIN "LedgerAccount" l ON l.code = 'escrow:affiliate:' || c.id
     WHERE c."settlementMode" = 'deferred' AND COALESCE(l.balance, 0) <> CASE WHEN c.status IN ('provisional','review') AND c."settledAt" IS NULL THEN c.amount ELSE 0 END`;
  if (escrowBad.length) v.push({ id: 'A1', count: escrowBad.length });
  const earnBad = await db.$queryRaw`
    SELECT l.id FROM "LedgerAccount" l WHERE l.type = 'affiliate_earnings'
       AND l.balance <> COALESCE((SELECT SUM(c."earnedKori") FROM "AffiliateCommission" c JOIN "AffiliateProfile" p ON p.id = c."affiliateId"
             WHERE p."userId" = l."ownerId" AND c.status = 'earned'), 0)`;
  if (earnBad.length) v.push({ id: 'A2', count: earnBad.length });
  return { ok: v.length === 0, violations: v };
}
