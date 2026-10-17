/**
 * J14-S3 — partner product mapping (ExternalLink objectType=product). DORMANT unless
 * PARTNER_PRODUCT_MAPPING_ENABLED=true.
 *
 * A partner (Kabu) maps ITS product id, within one of ITS linked businesses, to a Jokko catalog Product OF THAT
 * BUSINESS. Nothing is copied: no title, price, stock or image crosses — only the two ids. Used by fulfilment
 * requests (S2) and partner-side reorders to name Jokko products by reference.
 *
 *   - the business link must be ACTIVE for this partner; the product must belong to that business;
 *   - the external product id is namespaced by the external business id (two shops may reuse a SKU);
 *   - idempotent: mapping the same pair again returns the same link; re-pointing an active mapping → 409;
 *   - the business owner sees and revokes these links with the existing business-links endpoints;
 *   - resolution re-checks the business link, so revoking the business link disables all its product links.
 */
import { prisma } from '../prisma.js';

export const productMappingEnabled = () => process.env.PARTNER_PRODUCT_MAPPING_ENABLED === 'true';

export class ProductLinkError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const SEP = '::';
const ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const externalKey = (extBiz, extProd) => `${extBiz}${SEP}${extProd}`;

function requireEnabled() {
  if (!productMappingEnabled()) throw new ProductLinkError('disabled', 'Product mapping is not enabled', 403);
}

async function activeBusinessLink(db, partnerId, externalBusinessId) {
  if (!externalBusinessId || !ID_RE.test(String(externalBusinessId))) throw new ProductLinkError('invalid', 'external_business_id is required');
  const link = await db.externalLink.findUnique({ where: { system_objectType_externalId: { system: partnerId, objectType: 'business', externalId: String(externalBusinessId) } } });
  // An unknown, another partner's, or a revoked business link all read the same.
  if (!link || link.status !== 'active') throw new ProductLinkError('business_not_linked', 'Business not linked', 404);
  return link;
}

function shape(l) {
  const i = l.externalId.indexOf(SEP);
  return {
    id: l.id,
    external_business_id: l.externalId.slice(0, i),
    external_product_id: l.externalId.slice(i + SEP.length),
    jokko_product_id: l.jokkoId,
    status: l.status,
    created_at: l.createdAt.toISOString(),
    revoked_at: l.revokedAt?.toISOString() ?? null,
  };
}

export async function partnerLinkProduct(partnerId, body, db = prisma) {
  requireEnabled();
  const extProd = String(body?.external_product_id ?? '');
  if (!ID_RE.test(extProd) || extProd.includes(SEP)) throw new ProductLinkError('invalid', 'external_product_id is required (1–120 chars, no "::")');
  const bizLink = await activeBusinessLink(db, partnerId, body?.external_business_id);
  const businessId = bizLink.jokkoId;
  let product = null;
  if (body?.jokko_product_id) {
    product = await db.product.findUnique({ where: { id: String(body.jokko_product_id) }, select: { id: true, businessId: true } });
  } else if (body?.jokko_sku) {
    product = await db.product.findFirst({ where: { businessId, sku: String(body.jokko_sku) }, select: { id: true, businessId: true } });
  } else {
    throw new ProductLinkError('invalid', 'jokko_product_id or jokko_sku is required');
  }
  // Another business's product reads exactly like a missing one.
  if (!product || product.businessId !== businessId) throw new ProductLinkError('product_not_found', 'Product not found in this business', 404);

  const externalId = externalKey(bizLink.externalId, extProd);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`product-link:${partnerId}:${externalId}`}))`;
    const existing = await tx.externalLink.findUnique({ where: { system_objectType_externalId: { system: partnerId, objectType: 'product', externalId } } });
    if (existing?.status === 'active') {
      if (existing.jokkoId === product.id && existing.businessId === businessId) return { link: shape(existing), created: false };
      throw new ProductLinkError('already_mapped', 'This external product is already mapped to another Jokko product — unlink it first', 409);
    }
    const link = existing
      ? await tx.externalLink.update({ where: { id: existing.id }, data: { status: 'active', jokkoId: product.id, businessId, revokedAt: null, linkedBy: `partner:${partnerId}` } })
      : await tx.externalLink.create({ data: { system: partnerId, objectType: 'product', externalId, jokkoType: 'product', jokkoId: product.id, businessId, linkedBy: `partner:${partnerId}` } });
    return { link: shape(link), created: true };
  });
}

export async function partnerListProductLinks(partnerId, { externalBusinessId } = {}, db = prisma) {
  requireEnabled();
  const bizLink = await activeBusinessLink(db, partnerId, externalBusinessId);
  const rows = await db.externalLink.findMany({ where: { system: partnerId, objectType: 'product', businessId: bizLink.jokkoId, externalId: { startsWith: `${bizLink.externalId}${SEP}` } }, orderBy: { createdAt: 'desc' }, take: 500 });
  return rows.map(shape);
}

export async function partnerUnlinkProduct(partnerId, linkId, db = prisma) {
  requireEnabled();
  const l = await db.externalLink.findUnique({ where: { id: String(linkId) } });
  if (!l || l.system !== partnerId || l.objectType !== 'product') throw new ProductLinkError('not_found', 'Product link not found', 404);
  if (l.status !== 'active') return shape(l);
  return shape(await db.externalLink.update({ where: { id: l.id }, data: { status: 'revoked', revokedAt: new Date() } }));
}

/**
 * Resolve a partner product reference to a Jokko product of the linked business — or null. Re-checks BOTH the
 * business link and the product link (S2 and reorders call this; a revoked link never resolves).
 */
export async function resolveExternalProduct(db, partnerId, externalBusinessId, externalProductId) {
  const biz = await db.externalLink.findUnique({ where: { system_objectType_externalId: { system: partnerId, objectType: 'business', externalId: String(externalBusinessId) } } });
  if (!biz || biz.status !== 'active') return null;
  const l = await db.externalLink.findUnique({ where: { system_objectType_externalId: { system: partnerId, objectType: 'product', externalId: externalKey(biz.externalId, String(externalProductId)) } } });
  if (!l || l.status !== 'active' || l.businessId !== biz.jokkoId) return null;
  const p = await db.product.findUnique({ where: { id: l.jokkoId }, select: { id: true, businessId: true } });
  return p && p.businessId === biz.jokkoId ? { productId: p.id, businessId: biz.jokkoId } : null;
}
