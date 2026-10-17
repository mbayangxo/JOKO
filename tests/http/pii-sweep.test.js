/**
 * PII / credential sweep — real HTTP, NODE_ENV=production.
 * An attacker gets connected to a victim through every social/commerce surface
 * they can reach without the victim's cooperation, then reads every list/detail
 * endpoint. Nothing secret or personal about the victim may come back.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { createUserWithWallet, createVerifiedDevice, establishedSessionToken, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
let api;
before(async () => { api = await startApiServer({ TONTINE_ESCROW_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

async function actor(koriBalance = 0) {
  const user = await createUserWithWallet({ koriBalance, tier: 2 });
  const device = await createVerifiedDevice(user.id);
  return { user, id: user.id, handle: user.handle, device, token: await establishedSessionToken(user.id, device, ACCESS_SECRET), ip: freshIp() };
}
const as = (a) => ({ token: a.token, device: a.device, ip: a.ip, headers: { 'x-vercel-ip-country': 'SN' } });
const call = (m, p, a, body) => api.client(m, p, { ...as(a), body });

test('a stranger connected to a victim never receives the victim’s secrets, phone, email or birth date', async () => {
  const victim = await actor(1000);
  const email = `victim-${crypto.randomBytes(4).toString('hex')}@private.test`;
  const pinHash = await bcrypt.hash('482193', 10);
  const cniHash = `cnihash-secret-${crypto.randomBytes(6).toString('hex')}`;
  await prisma.user.update({
    where: { id: victim.id },
    data: { pinHash, passwordHash: await bcrypt.hash('hunter2hunter2', 10), email, emailVerifiedAt: new Date(), dateOfBirth: new Date('1999-01-02'), cniNumberEnc: 'enc:SECRETCNI', cniHash },
  });
  const victimBiz = (await call('POST', 'businesses', victim, { name: `Victim Shop ${crypto.randomBytes(3).toString('hex')}`, type: 'merchant' })).body;

  const attacker = await actor(1000);
  const thread = await call('POST', 'mbolo/threads', attacker, { memberHandles: [victim.handle] });
  await call('POST', `mbolo/threads/${thread.body.id}/messages`, attacker, { body: 'salut' });
  await call('POST', 'friends', attacker, { handle: victim.handle });
  await call('POST', 'transfers/request', attacker, { recipientHandle: victim.handle, amount: 50 });
  await call('POST', 'trust/vouch', attacker, { handle: victim.handle });
  await call('POST', 'tontine/groups', attacker, { name: 'T', amountPerMember: 1000, memberHandles: [victim.handle] });
  await call('POST', `merchants/${victimBiz.id}/pay`, attacker, { amount: 5 });

  const reads = [
    'mbolo/threads', `mbolo/threads/${thread.body.id}/messages`, `mbolo/threads/${thread.body.id}/presence`,
    'friends', 'friends/requests', 'transfers/requests', `users/lookup?q=${victim.handle}`, `profiles/${victim.id}`,
    'businesses', `businesses/${victimBiz.id}`, `marketplace/shops/${victimBiz.id}`, `merchants/${victimBiz.id}/public`,
    'trust/vouch', 'tontine/groups', 'jekkal/campaigns', 'channels', 'transactions', 'notifications', 'marketplace/search?q=Victim',
    'agents/nearby?lat=14.69&lng=-17.44', 'deliveries/nearby?lat=14.69&lng=-17.44', 'charts', 'mbolo/stories',
  ];
  const secrets = [pinHash, '$2a$', '$2b$', email, victim.user.phone, '1999-01-02', 'SECRETCNI', cniHash];
  const leaks = [];
  for (const path of reads) {
    const r = await call('GET', path, attacker);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    for (const s of secrets) if (text.includes(s)) leaks.push(`${path} → ${s.slice(0, 12)}…`);
    for (const k of ['pinHash', 'passwordHash', 'cniNumberEnc', 'cniHash']) if (text.includes(`"${k}"`)) leaks.push(`${path} → key ${k}`);
  }
  assert.deepEqual(leaks, []);
});
