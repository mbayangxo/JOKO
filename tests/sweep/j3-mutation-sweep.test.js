/**
 * J3 horizontal-authorization sweep for MUTATIONS — real HTTP, NODE_ENV=production.
 *
 * Runs after the full suite on the same LOCAL database (`npm run test:sweep`).
 * A multi-role attacker (customer with an established, step-up session; owner
 * of their own business; ACTIVE courier and agent; staff of one other
 * business) calls EVERY mutating route that takes an object id, substituting
 * ids of objects that belong to other people.
 *
 * Fails on: a 2xx on someone else's object (unless public by design), any
 * 5xx, a route with no candidate object, or any J2 money invariant violation.
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createUserWithWallet, createVerifiedDevice, establishedSessionToken, fundUser, prisma } from '../helpers/db.js';
import { freshIp, startApiServer } from '../helpers/http-harness.js';
import { listRoutes } from '../../lib/api-router.js';
import { ROUTE_POLICY } from '../../lib/authz/route-policy.js';
import { checkInvariants } from '../../lib/money-kernel/invariants.js';

const ACCESS_SECRET = 'http-test-access-secret-0123456789';
const host = new URL(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, 'http:')).hostname;
if (!/^(localhost|127\.0\.0\.1)$/.test(host)) throw new Error('mutation sweep only runs on a local database');

let api;
before(async () => { api = await startApiServer({ TONTINE_ESCROW_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });

/**
 * Acting on someone else's object is allowed BY DESIGN here (paying a
 * merchant, buying a ticket, following a public channel …). Each is still a
 * self-scoped action: the attacker pays from / changes only their own state.
 */
const PUBLIC_BY_DESIGN = new Set([
  'POST merchants/:id/pay',
  'POST events/:id/tickets',
  'POST jekkal/campaigns/:id/contribute',
  'POST channels/:id/follow',
  'POST marketplace/products/:id/view',
  'POST affiliate/links/:code/click',
  'POST trending/alerts/:id/read',
  'POST trending/alerts/:id/share',
  'POST mbolo/gifs/:id/use',
  'POST businesses/:id/reviews', // a review is the attacker's own content about a business (verified-customer gate inside)
  'POST polls/:id/vote', // profile polls are public: the vote is the attacker's own
  // Self-scoped by construction: deletes only friendship edges that include the caller.
  'DELETE friends/:id',
  // Role by design: the attacker IS an active courier, and accepting an OPEN
  // job is what couriers do (the buyer requested it; escrow is the buyer's own
  // request). Pickup/deliver/confirm on someone else's job stay refused.
  'POST deliveries/:id/accept',
  'POST deliveries/:id/claim',
  // J4: paying a merchant's charge (QR) is paying that merchant — the attacker's own money, server amount.
  'POST money/charges/:id/pay',
]);
// (J5) A relationship invitation id of someone else must never be answerable.

/** Object id sources for each param route (rows that are NOT the attacker's). */
function sourceFor(routeKey) {
  const path = routeKey.split(' ')[1];
  const map = [
    [/^payment-funds\/:id/, `SELECT "id" FROM "PaymentFund" WHERE "userId" <> $ME`],
    [/^scheduled-payments\/:id/, `SELECT "id" FROM "ScheduledPayment" WHERE "userId" <> $ME`],
    [/^hubs\/parcels\/:id/, `SELECT "id" FROM "HubParcel"`],
    [/^marketplace\/products\/:id/, `SELECT p."id" FROM "Product" p WHERE p."businessId" IS NULL OR p."businessId" NOT IN ($MYBIZ)`],
    [/^marketplace\/business\/:id/, `SELECT "id" FROM "Business" WHERE "id" NOT IN ($MYBIZ)`],
    [/^marketplace\/orders\/:id/, `SELECT "id" FROM "Order" WHERE "buyerId" IS DISTINCT FROM $ME`],
    [/^distribution\/invoices\/:id/, `SELECT "id" FROM "TradeInvoice"`],
    [/^transfers\/:reference\/undo/, `SELECT "reference" FROM "LedgerEntry" WHERE "type" = 'send' AND "userId" <> $ME`],
    [/^transfers\/requests\/:id/, `SELECT "id" FROM "MoneyRequest" WHERE "requesterId" <> $ME AND "payerId" IS DISTINCT FROM $ME`],
    [/^deliveries\/:id/, `SELECT "id" FROM "DeliveryTask" WHERE "buyerId" IS DISTINCT FROM $ME AND "assignedDriverId" IS DISTINCT FROM $ME`],
    [/^agent\/deposits\/:id/, `SELECT "id" FROM "AgentDeposit"`],
    [/^agent\/withdrawals\/:id/, `SELECT "id" FROM "AgentWithdrawal"`],
    // J6: foreign cash transactions and service points.
    [/^agent-cash\/tx\/:id/, `SELECT "id" FROM "AgentCashTransaction" WHERE "customerId" <> $ME`],
    [/^agent\/cash\/:id/, `SELECT "id" FROM "AgentCashTransaction" WHERE "customerId" <> $ME`],
    [/^agent\/service-points\/:id/, `SELECT sp."id" FROM "AgentServicePoint" sp JOIN "AgentOrganization" o ON o."id" = sp."organizationId" WHERE o."ownerUserId" <> $ME`],
    [/^tontine\/groups\/:id/, `SELECT "id" FROM "TontineGroup" WHERE "createdBy" <> $ME`],
    [/^mbolo\/threads\/:id/, `SELECT t."id" FROM "MboloThread" t WHERE NOT EXISTS (SELECT 1 FROM "MboloMember" m WHERE m."threadId" = t."id" AND m."userId" = $ME)`],
    [/^mbolo\/messages\/:id/, `SELECT "id" FROM "MboloMessage" WHERE "senderId" <> $ME`],
    [/^mbolo\/vault\/:id/, `SELECT "id" FROM "MbooloMediaAsset" WHERE "ownerId" <> $ME`],
    [/^mbolo\/gifs\/:id/, `SELECT "id" FROM "MbooloGif"`],
    [/^events\/:id/, `SELECT "id" FROM "Event" WHERE "promoterId" <> $ME`],
    [/^jekkal\/campaigns\/:id/, `SELECT "id" FROM "SolidarityCampaign" WHERE "creatorId" <> $ME`],
    [/^friends\/requests\/:id/, `SELECT "id" FROM "FriendRequest" WHERE "toId" <> $ME AND "fromId" <> $ME`],
    [/^friends\/:id/, `SELECT "id" FROM "User" WHERE "id" <> $ME`],
    [/^notifications\/:id/, `SELECT "id" FROM "Notification" WHERE "userId" <> $ME`],
    [/^trust\/block\/:id/, `SELECT "id" FROM "UserBlock" WHERE "blockerId" <> $ME`],
    [/^channels\/posts\/:id/, `SELECT p."id" FROM "ChannelPost" p JOIN "Channel" c ON c."id" = p."channelId" WHERE c."ownerId" <> $ME`],
    [/^channels\/:id/, `SELECT "id" FROM "Channel" WHERE "ownerId" <> $ME`],
    [/^polls\/:id/, `SELECT "id" FROM "UserPoll" WHERE "userId" <> $ME`],
    [/^merchants\/:id/, `SELECT "id" FROM "Business" WHERE "id" NOT IN ($MYBIZ)`],
    [/^affiliate\/links\/:code/, `SELECT "linkCode" FROM "AffiliateLink"`],
    [/^trending\/alerts\/:id/, `SELECT "id" FROM "RegionalAlert"`],
    [/^support\/tickets\/:id/, `SELECT "id" FROM "SupportTicket" WHERE "userId" <> $ME`],
    [/^auth\/sessions\/:id/, `SELECT "id" FROM "AuthSession" WHERE "userId" <> $ME`],
    [/^auth\/devices\/:id/, `SELECT "id" FROM "UserDevice" WHERE "userId" <> $ME`],
    // J5 business OS sub-objects: another business's own rows.
    [/^businesses\/:id\/os\/orders\/:subId/, `SELECT "businessId" || '|' || "id" FROM "Order" WHERE "businessId" IS NOT NULL AND "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/os\/(catalog|stock)\/:subId/, `SELECT "businessId" || '|' || "id" FROM "Product" WHERE "businessId" IS NOT NULL AND "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/os\/relationships\/:subId/, `SELECT "merchantBusinessId" || '|' || "id" FROM "MerchantRelationship" WHERE "merchantBusinessId" IS NOT NULL AND "merchantBusinessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/os\/integrations\/:subId/, `SELECT "businessId" || '|' || "id" FROM "ExternalLink" WHERE "businessId" IS NOT NULL AND "businessId" NOT IN ($MYBIZ)`],
    [/^me\/distribution-invitations\/:id/, `SELECT "id" FROM "MerchantRelationship" WHERE "invitedUserId" IS DISTINCT FROM $ME`],
    [/^businesses\/:id\/os\/locations\/:subId/, `SELECT "businessId" || '|' || "id" FROM "BusinessLocation" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/members\/:subId/, `SELECT "businessId" || '|' || "id" FROM "BusinessMember" WHERE "businessId" NOT IN ($MYBIZ) AND "userId" <> $ME`],
    [/^businesses\/:id\/school\/periods\/:subId/, `SELECT "businessId" || '|' || "id" FROM "SchoolFeePeriod" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/cooperative\/deliveries\/:subId/, `SELECT "businessId" || '|' || "id" FROM "FarmerDeliveryLog" WHERE "businessId" NOT IN ($MYBIZ)`],
    // J7 B2B sub-objects: another business's purchase orders / invoices / returns (both sides), relationships, territories, depots.
    [/^businesses\/:id\/b2b\/purchase-orders\/:subId/, `SELECT v FROM (SELECT "buyerBusinessId" || '|' || "id" AS v FROM "PurchaseOrder" WHERE "buyerBusinessId" NOT IN ($MYBIZ) UNION ALL SELECT "sellerBusinessId" || '|' || "id" FROM "PurchaseOrder" WHERE "sellerBusinessId" NOT IN ($MYBIZ)) u`],
    [/^businesses\/:id\/b2b\/invoices\/:subId/, `SELECT v FROM (SELECT "buyerBusinessId" || '|' || "id" AS v FROM "TradeInvoice" WHERE "buyerBusinessId" IS NOT NULL AND "buyerBusinessId" NOT IN ($MYBIZ) UNION ALL SELECT "supplierBusinessId" || '|' || "id" FROM "TradeInvoice" WHERE "supplierBusinessId" NOT IN ($MYBIZ)) u`],
    [/^businesses\/:id\/b2b\/returns\/:subId/, `SELECT v FROM (SELECT "buyerBusinessId" || '|' || "id" AS v FROM "CommercialReturn" WHERE "buyerBusinessId" NOT IN ($MYBIZ) UNION ALL SELECT "sellerBusinessId" || '|' || "id" FROM "CommercialReturn" WHERE "sellerBusinessId" NOT IN ($MYBIZ)) u`],
    [/^businesses\/:id\/b2b\/relationships\/:subId/, `SELECT "distributorBusinessId" || '|' || "id" FROM "MerchantRelationship" WHERE "distributorBusinessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/b2b\/territories\/:subId/, `SELECT "distributorBusinessId" || '|' || "id" FROM "Territory" WHERE "distributorBusinessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/b2b\/depots\/:subId/, `SELECT "operatorBusinessId" || '|' || "id" FROM "InventoryLocation" WHERE "operatorBusinessId" IS NOT NULL AND "operatorBusinessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id/, `SELECT "id" FROM "Business" WHERE "id" NOT IN ($MYBIZ)`],
    [/^money\/charges\/:id/, `SELECT "code" FROM "MerchantCharge" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^money\/payments\/:reference/, `SELECT e."reference" FROM "JournalEntry" e WHERE e."kind" IN ('pay_merchant','merchant_payment','charge_payment','business_payment') AND NOT EXISTS (SELECT 1 FROM "Posting" p JOIN "LedgerAccount" a ON a."id" = p."accountId" WHERE p."entryId" = e."id" AND (a."code" LIKE 'customer:' || $ME || ':%' OR a."ownerId" IN ($ME, $MYBIZ)))`],
    [/^roles\/:id/, null], // self-scoped: covered by tests/j3/authz-roles (no foreign object)
  ];
  const hit = map.find(([re]) => re.test(path));
  return hit ? hit[1] : undefined;
}

const BODY = (attackerBizId) => ({
  merchantBusinessId: attackerBizId,
  priceKori: 1,
  delta: 50,
  note: 'sweep: someone else’s stock',
  amount: 100,
  amountXof: 100,
  reason: 'sweep: acting on someone else’s object',
  note: 'sweep',
  status: 'delivered',
  rating: 5,
  text: 'sweep',
  body: 'sweep',
  content: 'sweep',
  message: 'sweep',
  optionIndex: 0,
  userHandle: 'nobody_sweep',
  role: 'staff',
  accept: true,
  kind: 'b2b',
  recipientBusinessId: attackerBizId,
  price: 100,
  name: 'sweep',
  label: 'T1',
  dueDate: new Date().toISOString(),
  // J7: shapes that pass validation, so authorization (not zod) is what refuses.
  approve: true,
  action: 'receive',
  to: 'preparing',
  expectedAmountKori: 100,
  amountKori: 100,
  resolution: 'none',
  restock: true,
  repUserId: 'nobody',
});

test('every mutating id-route, called by an unrelated multi-role attacker on other people’s objects, is refused', { timeout: 900_000 }, async () => {
  assert.ok((await prisma.user.count()) > 50, 'run after the full suite (populated DB)');

  const user = await createUserWithWallet({ koriBalance: 0, tier: 3 });
  await fundUser(user.id, 50_000);
  const device = await createVerifiedDevice(user.id);
  const token = await establishedSessionToken(user.id, device, ACCESS_SECRET, { stepUp: true });
  const ip = freshIp();
  const H = { 'x-vercel-ip-country': 'SN' };
  const own = await prisma.business.create({ data: { ownerId: user.id, name: `Sweep ${crypto.randomBytes(3).toString('hex')}` } });
  await prisma.accountRole.createMany({ data: ['personal', 'driver', 'agent'].map((role) => ({ userId: user.id, role, status: 'active' })) });
  await prisma.agentProfile.create({ data: { userId: user.id, agentCode: `MS${crypto.randomBytes(3).toString('hex')}`, displayName: 'Sweep agent', status: 'active' } });

  // J6: legacy agent sessions are no longer created by any flow, but production has them
  // (history routes stay live): seed one foreign legacy deposit + withdrawal to attack.
  {
    const victim = await createUserWithWallet({ koriBalance: 0 });
    const k = crypto.randomBytes(6).toString('hex');
    const exp = new Date(Date.now() + 15 * 60_000);
    await prisma.agentDeposit.create({ data: { reference: `AGD-LEG-${k}`, token: `legdep${k}`, userId: victim.id, amountXof: 5000, status: 'pending', expiresAt: exp } });
    await prisma.agentWithdrawal.create({ data: { reference: `AGW-LEG-${k}`, token: `legwd${k}`, userId: victim.id, amountXof: 5000, status: 'pending', expiresAt: exp } });
  }
  const employer = await prisma.business.findFirst({ where: { ownerId: { not: user.id }, id: { not: own.id } }, select: { id: true } });
  if (employer) await prisma.businessMember.create({ data: { businessId: employer.id, userId: user.id, role: 'staff', status: 'active' } });
  const myBiz = [own.id, employer?.id].filter(Boolean);
  const body = BODY(own.id);

  // Make sure every route has a foreign object to try (a victim's rows).
  const victim = await createUserWithWallet({ koriBalance: 0, tier: 2 });
  const tag = crypto.randomBytes(4).toString('hex');
  const fund = await prisma.paymentFund.create({ data: { userId: victim.id, name: 'Savings' } });
  await prisma.scheduledPayment.create({ data: { userId: victim.id, fundId: fund.id, amountKori: 10, scheduleType: 'monthly', scheduleDay: 1, nextRunAt: new Date(Date.now() + 864e5) } });
  await prisma.supportTicket.create({ data: { userId: victim.id, subject: 'private matter' } });
  await prisma.event.create({ data: { promoterId: victim.id, title: `Ev ${tag}`, startsAt: new Date(Date.now() + 864e5), ticketPrice: 0 } });
  await prisma.regionalAlert.create({ data: { alertType: 'info', severity: 'low', title: 'A', body: 'B', regionLabel: 'Dakar', source: 'test' } });
  await prisma.solidarityCampaign.create({ data: { creatorId: victim.id, beneficiaryUserId: victim.id, title: 'Help', goalAmount: 1000 } });
  const aff = await prisma.affiliateProfile.create({ data: { userId: victim.id, affiliateCode: `MX${tag}` } });
  await prisma.affiliateLink.create({ data: { affiliateId: aff.id, linkCode: `M${tag}` } });
  await prisma.userPoll.create({ data: { userId: victim.id, question: 'Q?', options: ['a', 'b'] } });
  const friendA = await createUserWithWallet({});
  await prisma.friendRequest.create({ data: { fromId: victim.id, toId: friendA.id } }).catch(() => {});
  const vBiz = await prisma.business.findFirst({ where: { id: { notIn: myBiz } }, select: { id: true, ownerId: true } });
  if (vBiz) {
    await prisma.merchantCharge.create({
      data: { code: `SWEEP${crypto.randomBytes(8).toString('hex')}`, businessId: vBiz.id, createdBy: vBiz.ownerId, amountKori: 100, expiresAt: new Date(Date.now() + 30 * 60_000) },
    });
  }

  const routes = listRoutes().filter((r) => r.auth === 'user' && r.method !== 'GET' && r.path.includes(':'));
  const findings = [];
  const tested = [];
  for (const r of routes) {
    const rk = `${r.method} ${r.path}`;
    const sql = sourceFor(rk);
    if (sql === null) continue;
    if (sql === undefined) {
      findings.push(`${rk}: no candidate source defined`);
      continue;
    }
    const q = sql
      .replaceAll('$ME', `'${user.id}'`)
      .replaceAll('$MYBIZ', myBiz.map((i) => `'${i}'`).join(','));
    const rows = await prisma.$queryRawUnsafe(`${q} ORDER BY random() LIMIT 2`).catch((e) => {
      findings.push(`${rk}: candidate query failed (${e.message.slice(0, 80)})`);
      return [];
    });
    const ids = rows.map((x) => String(Object.values(x)[0]));
    if (!ids.length) {
      findings.push(`${rk}: no foreign object to test with`);
      continue;
    }
    for (const id of ids) {
      const [a, b] = id.split('|');
      const path = r.path.replace(/:(id|reference|code)/, encodeURIComponent(a)).replace(':subId', encodeURIComponent(b ?? ''));
      await prisma.userRateLimit.deleteMany({ where: { userId: user.id } });
      const res = await api.client(r.method, path, { token, device, ip, headers: H, body });
      tested.push(`${rk} → ${res.status}`);
      if (res.status >= 500) findings.push(`${rk}: HTTP ${res.status}`);
      if (res.status < 300 && !PUBLIC_BY_DESIGN.has(rk)) findings.push(`${rk}: someone else's object accepted (${res.status}) ${JSON.stringify(res.body).slice(0, 120)}`);
      if (res.status < 300 && PUBLIC_BY_DESIGN.has(rk) && ROUTE_POLICY[rk].resource === undefined) findings.push(`${rk}: undocumented`);
    }
  }
  const inv = await checkInvariants(prisma);
  if (!inv.ok) findings.push(`money invariants: ${inv.violations.map((v) => v.id).join(',')}`);
  console.log(JSON.stringify({ mutatingIdRoutes: routes.length, calls: tested.length }));
  assert.deepEqual([...new Set(findings)], []);
});
