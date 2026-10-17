import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchApi } from '../../lib/api-router.js';
import {
  marketplaceSearch,
  marketplaceShopsNearby,
  marketplaceShopGet,
  marketplaceHubsList,
  marketplaceOrderCreate,
} from '../../lib/marketplace-handlers.js';
import { deliveriesNearby } from '../../lib/handlers.js';
import { createUserWithWallet, mockReq, mockRes, prisma, resetReserveToWallets, createVerifiedDevice } from '../helpers/db.js';
import { signAccessToken } from '../../api/_lib/auth.js';
// D41: the legacy open-claim courier marketplace is off by default; these tests cover it explicitly re-enabled.
process.env.LEGACY_CONSUMER_DELIVERY_ENABLED = 'true';

after(async () => {
  await prisma.$disconnect();
});

async function call(handler, { userId, body, query, method = 'POST', deviceId } = {}) {
  const headers = deviceId ? { 'x-device-id': deviceId } : {};
  const req = mockReq({ userId, body, query, method, headers });
  const res = mockRes();
  await handler(req, res);
  return res;
}

function authHeader(userId) {
  return `Bearer ${signAccessToken(userId)}`;
}

test('api router: marketplace/shops/:id resolves dynamic path', async () => {
  const merchant = await createUserWithWallet({ koriBalance: 0 });
  const business = await prisma.business.create({
    data: {
      ownerId: merchant.id,
      name: `Marché Test ${Date.now()}`,
      category: 'grocery',
      lat: 14.6892,
      lng: -17.4421,
      arrondissement: 'medina',
      address: 'Rue test',
    },
  });

  const req = {
    method: 'GET',
    headers: { authorization: authHeader(merchant.id) },
    query: {},
    body: {},
  };
  const res = mockRes();
  await dispatchApi(req, res, ['marketplace', 'shops', business.id]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.shop.id, business.id);
});

test('marketplace E2E: publish → search → order pickup → order delivery → rider sees job', async () => {
  await resetReserveToWallets();

  const merchant = await createUserWithWallet({ koriBalance: 0, name: 'Marchand Test' });
  const buyer = await createUserWithWallet({ koriBalance: 5000, name: 'Acheteur Test' });
  const rider = await createUserWithWallet({ koriBalance: 2000, name: 'Livreur Test' });
  await prisma.accountRole.create({ data: { userId: rider.id, role: 'driver', status: 'active' } }); // open jobs are courier-only
  const buyerDevice = await createVerifiedDevice(buyer.id);

  const business = await prisma.business.create({
    data: {
      ownerId: merchant.id,
      name: `Épicerie Médina ${Date.now()}`,
      category: 'grocery',
      type: 'merchant',
      lat: 14.6892,
      lng: -17.4421,
      arrondissement: 'medina',
      address: 'Marché Sandaga',
    },
  });

  const product = await prisma.product.create({
    data: {
      businessId: business.id,
      title: 'Riz brisé 1kg',
      description: 'Riz local premium',
      price: 500,
      inventory: 20,
      category: 'grocery',
      active: true,
      imageUrl: 'data:image/png;base64,test',
    },
  });

  const hubsRes = await call(marketplaceHubsList, { userId: buyer.id, method: 'GET' });
  assert.equal(hubsRes.statusCode, 200);
  assert.ok(Array.isArray(hubsRes.body.hubs));
  assert.ok(hubsRes.body.hubs.length >= 3, 'default Dakar hubs seeded');

  const searchRes = await call(marketplaceSearch, {
    userId: buyer.id,
    method: 'GET',
    query: { q: 'riz', lat: '14.69', lng: '-17.44', category: 'grocery' },
  });
  assert.equal(searchRes.statusCode, 200);
  assert.ok(searchRes.body.shops.some((s) => s.id === business.id), 'shop appears in search');
  assert.ok(searchRes.body.results.some((p) => p.id === product.id));

  const nearbyRes = await call(marketplaceShopsNearby, {
    userId: buyer.id,
    method: 'GET',
    query: { lat: '14.69', lng: '-17.44', category: 'grocery' },
  });
  assert.equal(nearbyRes.statusCode, 200);
  assert.ok(nearbyRes.body.shops.some((s) => s.id === business.id));

  const catalogRes = await call(marketplaceShopGet, {
    userId: buyer.id,
    method: 'GET',
    query: { id: business.id, lat: '14.69', lng: '-17.44' },
  });
  assert.equal(catalogRes.statusCode, 200);
  assert.equal(catalogRes.body.shop.id, business.id);
  assert.equal(catalogRes.body.products.length, 1);
  assert.equal(catalogRes.body.products[0].imageUrl, product.imageUrl);

  const pickupRes = await call(marketplaceOrderCreate, {
    userId: buyer.id,
    deviceId: buyerDevice,
    body: {
      businessId: business.id,
      items: [{ productId: product.id, quantity: 2 }],
      fulfillmentType: 'pickup',
    },
  });
  assert.equal(pickupRes.statusCode, 201, JSON.stringify(pickupRes.body));
  // J5: a paid order waits for the merchant (confirmed → preparing → ready).
  assert.equal(pickupRes.body.status, 'confirmed');
  assert.equal(pickupRes.body.totalKori, 1000);

  const buyerWalletAfterPickup = await prisma.wallet.findUnique({ where: { userId: buyer.id } });
  assert.equal(buyerWalletAfterPickup.koriBalance, 4000);

  // J5: new businesses settle to the business wallet, not the owner's personal wallet.
  const merchantWalletAfterPickup = await prisma.wallet.findUnique({ where: { userId: merchant.id } });
  assert.equal(merchantWalletAfterPickup.koriBalance, 0);
  const bizAccount = await prisma.ledgerAccount.findUnique({ where: { code: `business:${business.id}:wallet` } });
  assert.equal(Number(bizAccount.balance), 1000);

  const stockAfterPickup = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(stockAfterPickup.inventory, 18);

  await prisma.product.update({
    where: { id: product.id },
    data: { inventory: 10 },
  });

  const deliveryRes = await call(marketplaceOrderCreate, {
    userId: buyer.id,
    deviceId: buyerDevice,
    body: {
      businessId: business.id,
      items: [{ productId: product.id, quantity: 1 }],
      fulfillmentType: 'delivery',
      dropoff: {
        area: 'Médina',
        address: 'Rue 22 x 40, portail bleu',
        lat: 14.69,
        lng: -17.44,
      },
    },
  });
  assert.equal(deliveryRes.statusCode, 201, JSON.stringify(deliveryRes.body));
  assert.equal(deliveryRes.body.fulfillmentType, 'delivery');
  assert.ok(deliveryRes.body.delivery?.id);
  assert.ok(deliveryRes.body.hub?.name);

  const task = await prisma.deliveryTask.findUnique({
    where: { id: deliveryRes.body.delivery.id },
    include: { hub: true },
  });
  assert.equal(task.status, 'open');
  assert.ok(task.productSummary.includes('Riz'));
  assert.ok(task.hubId);

  const nearbyJobs = await call(deliveriesNearby, {
    userId: rider.id,
    method: 'GET',
    query: { lat: '14.69', lng: '-17.44' },
  });
  assert.equal(nearbyJobs.statusCode, 200);
  assert.ok(Array.isArray(nearbyJobs.body));
  assert.ok(nearbyJobs.body.some((j) => j.id === task.id), 'delivery visible to rider');
  const job = nearbyJobs.body.find((j) => j.id === task.id);
  assert.ok(job.hub?.name);
  assert.ok(job.productSummary);
});

test('marketplace order rejects insufficient stock and balance', async () => {
  await resetReserveToWallets();
  const merchant = await createUserWithWallet({ koriBalance: 0 });
  const buyer = await createUserWithWallet({ koriBalance: 100 });
  const buyerDevice = await createVerifiedDevice(buyer.id);
  const business = await prisma.business.create({
    data: { ownerId: merchant.id, name: 'Petit marché', category: 'grocery', lat: 14.69, lng: -17.44 },
  });
  const product = await prisma.product.create({
    data: { businessId: business.id, title: 'Huile', price: 800, inventory: 1, category: 'grocery', active: true },
  });

  const overStock = await call(marketplaceOrderCreate, {
    userId: buyer.id,
    deviceId: buyerDevice,
    body: {
      businessId: business.id,
      items: [{ productId: product.id, quantity: 5 }],
      fulfillmentType: 'pickup',
    },
  });
  assert.equal(overStock.statusCode, 400);

  const overBalance = await call(marketplaceOrderCreate, {
    userId: buyer.id,
    deviceId: buyerDevice,
    body: {
      businessId: business.id,
      items: [{ productId: product.id, quantity: 1 }],
      fulfillmentType: 'pickup',
    },
  });
  assert.equal(overBalance.statusCode, 400);
  assert.match(overBalance.body.error ?? '', /insuffisant/i);
});
