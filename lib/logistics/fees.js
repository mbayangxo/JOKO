import { prisma } from '../prisma.js';
import { account, business as businessAccount, customer as customerAccount, move } from '../money-kernel/flows.js';
import { lockProjections, runMoneyTransaction } from '../wallet-atomic.js';
import { ensureBusinessWallet } from '../business-wallet-service.js';
import { LogisticsError } from './contract.js';

/**
 * J8.10 / J8.11 — delivery fee and courier earnings (J2 recipes).
 *
 * Only JOKKO_LOGISTICS charges a Jokko delivery fee. Merchant / distributor
 * own-fleet deliveries and customer pickup carry no Jokko fee (honest: the
 * business runs its own movement). Fee and courier share are SERVER rules,
 * snapshotted on the request; nobody sends a price.
 *
 *   request (JOKKO_LOGISTICS)  sender business wallet ──fee──▶ escrow:shipment_fee:<req>      feeStatus=held
 *   verified delivery          escrow ──earning──▶ courier:<id>:earnings (CourierEarning accrued)
 *                              escrow ──remainder──▶ revenue:delivery                         feeStatus=released
 *   cancel / operational fail  escrow ──fee──▶ sender business wallet                          feeStatus=refunded
 *   payout (after hold, no open dispute)  courier:<id>:earnings ──▶ courier wallet            earning=paid
 *
 * Every posting has a deterministic reference: a retry replays, never repeats.
 * A courier is never paid because they pressed a button: release happens only
 * with a verified proof (receiver code / receiver receiving / pickup-point
 * release / operator ruling).
 */
/**
 * TEST CONFIGURATION ONLY (D35): 150 Kori, 80 % courier share, 24 h hold. Production
 * activation stays disabled until finance approves pricing and settlement rules.
 *
 * Failed-attempt compensation (D37), in basis points of the HELD fee, per CONFIRMED side.
 * Defaults are 0: a failed attempt pays nothing unless finance configures it. Only sides
 * the sender's held fee can fairly fund are configurable (receiver, source); a courier
 * fault never pays, and a platform cancellation would need platform funding (not built).
 */
const COMPENSABLE_SIDES = ['receiver', 'source'];
export const FEE_RULES = (() => {
  const base = { local: { feeKori: 150, courierShareBps: 8000, failedAttemptBps: { receiver: 0, source: 0 } } };
  try {
    const o = JSON.parse(process.env.LOGISTICS_FEE_JSON ?? '{}');
    if (o.local && Number.isSafeInteger(o.local.feeKori) && o.local.feeKori > 0 && Number.isSafeInteger(o.local.courierShareBps) && o.local.courierShareBps >= 0 && o.local.courierShareBps <= 10_000) {
      const fa = { receiver: 0, source: 0 };
      for (const side of COMPENSABLE_SIDES) {
        const v = o.local.failedAttemptBps?.[side];
        if (Number.isSafeInteger(v) && v >= 0 && v <= o.local.courierShareBps) fa[side] = v;
      }
      base.local = { feeKori: o.local.feeKori, courierShareBps: o.local.courierShareBps, failedAttemptBps: fa };
    }
  } catch {
    /* invalid override ignored: defaults stand */
  }
  return base;
})();
export const EARNING_HOLD_HOURS = 24;

export function feeFor(serviceType) {
  const rule = FEE_RULES[serviceType];
  if (!rule) throw new LogisticsError('service_not_available', 'Ce type de livraison n’est pas encore proposé', 409);
  const earning = Math.floor((rule.feeKori * rule.courierShareBps) / 10_000);
  return { feeKori: rule.feeKori, courierEarningKori: earning };
}

/** Courier compensation for a failed attempt whose side is CONFIRMED (0 otherwise). Funded from the held fee only. */
export function failedAttemptCompensation(request, { side, confirmed }) {
  if (!confirmed || !COMPENSABLE_SIDES.includes(side)) return 0;
  const bps = FEE_RULES[request.serviceType]?.failedAttemptBps?.[side] ?? 0;
  return Math.min(Math.floor((request.feeKori * bps) / 10_000), request.courierEarningKori);
}

const escrow = (tx, requestId) => account(tx, 'escrowShipmentFee', requestId);

export async function holdFeeInTx(tx, request, { actorUserId }) {
  if (request.feeKori <= 0 || request.feeStatus !== 'none') return request;
  const w = await ensureBusinessWallet(request.originBusinessId, tx);
  await lockProjections(tx, { BusinessWallet: [w.id] });
  await move(tx, {
    from: await businessAccount(tx, request.originBusinessId),
    to: await escrow(tx, request.id),
    amount: request.feeKori,
    reference: `SHF-HOLD-${request.id}`,
    kind: 'shipment_fee_hold',
    actor: { type: 'user', id: actorUserId },
    authorization: 'sender_requested_jokko_logistics',
  });
  return tx.fulfilmentRequest.update({ where: { id: request.id }, data: { feeStatus: 'held' } });
}

/** Release on VERIFIED delivery (or a receiver-side failure once the goods are back). */
export async function releaseFeeInTx(tx, request, { shipmentId, courierUserId }) {
  await tx.$executeRaw`SELECT id FROM "FulfilmentRequest" WHERE id = ${request.id} FOR UPDATE`;
  const r = await tx.fulfilmentRequest.findUnique({ where: { id: request.id } });
  if (r.feeStatus !== 'held') return null; // nothing held, or already settled: never twice
  const earning = Math.min(r.courierEarningKori, r.feeKori);
  if (earning > 0) {
    await move(tx, { from: await escrow(tx, r.id), to: await account(tx, 'courierEarnings', courierUserId), amount: earning, reference: `SHF-EARN-${r.id}`, kind: 'courier_earning_accrue', actor: { type: 'system', id: 'logistics' }, authorization: 'verified_delivery' });
    await tx.courierEarning.create({ data: { shipmentId, courierUserId, amountKori: earning, status: 'accrued', releasableAt: new Date(Date.now() + EARNING_HOLD_HOURS * 3600_000) } });
  }
  if (r.feeKori - earning > 0) {
    await move(tx, { from: await escrow(tx, r.id), to: await account(tx, 'revenue', 'delivery'), amount: r.feeKori - earning, reference: `SHF-REV-${r.id}`, kind: 'delivery_revenue', actor: { type: 'system', id: 'logistics' }, authorization: 'verified_delivery' });
  }
  return tx.fulfilmentRequest.update({ where: { id: r.id }, data: { feeStatus: 'released' } });
}

/**
 * Failed attempt, goods back at the source: pay the confirmed compensation (may be 0)
 * to the courier, refund the rest of the held fee to the sender. Once (feeStatus).
 */
export async function settleFailedAttemptInTx(tx, request, { shipmentId, courierUserId, compensationKori, reason }) {
  await tx.$executeRaw`SELECT id FROM "FulfilmentRequest" WHERE id = ${request.id} FOR UPDATE`;
  const r = await tx.fulfilmentRequest.findUnique({ where: { id: request.id } });
  if (r.feeStatus !== 'held') return null;
  const comp = Math.max(0, Math.min(compensationKori, r.courierEarningKori, r.feeKori));
  if (comp > 0 && courierUserId) {
    await move(tx, { from: await escrow(tx, r.id), to: await account(tx, 'courierEarnings', courierUserId), amount: comp, reference: `SHF-EARN-${r.id}`, kind: 'courier_earning_accrue', actor: { type: 'system', id: 'logistics' }, authorization: `failed_attempt_confirmed:${reason}` });
    await tx.courierEarning.create({ data: { shipmentId, courierUserId, amountKori: comp, status: 'accrued', releasableAt: new Date(Date.now() + EARNING_HOLD_HOURS * 3600_000) } });
  }
  const back = r.feeKori - (comp > 0 && courierUserId ? comp : 0);
  if (back > 0) {
    const w = await ensureBusinessWallet(r.originBusinessId, tx);
    await lockProjections(tx, { BusinessWallet: [w.id] });
    await move(tx, { from: await escrow(tx, r.id), to: await businessAccount(tx, r.originBusinessId), amount: back, reference: `SHF-REFUND-${r.id}`, kind: 'shipment_fee_refund', actor: { type: 'system', id: 'logistics' }, authorization: `failed:${reason}` });
  }
  return tx.fulfilmentRequest.update({ where: { id: r.id }, data: { feeStatus: comp > 0 && courierUserId ? 'released' : 'refunded' } });
}

export async function refundFeeInTx(tx, request, { reason }) {
  await tx.$executeRaw`SELECT id FROM "FulfilmentRequest" WHERE id = ${request.id} FOR UPDATE`;
  const r = await tx.fulfilmentRequest.findUnique({ where: { id: request.id } });
  if (r.feeStatus !== 'held') return null;
  const w = await ensureBusinessWallet(r.originBusinessId, tx);
  await lockProjections(tx, { BusinessWallet: [w.id] });
  await move(tx, { from: await escrow(tx, r.id), to: await businessAccount(tx, r.originBusinessId), amount: r.feeKori, reference: `SHF-REFUND-${r.id}`, kind: 'shipment_fee_refund', actor: { type: 'system', id: 'logistics' }, authorization: `fee_refund:${reason}` });
  return tx.fulfilmentRequest.update({ where: { id: r.id }, data: { feeStatus: 'refunded' } });
}

/** Mark accrued earnings past their hold (and without an open dispute) releasable. */
export async function promoteReleasableEarnings(db = prisma, now = new Date()) {
  const rows = await db.courierEarning.findMany({ where: { status: 'accrued', releasableAt: { lte: now } }, select: { id: true, shipmentId: true } });
  let n = 0;
  for (const e of rows) {
    const open = await db.shipmentDispute.findFirst({ where: { shipmentId: e.shipmentId, status: { in: ['open', 'awaiting_reversal'] } } });
    if (open) continue;
    const u = await db.courierEarning.updateMany({ where: { id: e.id, status: 'accrued' }, data: { status: 'releasable' } });
    n += u.count;
  }
  return { promoted: n };
}

/** Courier pays their releasable earnings out to their own wallet. Idempotent per key. */
export async function payoutEarnings(courierUserId, { idempotencyKey }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) throw new LogisticsError('idempotency_key_required', 'Clé d’idempotence requise', 400);
  const reference = `CEP-${courierUserId}-${idempotencyKey}`.slice(0, 120);
  return runMoneyTransaction(prisma, async (tx) => {
    const done = await tx.courierEarning.findMany({ where: { payoutReference: { startsWith: reference } } });
    if (done.length) return { paidKori: done.reduce((a, e) => a + e.amountKori, 0), count: done.length, replayed: true };
    await tx.$executeRaw`SELECT id FROM "CourierEarning" WHERE "courierUserId" = ${courierUserId} AND status = 'releasable' FOR UPDATE`;
    const frozen = (await tx.shipmentDispute.findMany({ where: { status: { in: ['open', 'awaiting_reversal'] }, shipmentId: { in: (await tx.courierEarning.findMany({ where: { courierUserId, status: 'releasable' }, select: { shipmentId: true } })).map((e) => e.shipmentId) } }, select: { shipmentId: true } })).map((d) => d.shipmentId);
    const rows = await tx.courierEarning.findMany({ where: { courierUserId, status: 'releasable', shipmentId: { notIn: frozen } }, orderBy: { createdAt: 'asc' }, take: 200 });
    if (!rows.length) return { paidKori: 0, count: 0 };
    const total = rows.reduce((a, e) => a + e.amountKori, 0);
    const wallet = await tx.wallet.findUnique({ where: { userId: courierUserId } });
    if (!wallet) throw new LogisticsError('wallet_missing', 'Portefeuille introuvable', 404);
    await lockProjections(tx, { Wallet: [wallet.id] });
    await move(tx, { from: await account(tx, 'courierEarnings', courierUserId), to: await customerAccount(tx, courierUserId), amount: total, reference, kind: 'courier_earning_payout', actor: { type: 'user', id: courierUserId }, authorization: 'courier_own_releasable_earnings' });
    let i = 0;
    for (const e of rows) {
      const u = await tx.courierEarning.updateMany({ where: { id: e.id, status: 'releasable' }, data: { status: 'paid', paidAt: new Date(), payoutReference: `${reference}#${i++}` } });
      if (u.count !== 1) throw new LogisticsError('conflict', 'Gains modifiés entre-temps — réessaie', 409);
    }
    return { paidKori: total, count: rows.length };
  });
}

/** Reverse an UNPAID earning (dispute ruling): compensating moves back to the fee payer. */
export async function reverseEarningInTx(tx, shipmentId, { reason }) {
  const e = await tx.courierEarning.findUnique({ where: { shipmentId } });
  if (!e) return { reversed: 0 };
  if (e.status === 'paid') return { reversed: 0, unrecoverable: e.amountKori };
  if (e.status === 'reversed') return { reversed: 0 };
  const sh = await tx.shipment.findUnique({ where: { id: shipmentId } });
  const r = await tx.fulfilmentRequest.findUnique({ where: { id: sh.requestId } });
  const w = await ensureBusinessWallet(r.originBusinessId, tx);
  await lockProjections(tx, { BusinessWallet: [w.id] });
  await move(tx, { from: await account(tx, 'courierEarnings', e.courierUserId), to: await businessAccount(tx, r.originBusinessId), amount: e.amountKori, reference: `SHF-REV-EARN-${shipmentId}`, kind: 'courier_earning_reversal', actor: { type: 'system', id: 'logistics' }, authorization: `dispute_ruling:${reason}` });
  // Reverse only the revenue that was actually posted (a failed-attempt settlement posts none).
  const posted = await tx.journalEntry.findFirst({ where: { reference: `SHF-REV-${r.id}` }, select: { id: true } });
  const rev = posted ? r.feeKori - Math.min(r.courierEarningKori, r.feeKori) : 0;
  if (rev > 0) {
    await move(tx, { from: await account(tx, 'revenue', 'delivery'), to: await businessAccount(tx, r.originBusinessId), amount: rev, reference: `SHF-REV-FEE-${shipmentId}`, kind: 'delivery_revenue_reversal', actor: { type: 'system', id: 'logistics' }, authorization: `dispute_ruling:${reason}` });
  }
  await tx.courierEarning.update({ where: { id: e.id }, data: { status: 'reversed' } });
  return { reversed: e.amountKori + Math.max(0, rev) };
}
