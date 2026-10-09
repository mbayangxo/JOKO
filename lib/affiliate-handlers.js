import { z } from 'zod';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import {
  AffiliateError,
  affiliateLinkShape,
  affiliateProfileShape,
  commissionShape,
  createAffiliateLink,
  getAffiliateByUserId,
  registerAffiliate,
  resolveAffiliateLink,
  shareAffiliateProductToMbolo,
  trackAffiliateClick,
} from './affiliate-service.js';

function handleAffiliateError(res, error) {
  if (error instanceof AffiliateError) {
    res.status(error.code === 'not_affiliate' ? 403 : 400).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

export async function affiliateMe(req, res) {
  if (req.method === 'POST') {
    const schema = z.object({ displayName: z.string().min(2).max(80).optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    try {
      const row = await registerAffiliate(prisma, req.userId, parsed.data.displayName);
      res.status(201).json(affiliateProfileShape(row));
    } catch (error) {
      if (handleAffiliateError(res, error)) return;
      throw error;
    }
    return;
  }

  const row = await getAffiliateByUserId(prisma, req.userId);
  if (!row) {
    res.json({ registered: false });
    return;
  }

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthEarned = await prisma.affiliateCommission.aggregate({
    where: { affiliateId: row.id, createdAt: { gte: monthStart }, status: 'paid' },
    _sum: { amount: true },
    _count: true,
  });

  res.json(
    affiliateProfileShape(row, {
      registered: true,
      links: row.links.map((l) => affiliateLinkShape(l, l.product, l.business)),
      commissions: row.commissions.map(commissionShape),
      stats: {
        totalEarned: row.totalEarned,
        monthEarned: monthEarned._sum.amount ?? 0,
        monthOrders: monthEarned._count,
        linkCount: row.links.length,
      },
    }),
  );
}

export async function affiliateLinks(req, res) {
  if (req.method === 'GET') {
    const row = await getAffiliateByUserId(prisma, req.userId);
    if (!row) {
      res.status(403).json({ error: 'Pas encore affilié', code: 'not_affiliate' });
      return;
    }
    res.json(row.links.map((l) => affiliateLinkShape(l, l.product, l.business)));
    return;
  }

  const schema = z.object({
    businessId: z.string().optional(),
    productId: z.string().optional(),
    label: z.string().max(120).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const link = await createAffiliateLink(prisma, req.userId, parsed.data);
    res.status(201).json(affiliateLinkShape(link, link.product, link.business));
  } catch (error) {
    if (handleAffiliateError(res, error)) return;
    throw error;
  }
}

export async function affiliateResolve(req, res) {
  const code = String(req.query.code ?? req.query.id ?? '').trim().toUpperCase();
  if (!code) {
    res.status(400).json({ error: 'Code requis' });
    return;
  }

  const link = await resolveAffiliateLink(prisma, code);
  if (!link) {
    res.status(404).json({ error: 'Lien introuvable' });
    return;
  }

  res.json({
    linkCode: link.linkCode,
    affiliate: { code: link.affiliate.affiliateCode, displayName: link.affiliate.displayName },
    product: link.product
      ? { id: link.product.id, title: link.product.title, price: link.product.price, imageUrl: link.product.imageUrl }
      : null,
    business: link.business
      ? { id: link.business.id, name: link.business.name, category: link.business.category }
      : null,
  });
}

export async function affiliateClick(req, res) {
  const code = String(req.query.code ?? req.query.id ?? '').trim();
  try {
    const link = await trackAffiliateClick(prisma, code);
    res.json({ ok: true, linkCode: link.linkCode });
  } catch (error) {
    if (handleAffiliateError(res, error)) return;
    throw error;
  }
}

export async function affiliateMboloShare(req, res) {
  const schema = z.object({
    threadId: z.string().min(1),
    productId: z.string().min(1),
    linkCode: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const result = await shareAffiliateProductToMbolo(prisma, req.userId, parsed.data);
    res.status(201).json({
      message: result.message,
      link: affiliateLinkShape(result.link, result.link.product, result.link.business),
      payload: result.payload,
    });
  } catch (error) {
    if (handleAffiliateError(res, error)) return;
    throw error;
  }
}

/** A4: deferred-mode earned commission → own wallet. Inactive unless AFFILIATE_DEFERRED_SETTLEMENT=true. */
export async function affiliateEarningsPayout(req, res) {
  const { affiliateDeferredEnabled, payoutAffiliateEarnings } = await import('./affiliate-settlement.js');
  if (!affiliateDeferredEnabled()) return res.status(403).json({ error: 'Versement des commissions différées non activé', code: 'affiliate_deferred_disabled' });
  const parsed = z.object({ idempotencyKey: z.string().max(120).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    res.json(await payoutAffiliateEarnings(req.userId, { idempotencyKey: String(req.headers?.['idempotency-key'] ?? parsed.data.idempotencyKey ?? '') }));
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message, code: error.code });
    throw error;
  }
}
