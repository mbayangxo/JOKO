import { assertCanPost, MboloAccessError } from './mbolo-access.js';
import { randomBytes } from 'crypto';
import { buildAffiliateShopUrl } from './k21-qr.js';
import { createInAppNotification } from './notify-service.js';
import { formatKori } from './kori.js';
import { lockWallets, InsufficientFundsError } from './wallet-atomic.js';
import { customerByWallet } from './money-kernel/flows.js';
import { post } from './money-kernel/ledger.js';

export class AffiliateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'AffiliateError';
  }
}

function linkCode() {
  return randomBytes(4).toString('hex').toUpperCase();
}

function affiliateCodeFromUser(user) {
  const handle = String(user.handle ?? '').replace(/^@/, '').trim().toLowerCase();
  if (handle.length >= 3) return handle.slice(0, 24);
  return `aff${randomBytes(3).toString('hex')}`;
}

export function affiliateProfileShape(row, extras = {}) {
  return {
    id: row.id,
    affiliateCode: row.affiliateCode,
    displayName: row.displayName,
    commissionBps: row.commissionBps,
    commissionPct: (row.commissionBps / 100).toFixed(1),
    totalEarned: row.totalEarned,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    links: extras.links,
    commissions: extras.commissions,
    stats: extras.stats,
  };
}

export function affiliateLinkShape(link, product, business) {
  return {
    id: link.id,
    linkCode: link.linkCode,
    label: link.label,
    clickCount: link.clickCount,
    orderCount: link.orderCount,
    shopUrl: buildAffiliateShopUrl({
      businessId: link.businessId ?? business?.id,
      productId: link.productId ?? product?.id,
      linkCode: link.linkCode,
    }),
    product: product
      ? { id: product.id, title: product.title, price: product.price, imageUrl: product.imageUrl }
      : null,
    business: business ? { id: business.id, name: business.name, category: business.category } : null,
    createdAt: link.createdAt.toISOString(),
  };
}

export function commissionShape(row) {
  return {
    id: row.id,
    amount: row.amount,
    orderTotal: row.orderTotal,
    commissionBps: row.commissionBps,
    source: row.source,
    linkCode: row.linkCode,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function registerAffiliate(db, userId, displayName) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new AffiliateError('user_not_found', 'Utilisateur introuvable');

  const existing = await db.affiliateProfile.findUnique({ where: { userId } });
  if (existing) return existing;

  let code = affiliateCodeFromUser(user);
  for (let i = 0; i < 5; i += 1) {
    try {
      return await db.affiliateProfile.create({
        data: {
          userId,
          affiliateCode: code,
          displayName: displayName ?? user.name ?? user.handle ?? 'Affilié K21',
        },
      });
    } catch (error) {
      if (error?.code === 'P2002') {
        code = `${affiliateCodeFromUser(user)}${randomBytes(2).toString('hex')}`;
        continue;
      }
      throw error;
    }
  }
  throw new AffiliateError('register_failed', 'Inscription affilié impossible');
}

export async function getAffiliateByUserId(db, userId) {
  return db.affiliateProfile.findUnique({
    where: { userId },
    include: {
      links: { orderBy: { createdAt: 'desc' }, take: 30, include: { product: true, business: true } },
      commissions: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
}

export async function createAffiliateLink(db, userId, params) {
  const affiliate = await db.affiliateProfile.findUnique({ where: { userId } });
  if (!affiliate || affiliate.status !== 'active') {
    throw new AffiliateError('not_affiliate', 'Inscris-toi comme affilié d\'abord');
  }

  if (!params.businessId && !params.productId) {
    throw new AffiliateError('target_required', 'Commerce ou produit requis');
  }

  let businessId = params.businessId ?? null;
  let productId = params.productId ?? null;

  if (productId) {
    const product = await db.product.findUnique({ where: { id: productId } });
    if (!product?.active) throw new AffiliateError('product_not_found', 'Produit introuvable');
    businessId = product.businessId ?? businessId;
  }

  if (businessId) {
    const business = await db.business.findUnique({ where: { id: businessId } });
    if (!business) throw new AffiliateError('business_not_found', 'Commerce introuvable');
  }

  let code = linkCode();
  for (let i = 0; i < 5; i += 1) {
    try {
      const link = await db.affiliateLink.create({
        data: {
          affiliateId: affiliate.id,
          productId,
          businessId,
          linkCode: code,
          label: params.label ?? null,
        },
        include: { product: true, business: true },
      });
      return link;
    } catch (error) {
      if (error?.code === 'P2002') {
        code = linkCode();
        continue;
      }
      throw error;
    }
  }
  throw new AffiliateError('link_failed', 'Lien affilié impossible');
}

export async function resolveAffiliateLink(db, linkCode) {
  const code = String(linkCode ?? '').trim().toUpperCase();
  if (!code) return null;

  return db.affiliateLink.findUnique({
    where: { linkCode: code },
    include: {
      affiliate: { include: { user: { include: { wallet: true } } } },
      product: true,
      business: true,
    },
  });
}

export async function trackAffiliateClick(db, linkCode) {
  const link = await resolveAffiliateLink(db, linkCode);
  if (!link) throw new AffiliateError('link_not_found', 'Lien introuvable');
  await db.affiliateLink.update({
    where: { id: link.id },
    data: { clickCount: { increment: 1 } },
  });
  return link;
}

export function computeAffiliateCommission(orderTotalKori, commissionBps) {
  if (orderTotalKori <= 0 || commissionBps <= 0) return 0;
  return Math.max(1, Math.floor((orderTotalKori * commissionBps) / 10_000));
}

/** Resolve attribution for checkout — returns null if invalid or self-referral. */
export async function resolveAffiliateAttribution(db, { linkCode, buyerId }) {
  if (!linkCode) return null;
  const link = await resolveAffiliateLink(db, linkCode);
  if (!link?.affiliate || link.affiliate.status !== 'active') return null;
  if (link.affiliate.userId === buyerId) return null;
  if (!link.affiliate.user?.wallet) return null;

  const commissionBps = link.affiliate.commissionBps;
  return {
    link,
    affiliateId: link.affiliate.id,
    affiliateUserId: link.affiliate.userId,
    affiliateWalletId: link.affiliate.user.wallet.id,
    commissionBps,
    productId: link.productId,
    businessId: link.businessId,
    linkCode: link.linkCode,
  };
}

export async function spendKoriWithAffiliateSplit(db, params) {
  // J2: one balanced entry — payer → merchant (+ affiliate). If there is no
  // affiliate wallet, the share stays with the merchant (pre-J2 it vanished).
  const hasAffiliate = (params.affiliateAmountKori ?? 0) > 0 && Boolean(params.affiliateWalletId);
  const affiliateAmount = hasAffiliate ? params.affiliateAmountKori : 0;
  const merchantAmount = params.amountKori - affiliateAmount;
  if (merchantAmount < 0) throw new InsufficientFundsError('Invalid affiliate split');

  const payerAcct = await customerByWallet(db, params.payerWalletId);
  const lines = [
    { account: payerAcct, side: 'debit', amount: params.amountKori },
  ];
  if (merchantAmount > 0) lines.push({ account: await customerByWallet(db, params.merchantWalletId), side: 'credit', amount: merchantAmount });
  if (affiliateAmount > 0) lines.push({ account: await customerByWallet(db, params.affiliateWalletId), side: 'credit', amount: affiliateAmount });
  await post(db, {
    reference: `${params.reference}-J`,
    kind: 'marketplace_purchase',
    actor: { type: 'user', id: params.payerId },
    lines,
  });

  await db.koriTransaction.create({
    data: {
      senderId: params.payerId,
      recipientId: params.merchantUserId,
      amountKori: merchantAmount,
      transactionType: 'spend',
      reference: params.reference,
      note: params.merchantName,
    },
  });

  await db.ledgerEntry.create({
    data: {
      walletId: params.payerWalletId,
      userId: params.payerId,
      type: 'pay_merchant',
      amount: -params.amountKori,
      counterpartyName: params.merchantName ?? null,
      note: params.merchantName ?? null,
      reference: params.reference,
    },
  });
  await db.ledgerEntry.create({
    data: {
      walletId: params.merchantWalletId,
      userId: params.merchantUserId,
      type: 'marketplace_sale',
      amount: merchantAmount,
      counterpartyName: params.payerName ?? null,
      note: params.merchantName ?? null,
      reference: `${params.reference}-M`,
    },
  });

  if (affiliateAmount > 0 && params.affiliateUserId) {
    await db.ledgerEntry.create({
      data: {
        walletId: params.affiliateWalletId,
        userId: params.affiliateUserId,
        type: 'affiliate_commission',
        amount: affiliateAmount,
        counterpartyName: params.merchantName ?? null,
        note: params.commissionNote ?? 'Commission affilié',
        reference: `${params.reference}-AFF`,
      },
    });
  }
}

export async function recordAffiliateCommission(db, params) {
  const {
    attribution,
    buyerId,
    orderId,
    orderTotal,
    source,
    mboloThreadId,
    mboloMessageId,
    reference,
  } = params;

  const amount = computeAffiliateCommission(orderTotal, attribution.commissionBps);
  if (amount <= 0) return null;

  const row = await db.affiliateCommission.create({
    data: {
      affiliateId: attribution.affiliateId,
      orderId: orderId ?? null,
      buyerId,
      amount,
      orderTotal,
      commissionBps: attribution.commissionBps,
      source,
      linkCode: attribution.linkCode,
      productId: attribution.productId,
      businessId: attribution.businessId,
      mboloThreadId: mboloThreadId ?? null,
      mboloMessageId: mboloMessageId ?? null,
      reference,
      status: 'paid',
    },
  });

  await db.affiliateProfile.update({
    where: { id: attribution.affiliateId },
    data: { totalEarned: { increment: amount } },
  });

  await db.affiliateLink.update({
    where: { id: attribution.link.id },
    data: { orderCount: { increment: 1 } },
  });

  return row;
}

export async function notifyAffiliateCommission(affiliateUserId, amount, businessName, db = prisma) {
  await createInAppNotification(
    affiliateUserId,
    'Commission affilié ✦',
    `${formatKori(amount)} sur une commande ${businessName ? `· ${businessName}` : ''}`,
    { kind: 'affiliate', actionLabel: 'Voir' },
    db,
  );
}

export async function shareAffiliateProductToMbolo(db, userId, { threadId, productId, linkCode }) {
  try {
    await assertCanPost(db, threadId, userId, { kind: 'affiliate_product' });
  } catch (error) {
    if (error instanceof MboloAccessError) throw new AffiliateError('not_in_thread', 'Tu n\'es pas dans ce groupe');
    throw error;
  }

  const product = await db.product.findUnique({
    where: { id: productId },
    include: { business: true },
  });
  if (!product?.active || !product.businessId) {
    throw new AffiliateError('product_not_found', 'Produit introuvable');
  }

  let link;
  if (linkCode) {
    link = await resolveAffiliateLink(db, linkCode);
    if (!link || link.affiliate.userId !== userId) {
      throw new AffiliateError('link_forbidden', 'Lien affilié invalide');
    }
  } else {
    link = await createAffiliateLink(db, userId, {
      productId: product.id,
      businessId: product.businessId,
      label: product.title,
    });
  }

  const payload = {
    linkCode: link.linkCode,
    productId: product.id,
    businessId: product.businessId,
    title: product.title,
    price: product.price,
    imageUrl: product.imageUrl,
    businessName: product.business?.name,
  };

  const message = await db.mboloMessage.create({
    data: {
      threadId,
      senderId: userId,
      kind: 'affiliate_product',
      body: JSON.stringify(payload),
    },
    include: { sender: { select: { id: true, name: true, handle: true, avatarEmoji: true } } },
  });

  await db.mboloThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });

  return { message, link, payload };
}
