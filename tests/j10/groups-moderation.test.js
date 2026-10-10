/**
 * J10-S3 groups with roles + J10-S8 report → review → action → appeal.
 * Groups: only owner/admins add, invite, remove, mute, switch announcement mode; admins never act on
 * the owner or other admins; removed members never rejoin by link; the owner hands over before leaving;
 * removing someone from a tontine's chat never touches the tontine.
 * Moderation: message reports keep a snapshot; only trust_safety reviews; a restriction stops messages
 * but NEVER money; one appeal, decided by a different operator; the reporter learns only "handled".
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fundUser, prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, operator, signedIn } from '../j3/helpers.js';

let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => { await assertInvariants(prisma); });

const ok = (r, what = '') => { assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const person = async () => { const c = await customer(); const s = await signedIn(api, c); return { c, s, id: c.id }; };
const say = (p, threadId, body) => p.s.call('POST', `mbolo/threads/${threadId}/messages`, { body, kind: 'text' });

async function group(owner, name = 'Quartier Médina') {
  const t = ok(await owner.s.call('POST', 'mbolo/threads', { name, memberHandles: [] }), 'create');
  const inv = ok(await owner.s.call('POST', `mbolo/threads/${t.id}/invite`, {}), 'invite');
  const join = async (p) => ok(await p.s.call('POST', 'mbolo/join-group', { code: inv.inviteCode }), 'join');
  return { id: t.id, code: inv.inviteCode, join };
}

test('roles: managers only, rank rules, removal sticks, announcement mode, mute, invite revoke, hand-over', async () => {
  const [owner, a, b, c, d] = await Promise.all([person(), person(), person(), person(), person()]);
  const g = await group(owner);
  await g.join(a); await g.join(b);
  // A plain member cannot manage.
  assert.equal((await a.s.call('POST', `mbolo/threads/${g.id}/invite`, {})).status, 403);
  assert.equal((await a.s.call('POST', `mbolo/threads/${g.id}/remove`, { userId: b.id })).status, 403);
  assert.equal((await a.s.call('POST', `mbolo/threads/${g.id}/members`, { handles: [c.c.user?.handle ?? 'x'] })).status, 403);
  // The owner promotes A; A removes B; B cannot come back through the link.
  ok(await owner.s.call('POST', `mbolo/threads/${g.id}/roles`, { userId: a.id, role: 'admin' }));
  assert.equal((await a.s.call('POST', `mbolo/threads/${g.id}/roles`, { userId: b.id, role: 'admin' })).status, 403, 'only the owner promotes');
  ok(await a.s.call('POST', `mbolo/threads/${g.id}/remove`, { userId: b.id }));
  assert.equal((await b.s.call('POST', 'mbolo/join-group', { code: g.code })).status, 404, 'removed: no rejoin by link');
  assert.equal((await say(b, g.id, 'je suis encore là ?')).status, 403);
  assert.equal((await a.s.call('POST', `mbolo/threads/${g.id}/remove`, { userId: owner.id })).status, 403, 'nobody removes the owner');
  // Announcement mode: members read, managers post.
  await g.join(c);
  ok(await a.s.call('POST', `mbolo/threads/${g.id}/settings`, { postingPolicy: 'admins' }));
  assert.equal((await say(c, g.id, 'Bonjour à tous')).body.code, 'announcement_only');
  ok(await say(a, g.id, 'Réunion de quartier samedi 10h'));
  ok(await owner.s.call('POST', `mbolo/threads/${g.id}/settings`, { postingPolicy: 'all' }));
  // Mute: C cannot post for a while; an admin cannot mute the owner.
  ok(await a.s.call('POST', `mbolo/threads/${g.id}/mute`, { userId: c.id, hours: 2 }));
  assert.equal((await say(c, g.id, 'spam spam')).body.code, 'muted');
  assert.equal((await a.s.call('POST', `mbolo/threads/${g.id}/mute`, { userId: owner.id, hours: 2 })).status, 403);
  const r = ok(await c.s.call('GET', `mbolo/threads/${g.id}/roster`));
  assert.ok(r.members.find((m) => m.userId === c.id).muted);
  assert.equal(r.members.find((m) => m.userId === owner.id).role, 'owner');
  // Revoke the link: a new person cannot join with the old code.
  ok(await owner.s.call('POST', `mbolo/threads/${g.id}/invite/revoke`, {}));
  assert.equal((await d.s.call('POST', 'mbolo/join-group', { code: g.code })).status, 404);
  // The owner hands over before leaving.
  assert.equal((await owner.s.call('POST', `mbolo/threads/${g.id}/leave`, {})).body.code, 'owner_must_transfer');
  ok(await owner.s.call('POST', `mbolo/threads/${g.id}/roles`, { userId: a.id, role: 'owner' }));
  ok(await owner.s.call('POST', `mbolo/threads/${g.id}/leave`, {}));
  assert.equal(ok(await a.s.call('GET', `mbolo/threads/${g.id}/roster`)).myRole, 'owner');
  // Outsiders see nothing.
  assert.equal((await d.s.call('GET', `mbolo/threads/${g.id}/roster`)).status, 404);
});

test('removing someone from a tontine’s group chat never touches the tontine membership', async () => {
  const [owner, m] = await Promise.all([person(), person()]);
  const g = await group(owner, 'Natt des mamans');
  await g.join(m);
  const tg = await prisma.tontineGroup.create({ data: { name: 'Natt des mamans', amountPerMember: 5000, frequency: 'monthly', createdBy: owner.id } });
  const tm = await prisma.tontineMembership.create({ data: { groupId: tg.id, userId: m.id, status: 'accepted', rotationOrder: 1 } });
  await prisma.mboloThread.update({ where: { id: g.id }, data: { commerceType: 'tontine', commerceRefId: tg.id } });
  ok(await owner.s.call('POST', `mbolo/threads/${g.id}/remove`, { userId: m.id }));
  assert.equal((await prisma.tontineMembership.findUnique({ where: { id: tm.id } })).status, 'accepted');
});

test('moderation: snapshot report, trust_safety only, restriction stops messages not money, one appeal by another operator', async () => {
  const [x, y, z] = await Promise.all([person(), person(), person()]);
  const g = await group(x, 'Voisins Liberté 6');
  await g.join(y);
  const m = ok(await say(x, g.id, 'Envoie-moi ton code OTP pour gagner un prix'));
  const msgId = m.id ?? m.message?.id;
  assert.ok(msgId, JSON.stringify(m));
  assert.equal((await z.s.call('POST', `mbolo/messages/${msgId}/report`, { category: 'scam', reason: 'arnaque' })).status, 404, 'cannot report what you cannot see');
  assert.equal((await x.s.call('POST', `mbolo/messages/${msgId}/report`, { category: 'scam', reason: 'moi-même' })).status, 400);
  const rep = ok(await y.s.call('POST', `mbolo/messages/${msgId}/report`, { category: 'scam', reason: 'Demande de code OTP' }));
  assert.equal(ok(await y.s.call('POST', `mbolo/messages/${msgId}/report`, { category: 'scam', reason: 'Demande de code OTP' })).replayed, true);
  // The message is deleted later: the snapshot keeps the evidence.
  await prisma.mboloMessage.update({ where: { id: msgId }, data: { body: '' } });
  const wops = await operator(api, ['work_ops']);
  assert.equal((await wops.call('GET', 'admin/moderation/reports')).status, 403, 'only trust & safety');
  const op1 = await operator(api, ['trust_safety']);
  const op2 = await operator(api, ['trust_safety']);
  const q = ok(await op1.call('GET', 'admin/moderation/reports'));
  const item = q.reports.find((r) => r.id === rep.id);
  assert.ok(item.evidence.body.includes('OTP'));
  const res = ok(await op1.call('POST', `admin/moderation/reports/${rep.id}/resolve`, { outcome: 'restrict_messaging', days: 3, note: 'Tentative d’hameçonnage (code OTP).' }));
  assert.equal(res.resolution, 'restrict_messaging');
  // Messages stop …
  assert.equal((await say(x, g.id, 'encore')).body.code, 'messaging_restricted');
  assert.equal((await x.s.call('POST', 'mbolo/threads', { name: 'Nouveau groupe', memberHandles: [] })).body.code, 'messaging_restricted');
  // … money does not.
  await fundUser(x.id, 5000);
  const yUser = await prisma.user.findUnique({ where: { id: y.id } });
  const pay = await x.s.call('POST', 'transfers/send', { recipientHandle: yUser.handle, amount: 500 }, { headers: { 'idempotency-key': `mod-pay-${Date.now()}` } });
  assert.ok([200, 201].includes(pay.status), `payments unaffected: ${JSON.stringify(pay.body)}`);
  // The person acted on is told (security: cannot be muted); the reporter only learns "handled".
  assert.ok(await prisma.notification.findFirst({ where: { userId: x.id, kind: 'moderation_action', category: 'security' } }));
  const mine = ok(await y.s.call('GET', 'me/reports'));
  assert.deepEqual(Object.keys(mine.reports.find((r) => r.id === rep.id)).sort(), ['category', 'createdAt', 'handled', 'handledAt', 'id']);
  // Appeal once; the deciding operator cannot rule on it; another one lifts it.
  const act = ok(await x.s.call('GET', 'me/moderation')).actions[0];
  assert.equal(act.appealable, true);
  ok(await x.s.call('POST', `me/moderation/${act.id}/appeal`, { note: 'C’était une blague entre voisins, je m’excuse.' }));
  assert.equal(ok(await x.s.call('POST', `me/moderation/${act.id}/appeal`, { note: 'Deuxième appel pour insister.' })).replayed, true);
  assert.equal((await y.s.call('POST', `me/moderation/${act.id}/appeal`, { note: 'Je fais appel pour lui.' })).status, 404);
  assert.equal((await op1.call('POST', `admin/moderation/actions/${act.id}/appeal/resolve`, { outcome: 'lifted', note: 'Je relève ma propre décision.' })).body.code, 'same_operator');
  ok(await op2.call('POST', `admin/moderation/actions/${act.id}/appeal/resolve`, { outcome: 'lifted', note: 'Premier écart, excuses présentées.' }));
  ok(await say(x, g.id, 'Désolé à tous.'));
  assert.equal(await prisma.adminAuditLog.count({ where: { targetId: { in: [rep.id, act.id] } } }), 2);
});

test('triage: a storm of spam reports never pushes a newer scam report out of the operators’ queue', async () => {
  const { moderationQueue } = await import('../../lib/community/moderation.js');
  const reporter = await prisma.user.findFirst({ select: { id: true } });
  const target = await prisma.user.findFirst({ where: { id: { not: reporter.id } }, select: { id: true } });
  await prisma.contentReport.createMany({ data: Array.from({ length: 60 }, (_, i) => ({ reporterId: reporter.id, targetUserId: target.id, category: 'spam', reason: `storm ${i}`, status: 'open' })) });
  const scam = await prisma.contentReport.create({ data: { reporterId: reporter.id, targetUserId: target.id, category: 'scam', reason: 'Demande de code OTP (triage test)', status: 'open' } });
  const q = await moderationQueue({ limit: 50 });
  assert.ok(q.reports.some((r) => r.id === scam.id), 'the scam report is in the first page');
  assert.ok(q.total >= 61);
  const firstSpam = q.reports.findIndex((r) => r.category === 'spam');
  assert.ok(q.reports.slice(firstSpam).every((r) => r.category === 'spam'), 'spam comes last');
});
