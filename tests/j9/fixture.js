import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { prisma, fundBusiness } from '../helpers/db.js';
import { business, customer, signedIn, stepUp } from '../j3/helpers.js';
import { ensureBusinessWallet } from '../../lib/business-wallet-service.js';

export const key = () => `k-${crypto.randomBytes(8).toString('hex')}`;
export const idemH = (k = key()) => ({ headers: { 'idempotency-key': k } });
export const withStepUp = async (s, k = key()) => ({ headers: { 'idempotency-key': k, 'x-step-up-token': await stepUp(s) } });
export const bizBal = async (id) => (await prisma.businessWallet.findUnique({ where: { businessId: id } }))?.balance ?? 0;
export const walletBal = async (userId) => (await prisma.wallet.findUnique({ where: { userId } })).koriBalance;
export const ok = (r, what = '') => {
  assert.ok(r.status >= 200 && r.status < 300, `${what} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

/** A verified, funded employer business. */
export async function employer(api, { fund = 100_000, type = 'merchant', verified = true } = {}) {
  const ownerC = await customer();
  const owner = await signedIn(api, ownerC);
  const b = await business(ownerC.user);
  await prisma.business.update({ where: { id: b.id }, data: { type, ...(verified ? { verificationStatus: 'verified', verified: true, verifiedAt: new Date() } : {}) } });
  await ensureBusinessWallet(b.id, prisma);
  if (fund) await fundBusiness(b.id, fund);
  return { b, owner, ownerC };
}

/** A signed-in worker with a work profile; `age` sets a KYC-verified date of birth. */
export async function worker(api, { age = 30, visibility = 'discoverable', skills = ['manutention'], areas = ['pikine'] } = {}) {
  const c = await customer();
  if (age !== null) {
    const dob = new Date();
    dob.setUTCFullYear(dob.getUTCFullYear() - age);
    dob.setUTCDate(dob.getUTCDate() - 2);
    await prisma.user.update({ where: { id: c.id }, data: { dateOfBirth: dob, verificationTier: 2 } });
  }
  const s = await signedIn(api, c);
  ok(await s.call('PUT', 'work/profile', { headline: 'Polyvalent', skills, areas, visibility }), 'profile');
  return s;
}

export const GIG = { type: 'gig', arrangement: 'contract', title: 'Inventaire de fin de mois', description: 'Compter le stock du magasin et saisir les quantités.', area: 'pikine', skills: ['manutention'], payKind: 'fixed', rateKori: 2000 };

export async function post(e, body = {}) {
  return ok(await e.owner.call('POST', `businesses/${e.b.id}/work/opportunities`, { ...GIG, ...body }), 'post');
}

/** Apply → (prepaid: step-up) offer → accept. Returns { opp, app, offer, assignment }. */
export async function hire(api, e, w, { opp, offer = {}, accept = {} } = {}) {
  const o = opp ?? (await post(e));
  const app = ok(await w.call('POST', `work/opportunities/${o.id}/apply`, { note: 'Disponible' }), 'apply');
  const h = o.funding === 'prepaid' ? await withStepUp(e.owner) : idemH();
  const of = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/offers`, { applicationId: app.id, startDate: '2026-11-02', duties: 'Compter et saisir le stock du rayon épicerie.', ...offer }, h), 'offer');
  const a = ok(await w.call('POST', `work/offers/${of.id}/accept`, { termsHash: of.termsHash, ...accept }), 'accept');
  return { opp: o, app, offer: of, assignment: a };
}
