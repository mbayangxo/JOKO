import '../helpers/setup.js';

// D31: legacy B2B channel orders are off by default; this file tests that legacy path, so it opts in.
process.env.LEGACY_B2B_ORDERS_ENABLED = 'true';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchApi } from '../../lib/api-router.js';
import { marketplaceOrderCreate } from '../../lib/marketplace-handlers.js';
import {
  buyerPortalSuppliers,
  buyerPortalCatalog,
  supplierReceivables,
  tradeAccountUpsert,
  tradeInvoicePay,
  marketplaceOrderConfirm,
} from '../../lib/trade-handlers.js';
import { updateOrderStatus } from '../../lib/order-fulfillment-service.js';
import { createUserWithWallet, mockReq, mockRes, prisma, resetReserveToWallets, createVerifiedDevice, fundBusiness } from '../helpers/db.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';

after(async () => {
  await prisma.$disconnect();
});

async function call(handler, { userId, body, query, method = 'POST', deviceId } = {}) {
  const headers = {
    'x-vercel-ip-country': 'SN',
    ...(deviceId ? { 'x-device-id': deviceId } : {}),
  };
  const req = mockReq({ userId, body, query, method, headers });
  const res = mockRes();
  await handler(req, res);
  return res;
}

async function dispatch(method, segments, { userId, body, query, deviceId } = {}) {
  const headers = deviceId ? { 'x-device-id': deviceId } : {};
  const req = mockReq({ userId, body, query: query ?? {}, method, headers });
  const res = mockRes();
  await dispatchApi(req, res, segments);
  return res;
}

test('B2B trade E2E: brand → trade account → portal → KEBU order → receivables → COD KEBU settle', async () => {
  await resetReserveToWallets();

  const supplier = await createUserWithWallet({ koriBalance: 0, name: 'Fournisseur' });
  const buyer = await createUserWithWallet({ koriBalance: 100_000, name: 'Acheteur' });
  const buyerDevice = await createVerifiedDevice(buyer.id);
  await prisma.user.update({
    where: { id: buyer.id },
    data: { stepUpVerifiedAt: new Date() },
  });

  const buyerBiz = await prisma.business.create({
    data: {
      ownerId: buyer.id,
      name: 'Épicerie Acheteur',
      type: 'merchant',
      category: 'grocery',
      kebuId: `KEBU-BUY-${Date.now()}`,
      lat: 14.69,
      lng: -17.44,
    },
  });
  await ensureBusinessWallet(buyerBiz.id, prisma);
  await fundBusiness(buyerBiz.id, 50_000);

  const brand = await prisma.business.create({
    data: {
      ownerId: supplier.id,
      name: `K21 Agro ${Date.now()}`,
      type: 'brand',
      category: 'k21',
      distributionEnabled: true,
      kebuId: `KEBU-SUP-${Date.now()}`,
      lat: 14.69,
      lng: -17.44,
      address: 'Dakar',
    },
  });
  await ensureBusinessWallet(brand.id, prisma);

  const product = await prisma.product.create({
    data: {
      businessId: brand.id,
      title: 'Granulés 50kg',
      price: 4500,
      b2bPrice: 4000,
      b2bMinQty: 1,
      saleChannel: 'both',
      inventory: 50,
      category: 'agro',
      active: true,
    },
  });

  const tradeRes = await call(tradeAccountUpsert, {
    userId: supplier.id,
    query: { businessId: brand.id },
    body: {
      buyerHandle: buyer.handle,
      buyerLabel: 'Client test',
      paymentTerm: 'net30',
      creditLimitKori: 500_000,
      codEnabled: true,
      trustTier: 'partner',
      buyerBusinessId: buyerBiz.id,
    },
  });
  assert.equal(tradeRes.statusCode, 200, JSON.stringify(tradeRes.body));

  const portalRes = await call(buyerPortalSuppliers, { userId: buyer.id, method: 'GET' });
  assert.equal(portalRes.statusCode, 200);
  assert.ok(portalRes.body.suppliers.some((s) => s.supplierBusinessId === brand.id), 'supplier visible in portal');

  const catalogRes = await call(buyerPortalCatalog, {
    userId: buyer.id,
    method: 'GET',
    query: { businessId: brand.id },
  });
  assert.equal(catalogRes.statusCode, 200);
  assert.equal(catalogRes.body.products.length, 1);
  assert.ok(catalogRes.body.tradeSummary);

  const kebuOrderRes = await call(marketplaceOrderCreate, {
    userId: buyer.id,
    deviceId: buyerDevice,
    body: {
      businessId: brand.id,
      items: [{ productId: product.id, quantity: 1 }],
      fulfillmentType: 'pickup',
      channel: 'b2b',
      paymentTerm: 'immediate',
      paymentSource: 'kebu',
      buyerBusinessId: buyerBiz.id,
    },
  });
  assert.equal(kebuOrderRes.statusCode, 201, JSON.stringify(kebuOrderRes.body));

  const buyerWallet = await prisma.businessWallet.findUnique({ where: { businessId: buyerBiz.id } });
  const supplierWallet = await prisma.businessWallet.findUnique({ where: { businessId: brand.id } });
  assert.equal(buyerWallet.balance, 50_000 - 4000);
  assert.equal(supplierWallet.balance, 4000);

  assert.ok(kebuOrderRes.body.orderId, 'orderId in response');

  const receivablesRes = await call(supplierReceivables, {
    userId: supplier.id,
    method: 'GET',
    query: { businessId: brand.id },
  });
  assert.equal(receivablesRes.statusCode, 200);

  // Credit order → invoice → pay from KEBU
  const creditRes = await call(marketplaceOrderCreate, {
    userId: buyer.id,
    deviceId: buyerDevice,
    body: {
      businessId: brand.id,
      items: [{ productId: product.id, quantity: 1 }],
      fulfillmentType: 'pickup',
      channel: 'b2b',
      paymentTerm: 'net30',
      paymentSource: 'kebu',
      buyerBusinessId: buyerBiz.id,
    },
  });
  assert.equal(creditRes.statusCode, 201, JSON.stringify(creditRes.body));
  assert.ok(creditRes.body.invoice?.id, 'trade invoice created');

  {
    const bw = await prisma.businessWallet.findUnique({ where: { businessId: buyerBiz.id } });
    if (bw.balance < 100_000) await fundBusiness(buyerBiz.id, 100_000 - bw.balance);
  }

  const payInvRes = await call(tradeInvoicePay, {
    userId: buyer.id,
    query: { id: creditRes.body.invoice.id },
    body: { paymentSource: 'kebu', buyerBusinessId: buyerBiz.id },
  });
  assert.equal(payInvRes.statusCode, 200, JSON.stringify(payInvRes.body));
  assert.equal(payInvRes.body.status, 'paid');

  // COD order → fulfill → buyer confirm with KEBU
  const codRes = await call(marketplaceOrderCreate, {
    userId: buyer.id,
    deviceId: buyerDevice,
    body: {
      businessId: brand.id,
      items: [{ productId: product.id, quantity: 1 }],
      fulfillmentType: 'pickup',
      channel: 'b2b',
      paymentTerm: 'cod',
      paymentSource: 'kebu',
      buyerBusinessId: buyerBiz.id,
    },
  });
  assert.equal(codRes.statusCode, 201, JSON.stringify(codRes.body));
  const codOrderId = codRes.body.orderId;
  assert.ok(codOrderId);

  await updateOrderStatus(prisma, {
    orderId: codOrderId,
    ownerId: supplier.id,
    status: 'preparing',
  });
  await updateOrderStatus(prisma, {
    orderId: codOrderId,
    ownerId: supplier.id,
    status: 'ready_for_pickup',
  });

  const beforeCod = await prisma.businessWallet.findUnique({ where: { businessId: buyerBiz.id } });
  const confirmRes = await call(marketplaceOrderConfirm, {
    userId: buyer.id,
    deviceId: buyerDevice,
    query: { id: codOrderId },
  });
  assert.equal(confirmRes.statusCode, 200, JSON.stringify(confirmRes.body));
  assert.equal(confirmRes.body.paymentStatus, 'paid');

  const afterCod = await prisma.businessWallet.findUnique({ where: { businessId: buyerBiz.id } });
  assert.equal(afterCod.balance, beforeCod.balance - 4000);
});

test('api router resolves new distribution routes', async () => {
  const buyer = await createUserWithWallet({ koriBalance: 0 });
  for (const segments of [
    ['distribution', 'buyer-portal'],
    ['distribution', 'trade-summary'],
  ]) {
    const res = await dispatch('GET', segments, { userId: buyer.id, query: segments[1] === 'trade-summary' ? { businessId: 'x' } : {} });
    assert.notEqual(res.statusCode, 404, segments.join('/'));
  }
});
