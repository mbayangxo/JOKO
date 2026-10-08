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

/** J8.0: hub actions need an operator of the ACTIVE pickup point running that hub. */
async function hubOperator(hubId) {
  const staff = await createUserWithWallet({ koriBalance: 0 });
  const owner = await createUserWithWallet({ koriBalance: 0 });
  const biz = await prisma.business.create({ data: { ownerId: owner.id, name: `Point ${Math.random().toString(36).slice(2, 7)}`, type: 'merchant' } });
  await prisma.businessMember.create({ data: { businessId: biz.id, userId: staff.id, role: 'fulfillment', status: 'active', acceptedAt: new Date() } });
  const existing = await prisma.pickupPoint.findUnique({ where: { hubId } });
  if (existing) await prisma.businessMember.create({ data: { businessId: existing.operatorBusinessId, userId: staff.id, role: 'fulfillment', status: 'active', acceptedAt: new Date() } });
  else await prisma.pickupPoint.create({ data: { operatorBusinessId: biz.id, hubId, name: 'Point K21 test', status: 'active', appliedBy: owner.id } });
  return staff;
}

async function call(handler, { userId, body, query, method = 'POST' } = {}) {
  const req = mockReq({ userId, body, query, method });
  const res = mockRes();
  await handler(req, res);
  return res;
}

test('hub parcel: register → arrive (pickup-point operator) → release by staff with the owner’s code', async () => {
  const owner = await createUserWithWallet({ koriBalance: 1000 });
  const courier = await createUserWithWallet({ koriBalance: 0 });
  await prisma.driverProfile.create({ data: { userId: courier.id, status: 'available' } });

  const hubs = await listDeliveryHubs(prisma, { lat: 14.69, lng: -17.44 });
  assert.ok(hubs.length >= 6);
  const staff = await hubOperator(hubs[0].id);

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

  // A courier (or any worker profile) is not a hub operator.
  const courierArrive = await call(hubParcelArrive, { userId: courier.id, query: { id: createRes.body.id } });
  assert.equal(courierArrive.statusCode, 403);
  const arriveRes = await call(hubParcelArrive, {
    userId: staff.id,
    query: { id: createRes.body.id },
  });
  assert.equal(arriveRes.statusCode, 200);
  assert.equal(arriveRes.body.status, 'ready_for_pickup');
  assert.equal(arriveRes.body.pickupCode, null, 'staff never see the owner’s collection code');

  const notif = await prisma.notification.findFirst({
    where: { userId: owner.id, kind: 'hub_parcel' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(notif);

  const parcel = await prisma.hubParcel.findUnique({ where: { id: createRes.body.id } });
  // The owner can no longer "confirm" their own collection.
  const selfConfirm = await call(hubParcelConfirmPickup, { userId: owner.id, body: { pickupCode: parcel.pickupCode }, query: { id: createRes.body.id } });
  assert.equal(selfConfirm.statusCode, 403);
  const wrong = await call(hubParcelConfirmPickup, { userId: staff.id, body: { pickupCode: '000000' === parcel.pickupCode ? '111111' : '000000' }, query: { id: createRes.body.id } });
  assert.equal(wrong.statusCode, 400);
  const pickupRes = await call(hubParcelConfirmPickup, {
    userId: staff.id,
    body: { pickupCode: parcel.pickupCode },
    query: { id: createRes.body.id },
  });
  assert.equal(pickupRes.statusCode, 200);
  assert.equal(pickupRes.body.status, 'picked_up');
  const again = await call(hubParcelConfirmPickup, { userId: staff.id, body: { pickupCode: parcel.pickupCode }, query: { id: createRes.body.id } });
  assert.equal(again.statusCode, 400, 'released once');
});

test('hub parcel: last mile creates rider job', async () => {
  const owner = await createUserWithWallet({ koriBalance: 1000 });
  const staff = await createUserWithWallet({ koriBalance: 0 });
  const rider = await createUserWithWallet({ koriBalance: 500 });
  await prisma.accountRole.create({ data: { userId: rider.id, role: 'driver', status: 'active' } }); // open jobs are courier-only

  const hubs = await listDeliveryHubs(prisma);
  const staffOp = await hubOperator(hubs[1].id);
  const createRes = await call(hubParcelsCreate, {
    userId: owner.id,
    body: {
      hubId: hubs[1].id,
      originCountry: 'NG',
      description: 'Tissu wax 6 yards',
      fulfillmentPlan: 'pickup',
    },
  });

  await call(hubParcelArrive, { userId: staffOp.id, query: { id: createRes.body.id } });

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
