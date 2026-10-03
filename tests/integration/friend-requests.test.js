import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  friendsHandler,
  friendRequestsList,
  friendRequestRespond,
  mboloThreadMessages,
} from '../../lib/handlers.js';
import { createUserWithWallet, mockReq, mockRes, prisma } from '../helpers/db.js';

after(() => prisma.$disconnect());

async function call(handler, { userId, body, query, method = 'POST' } = {}) {
  const req = mockReq({ userId, body, query, method });
  const res = mockRes();
  await handler(req, res);
  return res;
}

test('friend requests: send → accept flow replaces instant add', async () => {
  const awa = await createUserWithWallet({ name: 'Awa Diop' });
  const ibou = await createUserWithWallet({ name: 'Ibou Fall' });

  // Sending creates a REQUEST, not a friendship.
  const sent = await call(friendsHandler, {
    userId: awa.id,
    body: { handle: ibou.handle, message: 'On s’est vus au marché !' },
  });
  assert.equal(sent.statusCode, 201);
  assert.equal(sent.body.requested, true);
  assert.equal(await prisma.userFriend.count({ where: { userId: awa.id, friendId: ibou.id } }), 0);

  // Ibou sees it incoming; Awa sees it outgoing.
  const ibouInbox = await call(friendRequestsList, { userId: ibou.id, method: 'GET' });
  assert.equal(ibouInbox.body.incoming.length, 1);
  assert.equal(ibouInbox.body.incoming[0].message, 'On s’est vus au marché !');
  const awaOut = await call(friendRequestsList, { userId: awa.id, method: 'GET' });
  assert.ok(awaOut.body.outgoing.some((r) => r.user.id === ibou.id));

  // A third user cannot answer someone else's request.
  const stranger = await createUserWithWallet({ name: 'Autre' });
  const forged = await call(friendRequestRespond, {
    userId: stranger.id,
    query: { id: ibouInbox.body.incoming[0].id },
    body: { accept: true },
  });
  assert.equal(forged.statusCode, 404);

  // Ibou accepts → both directions of friendship + a direct Mboolo thread.
  const accepted = await call(friendRequestRespond, {
    userId: ibou.id,
    query: { id: ibouInbox.body.incoming[0].id },
    body: { accept: true },
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.accepted, true);
  assert.ok(accepted.body.mboloThreadId);
  assert.equal(await prisma.userFriend.count({ where: { userId: awa.id, friendId: ibou.id } }), 1);
  assert.equal(await prisma.userFriend.count({ where: { userId: ibou.id, friendId: awa.id } }), 1);
});

test('friend requests: decline sticks (no silent re-open spam), mutual request auto-accepts', async () => {
  const a = await createUserWithWallet({ name: 'Fatou' });
  const b = await createUserWithWallet({ name: 'Moussa' });

  await call(friendsHandler, { userId: a.id, body: { handle: b.handle } });
  const inbox = await call(friendRequestsList, { userId: b.id, method: 'GET' });
  const declined = await call(friendRequestRespond, {
    userId: b.id,
    query: { id: inbox.body.incoming[0].id },
    body: { accept: false },
  });
  assert.equal(declined.body.declined, true);
  assert.equal(await prisma.userFriend.count({ where: { userId: a.id, friendId: b.id } }), 0);

  // Re-sending after a decline does NOT re-open it (no repeated requests for
  // 30 days). The sender sees the same answer as a normal send.
  const notesBefore = await prisma.notification.count({ where: { userId: b.id } });
  const resent = await call(friendsHandler, { userId: a.id, body: { handle: b.handle } });
  assert.equal(resent.body.requested, true);
  assert.equal(resent.body.silent, undefined, 'silent flag never leaves the server');
  const row = await prisma.friendRequest.findUnique({ where: { fromId_toId: { fromId: a.id, toId: b.id } } });
  assert.equal(row.status, 'declined');
  assert.equal(await prisma.notification.count({ where: { userId: b.id } }), notesBefore, 'B is not pinged again');

  // B changes their mind and asks A; A "adding" B back counts as accepting.
  await call(friendsHandler, { userId: b.id, body: { handle: a.handle } });
  const mutual = await call(friendsHandler, { userId: a.id, body: { handle: b.handle } });
  assert.equal(mutual.body.autoAccepted, true);
  assert.equal(await prisma.userFriend.count({ where: { userId: b.id, friendId: a.id } }), 1);
});

test('friend requests: accepting is KYC-gated (name + verified phone)', async () => {
  const sender = await createUserWithWallet({ name: 'Vérifiée' });
  const bare = await createUserWithWallet();
  // Strip the gate requirements: no name.
  await prisma.user.update({ where: { id: bare.id }, data: { name: null } });

  await call(friendsHandler, { userId: sender.id, body: { handle: bare.handle } });
  const inbox = await call(friendRequestsList, { userId: bare.id, method: 'GET' });

  const blocked = await call(friendRequestRespond, {
    userId: bare.id,
    query: { id: inbox.body.incoming[0].id },
    body: { accept: true },
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.code, 'verification_required');
  assert.equal(await prisma.userFriend.count({ where: { userId: bare.id } }), 0);

  // Completing the profile unlocks accepting.
  await prisma.user.update({ where: { id: bare.id }, data: { name: 'Enfin Nommé' } });
  const ok = await call(friendRequestRespond, {
    userId: bare.id,
    query: { id: inbox.body.incoming[0].id },
    body: { accept: true },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.accepted, true);

  // CNI hook: flipping the env flag gates un-CNI'd users too.
  process.env.FRIEND_GATE_REQUIRES_CNI = 'true';
  try {
    const tier1 = await createUserWithWallet({ tier: 1, name: 'Tier Un' });
    await call(friendsHandler, { userId: sender.id, body: { handle: tier1.handle } });
    const inbox2 = await call(friendRequestsList, { userId: tier1.id, method: 'GET' });
    const cniBlocked = await call(friendRequestRespond, {
      userId: tier1.id,
      query: { id: inbox2.body.incoming[0].id },
      body: { accept: true },
    });
    assert.equal(cniBlocked.statusCode, 403);
    assert.equal(cniBlocked.body.code, 'verification_required');
  } finally {
    delete process.env.FRIEND_GATE_REQUIRES_CNI;
  }
});

test('mboolo: first reply in a direct chat is gated, replies after stay open', async () => {
  const a = await createUserWithWallet({ name: 'Awa' });
  const b = await createUserWithWallet({ name: 'Binta' });

  await call(friendsHandler, { userId: a.id, body: { handle: b.handle } });
  const inbox = await call(friendRequestsList, { userId: b.id, method: 'GET' });
  const accepted = await call(friendRequestRespond, {
    userId: b.id,
    query: { id: inbox.body.incoming[0].id },
    body: { accept: true },
  });
  const threadId = accepted.body.mboloThreadId;

  // A (verified) opens the conversation.
  const first = await call(mboloThreadMessages, {
    userId: a.id,
    query: { id: threadId },
    body: { body: 'Salut !', kind: 'text' },
  });
  assert.equal(first.statusCode, 201);

  // B loses their name → first reply is blocked by the gate.
  await prisma.user.update({ where: { id: b.id }, data: { name: null } });
  const blocked = await call(mboloThreadMessages, {
    userId: b.id,
    query: { id: threadId },
    body: { body: 'Coucou', kind: 'text' },
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.code, 'verification_required');

  // Profile completed → reply goes through; later messages skip the gate.
  await prisma.user.update({ where: { id: b.id }, data: { name: 'Binta Ndiaye' } });
  const reply = await call(mboloThreadMessages, {
    userId: b.id,
    query: { id: threadId },
    body: { body: 'Coucou', kind: 'text' },
  });
  assert.equal(reply.statusCode, 201);
  const again = await call(mboloThreadMessages, {
    userId: b.id,
    query: { id: threadId },
    body: { body: 'Ça va ?', kind: 'text' },
  });
  assert.equal(again.statusCode, 201);
});
