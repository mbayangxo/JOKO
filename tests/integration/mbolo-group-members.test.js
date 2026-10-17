import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { mboloThreads, mboloThreadMembers } from '../../lib/handlers.js';
import { createUserWithWallet, mockReq, mockRes, prisma } from '../helpers/db.js';

after(() => prisma.$disconnect());

async function call(handler, { userId, body, query, method = 'POST' } = {}) {
  const req = mockReq({ userId, body, query, method });
  const res = mockRes();
  await handler(req, res);
  return res;
}

test('mbolo group members: a member can add someone new, thread flips to group once it has 3+ members', async () => {
  const creator = await createUserWithWallet({ name: 'Creator' });
  const existing = await createUserWithWallet({ name: 'Existing' });
  const newcomer = await createUserWithWallet({ name: 'Newcomer' });

  const created = await call(mboloThreads, {
    userId: creator.id,
    body: { name: 'Copains', memberHandles: [existing.handle] },
  });
  assert.equal(created.body.type, 'direct');

  const res = await call(mboloThreadMembers, {
    userId: creator.id,
    query: { id: created.body.id },
    body: { handles: [newcomer.handle] },
  });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.type, 'group');
  assert.equal(res.body.members.length, 3);

  // The newcomer is not the adder's friend: they get an invitation they must
  // accept (message-request model), not silent membership.
  const notif = await prisma.notification.findFirst({ where: { userId: newcomer.id, title: { contains: 'Invitation' } } });
  assert.ok(notif, 'newcomer is notified');
  const row = await prisma.mboloMember.findUnique({ where: { threadId_userId: { threadId: created.body.id, userId: newcomer.id } } });
  assert.equal(row.status, 'requested');
});

test('mbolo group members: adding an already-existing member again is a no-op, not a duplicate', async () => {
  const creator = await createUserWithWallet({ name: 'Creator2' });
  const existing = await createUserWithWallet({ name: 'Existing2' });

  const created = await call(mboloThreads, {
    userId: creator.id,
    body: { memberHandles: [existing.handle] },
  });

  const res = await call(mboloThreadMembers, {
    userId: creator.id,
    query: { id: created.body.id },
    body: { handles: [existing.handle] },
  });

  assert.equal(res.statusCode, 201);
  const members = await prisma.mboloMember.findMany({ where: { threadId: created.body.id, userId: existing.id } });
  assert.equal(members.length, 1);
});

test('mbolo group members: a non-member cannot add people to a thread', async () => {
  const creator = await createUserWithWallet({ name: 'Creator3' });
  const outsider = await createUserWithWallet({ name: 'Outsider3' });
  const someone = await createUserWithWallet({ name: 'Someone3' });

  const created = await call(mboloThreads, { userId: creator.id, body: { memberHandles: [] } });

  const res = await call(mboloThreadMembers, {
    userId: outsider.id,
    query: { id: created.body.id },
    body: { handles: [someone.handle] },
  });

  assert.equal(res.statusCode, 403);
});
