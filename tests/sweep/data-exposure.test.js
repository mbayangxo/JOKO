/**
 * Data-exposure + horizontal-authorization sweep — real HTTP, NODE_ENV=production.
 *
 * Runs AFTER the full suite on the same LOCAL database (`npm run test:sweep`),
 * so every table holds rows owned by other people. A fresh "attacker" who is
 * simultaneously a customer, merchant, courier, agent and employee of one
 * business then calls EVERY authenticated GET route, substituting ids that
 * belong to other people.
 *
 * Fails on:
 *  - another user's email / phone / DOB / CNI / credential hash in any body
 *    (other users' PII is overwritten with recognizable markers first);
 *  - other users' wallet balances, agent float or deposit/withdrawal tokens;
 *  - raw User rows (credential/KYC bookkeeping fields) in any body;
 *  - the global scrubber having to strip anything (explicit shaping is primary);
 *  - a private resource of someone else answering 2xx;
 *  - any 5xx.
 *
 * Mutates other users' PII markers, so it refuses to run on a non-local DB.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { createUserWithWallet, createVerifiedDevice, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { listRoutes } from '../../lib/api-router.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
const host = new URL(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, 'http:')).hostname;
if (!/^(localhost|127\.0\.0\.1)$/.test(host)) throw new Error('data-exposure sweep only runs on a local database');

let api;
let attacker;
before(async () => { api = await startApiServer({ TONTINE_ESCROW_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

/** Resources anyone may read by design (public profiles, shops, campaigns...). */
const PUBLIC_BY_DESIGN = new Set([
  'profiles/:id',
  'merchants/:id/public',
  'marketplace/shops/:id',
  'businesses/:id', // public business card (shaped)
  'businesses/:id/reviews',
  'businesses/:id/kebu-score', // public trust score of a business
  'jekkal/campaigns/:id',
  'channels/:id',
  'affiliate/resolve/:code',
  'trending/alerts/:id',
  'work/opportunities/:id', // J9: an open posting of a verified business (no PII; blocked businesses hidden)
  // J4: a charge code is a bearer payment reference shown on a QR — whoever
  // holds it may see merchant name + amount (never payer identity or balances).
  'money/charges/:id',
]);

/**
 * Someone else's resource the attacker may read BECAUSE of a role, with the
 * shape restricted: an active courier sees OPEN delivery requests without
 * the exact dropoff or buyer id.
 */
const ROLE_BY_DESIGN = {
  // J5: someone else's address answers with the coarse area only — never the door, landmark or pin.
  'addresses/:id': (b) => b && b.lat === undefined && b.lng === undefined && b.street === undefined && b.landmark === undefined && b.building === undefined && b.instructions === undefined,
  // J4: intent lookup is per caller — someone else's key reads as "not_found", nothing else.
  'money/intents/:id': (b) => b?.state === 'not_found' && Array.isArray(b?.references) && b.references.length === 0,
  'deliveries/:id': (b) => b?.status === 'open' && b?.dropoff?.exact == null && b?.dropoff?.lat == null && b?.buyerId === undefined,
};

/** Upstream-dependent routes: fail closed (502/503) when the provider is absent. */
const UPSTREAM_ROUTES = new Set(['charts/search', 'geo/search']);

/** Routes where the attacker's OWN balance legitimately appears. */
const OWN_BALANCE_ROUTES = new Set(['wallet', 'money/home', 'me', 'me/summary', 'kori/reserve', 'agent/me', 'businesses/mine', 'businesses/:id/wallet']);

const pick = async (sql) => (await prisma.$queryRawUnsafe(sql)).map((r) => Object.values(r)[0]).filter(Boolean);

async function candidatesFor(path, me, myBizIds) {
  const notMine = (col) => `${col} <> '${me}'`;
  const otherBiz = `SELECT b."id" FROM "Business" b WHERE ${notMine('b."ownerId"')} AND b."id" NOT IN (${myBizIds.map((i) => `'${i}'`).join(',') || "''"}) ORDER BY random() LIMIT 2`;
  const table = {
    'businesses/:id': otherBiz,
    'deliveries/:id': `SELECT "id" FROM "DeliveryTask" ORDER BY random() LIMIT 2`,
    'deposits/agent/:reference': `SELECT "reference" FROM "AgentDeposit" ORDER BY random() LIMIT 2`,
    'deposits/card/:reference': `SELECT "reference" FROM "StripeDeposit" ORDER BY random() LIMIT 2`,
    'withdrawals/agent/:reference': `SELECT "reference" FROM "AgentWithdrawal" ORDER BY random() LIMIT 2`,
    // J6: someone else's cash transaction (the attacker holds the agent role but is bound to none).
    'agent-cash/tx/:id': `SELECT "id" FROM "AgentCashTransaction" WHERE "customerId" <> '${me}' ORDER BY random() LIMIT 2`,
    'hubs/parcels/:id': `SELECT "id" FROM "HubParcel" ORDER BY random() LIMIT 2`,
    'marketplace/orders/:id': `SELECT "id" FROM "Order" ORDER BY random() LIMIT 2`,
    'support/tickets/:id': `SELECT "id" FROM "SupportTicket" ORDER BY random() LIMIT 2`,
    'transfers/requests/:id': `SELECT "id" FROM "MoneyRequest" ORDER BY random() LIMIT 2`,
    'tontine/groups/:id': `SELECT "id" FROM "TontineGroup" ORDER BY random() LIMIT 2`,
    'mbolo/threads/:id': `SELECT "id" FROM "MboloThread" ORDER BY random() LIMIT 2`,
    'events/:id': `SELECT "id" FROM "Event" ORDER BY random() LIMIT 2`,
    'trending/alerts/:id': `SELECT "id" FROM "RegionalAlert" ORDER BY random() LIMIT 1`,
    'channels/:id': `SELECT "id" FROM "Channel" ORDER BY random() LIMIT 1`,
    'jekkal/campaigns/:id': `SELECT "id" FROM "SolidarityCampaign" ORDER BY random() LIMIT 1`,
    'profiles/:id': `SELECT "id" FROM "User" WHERE ${notMine('"id"')} ORDER BY random() LIMIT 2`,
    'merchants/:id': otherBiz,
    'marketplace/shops/:id': otherBiz,
    'money/activity/:reference': `(SELECT e."reference" FROM "JournalEntry" e JOIN "Posting" p ON p."entryId" = e."id" JOIN "LedgerAccount" a ON a."id" = p."accountId" WHERE a."code" LIKE 'customer:%' AND a."code" NOT LIKE 'customer:${me}:%' ORDER BY random() LIMIT 2) UNION ALL (SELECT "reference" FROM "ExternalOperation" WHERE "userId" <> '${me}' ORDER BY random() LIMIT 1)`,
    'money/intents/:id': `SELECT regexp_replace("key", '^api:[^:]+:[^:]+:', '') FROM "ApiIdempotency" WHERE "provider" = 'api' AND "userId" <> '${me}' ORDER BY random() LIMIT 2`,
    'money/charges/:id': `SELECT "code" FROM "MerchantCharge" ORDER BY random() LIMIT 1`,
    'addresses/:id': `SELECT "id" FROM "Address" WHERE NOT ("ownerType" = 'user' AND "ownerId" = '${me}') ORDER BY random() LIMIT 2`,
    // J8: shipments / disputes the attacker is no party to.
    'logistics/shipments/:id': `SELECT "id" FROM "Shipment" ORDER BY random() LIMIT 2`,
    'logistics/disputes/:id': `SELECT "id" FROM "ShipmentDispute" ORDER BY random() LIMIT 2`,
    // J9: work objects the attacker is no party to (an open posting is public by design: minimal DTO, no PII).
    'work/opportunities/:id': `SELECT "id" FROM "WorkOpportunity" WHERE status = 'open' ORDER BY random() LIMIT 2`,
    'work/assignments/:id': `SELECT "id" FROM "WorkAssignment" WHERE "workerUserId" <> '${me}' ORDER BY random() LIMIT 2`,
    'work/disputes/:id': `SELECT "id" FROM "WorkDispute" ORDER BY random() LIMIT 2`,
    'affiliate/resolve/:code': `SELECT "linkCode" FROM "AffiliateLink" ORDER BY random() LIMIT 1`,
    // J10: conversations (groups, order chats, partner threads) and evidence files the attacker is not part of.
    'mbolo/threads/:id': `SELECT t."id" FROM "MboloThread" t WHERE NOT EXISTS (SELECT 1 FROM "MboloMember" m WHERE m."threadId" = t."id" AND m."userId" = '${me}') ORDER BY random() LIMIT 3`,
    'work/evidence/files/:id': `SELECT "id" FROM "WorkEvidenceFile" ORDER BY random() LIMIT 2`,
  };
  const prefix = Object.keys(table).find((k) => path === k || path.startsWith(`${k}/`));
  if (!prefix) return null;
  const ids = await pick(table[prefix]);
  if (path.includes(':subId') && (path.includes('/os/orders/') || path.includes('/os/stock/'))) {
    // J5: a foreign business's own order / product as the sub-object.
    const table = path.includes('/os/orders/') ? '"Order"' : '"Product"';
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "businessId", "id" FROM ${table} WHERE "businessId" IS NOT NULL AND "businessId" NOT IN (${myBizIds.map((i) => `'${i}'`).join(',') || "''"}) ORDER BY random() LIMIT 2`,
    );
    return rows.map((r) => path.replace(':id', r.businessId).replace(':subId', r.id));
  }
  if (path.includes(':subId') && path.includes('/b2b/')) {
    // J7: a foreign business's own purchase order / invoice (as buyer AND as seller), supplier relationship, depot.
    const not = `NOT IN (${myBizIds.map((i) => `'${i}'`).join(',') || "''"})`;
    const sql = path.includes('/purchase-orders/')
      ? `(SELECT "buyerBusinessId" AS a, "id" AS b FROM "PurchaseOrder" WHERE "buyerBusinessId" ${not} ORDER BY random() LIMIT 1) UNION ALL (SELECT "sellerBusinessId", "id" FROM "PurchaseOrder" WHERE "sellerBusinessId" ${not} ORDER BY random() LIMIT 1)`
      : path.includes('/invoices/')
        ? `(SELECT "buyerBusinessId" AS a, "id" AS b FROM "TradeInvoice" WHERE "buyerBusinessId" IS NOT NULL AND "buyerBusinessId" ${not} ORDER BY random() LIMIT 1) UNION ALL (SELECT "supplierBusinessId", "id" FROM "TradeInvoice" WHERE "supplierBusinessId" ${not} ORDER BY random() LIMIT 1)`
        : path.includes('/suppliers/')
          ? `SELECT "merchantBusinessId" AS a, "distributorBusinessId" AS b FROM "MerchantRelationship" WHERE status = 'active' AND "merchantBusinessId" ${not} ORDER BY random() LIMIT 2`
          : `SELECT "operatorBusinessId" AS a, "id" AS b FROM "InventoryLocation" WHERE "operatorBusinessId" IS NOT NULL AND "operatorBusinessId" ${not} ORDER BY random() LIMIT 2`;
    const rows = await prisma.$queryRawUnsafe(sql);
    return rows.map((r) => path.replace(':id', r.a).replace(':subId', r.b));
  }
  if (path.includes(':subId')) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "businessId", "id" FROM "SchoolFeePeriod" WHERE "businessId" NOT IN (${myBizIds.map((i) => `'${i}'`).join(',') || "''"}) ORDER BY random() LIMIT 2`,
    );
    return rows.map((r) => path.replace(':id', r.businessId).replace(':subId', r.id));
  }
  return ids.map((id) => path.replace(/:(id|reference|code)/, encodeURIComponent(id)));
}

const QUERY_DEFAULTS = {
  'users/lookup': '?q=test',
  'agents/nearby': '?lat=14.69&lng=-17.44',
  'agent-cash/points': '?lat=14.69&lng=-17.44&service=cash_out',
  'deliveries/nearby': '?lat=14.69&lng=-17.44',
  'marketplace/shops/nearby': '?lat=14.69&lng=-17.44',
  'marketplace/search': '?q=a',
  'charts/search': '?q=a',
  'geo/search': '?q=Dakar',
};

const RAW_USER_KEYS = ['otpVerifiedAt', 'accountLockedAt', 'frozenByAdminAt', 'credentialResetRequiredAt', 'sessionsRevokedAt', 'referredByUserId', 'biometricEnabled', 'stepUpVerifiedAt'];
const BALANCE_KEYS = new Set(['koriBalance', 'floatBalance', 'balance', 'availableKori', 'spendableKori']);
const SECRET_KEYS = new Set(['token', 'tokenHash', 'pinHash', 'passwordHash', 'cniHash', 'cniNumberEnc', 'totpSecret', 'apiKey', 'apiKeyHash', 'webhookSecret', 'secret', 'stripeSessionId']);

function walk(value, visit, path = '$') {
  if (value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
  visit(value, path);
  for (const [k, v] of Object.entries(value)) walk(v, visit, `${path}.${k}`);
}

test('every authenticated GET route, called by an unrelated multi-role attacker, leaks nothing', { timeout: 600_000 }, async () => {
  const userCount = await prisma.user.count();
  assert.ok(userCount > 50, `sweep needs a populated DB (run the full suite first); users=${userCount}`);

  const user = await createUserWithWallet({ koriBalance: 1234, tier: 2 });
  const device = await createVerifiedDevice(user.id);
  attacker = { id: user.id, device, token: jwt.sign({ sub: user.id, type: 'access' }, ACCESS_SECRET), ip: freshIp() };
  const call = async (path) => {
    await prisma.userRateLimit.deleteMany({ where: { userId: attacker.id } });
    return api.client('GET', path, { token: attacker.token, device: attacker.device, ip: attacker.ip, headers: { 'x-vercel-ip-country': 'SN' } });
  };

  // Multi-role attacker: merchant (own business), courier, agent, employee of ONE other business.
  const own = await api.client('POST', 'businesses', { token: attacker.token, device, ip: attacker.ip, headers: { 'x-vercel-ip-country': 'SN' }, body: { name: `Sweep ${crypto.randomBytes(3).toString('hex')}`, type: 'merchant' } });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  await prisma.accountRole.createMany({ data: ['driver', 'personal', 'agent'].map((role) => ({ userId: attacker.id, role, status: 'active' })) });
  await prisma.agentProfile.create({ data: { userId: attacker.id, agentCode: `SW${crypto.randomBytes(3).toString('hex')}`, displayName: 'Sweep agent', status: 'active' } });

  // J6: legacy agent sessions are no longer created by any flow, but production has them
  // (history routes stay live): seed one foreign legacy deposit + withdrawal to attack.
  {
    const victim = await createUserWithWallet({ koriBalance: 0 });
    const k = crypto.randomBytes(6).toString('hex');
    const exp = new Date(Date.now() + 15 * 60_000);
    await prisma.agentDeposit.create({ data: { reference: `AGD-LEG-${k}`, token: `legdep${k}`, userId: victim.id, amountXof: 5000, status: 'pending', expiresAt: exp } });
    await prisma.agentWithdrawal.create({ data: { reference: `AGW-LEG-${k}`, token: `legwd${k}`, userId: victim.id, amountXof: 5000, status: 'pending', expiresAt: exp } });
  }
  const employer = await prisma.business.findFirst({ where: { ownerId: { not: attacker.id } }, select: { id: true } });
  if (employer) await prisma.businessMember.create({ data: { businessId: employer.id, userId: attacker.id, role: 'staff' } });
  const myBizIds = [own.body.id, employer?.id].filter(Boolean);

  // Make sure every param route has someone else's row to try.
  const victim = await createUserWithWallet({ koriBalance: 999, tier: 2 });
  const vBiz = await prisma.business.findFirst({ where: { ownerId: { notIn: [attacker.id] }, id: { notIn: myBizIds } }, select: { id: true } });
  const tag = crypto.randomBytes(4).toString('hex');
  await prisma.supportTicket.create({ data: { userId: victim.id, subject: 'private matter' } });
  await prisma.event.create({ data: { promoterId: victim.id, title: `Ev ${tag}`, startsAt: new Date(Date.now() + 864e5), ticketPrice: 100 } });
  await prisma.regionalAlert.create({ data: { alertType: 'info', severity: 'low', title: 'A', body: 'B', regionLabel: 'Dakar', source: 'test' } });
  await prisma.stripeDeposit.create({ data: { userId: victim.id, amountXof: 1000, amountEurCents: 152, reference: `SD-${tag}` } });
  await prisma.solidarityCampaign.create({ data: { creatorId: victim.id, beneficiaryUserId: victim.id, title: 'Help', goalAmount: 1000 } });
  if (vBiz) await prisma.schoolFeePeriod.create({ data: { businessId: vBiz.id, label: 'T1', amount: 1000, dueDate: new Date() } });
  const aff = await prisma.affiliateProfile.create({ data: { userId: victim.id, affiliateCode: `AF${tag}` } });
  await prisma.affiliateLink.create({ data: { affiliateId: aff.id, linkCode: `L${tag}` } });

  // Recognizable markers for everyone else's PII/credentials.
  await prisma.$executeRawUnsafe(`
    UPDATE "User" SET "email" = 'u' || "id" || '@leak.invalid', "dateOfBirth" = '1901-02-03',
      "cniHash" = 'LEAKCNI' || "id", "cniNumberEnc" = 'LEAKENC', "pinHash" = '$2b$10$LEAKPIN', "passwordHash" = '$2b$10$LEAKPWD'
    WHERE "id" <> '${attacker.id}'`);
  const otherPhones = new Set(await pick(`SELECT "phone" FROM "User" WHERE "id" <> '${attacker.id}' AND "phone" IS NOT NULL`));
  const ownPhone = user.phone;

  const routes = listRoutes().filter((r) => r.method === 'GET' && r.auth === 'user');
  const findings = [];
  const statuses = {};
  const logStart = api.logs().length;

  for (const r of routes) {
    let paths = [r.path];
    if (r.path.includes(':')) {
      paths = (await candidatesFor(r.path, attacker.id, myBizIds)) ?? [];
      if (paths.length === 0) {
        findings.push(`${r.path}: no candidate row to test with`);
        continue;
      }
    }
    for (const p of paths) {
      const res = await call(p + (QUERY_DEFAULTS[r.path] ?? ''));
      statuses[r.path] = res.status;
      if (res.status >= 500 && !(UPSTREAM_ROUTES.has(r.path) && [502, 503].includes(res.status))) {
        findings.push(`${r.path}: HTTP ${res.status}`);
      }
      const roleOk = ROLE_BY_DESIGN[r.path]?.(res.body);
      if (r.path.includes(':') && !PUBLIC_BY_DESIGN.has(r.path) && !roleOk && res.status < 300) {
        findings.push(`${r.path}: someone else's resource answered ${res.status} (horizontal authz)`);
      }
      const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
      for (const marker of ['@leak.invalid', '1901-02-03', 'LEAKCNI', 'LEAKENC', 'LEAKPIN', 'LEAKPWD', '$2a$', '$2b$']) {
        if (text.includes(marker)) findings.push(`${r.path}: contains ${marker}`);
      }
      for (const m of text.matchAll(/\+?\d{9,15}/g)) {
        if (m[0] !== ownPhone && otherPhones.has(m[0])) findings.push(`${r.path}: another user's phone`);
      }
      walk(res.body, (obj, at) => {
        const raw = RAW_USER_KEYS.filter((k) => k in obj);
        if (raw.length && obj.id !== attacker.id) findings.push(`${r.path} ${at}: raw user row (${raw.join(',')})`);
        for (const k of Object.keys(obj)) {
          if (SECRET_KEYS.has(k)) findings.push(`${r.path} ${at}.${k}: secret-bearing key`);
          if (BALANCE_KEYS.has(k) && !OWN_BALANCE_ROUTES.has(r.path)) {
            const owner = obj.userId ?? obj.ownerId ?? null;
            if (owner !== attacker.id) findings.push(`${r.path} ${at}.${k}: balance of someone else`);
          }
        }
      });
    }
  }

  const scrubbed = api.logs().slice(logStart).split('\n').filter((l) => l.includes('[scrubber] stripped'));
  for (const l of scrubbed) findings.push(`scrubber had to strip: ${l.trim()}`);

  console.log(JSON.stringify({ routes: routes.length, statuses }, null, 0));
  assert.deepEqual([...new Set(findings)], []);
});

test('ordinary user → admin/ops: every admin route refuses a user token', { timeout: 300_000 }, async () => {
  const user = await createUserWithWallet({ tier: 3 });
  const device = await createVerifiedDevice(user.id);
  const token = jwt.sign({ sub: user.id, type: 'access' }, ACCESS_SECRET);
  const admin = listRoutes().filter((r) => r.auth === 'admin');
  assert.ok(admin.length > 20);
  const bad = [];
  for (const r of admin) {
    await prisma.userRateLimit.deleteMany({ where: { userId: user.id } });
    const path = r.path.replace(/:[a-zA-Z]+/g, 'x1');
    const res = await api.client(r.method, path, { token, device, ip: freshIp(), body: r.method === 'GET' ? undefined : {} });
    if (![401, 403].includes(res.status)) bad.push(`${r.method} ${r.path} → ${res.status}`);
  }
  assert.deepEqual(bad, []);
});
