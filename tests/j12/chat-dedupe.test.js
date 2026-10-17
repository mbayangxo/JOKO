/**
 * J12 (P-J12-3) — chat message de-duplication, real HTTP (NODE_ENV=production).
 * A stable client message id + a server unique index (senderId, clientMessageId):
 *   offline retry / reconnect replays the stored message; duplicate and CONCURRENT submissions store one;
 *   an id reused for a different message is refused; ids are per sender (account switch: B's same id is
 *   B's own message); a sender who lost access cannot replay; a retried message-request intro is not a
 *   "second intro"; old clients (no id) keep working.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createUserWithWallet, createVerifiedDevice, establishedSessionToken, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

async function actor() {
  const user = await createUserWithWallet({ koriBalance: 0, tier: 2 });
  const device = await createVerifiedDevice(user.id);
  return { id: user.id, handle: user.handle, device, token: await establishedSessionToken(user.id, device, ACCESS_SECRET), ip: freshIp() };
}
const call = (m, p, a, body) => api.client(m, p, { token: a.token, device: a.device, ip: a.ip, headers: { 'x-vercel-ip-country': 'SN' }, body });
const cid = () => `cm-${crypto.randomBytes(8).toString('hex')}`;
const count = (threadId) => prisma.mboloMessage.count({ where: { threadId } });

async function friendsThread() {
  const a = await actor();
  const b = await actor();
  await prisma.userFriend.createMany({ data: [{ userId: a.id, friendId: b.id }, { userId: b.id, friendId: a.id }] });
  const t = await call('POST', 'mbolo/threads', a, { memberHandles: [b.handle] });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  return { a, b, threadId: t.body.id };
}
const post = (who, threadId, body, clientMessageId, kind = 'text') => call('POST', `mbolo/threads/${threadId}/messages`, who, { body, kind, ...(clientMessageId ? { clientMessageId } : {}) });

test('offline retry / reconnect: the same client id returns the stored message, never a second one', async () => {
  const { a, threadId } = await friendsThread();
  const id = cid();
  const first = await post(a, threadId, 'On se voit à 18h ?', id);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  for (let i = 0; i < 3; i += 1) {
    const again = await post(a, threadId, 'On se voit à 18h ?', id);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
  }
  assert.equal(await count(threadId), 1);
});

test('concurrent duplicate submissions store exactly one message', async () => {
  const { a, threadId } = await friendsThread();
  const id = cid();
  const rs = await Promise.all(Array.from({ length: 10 }, () => post(a, threadId, 'Inchallah', id)));
  assert.ok(rs.every((r) => [200, 201].includes(r.status)), JSON.stringify(rs.map((r) => r.status)));
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1, 'every caller gets the same message');
  assert.equal(await count(threadId), 1);
});

test('an id reused for a different message (or another thread) is refused, nothing stored', async () => {
  const { a, b, threadId } = await friendsThread();
  const id = cid();
  assert.equal((await post(a, threadId, 'Bonjour', id)).status, 201);
  const changed = await post(a, threadId, 'Bonsoir', id);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'client_message_id_reuse');
  const c = await actor();
  await prisma.userFriend.createMany({ data: [{ userId: a.id, friendId: c.id }, { userId: c.id, friendId: a.id }] });
  const t2 = (await call('POST', 'mbolo/threads', a, { memberHandles: [c.handle] })).body.id;
  assert.equal((await post(a, t2, 'Bonjour', id)).status, 409, 'same id in another thread');
  assert.equal(await count(threadId), 1);
  assert.equal(await count(t2), 0);
  void b;
});

test('account switch: ids are per sender — B using the same id posts B’s own message, never sees A’s', async () => {
  const { a, b, threadId } = await friendsThread();
  const id = cid();
  const ra = await post(a, threadId, 'De la part de A', id);
  const rb = await post(b, threadId, 'De la part de B', id);
  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201, 'B is not handed A’s message');
  assert.notEqual(ra.body.id, rb.body.id);
  assert.equal(rb.body.senderId, b.id);
  assert.equal(await count(threadId), 2);
});

test('offline state never overrides permissions: a removed member cannot replay a stored message id', async () => {
  const { a, b, threadId } = await friendsThread();
  const id = cid();
  assert.equal((await post(b, threadId, 'Message', id)).status, 201);
  await prisma.mboloMember.update({ where: { threadId_userId: { threadId, userId: b.id } }, data: { status: 'removed' } });
  const replay = await post(b, threadId, 'Message', id);
  assert.ok([403, 404].includes(replay.status), `removed member replay: ${replay.status}`);
  void a;
});

test('a retried message-request intro is the same intro (not refused as a second one); old clients still work', async () => {
  const s = await actor();
  const v = await actor();
  const t = await call('POST', 'mbolo/threads', s, { memberHandles: [v.handle] });
  assert.equal(t.status, 201);
  const id = cid();
  const first = await post(s, t.body.id, 'Salut, on s’est vus au marché ?', id);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const retry = await post(s, t.body.id, 'Salut, on s’est vus au marché ?', id);
  assert.equal(retry.status, 200, 'the lost-response retry of the intro returns the intro');
  const second = await post(s, t.body.id, 'Encore moi', cid());
  assert.notEqual(second.status, 201, 'a genuinely second message before acceptance is still refused');
  const { a, threadId } = await friendsThread();
  assert.equal((await post(a, threadId, 'sans id')).status, 201);
  assert.equal((await post(a, threadId, 'sans id')).status, 201, 'old clients (no id) are unchanged');
});
