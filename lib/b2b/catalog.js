import { prisma } from '../prisma.js';
import { OrgAccessError, requireBusinessCapability } from '../business-access.js';
import { DISTRIBUTION_MODES } from '../business/distribution.js';
import { emitCommerceEvent } from '../commerce/events.js';

/**
 * J7.5 / J7.6 — wholesale catalog and server-authoritative pricing.
 *
 * A `WholesaleListing` is the seller's (distributor / wholesaler /
 * manufacturer) operational catalog line: SKU, unit / pack / case, units per
 * pack, base price per ordered pack, quantity tiers, MOQ and step, availability,
 * territory, depot, effective dates. It may reference the seller's own retail
 * `Product` (for stock) but is a separate catalog: Business Lite stays light.
 *
 * Visibility: listings are seen ONLY by businesses with an ACTIVE relationship
 * (scope `wholesale_catalog`) — never public, never other suppliers. Prices
 * are always computed here: price list entry for the relationship > best
 * quantity tier > base. A client-sent price is never read; the client sends
 * the total it saw (`expectedTotalKori`) and a mismatch is refused.
 */
export class CatalogB2bError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'CatalogB2bError';
    this.code = code;
    this.status = status;
  }
}

export const UNITS = ['unit', 'pack', 'case'];
export const AVAILABILITY = ['available', 'limited', 'preorder', 'out_of_stock'];
const MAX_LINES = 100;
const MAX_PACKS = 100_000;
const int = (v) => Number.isSafeInteger(v);

export async function requireSeller(userId, sellerId, capability, db = prisma) {
  const b = await requireBusinessCapability(userId, sellerId, capability, db);
  if (!DISTRIBUTION_MODES.has(b.operatingMode)) {
    throw new CatalogB2bError('not_a_distributor', 'Activez le mode distribution / grossiste pour ce commerce', 409);
  }
  return b;
}

function validateListingInput(input) {
  const errors = [];
  if (!input.sku || !/^[A-Za-z0-9._-]{1,40}$/.test(input.sku)) errors.push('sku');
  if (!input.title || String(input.title).length > 120) errors.push('title');
  if (input.unit && !UNITS.includes(input.unit)) errors.push('unit');
  if (input.unitsPerPack != null && (!int(input.unitsPerPack) || input.unitsPerPack < 1 || input.unitsPerPack > 10_000)) errors.push('unitsPerPack');
  if (!int(input.priceKori) || input.priceKori <= 0 || input.priceKori > 100_000_000) errors.push('priceKori');
  if (input.moqPacks != null && (!int(input.moqPacks) || input.moqPacks < 1)) errors.push('moqPacks');
  if (input.stepPacks != null && (!int(input.stepPacks) || input.stepPacks < 1)) errors.push('stepPacks');
  if (input.availability && !AVAILABILITY.includes(input.availability)) errors.push('availability');
  for (const t of input.tiers ?? []) {
    if (!int(t.minPacks) || t.minPacks < 2 || !int(t.priceKori) || t.priceKori <= 0) errors.push('tiers');
  }
  if (errors.length) throw new CatalogB2bError('invalid', `Champs invalides : ${[...new Set(errors)].join(', ')}`, 400);
}

/** Create or update (by SKU) a listing. Price edits affect future quotes only — PO lines are snapshots. */
export async function upsertListing(userId, sellerId, input) {
  await requireSeller(userId, sellerId, 'business.catalog.manage');
  validateListingInput(input);
  if (input.productId) {
    const p = await prisma.product.findFirst({ where: { id: input.productId, businessId: sellerId } });
    if (!p) throw new CatalogB2bError('product_not_found', 'Produit introuvable', 404);
  }
  if (input.depotLocationId) {
    const loc = await prisma.inventoryLocation.findFirst({ where: { id: input.depotLocationId, operatorBusinessId: sellerId, status: 'active' } });
    if (!loc) throw new CatalogB2bError('depot_not_found', 'Dépôt introuvable', 404);
  }
  const territoryIds = input.territoryIds ?? null;
  if (territoryIds) {
    const n = await prisma.territory.count({ where: { id: { in: territoryIds }, distributorBusinessId: sellerId } });
    if (n !== new Set(territoryIds).size) throw new CatalogB2bError('territory_not_found', 'Territoire introuvable', 404);
  }
  const data = {
    title: String(input.title).trim(),
    category: input.category ?? null,
    unit: input.unit ?? 'pack',
    unitsPerPack: input.unitsPerPack ?? 1,
    priceKori: input.priceKori,
    moqPacks: input.moqPacks ?? 1,
    stepPacks: input.stepPacks ?? 1,
    availability: input.availability ?? 'available',
    territoryIdsJson: territoryIds ? JSON.stringify([...new Set(territoryIds)]) : null,
    depotLocationId: input.depotLocationId ?? null,
    productId: input.productId ?? null,
    effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
    status: input.status === 'inactive' ? 'inactive' : 'active',
  };
  if (data.effectiveTo && data.effectiveTo <= data.effectiveFrom) throw new CatalogB2bError('invalid', 'Dates de validité invalides', 400);
  const listing = await prisma.$transaction(async (tx) => {
    const l = await tx.wholesaleListing.upsert({
      where: { sellerBusinessId_sku: { sellerBusinessId: sellerId, sku: input.sku } },
      create: { sellerBusinessId: sellerId, sku: input.sku, createdBy: userId, ...data },
      update: data,
    });
    if (input.tiers) {
      await tx.wholesalePriceTier.deleteMany({ where: { listingId: l.id } });
      for (const t of input.tiers) await tx.wholesalePriceTier.create({ data: { listingId: l.id, minPacks: t.minPacks, priceKori: t.priceKori } });
    }
    await emitCommerceEvent(tx, { type: 'listing.updated', businessId: sellerId, aggregateType: 'wholesale_listing', aggregateId: l.id, payload: { sku: l.sku, status: l.status } });
    return l;
  });
  return sellerListingView(listing, await prisma.wholesalePriceTier.findMany({ where: { listingId: listing.id }, orderBy: { minPacks: 'asc' } }));
}

function sellerListingView(l, tiers = []) {
  return {
    id: l.id,
    sku: l.sku,
    title: l.title,
    category: l.category,
    unit: l.unit,
    unitsPerPack: l.unitsPerPack,
    priceKori: l.priceKori,
    tiers: tiers.map((t) => ({ minPacks: t.minPacks, priceKori: t.priceKori })),
    moqPacks: l.moqPacks,
    stepPacks: l.stepPacks,
    availability: l.availability,
    territoryIds: l.territoryIdsJson ? JSON.parse(l.territoryIdsJson) : null,
    depotLocationId: l.depotLocationId,
    productId: l.productId,
    effectiveFrom: l.effectiveFrom.toISOString(),
    effectiveTo: l.effectiveTo?.toISOString() ?? null,
    status: l.status,
  };
}

export async function listSellerListings(userId, sellerId, { cursor, limit = 100 } = {}) {
  await requireSeller(userId, sellerId, 'business.catalog.manage');
  const take = Math.min(Math.max(1, Number(limit) || 100), 200);
  const rows = await prisma.wholesaleListing.findMany({
    where: { sellerBusinessId: sellerId },
    orderBy: { id: 'asc' },
    take: take + 1,
    ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
  });
  const page = rows.slice(0, take);
  const tiers = await prisma.wholesalePriceTier.findMany({ where: { listingId: { in: page.map((l) => l.id) } }, orderBy: { minPacks: 'asc' } });
  return { items: page.map((l) => sellerListingView(l, tiers.filter((t) => t.listingId === l.id))), nextCursor: rows.length > take ? page[page.length - 1].id : null };
}

/** Price lists: a seller's negotiated prices for chosen relationships. */
export async function createPriceList(userId, sellerId, { name, entries }) {
  await requireSeller(userId, sellerId, 'business.distribution.manage');
  if (!name || !Array.isArray(entries) || !entries.length) throw new CatalogB2bError('invalid', 'Nom et prix requis', 400);
  const ids = entries.map((e) => e.listingId);
  const owned = await prisma.wholesaleListing.count({ where: { id: { in: ids }, sellerBusinessId: sellerId } });
  if (owned !== new Set(ids).size) throw new CatalogB2bError('listing_not_found', 'Article introuvable', 404);
  if (entries.some((e) => !int(e.priceKori) || e.priceKori <= 0)) throw new CatalogB2bError('invalid', 'Prix invalide', 400);
  return prisma.$transaction(async (tx) => {
    const pl = await tx.priceList.create({ data: { sellerBusinessId: sellerId, name: String(name).slice(0, 80), createdBy: userId } });
    for (const e of entries) await tx.priceListEntry.create({ data: { priceListId: pl.id, listingId: e.listingId, priceKori: e.priceKori } });
    return { id: pl.id, name: pl.name, entries: entries.length };
  });
}

/** Assign (or clear) a relationship's price list / rep — distributor managers only. */
export async function configureRelationship(userId, sellerId, relationshipId, { priceListId, assignedRepUserId }) {
  await requireSeller(userId, sellerId, 'business.distribution.manage');
  const r = await prisma.merchantRelationship.findFirst({ where: { id: relationshipId, distributorBusinessId: sellerId } });
  if (!r) throw new CatalogB2bError('not_found', 'Relation introuvable', 404);
  const data = {};
  if (priceListId !== undefined) {
    if (priceListId) {
      const pl = await prisma.priceList.findFirst({ where: { id: priceListId, sellerBusinessId: sellerId, status: 'active' } });
      if (!pl) throw new CatalogB2bError('not_found', 'Liste de prix introuvable', 404);
    }
    data.priceListId = priceListId || null;
  }
  if (assignedRepUserId !== undefined) {
    if (assignedRepUserId) {
      const m = await prisma.businessMember.findFirst({ where: { businessId: sellerId, userId: assignedRepUserId, status: 'active' } });
      if (!m) throw new CatalogB2bError('not_a_member', 'Ce commercial n’est pas membre actif', 400);
    }
    data.assignedRepUserId = assignedRepUserId || null;
  }
  const u = await prisma.merchantRelationship.update({ where: { id: r.id }, data });
  return { id: u.id, priceListId: u.priceListId, assignedRep: Boolean(u.assignedRepUserId) };
}

/** Active relationship seller → buyer carrying `scope`; locked FOR SHARE when a tx is given. */
export async function activeRelationship(db, { sellerId, buyerId, scope = 'wholesale_ordering', lock = false }) {
  if (lock) {
    await db.$executeRaw`SELECT id FROM "MerchantRelationship" WHERE "distributorBusinessId" = ${sellerId} AND "merchantBusinessId" = ${buyerId} AND status = 'active' FOR SHARE`;
  }
  const r = await db.merchantRelationship.findFirst({ where: { distributorBusinessId: sellerId, merchantBusinessId: buyerId, status: 'active' } });
  if (!r || !JSON.parse(r.scopesJson).includes(scope)) return null;
  return r;
}

function listingVisibleTo(l, relationship, now) {
  if (l.status !== 'active' || l.effectiveFrom > now || (l.effectiveTo && l.effectiveTo <= now)) return false;
  if (l.territoryIdsJson) {
    const ids = JSON.parse(l.territoryIdsJson);
    if (!relationship.territoryId || !ids.includes(relationship.territoryId)) return false;
  }
  return true;
}

/** The ONE pricing function (J7.6). */
export function priceFor(listing, packs, { tiers = [], priceListEntry = null } = {}) {
  if (priceListEntry) return { unitPriceKori: priceListEntry.priceKori, priceSource: 'price_list' };
  const tier = tiers.filter((t) => t.minPacks <= packs).sort((a, b) => b.minPacks - a.minPacks)[0];
  if (tier) return { unitPriceKori: tier.priceKori, priceSource: 'tier' };
  return { unitPriceKori: listing.priceKori, priceSource: 'base' };
}

/**
 * Server quote for `lines` [{listingId, packs}] from seller to buyer, using
 * the relationship's price list and territory. Enforces visibility, MOQ, step,
 * availability. Returns snapshot lines + totals. Never reads a client price.
 */
export async function quoteInDb(db, { sellerId, relationship, lines }) {
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_LINES) throw new CatalogB2bError('invalid', 'Lignes invalides', 400);
  const seen = new Set();
  for (const ln of lines) {
    if (typeof ln.listingId !== 'string' || !int(ln.packs) || ln.packs < 1 || ln.packs > MAX_PACKS) throw new CatalogB2bError('invalid', 'Quantité invalide', 400);
    if (seen.has(ln.listingId)) throw new CatalogB2bError('invalid', 'Article en double', 400);
    seen.add(ln.listingId);
  }
  const ids = lines.map((l) => l.listingId);
  const [listings, tiers, plEntries] = await Promise.all([
    db.wholesaleListing.findMany({ where: { id: { in: ids }, sellerBusinessId: sellerId } }),
    db.wholesalePriceTier.findMany({ where: { listingId: { in: ids } } }),
    relationship.priceListId ? db.priceListEntry.findMany({ where: { priceListId: relationship.priceListId, listingId: { in: ids } } }) : [],
  ]);
  const now = new Date();
  const out = [];
  let subtotal = 0;
  for (const ln of lines) {
    const l = listings.find((x) => x.id === ln.listingId);
    // Another seller's listing, an inactive / expired one or one outside the territory: indistinguishable.
    if (!l || !listingVisibleTo(l, relationship, now)) throw new CatalogB2bError('listing_not_found', 'Article introuvable', 404);
    if (l.availability === 'out_of_stock') throw new CatalogB2bError('out_of_stock', `${l.title} — en rupture`);
    if (ln.packs < l.moqPacks) throw new CatalogB2bError('below_moq', `${l.title} — minimum ${l.moqPacks}`, 400);
    if ((ln.packs - l.moqPacks) % l.stepPacks !== 0) throw new CatalogB2bError('bad_step', `${l.title} — par multiples de ${l.stepPacks}`, 400);
    const p = priceFor(l, ln.packs, { tiers: tiers.filter((t) => t.listingId === l.id), priceListEntry: plEntries.find((e) => e.listingId === l.id) });
    const lineTotal = p.unitPriceKori * ln.packs;
    if (!int(lineTotal)) throw new CatalogB2bError('invalid', 'Montant hors limites', 400);
    subtotal += lineTotal;
    out.push({ listingId: l.id, productId: l.productId, sku: l.sku, title: l.title, unit: l.unit, unitsPerPack: l.unitsPerPack, packs: ln.packs, unitPriceKori: p.unitPriceKori, lineTotalKori: lineTotal, priceSource: p.priceSource, depotLocationId: l.depotLocationId });
  }
  if (!int(subtotal) || subtotal > 2_000_000_000) throw new CatalogB2bError('invalid', 'Montant hors limites', 400);
  return { lines: out, subtotalKori: subtotal, totalKori: subtotal };
}

/** Buyer-side catalog of ONE connected seller (relationship-gated). */
export async function buyerCatalog(userId, buyerId, sellerId, { cursor, limit = 100 } = {}) {
  await requireBusinessCapability(userId, buyerId, 'business.purchasing');
  const rel = await activeRelationship(prisma, { sellerId, buyerId, scope: 'wholesale_catalog' });
  if (!rel) throw new OrgAccessError('Fournisseur introuvable', 404);
  const take = Math.min(Math.max(1, Number(limit) || 100), 200);
  const rows = await prisma.wholesaleListing.findMany({
    where: { sellerBusinessId: sellerId, status: 'active' },
    orderBy: { id: 'asc' },
    take: take + 1,
    ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
  });
  const now = new Date();
  const page = rows.slice(0, take);
  const visible = page.filter((l) => listingVisibleTo(l, rel, now));
  const [tiers, plEntries] = await Promise.all([
    prisma.wholesalePriceTier.findMany({ where: { listingId: { in: visible.map((l) => l.id) } }, orderBy: { minPacks: 'asc' } }),
    rel.priceListId ? prisma.priceListEntry.findMany({ where: { priceListId: rel.priceListId, listingId: { in: visible.map((l) => l.id) } } }) : [],
  ]);
  return {
    items: visible.map((l) => {
      const entry = plEntries.find((e) => e.listingId === l.id);
      return {
        listingId: l.id,
        sku: l.sku,
        title: l.title,
        category: l.category,
        unit: l.unit,
        unitsPerPack: l.unitsPerPack,
        // Only THIS buyer's price: their price list, or base + tiers. Other buyers' negotiated prices never leak.
        priceKori: entry ? entry.priceKori : l.priceKori,
        tiers: entry ? [] : tiers.filter((t) => t.listingId === l.id).map((t) => ({ minPacks: t.minPacks, priceKori: t.priceKori })),
        moqPacks: l.moqPacks,
        stepPacks: l.stepPacks,
        availability: l.availability,
      };
    }),
    nextCursor: rows.length > take ? page[page.length - 1].id : null,
  };
}
