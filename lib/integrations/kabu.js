import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { OrgAccessError, requireBusinessCapability } from '../business-access.js';

/**
 * J5 Kabu ↔ Jokko integration contract (docs/JOKKO-ECONOMIC-OS-ARCHITECTURE.md §3).
 *
 * Kabu (spelled "Kebu"/"KEBU" in existing code and the Partner API) is the
 * full Shopify-class commerce OS and the system of record for its stores,
 * ecommerce orders, merchandising and customers. Jokko is the system of
 * record for money (J2), identity/permissions (J3) and network services.
 *
 * Objects cross by REFERENCE: an ExternalLink maps a Kabu id to a Jokko id.
 * No Kabu order / product / customer is copied into Jokko.
 *
 * Linking a Kabu business to a Jokko business needs both sides' consent:
 *  1. the Jokko business OWNER creates a one-time link code (15 min);
 *  2. Kabu, authenticated with its partner key, presents the code + its own
 *     business id (POST /api/v1/business-links).
 *
 * ACTIVE: link / list / revoke; partner payments + payouts (existing Partner
 * API, docs/JOKO-PARTNER-API.md); J6.0 per-merchant settlement — a payment
 * carrying `merchant.external_business_id` settles to the linked business
 * wallet (lib/partner-payments-service.js), or is held for review if the
 * mapping / merchant is no longer valid at confirmation. LEGACY (D23):
 * unmapped payments and all payouts use PARTNER_SETTLEMENT_USER_ID.
 * DORMANT (contract only): per-merchant payouts from a business wallet,
 * product/order mirroring, Jokko Logistics fulfilment requests, payroll
 * instructions from Kabu staff.
 */
const CODE_TTL_MS = 15 * 60_000;
const hash = (c) => crypto.createHash('sha256').update(String(c)).digest('hex');

export class IntegrationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
    this.status = status;
  }
}

export async function createBusinessLinkCode(userId, businessId, system = 'kebu') {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { ownerId: true } });
  if (!b) throw new OrgAccessError('Business not found', 404);
  if (b.ownerId !== userId) throw new OrgAccessError('Seul le propriétaire peut relier ce commerce à un autre système');
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  await prisma.businessLinkCode.create({ data: { businessId, system, codeHash: hash(code), createdBy: userId, expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
  return { code, system, expiresInMinutes: 15 };
}

/** Partner side (authenticated by partner key upstream). */
export async function partnerLinkBusiness(partnerId, { code, externalBusinessId }) {
  if (!code || !externalBusinessId) throw new IntegrationError('invalid', 'code and external_business_id required');
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`SELECT id FROM "BusinessLinkCode" WHERE "codeHash" = ${hash(code)} FOR UPDATE`;
    const lc = rows.length ? await tx.businessLinkCode.findUnique({ where: { id: rows[0].id } }) : null;
    if (!lc || lc.system !== partnerId || lc.usedAt || lc.expiresAt <= new Date()) throw new IntegrationError('invalid_code', 'Link code invalid, expired or already used', 404);
    const clash = await tx.externalLink.findUnique({ where: { system_objectType_externalId: { system: partnerId, objectType: 'business', externalId: String(externalBusinessId) } } });
    if (clash && clash.status === 'active' && clash.jokkoId !== lc.businessId) throw new IntegrationError('already_linked', 'External business already linked to another Jokko business', 409);
    await tx.businessLinkCode.update({ where: { id: lc.id }, data: { usedAt: new Date() } });
    const link = clash
      ? await tx.externalLink.update({ where: { id: clash.id }, data: { status: 'active', jokkoId: lc.businessId, businessId: lc.businessId, revokedAt: null, linkedBy: lc.createdBy } })
      : await tx.externalLink.create({ data: { system: partnerId, objectType: 'business', externalId: String(externalBusinessId), jokkoType: 'business', jokkoId: lc.businessId, businessId: lc.businessId, linkedBy: lc.createdBy } });
    return { link_id: link.id, system: partnerId, external_business_id: link.externalId, status: link.status };
  });
}

export async function listBusinessLinks(userId, businessId) {
  await requireBusinessCapability(userId, businessId, 'business.profile.manage');
  const rows = await prisma.externalLink.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } });
  return rows.map((l) => ({ id: l.id, system: l.system, objectType: l.objectType, externalId: l.externalId, status: l.status, createdAt: l.createdAt.toISOString(), revokedAt: l.revokedAt?.toISOString() ?? null }));
}

export async function revokeBusinessLink(userId, businessId, linkId) {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { ownerId: true } });
  if (!b || b.ownerId !== userId) throw new OrgAccessError('Seul le propriétaire peut délier ce commerce');
  const r = await prisma.externalLink.updateMany({ where: { id: linkId, businessId, status: 'active' }, data: { status: 'revoked', revokedAt: new Date() } });
  if (!r.count) throw new IntegrationError('not_found', 'Lien introuvable', 404);
  return { id: linkId, status: 'revoked' };
}

/** Contract surface (versioned) — what each system may ask of the other. */
export const KABU_CONTRACT = {
  version: '2026-10-j6',
  identity: { link: 'POST /api/v1/business-links {code, external_business_id}', mapping: 'ExternalLink(system=kebu, objectType=business)' },
  payments: { status: 'ACTIVE', api: 'POST /api/v1/checkout/sessions, POST /api/v1/payments/collect (Partner API)', resultTo: 'Kabu webhook (signed) → Kabu updates ITS order' },
  payouts: { status: 'ACTIVE', api: 'POST /api/v1/payouts' },
  perMerchantSettlement: { status: 'ACTIVE', api: 'POST /api/v1/payments/collect | checkout/sessions {merchant: {external_business_id}}', result: 'settlement {target, external_business_id, status pending|settled|held_for_review, ledger_reference}' },
  legacyPlatformSettlement: { status: 'LEGACY', note: 'unmapped payments → PARTNER_SETTLEMENT_USER_ID; PARTNER_LEGACY_PLATFORM_SETTLEMENT=false refuses them' },
  perMerchantPayouts: { status: 'DORMANT', note: 'payouts still debit the platform settlement wallet; debiting a merchant wallet needs merchant authority (payroll instructions)' },
  payrollInstructions: { status: 'DORMANT', note: 'Kabu staff authority → Jokko payout instruction → J3 authorization → J2' },
  logistics: { status: 'DORMANT', note: 'Kabu fulfilment request → Jokko Logistics (J8) → status/proof events → Kabu' },
  productMapping: { status: 'DORMANT', note: 'ExternalLink(objectType=product) when a Kabu SKU is sold through Jokko distribution' },
  events: { status: 'ACTIVE (outbox)', note: 'CommerceEvent outbox; signed webhooks to Kabu reuse partner-webhook-service' },
};
