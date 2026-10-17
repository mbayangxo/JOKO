/**
 * J11 stale-authorization review — cash agents. Binding, the customer's commit and the agent's
 * completion re-checked the agent profile with a plain read inside the money transaction. A suspension
 * committing at that moment was invisible, so a just-suspended agent's cash operation could still post.
 * Forced interleaving: B locks the profile and suspends it → A's check blocks (pg_locks) → B commits →
 * A must see the suspension.
 */
import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createUserWithWallet, prisma } from '../helpers/db.js';
import { agentActiveInTx } from '../../lib/agents/cash.js';

const other = new PrismaClient();
after(async () => { await other.$disconnect(); await prisma.$disconnect(); });

async function agentFor(user) {
  return prisma.agentProfile.create({ data: { userId: user.id, displayName: 'Race test', agentCode: `RT${Date.now().toString(36).toUpperCase()}`, status: 'active' } });
}

test('an agent suspension that commits during the check is seen (no stale "active")', async () => {
  const agent = await agentFor(await createUserWithWallet({}));
  let releaseB; let bReady;
  const gate = new Promise((r) => { releaseB = r; });
  const ready = new Promise((r) => { bReady = r; });
  const b = other.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "AgentProfile" WHERE id = ${agent.id} FOR UPDATE`;
    await tx.agentProfile.update({ where: { id: agent.id }, data: { status: 'suspended', suspendedAt: new Date(), suspensionReason: 'race test' } });
    bReady();
    await gate;
  }, { timeout: 20_000 });
  await ready;

  const a = prisma.$transaction((tx) => agentActiveInTx(tx, agent.id), { timeout: 20_000 });
  for (let i = 0; i < 100; i += 1) {
    const waiting = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid','tuple')`;
    if (waiting[0].n > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  releaseB();
  await b;
  assert.equal(await a, false, 'the agent check must see the committed suspension');
});

test('an active agent passes; an unknown agent id is refused', async () => {
  const agent = await agentFor(await createUserWithWallet({}));
  assert.equal(await prisma.$transaction((tx) => agentActiveInTx(tx, agent.id)), true);
  assert.equal(await prisma.$transaction((tx) => agentActiveInTx(tx, 'missing')), false);
});
