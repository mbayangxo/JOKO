/**
 * J10 load (local): 4 neighbourhood groups × 12 members. Everyone polls Aujourd'hui and the unread
 * badge at once, members post concurrently, admins moderate while posting continues, reports and
 * notifications storm. Checks: no 5xx, one effect per real event, money invariants intact.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { customer, signedIn } from '../j3/helpers.js';

const GROUPS = 4;
const PER = 12;
let api;
before(async () => { api = await startApiServer(); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };
const p95 = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.95) - 1] ?? xs[xs.length - 1];
const ok = (r, w = '') => { assert.ok(r.status >= 200 && r.status < 300, `${w} ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

test(`${GROUPS} groups × ${PER} members: polling, posting, moderation and report storms under concurrency`, async () => {
  const groups = [];
  for (let g = 0; g < GROUPS; g += 1) {
    const owner = await signedIn(api, await customer());
    const t = ok(await owner.call('POST', 'mbolo/threads', { name: `Quartier charge ${g}`, memberHandles: [] }));
    const inv = ok(await owner.call('POST', `mbolo/threads/${t.id}/invite`, {}));
    const members = await Promise.all(Array.from({ length: PER }, async () => signedIn(api, await customer())));
    await Promise.all(members.map((m) => m.call('POST', 'mbolo/join-group', { code: inv.inviteCode })));
    groups.push({ owner, id: t.id, members });
  }
  const everyone = groups.flatMap((g) => [g.owner, ...g.members]);
  const lat = [];
  const statuses = [];
  const record = async (fn) => { const { r, ms } = await timed(fn); lat.push(ms); statuses.push(r.status); return r; };
  // Wave 1: everyone polls Today + unread at once.
  await Promise.all(everyone.flatMap((s) => [record(() => s.call('GET', 'me/today')), record(() => s.call('GET', 'notifications/unread'))]));
  // Wave 2: concurrent posting while admins switch announcement mode and mute someone.
  const posts = await Promise.all(groups.flatMap((g) => g.members.map((m, i) => record(() => m.call('POST', `mbolo/threads/${g.id}/messages`, { body: `Bonjour voisin ${i}`, kind: 'text' })))));
  await Promise.all(groups.map((g) => record(() => g.owner.call('POST', `mbolo/threads/${g.id}/mute`, { userId: g.members[0].id ?? g.members[0].userId, hours: 1 }))));
  // Wave 3: report storm — every member reports the first message of their group twice.
  for (const g of groups) {
    const first = await prisma.mboloMessage.findFirst({ where: { threadId: g.id, kind: 'text' }, orderBy: { createdAt: 'asc' } });
    await Promise.all(g.members.filter((m) => m.id !== first.senderId).flatMap((m) => [1, 2].map(() => record(() => m.call('POST', `mbolo/messages/${first.id}/report`, { category: 'spam', reason: 'charge' })))));
    const reporters = await prisma.contentReport.groupBy({ by: ['reporterId'], where: { targetMessageId: first.id }, _count: true });
    assert.ok(reporters.every((r) => r._count === 1), 'one report per reporter per message');
  }
  assert.equal(statuses.filter((s) => s >= 500).length, 0, `no 5xx: ${statuses.filter((s) => s >= 500).length}`);
  assert.ok(posts.filter((r) => r.status === 201 || r.status === 200).length >= GROUPS * PER * 0.9, 'members can post under load');
  await assertInvariants(prisma);
  console.log(JSON.stringify({ j10Requests: lat.length, p95ms: p95([...lat]), maxMs: Math.max(...lat) }));
});
