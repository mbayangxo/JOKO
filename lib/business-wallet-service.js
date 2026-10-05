import { randomUUID } from 'node:crypto';
import { assertBusinessAuthorityInTx } from './business-access.js';
/**
 * Atomic KEBU (business) wallet operations — same rules as lib/wallet-atomic.js.
 */
import { prisma } from './prisma.js';
import { InsufficientFundsError, WalletNotFoundError, lockProjections, runMoneyTransaction, isMoneyError, moneyErrorStatus } from './wallet-atomic.js';
import { business as businessAccount, customerByWallet, move } from './money-kernel/flows.js';

export { InsufficientFundsError, WalletNotFoundError, runMoneyTransaction, isMoneyError, moneyErrorStatus };

// Kernel lock order (ledger accounts, then projection rows) — see lockProjections.
export function lockBusinessWallets(tx, walletIds) {
  return lockProjections(tx, { BusinessWallet: walletIds });
}

export function lockMixedWallets(tx, { userWalletIds = [], businessWalletIds = [] }) {
  return lockProjections(tx, { Wallet: userWalletIds, BusinessWallet: businessWalletIds });
}

/**
 * Race-safe: two first payments to a new business may both get here. A plain
 * find-then-create let the loser fail on the unique businessId (HTTP 500 in
 * the J5 oversell race). ON CONFLICT DO NOTHING is also safe inside an
 * interactive transaction (a caught unique violation would abort it).
 */
export async function ensureBusinessWallet(businessId, db) {
  const existing = await db.businessWallet.findUnique({ where: { businessId } });
  if (existing) return existing;
  await db.$executeRaw`
    INSERT INTO "BusinessWallet" ("id","businessId","balance","currency","createdAt","updatedAt")
    VALUES (${randomUUID()}, ${businessId}, 0, 'KORI', now(), now())
    ON CONFLICT ("businessId") DO NOTHING`;
  return db.businessWallet.findUnique({ where: { businessId } });
}

// J2: business wallets move only through the Money Kernel (move between
// ledger accounts); BusinessWallet.balance is a database-written projection.
/**
 * J3: when a person acts for the business, re-check their authority inside
 * the money transaction (row-locked; a concurrent member removal either
 * commits first and this fails, or waits for this payment).
 */
async function assertActing(tx, params, businessId, defaultCapability) {
  if (!params.actingUserId) return;
  await assertBusinessAuthorityInTx(tx, params.actingUserId, businessId, params.capability ?? defaultCapability);
}

async function bizMove(tx, { from, to, amount, reference, kind, actor, authorization }) {
  return move(tx, { from, to, amount, reference: `${reference}-J`, kind, actor, authorization });
}

async function debitBusinessWallet(tx, { businessWalletId, businessId, amount, reference, ledger, to, actor }) {
  if (!to) throw new Error('debitBusinessWallet requires a counter-account (to)');
  await bizMove(tx, { from: await businessAccount(tx, businessId), to, amount, reference, kind: ledger.type, actor });

  return tx.businessLedgerEntry.create({
    data: {
      businessWalletId,
      businessId,
      type: ledger.type,
      amount: -amount,
      counterpartyBusinessId: ledger.counterpartyBusinessId ?? null,
      counterpartyUserId: ledger.counterpartyUserId ?? null,
      counterpartyName: ledger.counterpartyName ?? null,
      counterpartyKebuId: ledger.counterpartyKebuId ?? null,
      note: ledger.note ?? null,
      reference,
    },
  });
}

async function creditBusinessWallet(tx, { businessWalletId, businessId, amount, reference, ledger, from, actor }) {
  const existing = await tx.businessLedgerEntry.findUnique({ where: { reference } });
  if (existing) return existing;

  if (!from) throw new Error('creditBusinessWallet requires a counter-account (from)');
  await bizMove(tx, { from, to: await businessAccount(tx, businessId), amount, reference, kind: ledger.type, actor: actor ?? { type: 'system', id: 'business' }, authorization: 'system_credit' });

  return tx.businessLedgerEntry.create({
    data: {
      businessWalletId,
      businessId,
      type: ledger.type,
      amount,
      counterpartyBusinessId: ledger.counterpartyBusinessId ?? null,
      counterpartyUserId: ledger.counterpartyUserId ?? null,
      counterpartyName: ledger.counterpartyName ?? null,
      counterpartyKebuId: ledger.counterpartyKebuId ?? null,
      note: ledger.note ?? null,
      reference,
    },
  });
}

/** Owner capital: personal AFRI wallet → KEBU wallet. */
export async function transferPersonalToBusiness(tx, params) {
  const {
    amount,
    userWalletId,
    userId,
    businessWalletId,
    businessId,
    reference,
    businessName,
    note,
  } = params;

  await lockMixedWallets(tx, {
    userWalletIds: [userWalletId],
    businessWalletIds: [businessWalletId],
  });

  await bizMove(tx, {
    from: await customerByWallet(tx, userWalletId),
    to: await businessAccount(tx, businessId),
    amount,
    reference,
    kind: 'business_capital_in',
    actor: { type: 'user', id: userId },
  });

  await tx.ledgerEntry.create({
    data: {
      walletId: userWalletId,
      userId,
      type: 'kebu_capital_in',
      amount: -amount,
      counterpartyName: businessName ?? 'KEBU',
      note: note ?? null,
      reference,
    },
  });

  return tx.businessLedgerEntry.create({
    data: {
      businessWalletId,
      businessId,
      type: 'capital_in',
      amount,
      counterpartyUserId: userId,
      counterpartyName: businessName ?? null,
      note: note ?? null,
      reference: `${reference}-B`,
    },
  });
}

/** Owner draw: KEBU wallet → personal AFRI wallet. */
export async function transferBusinessToPersonal(tx, params) {
  const {
    amount,
    businessWalletId,
    businessId,
    userWalletId,
    userId,
    reference,
    businessName,
    note,
  } = params;
  await assertActing(tx, params, businessId, 'business.treasury');

  await lockMixedWallets(tx, {
    userWalletIds: [userWalletId],
    businessWalletIds: [businessWalletId],
  });

  await bizMove(tx, {
    from: await businessAccount(tx, businessId),
    to: await customerByWallet(tx, userWalletId),
    amount,
    reference,
    kind: 'business_owner_draw',
    actor: params.actor ?? { type: 'user', id: userId },
    authorization: 'business_admin',
  });

  const bizEntry = await tx.businessLedgerEntry.create({
    data: {
      businessWalletId,
      businessId,
      type: 'owner_draw',
      amount: -amount,
      counterpartyUserId: userId,
      note: note ?? null,
      reference,
    },
  });

  await tx.ledgerEntry.create({
    data: {
      walletId: userWalletId,
      userId,
      type: 'kebu_owner_draw',
      amount,
      counterpartyName: businessName ?? 'KEBU',
      note: note ?? null,
      reference: `${reference}-P`,
    },
  });

  return bizEntry;
}

/** Marketplace / invoice payment: personal AFRI wallet → supplier KEBU wallet. */
export async function spendKoriToBusinessWallet(tx, params) {
  const {
    payerWalletId,
    payerId,
    businessWalletId,
    businessId,
    amountKori,
    reference,
    businessName,
    payerName,
    note,
    merchantUserId,
  } = params;

  await lockMixedWallets(tx, {
    userWalletIds: [payerWalletId],
    businessWalletIds: [businessWalletId],
  });

  await bizMove(tx, {
    from: await customerByWallet(tx, payerWalletId),
    to: await businessAccount(tx, businessId),
    amount: amountKori,
    reference,
    kind: params.kind ?? 'business_payment',
    actor: params.actor ?? { type: 'user', id: payerId },
    authorization: params.authorization,
  });

  await tx.koriTransaction.create({
    data: {
      senderId: payerId,
      recipientId: merchantUserId ?? null,
      amountKori,
      transactionType: 'marketplace_sale',
      reference,
      note: note ?? businessName ?? null,
    },
  });

  await tx.ledgerEntry.create({
    data: {
      walletId: payerWalletId,
      userId: payerId,
      type: 'pay_merchant',
      amount: -amountKori,
      counterpartyName: businessName ?? null,
      note: note ?? businessName ?? null,
      reference,
    },
  });

  return tx.businessLedgerEntry.create({
    data: {
      businessWalletId,
      businessId,
      type: 'marketplace_sale',
      amount: amountKori,
      counterpartyUserId: payerId,
      counterpartyName: payerName ?? null,
      note: note ?? null,
      reference: `${reference}-B`,
    },
  });
}

/** Pay open trade invoice from buyer personal wallet → supplier KEBU. */
export async function payInvoiceToBusinessWallet(tx, params) {
  return spendKoriToBusinessWallet(tx, {
    ...params,
    note: params.note ?? 'Facture commerciale',
  });
}

/** B2B: one KEBU wallet → another KEBU wallet. */
export async function transferBusinessToBusiness(tx, params) {
  const {
    amount,
    senderWalletId,
    senderBusinessId,
    recipientWalletId,
    recipientBusinessId,
    reference,
    senderLedger,
    recipientLedger,
  } = params;
  await assertActing(tx, params, senderBusinessId, 'business.treasury');

  await lockBusinessWallets(tx, [senderWalletId, recipientWalletId]);

  await bizMove(tx, {
    from: await businessAccount(tx, senderBusinessId),
    to: await businessAccount(tx, recipientBusinessId),
    amount,
    reference,
    kind: 'business_transfer',
    actor: params.actor ?? { type: 'system', id: 'business' },
  });

  const outgoing = await tx.businessLedgerEntry.create({
    data: {
      businessWalletId: senderWalletId,
      businessId: senderBusinessId,
      type: senderLedger.type ?? 'b2b_out',
      amount: -amount,
      counterpartyBusinessId: recipientBusinessId,
      counterpartyName: senderLedger.counterpartyName ?? null,
      counterpartyKebuId: senderLedger.counterpartyKebuId ?? null,
      note: senderLedger.note ?? null,
      reference,
    },
  });

  await tx.businessLedgerEntry.create({
    data: {
      businessWalletId: recipientWalletId,
      businessId: recipientBusinessId,
      type: recipientLedger.type ?? 'b2b_in',
      amount,
      counterpartyBusinessId: senderBusinessId,
      counterpartyName: recipientLedger.counterpartyName ?? null,
      counterpartyKebuId: recipientLedger.counterpartyKebuId ?? null,
      note: recipientLedger.note ?? null,
      reference: `${reference}-IN`,
    },
  });

  return outgoing;
}

/** Payroll / farmer payout: KEBU wallet → employee personal wallet. */
export async function transferBusinessToPersonalPayroll(tx, params) {
  const {
    amount,
    businessWalletId,
    businessId,
    userWalletId,
    userId,
    reference,
    businessName,
    employeeName,
    employeeHandle,
    note,
  } = params;
  await assertActing(tx, params, businessId, 'business.pay');

  await lockMixedWallets(tx, {
    userWalletIds: [userWalletId],
    businessWalletIds: [businessWalletId],
  });

  await bizMove(tx, {
    from: await businessAccount(tx, businessId),
    to: await customerByWallet(tx, userWalletId),
    amount,
    reference,
    kind: 'payroll_payment',
    actor: params.actor ?? { type: 'system', id: 'payroll' },
  });

  const bizEntry = await tx.businessLedgerEntry.create({
    data: {
      businessWalletId,
      businessId,
      type: 'payroll_out',
      amount: -amount,
      counterpartyUserId: userId,
      counterpartyName: employeeName ?? null,
      note: note ?? null,
      reference,
    },
  });

  await tx.ledgerEntry.create({
    data: {
      walletId: userWalletId,
      userId,
      type: 'payroll',
      amount,
      counterpartyName: businessName ?? 'KEBU',
      counterpartyHandle: employeeHandle ?? null,
      note: note ?? null,
      reference: `${reference}-E`,
    },
  });

  return bizEntry;
}

export function businessLedgerShape(entry) {
  return {
    id: entry.id,
    type: entry.type,
    amount: entry.amount,
    counterpartyName: entry.counterpartyName ?? null,
    counterpartyKebuId: entry.counterpartyKebuId ?? null,
    note: entry.note ?? null,
    reference: entry.reference,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function businessWalletShape(wallet, business) {
  return {
    businessId: wallet.businessId,
    balance: wallet.balance,
    koriBalance: wallet.balance,
    currency: 'KORI',
    unit: 'C',
    kebuId: business?.kebuId ?? null,
    businessName: business?.name ?? null,
    businessType: business?.type ?? null,
  };
}

function kebuCreditTier({ payrollVolume90, b2bVolume90, balance, verified }) {
  const volume = payrollVolume90 + b2bVolume90;
  if (verified && volume >= 500_000 && balance >= 50_000) return 'established';
  if (volume >= 50_000 || balance >= 10_000) return 'building';
  return 'starter';
}

export async function getBusinessCreditSummary(businessId) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { wallet: true, owner: { select: { id: true, name: true, afriId: true } } },
  });
  if (!business) throw new Error('Business not found');

  const wallet = business.wallet ?? (await ensureBusinessWallet(businessId, prisma));
  const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const recentLedger = await prisma.businessLedgerEntry.findMany({
    where: { businessId, createdAt: { gte: since90 } },
    orderBy: { createdAt: 'desc' },
  });

  const payrollOut90 = recentLedger
    .filter((e) => e.type === 'payroll_out')
    .reduce((sum, e) => sum + Math.abs(e.amount), 0);
  const b2bOut90 = recentLedger
    .filter((e) => e.type === 'b2b_out')
    .reduce((sum, e) => sum + Math.abs(e.amount), 0);
  const b2bIn90 = recentLedger
    .filter((e) => e.type === 'b2b_in')
    .reduce((sum, e) => sum + e.amount, 0);

  const payrollRuns = await prisma.payrollRun.count({
    where: { businessId, status: 'completed', createdAt: { gte: since90 } },
  });

  const allTime = await prisma.businessLedgerEntry.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return {
    business: {
      id: business.id,
      name: business.name,
      type: business.type,
      kebuId: business.kebuId,
      verified: business.verified,
      ownerAfriId: business.owner?.afriId ?? null,
    },
    wallet: businessWalletShape(wallet, business),
    period90Days: {
      payrollOutKori: payrollOut90,
      b2bOutKori: b2bOut90,
      b2bInKori: b2bIn90,
      payrollOutNational: payrollOut90 * 10,
      b2bOutNational: b2bOut90 * 10,
      b2bInNational: b2bIn90 * 10,
      payrollRuns,
      transactionCount: recentLedger.length,
    },
    lifetime: {
      creditTier: kebuCreditTier({
        payrollVolume90: payrollOut90,
        b2bVolume90: b2bOut90 + b2bIn90,
        balance: wallet.balance,
        verified: business.verified,
      }),
    },
    ledger: allTime.map(businessLedgerShape),
    loanNote:
      'Document généré par K21 — historique KEBU vérifiable pour financement commercial. Contact support@k21.app pour vérifier une référence.',
  };
}
