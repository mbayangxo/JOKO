import '../helpers/setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestAgentFloatTopUp,
  getMyFloatTopUpRequests,
  listFloatTopUpRequests,
  approveFloatTopUpRequest,
  rejectFloatTopUpRequest,
  AgentError,
} from '../../lib/agent-service.js';
import { prisma } from '../helpers/db.js';
import { activeAgent } from '../j6/helpers.js';

after(() => prisma.$disconnect());

async function makeActiveAgent(name) {
  // J6: through the full lifecycle (identity → review → maker-checker activation), no float.
  const a = await activeAgent(null, { floatXof: 0, signed: false });
  await prisma.agentProfile.update({ where: { id: a.profile.id }, data: { displayName: name } });
  return { user: a.user, profile: a.profile };
}

test('agent float top-up request: create, approve — float actually increases', async () => {
  const { user, profile } = await makeActiveAgent('Boutique A');

  const request = await requestAgentFloatTopUp(user.id, 200_000, 'Besoin pour le week-end');
  assert.equal(request.status, 'pending');
  assert.equal(request.amountXof, 200_000);

  const mine = await getMyFloatTopUpRequests(user.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'pending');

  const pendingList = await listFloatTopUpRequests('pending');
  assert.ok(pendingList.some((r) => r.id === request.id));

  const approved = await approveFloatTopUpRequest(request.id, 'admin-test');
  assert.equal(approved.status, 'approved');

  const agentAfter = await prisma.agentProfile.findUnique({ where: { id: profile.id } });
  assert.equal(agentAfter.floatBalance, 200_000);

  const notifs = await prisma.notification.findMany({ where: { userId: user.id, kind: 'agent_float_topup_approved' } });
  assert.equal(notifs.length, 1);
});

test('agent float top-up request: reject — no float change, agent notified', async () => {
  const { user, profile } = await makeActiveAgent('Boutique B');

  const request = await requestAgentFloatTopUp(user.id, 150_000);
  const rejected = await rejectFloatTopUpRequest(request.id, 'admin-test', 'Volume insuffisant ce mois');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.responseNote, 'Volume insuffisant ce mois');

  const agentAfter = await prisma.agentProfile.findUnique({ where: { id: profile.id } });
  assert.equal(agentAfter.floatBalance, 0);

  const notifs = await prisma.notification.findMany({ where: { userId: user.id, kind: 'agent_float_topup_rejected' } });
  assert.equal(notifs.length, 1);
});

test('agent float top-up request: cannot request twice while one is pending', async () => {
  const { user } = await makeActiveAgent('Boutique C');
  await requestAgentFloatTopUp(user.id, 100_000);

  await assert.rejects(
    () => requestAgentFloatTopUp(user.id, 50_000),
    (err) => err instanceof AgentError && err.code === 'already_processed',
  );
});

test('agent float top-up request: rejected upfront if it would exceed the tier float limit', async () => {
  const { user, profile } = await makeActiveAgent('Boutique D');
  const over = profile.floatLimit + 1;

  await assert.rejects(
    () => requestAgentFloatTopUp(user.id, over),
    (err) => err instanceof AgentError && err.code === 'float_limit',
  );
});

test('agent float top-up request: cannot approve or reject the same request twice', async () => {
  const { user } = await makeActiveAgent('Boutique E');
  const request = await requestAgentFloatTopUp(user.id, 80_000);
  await approveFloatTopUpRequest(request.id, 'admin-test');

  await assert.rejects(
    () => approveFloatTopUpRequest(request.id, 'admin-test'),
    (err) => err instanceof AgentError && err.code === 'already_processed',
  );
  await assert.rejects(
    () => rejectFloatTopUpRequest(request.id, 'admin-test'),
    (err) => err instanceof AgentError && err.code === 'already_processed',
  );
});
