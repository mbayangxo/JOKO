import { randomUUID } from 'node:crypto';
import { COUNTRY_MARKETS } from '../currency-registry.js';
import { LedgerInvariantError, WalletNotFoundError } from './errors.js';

/**
 * Ledger account taxonomy (docs/JOKKO-J2-DESIGN.md §2) and resolvers.
 *
 * Every resolver returns the LedgerAccount row, creating it on first use.
 * Accounts that project onto a legacy balance column (Wallet.koriBalance, …)
 * are opened with an explicit `opening_balance` entry equal to the legacy
 * value found at that moment (lazy migration) — never by writing `balance`.
 */

export const KRI = 'KRI';

/** Fixed peg: external minor units per 1 ₭ (from the market registry). */
export function pegFor(currency) {
  const pegs = new Set(
    Object.values(COUNTRY_MARKETS)
      .filter((m) => m.currency === currency)
      .map((m) => m.nationalPerCauris),
  );
  if (pegs.size !== 1) throw new LedgerInvariantError(`No single peg for currency ${currency}`, 'unknown_currency');
  return [...pegs][0];
}

const PROJECTION_COLUMN = {
  Wallet: 'koriBalance',
  BusinessWallet: 'balance',
  PaymentFund: 'balanceKori',
  MerchantVoucher: 'balanceKori',
  AgentProfile: 'floatBalance',
  TontineGroup: 'potBalance',
};

const liability = (extra) => ({ normalSide: 'credit', allowNegative: false, currency: KRI, ...extra });
const asset = (extra) => ({ normalSide: 'debit', allowNegative: false, ...extra });

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export const specs = {
  customerAvailable: (userId, walletId) =>
    liability({ code: `customer:${userId}:available`, type: 'customer_available', ownerType: 'user', ownerId: userId, projTable: 'Wallet', projId: walletId }),
  customerHeld: (userId) =>
    liability({ code: `customer:${userId}:held`, type: 'customer_held', ownerType: 'user', ownerId: userId }),
  businessWallet: (businessId, businessWalletId) =>
    liability({ code: `business:${businessId}:wallet`, type: 'business_wallet', ownerType: 'business', ownerId: businessId, projTable: 'BusinessWallet', projId: businessWalletId }),
  merchantSettlement: (businessId) =>
    liability({ code: `merchant:${businessId}:settlement`, type: 'merchant_settlement', ownerType: 'business', ownerId: businessId }),
  agentFloat: (agentId, currency = 'XOF') =>
    liability({ code: `agent:${agentId}:float`, type: 'agent_float', currency, ownerType: 'agent', ownerId: agentId, projTable: 'AgentProfile', projId: agentId }),
  /** J6: agent e-float reserved for a bound cash-in (not spendable, still owed to the agent). */
  agentFloatHeld: (agentId, currency = 'XOF') =>
    liability({ code: `agent:${agentId}:float_held`, type: 'agent_float_held', currency, ownerType: 'agent', ownerId: agentId }),
  /** J6.7: funded commission budget (treasury-funded, maker/checker). Commissions are paid only from here. */
  agentCommissionBudget: () => liability({ code: 'platform:agent_commission_budget', type: 'agent_commission_budget', ownerType: 'platform' }),
  agentCommission: (agentId) =>
    liability({ code: `agent:${agentId}:commission`, type: 'agent_commission', ownerType: 'agent', ownerId: agentId }),
  escrowDelivery: (taskId) =>
    liability({ code: `escrow:delivery:${taskId}`, type: 'escrow_delivery', ownerType: 'delivery', ownerId: taskId }),
  escrowOrder: (orderId) => liability({ code: `escrow:order:${orderId}`, type: 'escrow_order', ownerType: 'order', ownerId: orderId }),
  /** J8: delivery fee held for one fulfilment request until verified delivery / failure rule. */
  escrowShipmentFee: (requestId) =>
    liability({ code: `escrow:shipment_fee:${requestId}`, type: 'escrow_shipment_fee', ownerType: 'fulfilment_request', ownerId: requestId }),
  /** J8: funded courier earnings owed to a courier (accrued/releasable, not yet paid to their wallet). */
  courierEarnings: (userId) =>
    liability({ code: `courier:${userId}:earnings`, type: 'courier_earnings', ownerType: 'user', ownerId: userId }),
  /** J9: funds a business committed to one prepaid work offer (then its assignment), released per accepted milestone. */
  escrowWork: (offerId) =>
    liability({ code: `escrow:work:${offerId}`, type: 'escrow_work', ownerType: 'work_offer', ownerId: offerId }),
  /** J9: funded work earnings owed to a worker (accrued / releasable, not yet paid to their wallet). */
  workerEarnings: (userId) =>
    liability({ code: `worker:${userId}:earnings`, type: 'worker_earnings', ownerType: 'user', ownerId: userId }),
  /** J9: funded fees owed to a business payee (e.g. a pickup-point operator), not yet credited to its wallet. */
  workBusinessEarnings: (businessId) =>
    liability({ code: `work_business:${businessId}:earnings`, type: 'worker_earnings', ownerType: 'business', ownerId: businessId }),
  /** J9: a business's prefunded budget for one outcome rule (rep commission / pickup-point fee). */
  workRuleBudget: (ruleId) =>
    liability({ code: `escrow:work_rule:${ruleId}`, type: 'work_rule_budget', ownerType: 'work_rule', ownerId: ruleId }),
  /** A4: an affiliate commission held until its order is financially eligible (refund-aware settlement). */
  affiliateEscrow: (commissionId) =>
    liability({ code: `escrow:affiliate:${commissionId}`, type: 'escrow_affiliate', ownerType: 'affiliate_commission', ownerId: commissionId }),
  /** A4: earned (eligible) affiliate commission, not yet moved to the affiliate's wallet. */
  affiliateEarnings: (userId) =>
    liability({ code: `affiliate:${userId}:earnings`, type: 'affiliate_earnings', ownerType: 'user', ownerId: userId }),
  tontinePot: (groupId) =>
    liability({ code: `tontine:${groupId}:pot`, type: 'tontine_pot', ownerType: 'tontine', ownerId: groupId, projTable: 'TontineGroup', projId: groupId }),
  voucher: (voucherId) =>
    liability({ code: `voucher:${voucherId}`, type: 'voucher', ownerType: 'voucher', ownerId: voucherId, projTable: 'MerchantVoucher', projId: voucherId }),
  paymentFund: (fundId) =>
    liability({ code: `fund:${fundId}`, type: 'payment_fund', ownerType: 'fund', ownerId: fundId, projTable: 'PaymentFund', projId: fundId }),

  providerClearingIn: (provider, currency) =>
    asset({ code: `provider:${provider}:${currency}:clearing_in`, type: 'ext_clearing_in', currency, ownerType: 'provider', ownerId: provider }),
  providerClearingOut: (provider, currency) =>
    liability({ code: `provider:${provider}:${currency}:clearing_out`, type: 'ext_clearing_out', currency, ownerType: 'provider', ownerId: provider }),
  providerSettlement: (provider, currency) =>
    asset({ code: `provider:${provider}:${currency}:settlement`, type: 'ext_settlement', currency, allowNegative: true, ownerType: 'provider', ownerId: provider }),
  cashOffice: (office, currency) =>
    asset({ code: `cash:${office}:${currency}`, type: 'cash_office', currency, ownerType: 'platform', ownerId: office }),

  /** External-currency side of the peg bridge (credit-normal: ext value converted in). */
  conversionExternal: (currency) =>
    ({ code: `conversion:${currency}`, type: 'conversion', currency, normalSide: 'credit', allowNegative: true, ownerType: 'platform' }),
  /** ₭ side of the peg bridge for that currency (debit-normal: ₭ issued against it). */
  conversionKori: (currency) =>
    ({ code: `conversion:KRI:${currency}`, type: 'conversion', currency: KRI, normalSide: 'debit', allowNegative: true, ownerType: 'platform' }),

  revenue: (product, currency = KRI) =>
    liability({ code: `revenue:${product}:${currency}`, type: 'fees', currency, ownerType: 'platform' }),
  /** J6.0: partner collection confirmed by the provider but not routable to its bound merchant (held for review). */
  partnerUnallocated: (partnerId) =>
    liability({ code: `partner:${partnerId}:unallocated`, type: 'partner_unallocated', ownerType: 'partner', ownerId: partnerId }),
  incentivesFunded: () => liability({ code: 'incentives:funded', type: 'incentives_funded', ownerType: 'platform' }),
  refundsBudget: () => liability({ code: 'platform:refunds', type: 'refunds', ownerType: 'platform' }),
  treasury: (currency) =>
    ({ code: `platform:treasury:${currency}`, type: 'treasury', currency, normalSide: 'debit', allowNegative: true, ownerType: 'platform' }),
  suspense: (currency = KRI) =>
    ({ code: `suspense:reconciliation:${currency}`, type: 'suspense', currency, normalSide: 'debit', allowNegative: true, ownerType: 'platform' }),
  migrationOpening: (currency = KRI) =>
    ({ code: `migration:opening:${currency}`, type: 'migration', currency, normalSide: 'debit', allowNegative: true, ownerType: 'platform' }),
  testFaucet: () =>
    ({ code: 'test:faucet:KRI', type: 'test_faucet', currency: KRI, normalSide: 'debit', allowNegative: true, ownerType: 'platform' }),
};

// ---------------------------------------------------------------------------
// Resolution (create on first use; lazy opening balance for projections)
// ---------------------------------------------------------------------------

async function findByCode(tx, code) {
  return tx.ledgerAccount.findUnique({ where: { code } });
}

/**
 * Ensure the account exists. If this call created a projection-backed account
 * and the legacy row already holds value, post the opening balance (provenance:
 * legacy snapshot) in the same transaction. Concurrent creators serialize on
 * the unique `code`; only the inserting transaction posts the opening.
 *
 * J4 (soak, item P): the conflict clause has NO target on purpose. With
 * `ON CONFLICT ("code")`, Postgres arbitrates only the `code` index; two
 * first-ever credits racing to open the same projection account then collided
 * on the other unique index ("projTable","projId") and the losing transfer
 * failed with 23505 (~1 per 1000-sender round). Any unique conflict now means
 * "someone else opened it"; if the row found by `code` is missing (a different
 * account already owns that projection), we fail closed below.
 */
export async function ensureAccount(tx, spec, { postOpening } = {}) {
  const existing = await findByCode(tx, spec.code);
  if (existing) return existing;

  const id = randomUUID();
  const inserted = await tx.$queryRaw`
    INSERT INTO "LedgerAccount"
      ("id","code","type","currency","normalSide","allowNegative","balance","ownerType","ownerId","projTable","projId","status","createdAt","updatedAt")
    VALUES (${id}, ${spec.code}, ${spec.type}, ${spec.currency}, ${spec.normalSide}, ${spec.allowNegative ?? false}, 0,
            ${spec.ownerType ?? null}, ${spec.ownerId ?? null}, ${spec.projTable ?? null}, ${spec.projId ?? null}, 'active', now(), now())
    ON CONFLICT DO NOTHING
    RETURNING "id"`;
  const account = await findByCode(tx, spec.code);
  if (!account) throw new LedgerInvariantError(`Could not open ledger account ${spec.code}`);

  if (inserted.length === 1) {
    const legacyValue = await legacyOpeningValue(tx, spec);
    if (legacyValue > 0) {
      if (!postOpening) throw new LedgerInvariantError('opening poster not wired');
      await postOpening(tx, account, legacyValue);
      return findByCode(tx, spec.code);
    }
  }
  return account;
}

/** Value the legacy system holds for this account at first contact. */
async function legacyOpeningValue(tx, spec) {
  if (spec.projTable) {
    const col = PROJECTION_COLUMN[spec.projTable];
    const rows = await tx.$queryRawUnsafe(
      `SELECT "${col}"::bigint AS v FROM "${spec.projTable}" WHERE id = $1 FOR UPDATE`,
      spec.projId,
    );
    if (rows.length === 0) throw new LedgerInvariantError(`Projection row ${spec.projTable}.${spec.projId} missing`);
    return Number(rows[0].v ?? 0);
  }
  if (spec.type === 'escrow_delivery') {
    // Escrows reserved before J2: the held ₭ is real customer money in transit.
    // (Pre-J1 escrows debited amountNational as ₭ — that is what was taken.)
    const rows = await tx.$queryRaw`
      SELECT COALESCE((to_jsonb(e)->>'amountKoriHeld')::bigint, e."amountNational"::bigint, 0) AS v
      FROM "DeliveryEscrow" e
      WHERE e."deliveryTaskId" = ${spec.ownerId} AND e.status IN ('reserved','disputed_held')`;
    return Number(rows[0]?.v ?? 0);
  }
  return 0;
}

export async function resolveCustomer(tx, userId, opts) {
  const wallet = await tx.wallet.findUnique({ where: { userId }, select: { id: true } });
  if (!wallet) throw new WalletNotFoundError();
  return ensureAccount(tx, specs.customerAvailable(userId, wallet.id), opts);
}

export async function resolveCustomerByWallet(tx, walletId, opts) {
  const wallet = await tx.wallet.findUnique({ where: { id: walletId }, select: { id: true, userId: true } });
  if (!wallet) throw new WalletNotFoundError();
  return ensureAccount(tx, specs.customerAvailable(wallet.userId, wallet.id), opts);
}

export async function resolveBusiness(tx, businessId, opts) {
  const bw = await tx.businessWallet.findUnique({ where: { businessId }, select: { id: true } });
  if (!bw) throw new WalletNotFoundError('Business wallet not found');
  return ensureAccount(tx, specs.businessWallet(businessId, bw.id), opts);
}

export { PROJECTION_COLUMN };
