/**
 * J11 carry-forward — root cause of an intermittent J3 failure ("no payment committed after the removal").
 * assertBusinessAuthorityInTx read the membership, then re-locked it with `status = 'active' FOR SHARE`
 * but ignored the result. If the owner's removal committed between the two statements, the re-check
 * returned no row and the payment still went through. This forces that exact interleaving, and PROVES it:
 *   1. B holds the member row lock before A starts (another session's FOR UPDATE NOWAIT is refused)
 *   2. A is blocked BY B (pg_blocking_pids of A's backend contains B's backend pid), and has not finished
 *   3. B marks the member removed and commits
 *   4. A's decision uses the updated row: REFUSED (OrgAccessError), and the row reads "removed"
 * Verified to FAIL against the original implementation (34f79d3~1, locking re-check result ignored) and
 * to PASS against the fix — recorded in docs/JOKKO-J12-REPORT.md §8.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import { assertBusinessAuthorityInTx, OrgAccessError } from '../../lib/business-access.js';

const other = new PrismaClient();
const third = new PrismaClient();
after(async () => { await other.$disconnect(); await third.$disconnect(); await prisma.$disconnect(); });

test('a removal that commits while the payment is between its read and its lock → the payment is refused', async () => {
  const owner = await createUserWithWallet({});
  const cfo = await createUserWithWallet({});
  const biz = await prisma.business.create({ data: { ownerId: owner.id, name: `Race ${Date.now()}` } });
  const m = await prisma.businessMember.create({ data: { businessId: biz.id, userId: cfo.id, role: 'cfo', status: 'active', acceptedAt: new Date() } });

  let releaseB;
  let bLocked;
  let bPid = null;
  const gate = new Promise((r) => { releaseB = r; });
  const locked = new Promise((r) => { bLocked = r; });
  const b = other.$transaction(async (tx) => {
    bPid = (await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`)[0].pid;
    await tx.$executeRaw`SELECT id FROM "BusinessMember" WHERE id = ${m.id} FOR UPDATE`;
    bLocked();
    await gate;
    await tx.businessMember.update({ where: { id: m.id }, data: { status: 'removed', removedAt: new Date() } });
  }, { timeout: 20_000 });
  await locked; // B has returned from its FOR UPDATE (a fixed sleep raced under load)

  // (1) B demonstrably holds the row lock: a third session cannot take it.
  const probe = await third.$transaction((tx) => tx.$executeRaw`SELECT id FROM "BusinessMember" WHERE id = ${m.id} FOR UPDATE NOWAIT`)
    .then(() => 'acquired', (e) => (/could not obtain lock|55P03/.test(`${e?.message} ${JSON.stringify(e?.meta ?? {})}`) ? 'lock_not_available' : `error:${e?.message}`));
  assert.equal(probe, 'lock_not_available', 'B holds the member row lock before A starts');

  let aSettled = false;
  const a = prisma.$transaction((tx) => assertBusinessAuthorityInTx(tx, cfo.id, biz.id, 'business.pay'), { timeout: 20_000 })
    .then(() => 'authorized', (e) => (e instanceof OrgAccessError ? 'refused' : `error:${e?.message}`))
    .finally(() => { aSettled = true; });

  // (2) A is blocked BY B — not merely "some lock is waiting somewhere" — and has not decided yet.
  let blockedByB = false;
  for (let i = 0; i < 200 && !blockedByB; i += 1) {
    const r = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE ${bPid}::int = ANY(pg_blocking_pids(pid))`;
    blockedByB = r[0].n > 0;
    if (!blockedByB) await new Promise((res) => setTimeout(res, 50));
  }
  assert.ok(blockedByB, 'A must be waiting on B’s lock (otherwise the interleaving under test did not happen)');
  assert.equal(aSettled, false, 'A cannot decide while B holds the lock');

  // (3) B removes the member and commits.
  releaseB();
  await b;

  // (4) A's decision uses the updated state.
  assert.equal(await a, 'refused', 'the authority re-check must see the removal');
  assert.equal((await prisma.businessMember.findUnique({ where: { id: m.id } })).status, 'removed');
});
