/**
 * J14-S3 Partner API: product mapping for the partner's linked businesses (dormant unless
 * PARTNER_PRODUCT_MAPPING_ENABLED=true). Ids only — no catalog copy.
 */
import { ProductLinkError, partnerLinkProduct, partnerListProductLinks, partnerUnlinkProduct } from './product-links.js';

async function partner(req, res) {
  const { requirePartner } = await import('../partner-handlers.js');
  return requirePartner(req, res);
}
function fail(res, e) {
  if (e instanceof ProductLinkError) {
    res.status(e.status).json({ error: e.message, code: e.code });
    return true;
  }
  return false;
}

export async function partnerProductLinkCreate(req, res) {
  if (!(await partner(req, res))) return;
  try {
    const r = await partnerLinkProduct(req.partnerId, req.body ?? {});
    res.status(r.created ? 201 : 200).json(r.link);
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function partnerProductLinksList(req, res) {
  if (!(await partner(req, res))) return;
  try {
    res.json({ links: await partnerListProductLinks(req.partnerId, { externalBusinessId: req.query.external_business_id }) });
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}

export async function partnerProductLinkUnlink(req, res) {
  if (!(await partner(req, res))) return;
  try {
    res.json(await partnerUnlinkProduct(req.partnerId, req.query.id));
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
}
