import { prisma } from '../prisma.js';
import { OrgAccessError, requireBusinessCapability } from '../business-access.js';

/**
 * J5 Address foundation (docs/JOKKO-ECONOMIC-OS-ARCHITECTURE.md §9).
 *
 * A reusable address for homes, shops, warehouses, pickup points, farms,
 * factories and (future) fulfilment centres — structured the way places are
 * found in Senegal and the region: commune / quartier, a landmark, entrance
 * instructions and a map pin, not just a street line.
 *
 * Privacy:
 *  - a HOME is always private: only its owner sees it; it is never public;
 *  - a person's address is shared with a business only for a purpose
 *    (an active delivery order) and only to roles that fulfil it;
 *  - everyone else gets at most the coarse area (city / commune).
 */
export const PURPOSES = ['home', 'business', 'store', 'warehouse', 'pickup_point', 'delivery_destination', 'farm', 'factory', 'fulfillment_center'];
const PUBLIC_ALLOWED = new Set(['business', 'store', 'warehouse', 'pickup_point', 'farm', 'factory', 'fulfillment_center']);
const FIELDS = ['country', 'region', 'department', 'city', 'commune', 'neighborhood', 'street', 'building', 'landmark', 'instructions', 'lat', 'lng'];

export class AddressError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AddressError';
    this.code = code;
    this.status = status;
  }
}

export function fullShape(a) {
  return { id: a.id, purpose: a.purpose, visibility: a.visibility, verificationState: a.verificationState, ...Object.fromEntries(FIELDS.map((f) => [f, a[f] ?? null])) };
}
/** What a stranger may know: the area, never the door or the pin. */
export function coarseShape(a) {
  return { id: a.id, purpose: a.purpose, country: a.country, city: a.city ?? null, commune: a.commune ?? null };
}

export async function createAddress(userId, { ownerType, ownerId, purpose, visibility = 'private', ...fields }) {
  if (!PURPOSES.includes(purpose)) throw new AddressError('invalid_purpose', 'Usage d’adresse inconnu');
  if (ownerType === 'user') {
    if (ownerId !== userId) throw new OrgAccessError('Adresse d’un autre utilisateur', 403);
  } else if (ownerType === 'business') {
    await requireBusinessCapability(userId, ownerId, 'business.profile.manage');
  } else throw new AddressError('invalid_owner', 'Propriétaire d’adresse inconnu');
  // A home is never public, whatever the request says.
  const vis = purpose === 'home' || !PUBLIC_ALLOWED.has(purpose) ? (visibility === 'public' ? 'private' : visibility) : visibility;
  if (!['private', 'counterparty', 'public'].includes(vis)) throw new AddressError('invalid_visibility', 'Visibilité inconnue');
  const data = { ownerType, ownerId, purpose, visibility: vis, verificationState: 'self_declared' };
  for (const f of FIELDS) if (fields[f] !== undefined) data[f] = fields[f];
  return fullShape(await prisma.address.create({ data }));
}

export async function listMyAddresses(userId) {
  const rows = await prisma.address.findMany({ where: { ownerType: 'user', ownerId: userId }, orderBy: { createdAt: 'desc' } });
  return rows.map(fullShape);
}

/**
 * Resolve an address for a viewer. `context` may name the order that justifies
 * sharing a customer's delivery address with the merchant's fulfilment roles.
 */
export async function viewAddress(viewerUserId, addressId, { orderId } = {}) {
  const a = await prisma.address.findUnique({ where: { id: addressId } });
  if (!a) throw new AddressError('not_found', 'Adresse introuvable', 404);
  if (a.ownerType === 'user' && a.ownerId === viewerUserId) return fullShape(a);
  if (a.ownerType === 'business') {
    const member = await requireBusinessCapability(viewerUserId, a.ownerId, 'business.read').then(() => true, () => false);
    if (member || a.visibility === 'public') return fullShape(a);
    return coarseShape(a);
  }
  if (orderId) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { deliveryAddressId: true, businessId: true, status: true, fulfillmentType: true } });
    const active = order && !['completed', 'cancelled', 'refunded'].includes(order.status);
    if (order?.deliveryAddressId === a.id && order.fulfillmentType === 'delivery' && active && order.businessId) {
      const canFulfil = await requireBusinessCapability(viewerUserId, order.businessId, 'business.orders.fulfill').then(() => true, () => false);
      if (canFulfil) return fullShape(a);
    }
  }
  return coarseShape(a);
}
