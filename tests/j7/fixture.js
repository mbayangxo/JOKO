import crypto from 'node:crypto';
import { prisma, fundBusiness } from '../helpers/db.js';
import { business, customer, signedIn, stepUp } from '../j3/helpers.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';

export const key = () => `k-${crypto.randomBytes(8).toString('hex')}`;
export const idemH = (k = key()) => ({ headers: { 'idempotency-key': k } });
export const bizBal = async (id) => (await prisma.businessWallet.findUnique({ where: { businessId: id } }))?.balance ?? 0;
export async function withStepUp(s, k = key()) {
  return { headers: { 'idempotency-key': k, 'x-step-up-token': await stepUp(s) } };
}

/** A person with a role in a business, signed in. */
export async function member(api, biz, role) {
  const c = await customer();
  await prisma.businessMember.create({ data: { businessId: biz.id, userId: c.id, role, status: 'active', acceptedAt: new Date() } });
  return signedIn(api, c);
}

/** Supplier (distribution mode) with a depot, a product and one listing. */
export async function supplier(api, { priceKori = 1000, moqPacks = 1, stepPacks = 1, unitsPerPack = 12, stock = 1200, tiers } = {}) {
  const ownerC = await customer();
  const owner = await signedIn(api, ownerC);
  const b = await business(ownerC.user);
  await prisma.business.update({ where: { id: b.id }, data: { operatingMode: 'distribution', name: `Distrib ${crypto.randomBytes(3).toString('hex')}` } });
  await ensureBusinessWallet(b.id, prisma);
  const depot = await prisma.inventoryLocation.create({ data: { operatorBusinessId: b.id, kind: 'distributor_depot', name: 'Dépôt Pikine' } });
  const product = await prisma.product.create({ data: { businessId: b.id, title: 'Huile 1L', price: 1500, inventory: 0, category: 'epicerie', active: true } });
  const sku = `HUI-${crypto.randomBytes(3).toString('hex')}`;
  const listing = await owner.call('POST', `businesses/${b.id}/b2b/listings`, { sku, title: 'Huile 1L — carton 12', category: 'epicerie', productId: product.id, unit: 'case', unitsPerPack, priceKori, moqPacks, stepPacks, depotLocationId: depot.id, ...(tiers ? { tiers } : {}) });
  if (listing.status !== 201) throw new Error(`listing ${listing.status} ${JSON.stringify(listing.body)}`);
  if (stock) {
    const r = await owner.call('POST', `businesses/${b.id}/b2b/depots/${depot.id}/stock`, { productId: product.id, units: stock });
    if (r.status !== 201) throw new Error(`stock ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { b, owner, ownerC, depot, product, listing: listing.body };
}

/** Merchant (buyer) business, funded wallet, connected to the supplier. */
export async function merchant(api, sup, { fund = 50_000, connect = true, territoryId = null } = {}) {
  const ownerC = await customer();
  const owner = await signedIn(api, ownerC);
  const b = await business(ownerC.user);
  await ensureBusinessWallet(b.id, prisma);
  if (fund) await fundBusiness(b.id, fund);
  let rel = null;
  if (connect) {
    rel = await prisma.merchantRelationship.create({ data: { distributorBusinessId: sup.b.id, merchantBusinessId: b.id, introducedByUserId: sup.ownerC.id, status: 'active', respondedAt: new Date(), territoryId } });
  }
  return { b, owner, ownerC, rel };
}

export async function grantTerms(sup, m, { term = 'net30', limit = 10_000 } = {}) {
  return prisma.tradeAccount.create({ data: { supplierBusinessId: sup.b.id, buyerUserId: m.ownerC.id, buyerBusinessId: m.b.id, paymentTerm: term, creditLimitKori: limit } });
}

export async function submit(m, sup, { packs = 2, term = 'due_now', expected, k = key(), as = m.owner } = {}) {
  const total = expected ?? packs * sup.listing.priceKori;
  return as.call('POST', `businesses/${m.b.id}/b2b/purchase-orders`, { sellerBusinessId: sup.b.id, lines: [{ listingId: sup.listing.id, packs }], paymentTerm: term, expectedTotalKori: total }, idemH(k));
}

export const depotRow = (sup) => prisma.depotStock.findUnique({ where: { locationId_productId: { locationId: sup.depot.id, productId: sup.product.id } } });
