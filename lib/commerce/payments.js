import { post } from '../money-kernel/ledger.js';
import { business as businessAccount, customerByWallet } from '../money-kernel/flows.js';
import { lockMixedWallets } from '../business-wallet-service.js';
import { assertBusinessCanReceive } from '../business/eligibility.js';

/**
 * J5: where a customer payment settles. Business and personal money stay
 * distinguishable: every new business settles to its own wallet
 * (`business:<id>:wallet`); businesses created before J5 keep the legacy
 * owner-personal settlement until the owner switches (decision recorded in
 * docs/JOKKO-J5-REPORT.md §3).
 */
export function settlementFor(business) {
  if (business.settlementMode === 'business' || business.distributionEnabled || business.type === 'brand') return 'business';
  return 'owner';
}

/** Order payment into the business wallet with an affiliate share (one balanced entry). */
export async function payBusinessWithAffiliateSplit(tx, p) {
  await assertBusinessCanReceive(tx, p.businessId, 'order_payment');
  await lockMixedWallets(tx, { userWalletIds: [p.payerWalletId, p.affiliateWalletId], businessWalletIds: [p.businessWalletId] });
  const affiliateAmount = p.affiliateWalletId && p.affiliateAmountKori > 0 ? p.affiliateAmountKori : 0;
  const merchantAmount = p.amountKori - affiliateAmount;
  const lines = [{ account: await customerByWallet(tx, p.payerWalletId), side: 'debit', amount: p.amountKori }];
  if (merchantAmount > 0) lines.push({ account: await businessAccount(tx, p.businessId), side: 'credit', amount: merchantAmount });
  if (affiliateAmount > 0) lines.push({ account: await customerByWallet(tx, p.affiliateWalletId), side: 'credit', amount: affiliateAmount });
  await post(tx, { reference: `${p.reference}-J`, kind: 'marketplace_purchase', actor: { type: 'user', id: p.payerId }, lines });
  // Payer statement row (legacy per-user history shape).
  await tx.ledgerEntry.create({
    data: { walletId: p.payerWalletId, userId: p.payerId, type: 'pay_merchant', amount: -p.amountKori, counterpartyName: p.businessName ?? null, note: p.businessName ?? null, reference: p.reference },
  });
  if (affiliateAmount > 0 && p.affiliateUserId) {
    await tx.ledgerEntry.create({
      data: { walletId: p.affiliateWalletId, userId: p.affiliateUserId, type: 'affiliate_commission', amount: affiliateAmount, counterpartyName: p.businessName ?? null, note: p.commissionNote ?? 'Commission affilié', reference: `${p.reference}-AFF` },
    });
  }
}

const ORDER_PAYMENT_KINDS = ['business_payment', 'merchant_payment', 'marketplace_purchase', 'pay_merchant'];

/** The journal entry that paid an order (order payments post as `<ref>` or `<ref>-J`). */
export function orderPaymentEntry(tx, orderReference) {
  if (!orderReference) return null;
  return tx.journalEntry.findFirst({
    where: { reference: { in: [orderReference, `${orderReference}-J`] }, kind: { in: ORDER_PAYMENT_KINDS } },
    include: { postings: { include: { account: true } } },
  });
}
