import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchApi } from '../../lib/api-router.js';
import {
  hubParcelsCreate,
  hubParcelArrive,
  hubParcelConfirmPickup,
  hubParcelLastMile,
} from '../../lib/hub-parcel-handlers.js';
import { deliveriesNearby } from '../../lib/handlers.js';
import { createUserWithWallet, mockReq, mockRes, prisma } from '../helpers/db.js';
import { signAccessToken } from '../../api/_lib/auth.js';
import { listDeliveryHubs } from '../../lib/hub-service.js';

after(() => prisma.$disconnect());

async function call(handler, { userId, body, query, method = 'POST' } = {}) {
  const req = mockReq({ userId, body, query, method });
  const res = mockRes();
  await handler(req, res);
  return res;
}

test('hub parcel: register → arrive → pickup', async () => {
  const owner = await createUserWithWallet({ koriBalance: 1000 });
  const staff = await createUserWithWallet({ koriBalance: 0 });
  await prisma.driverProfile.create({ data: { userId: staff.id, status: 'available' } });

  const hubs = await listDeliveryHubs(prisma, { lat: 14.69, lng: -17.44 });
  assert.ok(hubs.length >= 6);

  const createRes = await call(hubParcelsCreate, {
    userId: owner.id,
    body: {
      hubId: hubs[0].id,
      originCountry: 'US',
      originLabel: 'Amazon USA',
      description: 'Sneakers taille 42',
      externalRef: 'DHL-123',
      fulfillmentPlan: 'pickup',
    },
  });
  assert.equal(createRes.statusCode, 201);
  assert.ok(createRes.body.shippingAddress?.line2?.includes(createRes.body.reference));

  const arriveRes = await call(hubParcelArrive, {
    userId: staff.id,
    query: { id: createRes.body.id },
  });
  assert.equal(arriveRes.statusCode, 200);
  assert.equal(arriveRes.body.status, 'ready_for_pickup');
  assert.ok(arriveRes.body.pickupCode);

  const notif = await prisma.notification.findFirst({
    where: { userId: owner.id, kind: 'hub_parcel' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(notif);

  const parcel = await prisma.hubParcel.findUnique({ where: { id: createRes.body.id } });
  const pickupRes = await call(hubParcelConfirmPickup, {
    userId: owner.id,
    body: { pickupCode: parcel.pickupCode },
    query: { id: createRes.body.id },
  });
  assert.equal(pickupRes.statusCode, 200);
  assert.equal(pickupRes.body.status, 'picked_up');
});

test('hub parcel: last mile creates rider job', async () => {
  const owner = await createUserWithWallet({ koriBalance: 1000 });
  const staff = await createUserWithWallet({ koriBalance: 0 });
  const rider = await createUserWithWallet({ koriBalance: 500 });
  await prisma.accountRole.create({ data: { userId: rider.id, role: 'driver', status: 'active' } }); // open jobs are courier-only
  await prisma.driverProfile.create({ data: { userId: staff.id } });

  const hubs = await listDeliveryHubs(prisma);
  const createRes = await call(hubParcelsCreate, {
    userId: owner.id,
    body: {
      hubId: hubs[1].id,
      originCountry: 'NG',
      description: 'Tissu wax 6 yards',
      fulfillmentPlan: 'pickup',
    },
  });

  await call(hubParcelArrive, { userId: staff.id, query: { id: createRes.body.id } });

  const lastMileRes = await call(hubParcelLastMile, {
    userId: owner.id,
    query: { id: createRes.body.id },
    body: { area: 'Médina', address: 'Rue 22 portail vert', lat: 14.69, lng: -17.44 },
  });
  assert.equal(lastMileRes.statusCode, 201);
  assert.equal(lastMileRes.body.status, 'out_for_delivery');
  assert.ok(lastMileRes.body.lastMile?.deliveryId);

  const jobs = await call(deliveriesNearby, {
    userId: rider.id,
    method: 'GET',
    query: { lat: '14.69', lng: '-17.44' },
  });
  assert.ok(jobs.body.some((j) => j.id === lastMileRes.body.lastMile.deliveryId));
});

test('api router resolves hubs/parcels/:id', async () => {
  const owner = await createUserWithWallet();
  const hubs = await listDeliveryHubs(prisma);
  const createRes = await call(hubParcelsCreate, {
    userId: owner.id,
    body: {
      hubId: hubs[0].id,
      originCountry: 'CI',
      description: 'Test route',
      fulfillmentPlan: 'pickup',
    },
  });

  const res = mockRes();
  await dispatchApi(
    {
      method: 'GET',
      headers: { authorization: `Bearer ${signAccessToken(owner.id)}` },
      query: {},
      body: {},
    },
    res,
    ['hubs', 'parcels', createRes.body.id],
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, createRes.body.id);
});
