import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx } from '../business-access.js';
import { account, business as businessAccount, move } from '../money-kernel/flows.js';
import { lockProjections, runMoneyTransaction } from '../wallet-atomic.js';
import { ensureBusinessWallet } from '../business-wallet-service.js';
import { COMMISSION_HOLD_HOURS, EARNING_HOLD_HOURS, WorkError, assertWorkMoneyEnabled, workMoneyEnabled } from './contract.js';
import { accrueInTx, escrowBalance, ruleBudget } from './money.js';

/**
 * J9 outcome-funded work: rep commissions and pickup-point fees, and per-delivery pay of a
 * business's own-fleet courier hired through J9.
 *
 * A rule starts at amount 0 / `proposed`. It pays only when a DIFFERENT business member holding
 * business.pay approved it, and only from its prefunded budget (escrow:work_rule:<id>) — "subject to
 * budget": an outcome that finds the budget short waits (nothing is promised unfunded) and is paid,
 * in order, once the budget is topped up. Every outcome is paid at most once (WorkOutcome.outcomeKey).
 *
 * Eligibility is a VERIFIED commercial / custody fact, never a self-report:
 *   rep_first_received_order  the merchant's FIRST PO from this distributor, received (J8 receiving
 *                             or the buyer's own receipt) AND paid; merchant introduced by the rep;
 *                             no self-dealing (rep / distributor staff own or run the merchant → ineligible)
 *   pickup_release_fee        a shipment of the rule's business released at the rule's pickup point
 *                             with the recipient's code (`pickup_point_release` proof)
 *   courier per delivery      own-fleet shipment delivered with a verified proof by the hired courier;
 *                             never when the shipment carries a J8 courier earning (no double pay)
 */
const VERIFIED_PROOFS = ['receiver_challenge', 'receiver_receiving', 'pickup_point_release', 'operator_ruling'];

async function auth(tx, userId, businessId, cap) {
  try {
    await assertBusinessAuthorityInTx(tx, userId, businessId, cap);
  } catch (e) {
    if (e instanceof OrgAccessError) throw new WorkError(e.status === 404 ? 'not_found' : 'not_authorized', 'Action non autorisée', e.status === 404 ? 404 : 403);
    throw e;
  }
}

const ruleView = async (db, r) => ({
  id: r.id, kind: r.kind, amountKori: r.amountKori, minOrderKori: r.minOrderKori, pickupPointId: r.pickupPointId, status: r.status,
  budgetKori: Number((await db.ledgerAccount.findUnique({ where: { code: `escrow:work_rule:${r.id}` }, select: { balance: true } }))?.balance ?? 0),
  approved: Boolean(r.approvedBy), createdAt: r.createdAt.toISOString(),
});

export async function proposeRule(userId, businessId, { kind, amountKori = 0, minOrderKori = 0, pickupPointId }) {
  if (!['rep_first_received_order', 'pickup_release_fee'].includes(kind)) throw new WorkError('invalid', 'Règle inconnue', 400);
  if (!Number.isSafeInteger(amountKori) || amountKori < 0 || amountKori > 1_000_000) throw new WorkError('invalid', 'Montant invalide', 400);
  if (!Number.isSafeInteger(minOrderKori) || minOrderKori < 0) throw new WorkError('invalid', 'Commande minimale invalide', 400);
  return prisma.$transaction(async (tx) => {
    await auth(tx, userId, businessId, kind === 'rep_first_received_order' ? 'business.distribution.manage' : 'business.staffing.manage');
    if (kind === 'pickup_release_fee') {
      const p = pickupPointId && (await tx.pickupPoint.findUnique({ where: { id: pickupPointId } }));
      if (!p || p.status !== 'active') throw new WorkError('not_found', 'Point relais introuvable', 404);
      if (p.operatorBusinessId === businessId) throw new WorkError('invalid', 'On ne se paie pas soi-même', 400);
    }
    const r = await tx.workRule.create({ data: { businessId, kind, amountKori, minOrderKori, pickupPointId: kind === 'pickup_release_fee' ? pickupPointId : null, proposedBy: userId } });
    return ruleView(tx, r);
  });
}

/** Dual control: a different member holding business.pay activates the rule (the owner may approve a manager's proposal). */
export async function approveRule(userId, businessId, ruleId) {
  return prisma.$transaction(async (tx) => {
    await auth(tx, userId, businessId, 'business.pay');
    const r = await tx.workRule.findUnique({ where: { id: ruleId } });
    if (!r || r.businessId !== businessId) throw new WorkError('not_found', 'Règle introuvable', 404);
    if (r.status === 'active') return { ...(await ruleView(tx, r)), replayed: true };
    if (r.status !== 'proposed') throw new WorkError('invalid_state', 'Règle non approuvable');
    if (r.proposedBy === userId) throw new WorkError('dual_control', 'Une autre personne habilitée doit approuver', 403);
    if (r.amountKori <= 0) throw new WorkError('zero_rate', 'Montant à 0 : rien à activer', 409);
    return ruleView(tx, await tx.workRule.update({ where: { id: r.id }, data: { status: 'active', approvedBy: userId, approvedAt: new Date() } }));
  });
}

export async function fundRule(userId, businessId, ruleId, { amountKori, idempotencyKey }) {
  if (!Number.isSafeInteger(amountKori) || amountKori <= 0) throw new WorkError('invalid', 'Montant invalide', 400);
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) throw new WorkError('idempotency_key_required', 'Clé d’idempotence requise', 400);
  return runMoneyTransaction(prisma, async (tx) => {
    await auth(tx, userId, businessId, 'business.pay');
    const r = await tx.workRule.findUnique({ where: { id: ruleId } });
    if (!r || r.businessId !== businessId) throw new WorkError('not_found', 'Règle introuvable', 404);
    assertWorkMoneyEnabled(); // after authorization: an outsider learns nothing about activation state
    if (!['proposed', 'active'].includes(r.status)) throw new WorkError('invalid_state', 'Règle close');
    const reference = `WRB-FUND-${r.id}-${idempotencyKey}`.slice(0, 120);
    if (await tx.journalEntry.findFirst({ where: { reference }, select: { id: true } })) return { ...(await ruleView(tx, r)), replayed: true };
    const w = await ensureBusinessWallet(businessId, tx);
    await lockProjections(tx, { BusinessWallet: [w.id] });
    await move(tx, { from: await businessAccount(tx, businessId), to: await ruleBudget(tx, r.id), amount: amountKori, reference, kind: 'work_rule_budget_fund', actor: { type: 'user', id: userId }, authorization: 'business.pay:work_rule' });
    return ruleView(tx, r);
  });
}

/** End a rule: the unused budget goes back to the business; outcomes already accrued stay earned. */
export async function endRule(userId, businessId, ruleId) {
  return runMoneyTransaction(prisma, async (tx) => {
    await auth(tx, userId, businessId, 'business.pay');
    await tx.$executeRaw`SELECT id FROM "WorkRule" WHERE id = ${ruleId} FOR UPDATE`;
    const r = await tx.workRule.findUnique({ where: { id: ruleId } });
    if (!r || r.businessId !== businessId) throw new WorkError('not_found', 'Règle introuvable', 404);
    if (r.status === 'ended') return { ...(await ruleView(tx, r)), replayed: true };
    const bal = Number((await tx.ledgerAccount.findUnique({ where: { code: `escrow:work_rule:${r.id}` }, select: { balance: true } }))?.balance ?? 0);
    if (bal > 0) {
      const w = await ensureBusinessWallet(businessId, tx);
      await lockProjections(tx, { BusinessWallet: [w.id] });
      await move(tx, { from: await ruleBudget(tx, r.id), to: await businessAccount(tx, businessId), amount: bal, reference: `WRB-END-${r.id}`, kind: 'work_rule_budget_refund', actor: { type: 'user', id: userId }, authorization: 'rule_ended' });
    }
    return ruleView(tx, await tx.workRule.update({ where: { id: r.id }, data: { status: 'ended' } }));
  });
}

export async function listRules(userId, businessId) {
  await prisma.$transaction((tx) => auth(tx, userId, businessId, 'business.staffing.manage').catch(() => auth(tx, userId, businessId, 'business.pay')));
  const rows = await prisma.workRule.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } });
  const out = [];
  for (const r of rows) out.push(await ruleView(prisma, r));
  return out;
}

async function isMemberOrOwner(db, userId, businessId) {
  const b = await db.business.findUnique({ where: { id: businessId }, select: { ownerId: true } });
  if (b?.ownerId === userId) return true;
  return Boolean(await db.businessMember.findFirst({ where: { businessId, userId, status: 'active' } }));
}

async function staffOf(db, businessId) {
  const b = await db.business.findUnique({ where: { id: businessId }, select: { ownerId: true } });
  const ms = await db.businessMember.findMany({ where: { businessId, status: 'active' }, select: { userId: true } });
  return new Set([b?.ownerId, ...ms.map((m) => m.userId)].filter(Boolean));
}

/** Why a rep commission is not payable (null = eligible). */
async function repIneligibility(db, rule, po, rel) {
  if (!rel?.introducedByUserId) return 'merchant_not_introduced_by_a_rep';
  const rep = rel.introducedByUserId;
  const merchant = await db.business.findUnique({ where: { id: po.buyerBusinessId }, select: { ownerId: true, status: true } });
  if (!merchant || merchant.status !== 'active') return 'merchant_not_active';
  if (await isMemberOrOwner(db, rep, po.buyerBusinessId)) return 'self_dealing_rep_runs_merchant';
  if ((await staffOf(db, rule.businessId)).has(merchant.ownerId)) return 'self_dealing_distributor_staff_owns_merchant';
  if (po.totalKori < rule.minOrderKori) return 'below_minimum_order';
  if (po.paymentStatus !== 'paid') {
    const inv = po.invoiceId ? await db.tradeInvoice.findUnique({ where: { id: po.invoiceId } }) : null;
    if (!inv || inv.amountPaid < inv.amount) return 'not_paid';
  }
  const verifiedReceipt = (po.deliveryRecordedBy ?? '').startsWith('shipment:') || (po.receivedBy && (await isMemberOrOwner(db, po.receivedBy, po.buyerBusinessId)));
  if (!verifiedReceipt) return 'receipt_not_verified';
  const hired = await db.workAssignment.findFirst({ where: { businessId: rule.businessId, workerUserId: rep, type: 'rep', status: { in: ['active', 'completed'] } } });
  if (!hired) return 'rep_not_engaged_through_j9';
  return null;
}

/** Commission earnings stay on hold while the PO they rest on has an open / approved return. */
export async function commissionOnHold(db, e) {
  const o = await db.workOutcome.findFirst({ where: { earningId: e.id } });
  if (!o) return false;
  const poId = o.sourceRef.startsWith('po:') ? o.sourceRef.slice(3) : null;
  if (!poId) return false;
  return Boolean(await db.commercialReturn.findFirst({ where: { purchaseOrderId: poId, status: { in: ['requested', 'approved', 'goods_returned', 'received'] } } }));
}

async function recordOutcome(db, data, accrue) {
  try {
    return await runMoneyTransaction(db, async (tx) => {
      const prior = await tx.workOutcome.findUnique({ where: { outcomeKey: data.outcomeKey } });
      if (prior) return null;
      let earningId = null;
      if (data.status === 'accrued') {
        const e = await accrue(tx);
        if (!e) return 'short';
        earningId = e.id;
      }
      await tx.workOutcome.create({ data: { ...data, earningId } });
      return data.status;
    });
  } catch (e) {
    if (e?.code === 'P2002') return null; // a concurrent run recorded it first
    throw e;
  }
}

async function budgetOf(db, ruleId) {
  return Number((await db.ledgerAccount.findUnique({ where: { code: `escrow:work_rule:${ruleId}` }, select: { balance: true } }))?.balance ?? 0);
}

/** Idempotent processor (cron + after relevant acts). Inert while J9 money is not activated. */
export async function processWorkOutcomes(db = prisma) {
  const out = { repCommissions: 0, pickupFees: 0, courierDeliveries: 0, ineligible: 0, waitingForBudget: 0 };
  if (!workMoneyEnabled()) return { ...out, skipped: 'work_money_not_activated' };

  // Rep: first received + paid PO per (distributor, merchant).
  for (const rule of await db.workRule.findMany({ where: { kind: 'rep_first_received_order', status: 'active' } })) {
    const pos = await db.purchaseOrder.findMany({ where: { sellerBusinessId: rule.businessId, receivedAt: { not: null }, status: { in: ['received', 'completed'] } }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] });
    const firsts = new Map();
    for (const po of pos) if (!firsts.has(po.buyerBusinessId)) firsts.set(po.buyerBusinessId, po);
    for (const [merchantId, po] of firsts) {
      const outcomeKey = `rule:${rule.id}:merchant:${merchantId}`;
      if (await db.workOutcome.findUnique({ where: { outcomeKey } })) continue;
      const rel = await db.merchantRelationship.findFirst({ where: { distributorBusinessId: rule.businessId, merchantBusinessId: merchantId, status: 'active' }, orderBy: { createdAt: 'asc' } });
      const why = await repIneligibility(db, rule, po, rel);
      if (why === 'not_paid' || why === 'rep_not_engaged_through_j9') continue; // may still become eligible
      if (why) {
        if (await recordOutcome(db, { ruleId: rule.id, outcomeKey, sourceRef: `po:${po.id}`, beneficiaryUserId: rel?.introducedByUserId ?? null, status: 'ineligible', reason: why })) out.ineligible += 1;
        continue;
      }
      if ((await budgetOf(db, rule.id)) < rule.amountKori) { out.waitingForBudget += 1; continue; }
      const r = await recordOutcome(db, { ruleId: rule.id, outcomeKey, sourceRef: `po:${po.id}`, beneficiaryUserId: rel.introducedByUserId, status: 'accrued' }, async (tx) => accrueInTx(tx, {
        sourceKey: `outcome:${outcomeKey}`, from: await ruleBudget(tx, rule.id), workerUserId: rel.introducedByUserId, payerBusinessId: rule.businessId, ruleId: rule.id,
        classification: 'commission', amountKori: rule.amountKori, holdHours: COMMISSION_HOLD_HOURS, contestHours: COMMISSION_HOLD_HOURS, authorization: `verified_received_paid_first_order:${po.id}`,
      }));
      if (r === 'accrued') out.repCommissions += 1;
    }
  }

  // Pickup point: per verified release of the rule business's shipments at that point.
  for (const rule of await db.workRule.findMany({ where: { kind: 'pickup_release_fee', status: 'active' } })) {
    const point = await db.pickupPoint.findUnique({ where: { id: rule.pickupPointId } });
    if (!point || point.status !== 'active') continue;
    const reqs = await db.fulfilmentRequest.findMany({ where: { pickupPointId: point.id, OR: [{ originBusinessId: rule.businessId }, { fulfillerBusinessId: rule.businessId }] }, select: { id: true } });
    const shs = await db.shipment.findMany({ where: { requestId: { in: reqs.map((r) => r.id) }, status: 'delivered', deliveryProof: 'pickup_point_release', deliveredAt: { gte: rule.approvedAt } }, orderBy: { deliveredAt: 'asc' } });
    for (const sh of shs) {
      const outcomeKey = `rule:${rule.id}:shipment:${sh.id}`;
      if (await db.workOutcome.findUnique({ where: { outcomeKey } })) continue;
      if (await db.shipmentDispute.findFirst({ where: { shipmentId: sh.id, status: { in: ['open', 'awaiting_reversal'] } } })) continue;
      if (await db.shipmentDispute.findFirst({ where: { shipmentId: sh.id, resolution: { in: ['upheld', 'upheld_reverse'] } } })) {
        if (await recordOutcome(db, { ruleId: rule.id, outcomeKey, sourceRef: `shipment:${sh.id}`, beneficiaryBizId: point.operatorBusinessId, status: 'ineligible', reason: 'delivery_dispute_upheld' })) out.ineligible += 1;
        continue;
      }
      if ((await budgetOf(db, rule.id)) < rule.amountKori) { out.waitingForBudget += 1; continue; }
      const r = await recordOutcome(db, { ruleId: rule.id, outcomeKey, sourceRef: `shipment:${sh.id}`, beneficiaryBizId: point.operatorBusinessId, status: 'accrued' }, async (tx) => accrueInTx(tx, {
        sourceKey: `outcome:${outcomeKey}`, from: await ruleBudget(tx, rule.id), payeeBusinessId: point.operatorBusinessId, payerBusinessId: rule.businessId, ruleId: rule.id,
        classification: 'service_fee', amountKori: rule.amountKori, holdHours: EARNING_HOLD_HOURS, contestHours: EARNING_HOLD_HOURS, authorization: `verified_pickup_point_release:${sh.id}`,
      }));
      if (r === 'accrued') out.pickupFees += 1;
    }
  }

  // Own-fleet courier hired through J9: per verified delivery, from the assignment escrow; once per shipment.
  for (const a of await db.workAssignment.findMany({ where: { type: 'courier', funding: 'prepaid', status: 'active' } })) {
    const terms = JSON.parse((await db.workOffer.findUnique({ where: { id: a.offerId } })).termsJson);
    const reqs = await db.fulfilmentRequest.findMany({ where: { fulfillerBusinessId: a.businessId }, select: { id: true } });
    // The hired courier completed the verified delivery themself (J8 closes their assignment as `delivered`).
    const done = await db.courierAssignment.findMany({ where: { courierUserId: a.workerUserId, status: 'completed', endReason: 'delivered' }, select: { shipmentId: true } });
    const shipIds = done.map((d) => d.shipmentId);
    const shs = await db.shipment.findMany({ where: { id: { in: shipIds }, requestId: { in: reqs.map((r) => r.id) }, status: 'delivered', deliveryProof: { in: VERIFIED_PROOFS }, deliveredAt: { gte: a.createdAt } }, orderBy: { deliveredAt: 'asc' } });
    for (const sh of shs) {
      const sourceKey = `shipment:${sh.id}`;
      if (await db.workEarning.findUnique({ where: { sourceKey } })) continue;
      if (await db.courierEarning.findUnique({ where: { shipmentId: sh.id } })) continue; // J8 already pays this delivery
      if (await db.shipmentDispute.findFirst({ where: { shipmentId: sh.id, status: { in: ['open', 'awaiting_reversal'] } } })) continue;
      if ((await escrowBalance(db, a.offerId)) < terms.ratePerDeliveryKori) { out.waitingForBudget += 1; break; }
      try {
        const e = await runMoneyTransaction(db, async (tx) => {
          await tx.$executeRaw`SELECT id FROM "WorkAssignment" WHERE id = ${a.id} FOR UPDATE`;
          const cur = await tx.workAssignment.findUnique({ where: { id: a.id } });
          if (cur.status !== 'active') return null;
          return accrueInTx(tx, { sourceKey, from: await account(tx, 'escrowWork', a.offerId), workerUserId: a.workerUserId, payerBusinessId: a.businessId, assignmentId: a.id, classification: 'contractor_payment', amountKori: terms.ratePerDeliveryKori, contestHours: EARNING_HOLD_HOURS, authorization: `verified_j8_delivery:${sh.id}` });
        });
        if (e) out.courierDeliveries += 1;
      } catch (err) {
        if (err?.code !== 'P2002') throw err;
      }
    }
  }
  return out;
}
