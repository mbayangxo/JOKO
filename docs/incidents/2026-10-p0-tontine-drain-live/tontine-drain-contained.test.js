/**
 * P0 tontine drain — containment regression (production base 7d262de + patch).
 * Before the patch (tests/repro/tontine-drain.test.js): 2 strangers × 20 000 debited into the creator.
 * After: release refuses (503), the daily cron skips, nobody is debited, nothing is credited.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createUserWithWallet, mockReq, mockRes, prisma } from '../helpers/db.js';
import { tontineGroups, tontineRelease } from '../../lib/handlers.js';
import { runTontineProcessor } from '../../lib/cron/tontine-processor.js';

after(async () => { await prisma.$disconnect(); });
const call = async (h, opts) => { const req = mockReq(opts); const res = mockRes(); await h(req, res); return res; };
const bal = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).balance;

test('contained: release refuses and the cron skips; no member is debited, the creator gains nothing', async () => {
  const [creator, v1, v2] = await Promise.all([0, 50_000, 50_000].map((b) => createUserWithWallet({ balance: b, koriBalance: b })));
  for (const u of [creator, v1, v2]) { u.handle = u.handle.replace(/^@/, ''); await prisma.user.update({ where: { id: u.id }, data: { handle: u.handle } }); }
  const g = await call(tontineGroups, { userId: creator.id, body: { name: 'Natt piège', amountPerMember: 20_000, frequency: 'monthly', memberHandles: [v1.handle, v2.handle] } });
  const groupId = g.body.id ?? g.body.group?.id;
  await prisma.tontineGroup.update({ where: { id: groupId }, data: { nextDueAt: new Date(Date.now() - 1000) } });
  const r = await call(tontineRelease, { userId: creator.id, query: { id: groupId } });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.code, 'tontine_suspended');
  const cron = await runTontineProcessor(prisma);
  assert.equal(cron.skipped, 'legacy_tontine_money_suspended');
  assert.deepEqual([await bal(creator.id), await bal(v1.id), await bal(v2.id)], [0, 50_000, 50_000]);
  assert.equal(await prisma.tontineMembership.count({ where: { groupId } }), 3, 'records preserved (no data change)');
});
