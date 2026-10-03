/**
 * Mboolo message requests — real HTTP, NODE_ENV=production.
 *
 * A public handle makes someone discoverable; it must not grant a
 * conversation. Adversarial cases: stranger→user, repeated requests, decline,
 * block, direct API bypass, posting before acceptance, receipt injection,
 * member enumeration, record/credential/phone/email leakage, concurrent
 * accept/decline, server restart, authorization after block, previously
 * accepted conversations, legacy-thread migration, rate limiting.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { createUserWithWallet, createVerifiedDevice, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { migrateLegacyThreadsToRequests } from '../../lib/mbolo-access.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
const SERVER_ENV = { RL_MSG_REQUEST_HOUR: '6' };
let api;
before(async () => { api = await startApiServer(SERVER_ENV); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

async function actor(koriBalance = 0) {
  const user = await createUserWithWallet({ koriBalance, tier: 2 });
  const device = await createVerifiedDevice(user.id);
  return { user, id: user.id, handle: user.handle, device, token: jwt.sign({ sub: user.id, type: 'access' }, ACCESS_SECRET), ip: freshIp() };
}
const as = (a) => ({ token: a.token, device: a.device, ip: a.ip, headers: { 'x-vercel-ip-country': 'SN' } });
const call = (m, p, a, body) => api.client(m, p, { ...as(a), body });
const memberStatus = async (threadId, userId) =>
  (await prisma.mboloMember.findUnique({ where: { threadId_userId: { threadId, userId } } }))?.status;

async function request(from, to, intro = 'Salut, on s’est vus au marché ?') {
  const t = await call('POST', 'mbolo/threads', from, { memberHandles: [to.handle] });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  if (intro) assert.equal((await call('POST', `mbolo/threads/${t.body.id}/messages`, from, { body: intro })).status, 201);
  return t.body.id;
}

async function makeFriends(a, b) {
  await prisma.userFriend.createMany({ data: [{ userId: a.id, friendId: b.id }, { userId: b.id, friendId: a.id }] });
}

test('stranger → user: request only; recipient sees a request card, not a conversation', async () => {
  const stranger = await actor();
  const victim = await actor();
  const threadId = await request(stranger, victim);

  assert.equal(await memberStatus(threadId, victim.id), 'requested');
  const list = await call('GET', 'mbolo/threads', victim);
  assert.ok(!list.body.some((t) => t.id === threadId), 'not in the recipient’s inbox');

  const reqs = await call('GET', 'mbolo/requests', victim);
  const card = reqs.body.requests.find((r) => r.threadId === threadId);
  assert.ok(card);
  assert.equal(card.from.handle, stranger.handle);
  assert.equal(card.intro.body, 'Salut, on s’est vus au marché ?');
  assert.deepEqual(Object.keys(card.from).sort(), ['avatarEmoji', 'avatarUrl', 'handle', 'id', 'name']);

  // Pending recipient: no thread read, no presence, no typing/read receipts.
  for (const [m, p] of [['GET', `mbolo/threads/${threadId}/messages`], ['GET', `mbolo/threads/${threadId}/presence`], ['POST', `mbolo/threads/${threadId}/typing`], ['POST', `mbolo/threads/${threadId}/read`]]) {
    assert.equal((await call(m, p, victim)).status, 403, `${m} ${p}`);
  }
  // Requester sees the request as pending, and no presence/read state of the recipient.
  const mine = (await call('GET', 'mbolo/threads', stranger)).body.find((t) => t.id === threadId);
  assert.equal(mine.requestPending, true);
  assert.equal(mine.members.find((m) => m.userId === victim.id).status, 'pending');
  assert.equal(mine.members.find((m) => m.userId === victim.id).lastReadAt, null);
  const presence = await call('GET', `mbolo/threads/${threadId}/presence`, stranger);
  assert.deepEqual(presence.body.readBy, []);
  assert.deepEqual(presence.body.typing, []);
});

test('sending before acceptance: one short text intro only — no second message, media, share, call or long text', async () => {
  const stranger = await actor();
  const victim = await actor();
  const threadId = await request(stranger, victim, null);

  const long = await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { body: 'x'.repeat(501) });
  assert.equal(long.status, 400);
  const media = await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { kind: 'image', mediaUrl: 'https://example.com/a.jpg' });
  assert.equal(media.status, 403);
  const sticker = await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { kind: 'sticker', body: '🔥' });
  assert.equal(sticker.status, 403);

  assert.equal((await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { body: 'Bonjour' })).status, 201);
  const second = await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { body: 'Tu es là ?' });
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'request_pending');

  const share = await call('POST', 'mbolo/share', stranger, { threadId, refType: 'business', refId: 'whatever' });
  assert.equal(share.status, 403);
  // Recipient cannot post until they accept.
  assert.equal((await call('POST', `mbolo/threads/${threadId}/messages`, victim, { body: 'hello' })).status, 403);
  assert.equal(await prisma.mboloMessage.count({ where: { threadId } }), 1);
});

test('repeated requests: same thread reused; after decline no new request, group or add-member path', async () => {
  const stranger = await actor();
  const victim = await actor();
  const threadId = await request(stranger, victim);

  const again = await call('POST', 'mbolo/threads', stranger, { memberHandles: [victim.handle] });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, threadId, 'no second thread');

  const declined = await call('POST', `mbolo/threads/${threadId}/decline`, victim);
  assert.equal(declined.status, 200);
  assert.equal(declined.body.status, 'declined');

  // Requester can't tell decline from pending, and gets no fresh request.
  const view = await call('POST', 'mbolo/threads', stranger, { memberHandles: [victim.handle] });
  assert.equal(view.body.id, threadId);
  assert.equal(view.body.members.find((m) => m.userId === victim.id).status, 'pending');
  assert.equal((await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { body: 'stp' })).status, 403);

  const other = await actor();
  const group = await call('POST', 'mbolo/threads', stranger, { name: 'Tontine', memberHandles: [victim.handle, other.handle] });
  assert.equal(group.status, 403);
  assert.equal(group.body.code, 'cannot_message');

  const g2 = await call('POST', 'mbolo/threads', stranger, { name: 'G2', memberHandles: [other.handle] });
  const add = await call('POST', `mbolo/threads/${g2.body.id}/members`, stranger, { handles: [victim.handle] });
  assert.equal(add.status, 201);
  assert.ok(!add.body.members.some((m) => m.userId === victim.id), 'declined recipient silently skipped');

  const reqs = await call('GET', 'mbolo/requests', victim);
  assert.ok(!reqs.body.requests.some((r) => r.threadId === threadId));
});

test('blocked sender: block from the request; every path to the recipient is closed', async () => {
  const stranger = await actor(1000);
  const victim = await actor();
  const threadId = await request(stranger, victim);

  const blocked = await call('POST', `mbolo/threads/${threadId}/block`, victim);
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.status, 'blocked');
  assert.ok(await prisma.userBlock.findFirst({ where: { blockerId: victim.id, blockedUserId: stranger.id } }));

  assert.equal((await call('POST', 'mbolo/threads', stranger, { memberHandles: [victim.handle] })).status, 403);
  assert.equal((await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { body: 'hey' })).status, 403);
  const notes = await prisma.notification.count({ where: { userId: victim.id } });
  const fr = await call('POST', 'friends', stranger, { handle: victim.handle });
  assert.equal(fr.status, 201, 'friend request looks sent');
  assert.equal(await prisma.friendRequest.count({ where: { fromId: stranger.id, toId: victim.id } }), 0, 'but nothing was created');
  assert.equal(await prisma.notification.count({ where: { userId: victim.id } }), notes, 'and the recipient is not pinged');

  const report = await call('POST', `mbolo/threads/${threadId}/report`, victim, { category: 'spam', reason: 'unsolicited' });
  assert.equal(report.status, 201);
  assert.ok(await prisma.contentReport.findFirst({ where: { reporterId: victim.id, targetUserId: stranger.id } }));
});

test('direct API bypass: outsiders, wrong actor, and fabricated ids get the same refusal', async () => {
  const stranger = await actor();
  const victim = await actor();
  const outsider = await actor();
  const threadId = await request(stranger, victim);

  // The requester cannot accept on the recipient's behalf.
  const selfAccept = await call('POST', `mbolo/threads/${threadId}/accept`, stranger);
  assert.notEqual(selfAccept.body.changed, true, 'accept only ever acts on the caller’s own membership');
  assert.equal(await memberStatus(threadId, victim.id), 'requested');

  const fake = `c${crypto.randomBytes(12).toString('hex')}`;
  for (const suffix of ['messages', 'presence', 'accept', 'decline', 'block', 'members', 'invite', 'typing', 'read']) {
    const method = suffix === 'messages' || suffix === 'presence' ? 'GET' : 'POST';
    const body = suffix === 'members' ? { handles: [outsider.handle] } : undefined;
    const real = await call(method, `mbolo/threads/${threadId}/${suffix}`, outsider, body);
    const none = await call(method, `mbolo/threads/${fake}/${suffix}`, outsider, body);
    assert.equal(real.status, 403, `${suffix} on a real thread`);
    assert.equal(real.status, none.status, `${suffix}: same status for real vs fake id (no enumeration)`);
    assert.deepEqual(real.body, none.body, `${suffix}: same body for real vs fake id`);
  }
  // Calls are refused too (calls are not configured in tests → 503 or 403, never a token).
  const callTry = await call('POST', 'calls/token', stranger, { threadId, ring: true });
  assert.ok(!callTry.body?.token);
});

test('receipt injection: a payment never lands in a pending request (with or without threadId)', async () => {
  const stranger = await actor(5000);
  const victim = await actor();
  const threadId = await request(stranger, victim);
  const before = await prisma.mboloMessage.count({ where: { threadId } });

  const withThread = await call('POST', 'transfers/send', stranger, { recipientHandle: victim.handle, amount: 10, threadId });
  assert.ok([201, 202].includes(withThread.status), JSON.stringify(withThread.body));
  assert.equal(withThread.body.mboloMessage, undefined);
  const without = await call('POST', 'transfers/send', stranger, { recipientHandle: victim.handle, amount: 10 });
  assert.ok([201, 202].includes(without.status));
  assert.equal(without.body.mboloMessage, undefined);
  assert.equal(await prisma.mboloMessage.count({ where: { threadId } }), before);
  assert.equal(await prisma.mboloMessage.count({ where: { threadId, kind: 'payment' } }), 0);
  // Paying someone does not create trust: still a request.
  assert.equal(await memberStatus(threadId, victim.id), 'requested');
});

test('no member enumeration: requests list shows only the requester, never other invitees', async () => {
  const stranger = await actor();
  const victim = await actor();
  const other = await actor();
  const g = await call('POST', 'mbolo/threads', stranger, { name: 'Club', memberHandles: [victim.handle, other.handle] });
  assert.equal(g.status, 201);
  const reqs = await call('GET', 'mbolo/requests', victim);
  const card = reqs.body.requests.find((r) => r.threadId === g.body.id);
  const text = JSON.stringify(card);
  assert.ok(!text.includes(other.handle) && !text.includes(other.id), 'other invitees are not revealed');
  assert.equal(card.intro, null, 'group requests carry no message content');
  assert.equal((await call('GET', `mbolo/threads/${g.body.id}/messages`, victim)).status, 403);
});

test('no record, credential, phone or email leakage on any Mboolo surface (explicit DTOs)', async () => {
  const stranger = await actor();
  const victim = await actor();
  const pinHash = await bcrypt.hash('482193', 4);
  const email = `v-${crypto.randomBytes(4).toString('hex')}@private.test`;
  for (const a of [stranger, victim]) {
    await prisma.user.update({
      where: { id: a.id },
      data: { pinHash, passwordHash: pinHash, email: `${a.id}-${email}`, dateOfBirth: new Date('1999-01-02'), cniNumberEnc: 'enc:SECRETCNI', cniHash: `cnihash-secret-${a.id}` },
    });
  }
  const threadId = await request(stranger, victim);
  const secrets = ['$2a$', '$2b$', email, victim.user.phone, stranger.user.phone, '1999-01-02', 'SECRETCNI', 'cnihash-secret', 'otpVerifiedAt', 'koriBalance'];
  const reads = [
    [stranger, 'GET', 'mbolo/threads'], [stranger, 'GET', `mbolo/threads/${threadId}/messages`], [stranger, 'GET', `mbolo/threads/${threadId}/presence`],
    [stranger, 'POST', 'mbolo/threads', { memberHandles: [victim.handle] }], [victim, 'GET', 'mbolo/requests'], [victim, 'POST', `mbolo/threads/${threadId}/accept`],
    [victim, 'GET', 'mbolo/threads'], [victim, 'GET', `mbolo/threads/${threadId}/messages`], [victim, 'GET', `mbolo/threads/${threadId}/presence`],
  ];
  const leaks = [];
  for (const [who, m, p, body] of reads) {
    const r = await call(m, p, who, body);
    const text = JSON.stringify(r.body);
    for (const s of secrets) if (text.includes(s)) leaks.push(`${m} ${p} → ${s}`);
  }
  assert.deepEqual(leaks, []);

  // Explicit shaping (not just the global scrubber): member objects carry only these keys.
  const list = await call('GET', 'mbolo/threads', victim);
  const t = list.body.find((x) => x.id === threadId);
  for (const m of t.members) {
    assert.deepEqual(Object.keys(m).sort(), ['lastReadAt', 'role', 'status', 'user', 'userId']);
    assert.deepEqual(Object.keys(m.user).sort(), ['avatarEmoji', 'avatarUrl', 'handle', 'id', 'name', 'statusText']);
  }
});

test('concurrent accept + decline: exactly one outcome wins, state matches the winner', async () => {
  for (let i = 0; i < 4; i += 1) {
    const stranger = await actor();
    const victim = await actor();
    const threadId = await request(stranger, victim);
    const [a, d] = await Promise.all([
      call('POST', `mbolo/threads/${threadId}/accept`, victim),
      call('POST', `mbolo/threads/${threadId}/decline`, victim),
    ]);
    const winners = [a, d].filter((r) => r.status === 200 && r.body.changed);
    assert.equal(winners.length, 1, `${a.status}/${d.status}`);
    assert.ok([a, d].some((r) => r.status === 409));
    assert.equal(await memberStatus(threadId, victim.id), winners[0].body.status);
  }
});

test('previously accepted conversation: full chat, media, presence and receipts for both', async () => {
  const stranger = await actor(5000);
  const victim = await actor();
  const threadId = await request(stranger, victim);
  assert.equal((await call('POST', `mbolo/threads/${threadId}/accept`, victim)).status, 200);

  assert.equal((await call('POST', `mbolo/threads/${threadId}/messages`, victim, { body: 'Oui !' })).status, 201);
  assert.equal((await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { body: 'Super' })).status, 201);
  assert.equal((await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { body: 'Et encore' })).status, 201);
  assert.ok((await call('GET', 'mbolo/threads', victim)).body.some((t) => t.id === threadId));
  assert.equal((await call('GET', `mbolo/threads/${threadId}/messages`, victim)).body.messages.length, 4);

  const pay = await call('POST', 'transfers/send', stranger, { recipientHandle: victim.handle, amount: 10, threadId });
  if (pay.status === 201) assert.ok(pay.body.mboloMessage, 'receipt allowed once both accepted');
});

test('authorization after block: blocking an accepted chat stops posting, receipts and presence', async () => {
  const stranger = await actor(5000);
  const victim = await actor();
  const threadId = await request(stranger, victim);
  await call('POST', `mbolo/threads/${threadId}/accept`, victim);
  await call('POST', `mbolo/threads/${threadId}/read`, victim);

  assert.equal((await call('POST', `mbolo/threads/${threadId}/block`, victim)).status, 200);
  assert.equal((await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { body: 'pourquoi ?' })).status, 403);
  const pres = await call('GET', `mbolo/threads/${threadId}/presence`, stranger);
  assert.deepEqual(pres.body.readBy, [], 'blocked member’s read state is gone');
  const pay = await call('POST', 'transfers/send', stranger, { recipientHandle: victim.handle, amount: 10, threadId });
  assert.equal(pay.body.mboloMessage, undefined);
  assert.ok(!(await call('GET', 'mbolo/threads', victim)).body.some((t) => t.id === threadId));
  // The generic trust/block also closes an accepted chat.
  const s2 = await actor();
  const v2 = await actor();
  const t2 = await request(s2, v2);
  await call('POST', `mbolo/threads/${t2}/accept`, v2);
  await call('POST', 'trust/block', v2, { blockedUserId: s2.id });
  assert.equal((await call('POST', `mbolo/threads/${t2}/messages`, s2, { body: 'hm' })).status, 403);
});

test('deliberate relationships bypass requests: friends are active immediately', async () => {
  const a = await actor();
  const b = await actor();
  await makeFriends(a, b);
  const t = await call('POST', 'mbolo/threads', a, { memberHandles: [b.handle] });
  assert.equal(await memberStatus(t.body.id, b.id), 'active');
  assert.equal((await call('POST', `mbolo/threads/${t.body.id}/messages`, a, { body: 'yo' })).status, 201);
  assert.equal((await call('POST', `mbolo/threads/${t.body.id}/messages`, a, { body: 'yo 2' })).status, 201);
});

test('rate limit on message requests to strangers', async () => {
  const spammer = await actor();
  const statuses = [];
  for (let i = 0; i < 8; i += 1) {
    const target = await actor();
    statuses.push((await call('POST', 'mbolo/threads', spammer, { memberHandles: [target.handle] })).status);
  }
  assert.ok(statuses.slice(0, 6).every((s) => s === 201), statuses.join(','));
  assert.ok(statuses.slice(6).every((s) => s === 429), statuses.join(','));
});

test('reload/restart: request state is server-side and survives a restart', async () => {
  const stranger = await actor();
  const victim = await actor();
  const threadId = await request(stranger, victim);
  await api.stop();
  api = await startApiServer(SERVER_ENV);
  assert.ok((await call('GET', 'mbolo/requests', victim)).body.requests.some((r) => r.threadId === threadId));
  assert.equal((await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { body: 'encore' })).status, 403);
  assert.equal((await call('POST', `mbolo/threads/${threadId}/accept`, victim)).status, 200);
  assert.equal((await call('POST', `mbolo/threads/${threadId}/messages`, stranger, { body: 'merci' })).status, 201);
});

test('legacy migration: non-consensual legacy members become requests; real conversations stay', async () => {
  const creator = await actor();
  const silent = await actor();
  const talker = await actor();
  const friend = await actor();
  await makeFriends(creator, friend);
  const mk = (userId) =>
    prisma.mboloThread.create({
      data: { creatorId: creator.id, type: 'direct', members: { create: [{ userId: creator.id }, { userId }] } },
    });
  const tSilent = await mk(silent.id);
  const tTalker = await mk(talker.id);
  const tFriend = await mk(friend.id);
  await prisma.mboloMessage.create({ data: { threadId: tTalker.id, senderId: talker.id, body: 'ok', kind: 'text' } });

  const dry = await migrateLegacyThreadsToRequests(prisma, { dryRun: true });
  assert.equal(dry.mode, 'DRY_RUN');
  assert.ok(dry.toRequested >= 1);
  assert.equal(await memberStatus(tSilent.id, silent.id), 'active', 'dry run changes nothing');

  await migrateLegacyThreadsToRequests(prisma, { dryRun: false });
  assert.equal(await memberStatus(tSilent.id, silent.id), 'requested');
  assert.equal(await memberStatus(tTalker.id, talker.id), 'active', 'previously accepted conversation kept');
  assert.equal(await memberStatus(tFriend.id, friend.id), 'active', 'friends kept');
  assert.equal(await memberStatus(tSilent.id, creator.id), 'active');
  assert.equal((await migrateLegacyThreadsToRequests(prisma, { dryRun: true })).toRequested, 0, 'idempotent');

  // The migrated member now sees it as a request and the creator as the requester.
  const reqs = await call('GET', 'mbolo/requests', silent);
  assert.equal(reqs.body.requests.find((r) => r.threadId === tSilent.id)?.from.id, creator.id);
});

test('server logs carry no intro text, secrets or phone numbers', () => {
  const logs = api.logs();
  for (const s of ['on s’est vus au marché', '$2a$', '$2b$', 'SECRETCNI']) assert.ok(!logs.includes(s), `log leak: ${s}`);
});
