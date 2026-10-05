import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { topUpAgentFloat, applyForAgentProfile, requireActiveAgent } from '../../lib/agent-service.js';
import { activateAgentInTx, approveAgent, decideServicePoint, verifyAgentIdentity } from '../../lib/agents/lifecycle.js';
import { createUserWithWallet, prisma } from '../helpers/db.js';

after(() => prisma.$disconnect());

test('agent: a float top-up never activates an applicant (J3: onboarding is compliance, float is finance)', async () => {
  const user = await createUserWithWallet({ balance: 0, koriBalance: 0 });

  const profile = await applyForAgentProfile({
    userId: user.id,
    displayName: 'Boutique Test',
    locationLabel: 'Marché Médina, allée 3',
  });
  assert.equal(profile.status, 'applied');

  const result = await topUpAgentFloat(profile.id, 500_000, 'admin-test', 'Initial float');
  assert.equal(result.status, 'applied');
  assert.equal(result.floatBalance, 500_000);

  const role = await prisma.accountRole.findFirst({ where: { userId: user.id, role: 'agent' } });
  assert.notEqual(role?.status, 'active');
  await assert.rejects(requireActiveAgent(user.id), (e) => e.code === 'not_agent' || e.code === 'agent_inactive');
});

test('agent: review approval alone never activates; activation is a separate maker-checker step on an approved service point', async () => {
  const user = await createUserWithWallet({ balance: 0, koriBalance: 0, tier: 2 });
  const profile = await applyForAgentProfile({ userId: user.id, displayName: 'Kiosk Test', locationLabel: 'Kiosque gare routière, Pikine' });
  await verifyAgentIdentity('op-a', profile.id);
  const approved = await approveAgent('op-b', profile.id, { reason: 'documents checked' });
  assert.equal(approved.status, 'approved');
  await assert.rejects(requireActiveAgent(user.id));
  const sp = await prisma.agentProfile.findUnique({ where: { id: profile.id } });
  await assert.rejects(prisma.$transaction((tx) => activateAgentInTx(tx, profile.id, { activatedBy: 'op-c', requestedBy: 'op-d' })), (e) => e.code === 'service_point_required');
  await decideServicePoint('op-a', sp.servicePointId, { status: 'active', reason: 'premises visited' });
  await assert.rejects(prisma.$transaction((tx) => activateAgentInTx(tx, profile.id, { activatedBy: 'op-b', requestedBy: 'op-d' })), (e) => e.code === 'same_operator');
  const active = await prisma.$transaction((tx) => activateAgentInTx(tx, profile.id, { activatedBy: 'op-c', requestedBy: 'op-d' }));
  assert.equal(active.status, 'active');
  assert.equal(active.floatBalance, 0, 'activation adds no float');
  assert.ok(await requireActiveAgent(user.id));
});
