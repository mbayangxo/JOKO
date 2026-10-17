import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { customer, signedIn, stepUp } from '../j3/helpers.js';
import { activateAgentInTx, applyAsAgent, approveAgent, decideServicePoint, verifyAgentIdentity } from '../../lib/agents/lifecycle.js';
import { topUpAgentFloat } from '../../lib/agent-service.js';

/**
 * An agent taken through the REAL lifecycle with distinct operators:
 * apply → identity verified (op A) → approved (op B) → service point approved
 * → activation requested (op C) and executed (op D) → float topped up by finance.
 */
export async function activeAgent(api, { floatXof = 200_000, tier = 'standard', hours, cashIn = true, cashOut = true, signed = true, lat = 14.6789, lng = -17.4467 } = {}) {
  const c = await customer({ tier: 2 });
  const n = crypto.randomBytes(3).toString('hex');
  const profile = await applyAsAgent(c.id, { displayName: `Point ${n}`, servicePoint: { name: `Boutique ${n}`, publicAddress: `Marché Tilène, allée ${n}, Médina`, area: 'Médina', lat, lng, hours, cashIn, cashOut } });
  await verifyAgentIdentity('op-verify', profile.id);
  await approveAgent('op-approve', profile.id, { reason: 'documents and premises checked' });
  await decideServicePoint('op-approve', profile.servicePointId, { status: 'active', reason: 'premises visited' });
  if (tier === 'business') await prisma.agentProfile.update({ where: { id: profile.id }, data: { tier: 'business', floatLimit: 10_000_000, maxDepositXof: 2_000_000, maxWithdrawXof: 5_000_000 } });
  await prisma.$transaction((tx) => activateAgentInTx(tx, profile.id, { activatedBy: 'op-activate', requestedBy: 'op-request', reason: 'activation test fixture' }));
  if (floatXof > 0) await topUpAgentFloat(profile.id, floatXof, 'op-finance', 'fixture float');
  const s = signed ? await signedIn(api, c) : null;
  return { ...c, s, profile: await prisma.agentProfile.findUnique({ where: { id: profile.id } }) };
}

export const idem = () => ({ headers: { 'idempotency-key': `k-${crypto.randomBytes(8).toString('hex')}` } });
export const withKey = (key, extra = {}) => ({ headers: { 'idempotency-key': key, ...extra } });
export const pinned = async (s) => ({ 'x-step-up-token': await stepUp(s) });

export const wallet = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).koriBalance;
export const floatOf = async (agentId) => (await prisma.agentProfile.findUnique({ where: { id: agentId } })).floatBalance;
export const held = async (agentId) => Number((await prisma.ledgerAccount.findUnique({ where: { code: `agent:${agentId}:float_held` } }))?.balance ?? 0);
export const customerHeld = async (userId) => Number((await prisma.ledgerAccount.findUnique({ where: { code: `customer:${userId}:held` } }))?.balance ?? 0);

/** Full cash-in over HTTP; returns the final transaction. */
export async function cashIn(cust, agent, amountXof) {
  const c = await cust.call('POST', 'agent-cash/in', { amountXof }, idem());
  if (c.status !== 201) throw new Error(`cash/in ${c.status} ${JSON.stringify(c.body)}`);
  const scan = await agent.s.call('POST', 'agent/cash/scan', { qr: c.body.qr });
  if (scan.status !== 200) throw new Error(`scan ${scan.status} ${JSON.stringify(scan.body)}`);
  const b = scan.body.transaction.bindingHash;
  const conf = await cust.call('POST', `agent-cash/tx/${c.body.transaction.id}/confirm`, { bindingHash: b });
  if (conf.status !== 200) throw new Error(`confirm ${conf.status} ${JSON.stringify(conf.body)}`);
  const done = await agent.s.call('POST', `agent/cash/${c.body.transaction.id}/complete`, { bindingHash: b }, { headers: await pinned(agent.s) });
  if (done.status !== 200) throw new Error(`complete ${done.status} ${JSON.stringify(done.body)}`);
  return done.body;
}

/** Full cash-out over HTTP. */
export async function cashOut(cust, agent, amountXof) {
  const c = await cust.call('POST', 'agent-cash/out', { amountXof }, { headers: { ...idem().headers, ...(await pinned(cust)) } });
  if (c.status !== 201) throw new Error(`cash/out ${c.status} ${JSON.stringify(c.body)}`);
  const scan = await agent.s.call('POST', 'agent/cash/scan', { qr: c.body.qr });
  if (scan.status !== 200) throw new Error(`scan ${scan.status} ${JSON.stringify(scan.body)}`);
  const b = scan.body.transaction.bindingHash;
  const auth = await cust.call('POST', `agent-cash/tx/${c.body.transaction.id}/confirm`, { bindingHash: b }, { headers: await pinned(cust) });
  if (auth.status !== 200) throw new Error(`authorize ${auth.status} ${JSON.stringify(auth.body)}`);
  const done = await agent.s.call('POST', `agent/cash/${c.body.transaction.id}/complete`, { bindingHash: b }, { headers: await pinned(agent.s) });
  if (done.status !== 200) throw new Error(`complete ${done.status} ${JSON.stringify(done.body)}`);
  return done.body;
}
