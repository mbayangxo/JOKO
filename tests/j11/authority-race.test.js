/**
 * J11 carry-forward — root cause of an intermittent J3 failure ("no payment committed after the removal").
 * assertBusinessAuthorityInTx read the membership, then re-locked it with `status = 'active' FOR SHARE`
 * but ignored the result. If the owner's removal committed between the two statements, the re-check
 * returned no row and the payment still went through. This forces that exact interleaving:
 *   B: lock the member row (FOR UPDATE)  →  A: authority check reads "active", then blocks on B's lock
 *   →  (pg_locks shows A waiting)  →  B: mark removed, commit  →  A must REFUSE.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import { assertBusinessAuthorityInTx, OrgAccessError } from '../../lib/business-access.js';

const other = new PrismaClient();
after(async () => { await other.$disconnect(); await prisma.$disconnect(); });

test('a removal that commits while the payment is between its read and its lock → the payment is refused', async () => {
  const owner = await createUserWithWallet({});
  const cfo = await createUserWithWallet({});
  const biz = await prisma.business.create({ data: { ownerId: owner.id, name: `Race ${Date.now()}` } });
  const m = await prisma.businessMember.create({ data: { businessId: biz.id, userId: cfo.id, role: 'cfo', status: 'active', acceptedAt: new Date() } });

  let releaseB;
  const gate = new Promise((r) => { releaseB = r; });
  const b = other.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "BusinessMember" WHERE id = ${m.id} FOR UPDATE`;
    await gate;
    await tx.businessMember.update({ where: { id: m.id }, data: { status: 'removed', removedAt: new Date() } });
  }, { timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 100)); // B holds the lock

  const a = prisma.$transaction((tx) => assertBusinessAuthorityInTx(tx, cfo.id, biz.id, 'business.pay'), { timeout: 20_000 }).then(() => 'authorized', (e) => (e instanceof OrgAccessError ? 'refused' : `error:${e.message}`));
  // Wait until A is really blocked on B's row lock (deterministic, not a sleep race).
  for (let i = 0; i < 100; i += 1) {
    const waiting = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid','tuple')`;
    if (waiting[0].n > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  releaseB();
  await b;
  assert.equal(await a, 'refused', 'the authority re-check must see the removal');
});
