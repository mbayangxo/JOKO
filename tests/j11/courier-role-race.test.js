/**
 * J11 stale-authorization review — courier role. Courier steps (pickup, delivery, failed attempt) and
 * dispatcher assignments checked the Jokko courier role with a plain read. A suspension committing
 * at the same moment was invisible to that read, so a just-suspended courier's step could still commit.
 * Forced interleaving: B locks the role row and suspends it → A's check blocks (pg_locks) → B commits → A
 * must see "suspended".
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import { courierRoleActiveInTx } from '../../lib/logistics/shipments.js';

const other = new PrismaClient();
after(async () => { await other.$disconnect(); await prisma.$disconnect(); });

test('a courier suspension that commits during the role check is seen (no stale "active")', async () => {
  const courier = await createUserWithWallet({});
  const role = await prisma.accountRole.create({ data: { userId: courier.id, role: 'driver', status: 'active' } });

  let releaseB; let bReady;
  const gate = new Promise((r) => { releaseB = r; });
  const ready = new Promise((r) => { bReady = r; });
  const b = other.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "AccountRole" WHERE id = ${role.id} FOR UPDATE`;
    await tx.accountRole.update({ where: { id: role.id }, data: { status: 'suspended', statusReason: 'race test' } });
    bReady();
    await gate;
  }, { timeout: 20_000 });
  await ready; // B holds the row lock with the suspension written, not yet committed

  const a = prisma.$transaction((tx) => courierRoleActiveInTx(tx, courier.id), { timeout: 20_000 });
  for (let i = 0; i < 100; i += 1) {
    const waiting = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid','tuple')`;
    if (waiting[0].n > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  releaseB();
  await b;
  assert.equal(await a, false, 'the courier check must see the committed suspension');
});

test('an active courier with no concurrent change passes; no role → refused', async () => {
  const c = await createUserWithWallet({});
  await prisma.accountRole.create({ data: { userId: c.id, role: 'driver', status: 'active' } });
  assert.equal(await prisma.$transaction((tx) => courierRoleActiveInTx(tx, c.id)), true);
  const n = await createUserWithWallet({});
  assert.equal(await prisma.$transaction((tx) => courierRoleActiveInTx(tx, n.id)), false);
});
