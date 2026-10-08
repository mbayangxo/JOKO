#!/usr/bin/env node
/**
 * J2 production-shaped migration rehearsal (LOCAL ONLY).
 *
 *   REHEARSAL_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres node scripts/rehearse-migration.mjs
 *
 *  1. Build a database from prisma/migrations/0_baseline (the 2026-08-17
 *     production shape) and seed legacy-shaped value in every balance column,
 *     legacy XOF, a pre-J1 escrow, legacy tontine contributions and a legacy
 *     Kebu investment.
 *  2. Baseline it (0_baseline applied), run scripts/db-migrate-deploy.mjs.
 *  3. Backfill dry run → execute; invariant checker; legacy totals == ledger.
 *  4. Run real kernel flows on the migrated data; invariant checker again.
 *  5. Run the read-only exposure pack.
 * Writes a JSON report to stdout. Refuses any non-local host.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const admin = process.env.REHEARSAL_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const host = new URL(admin).hostname;
if (!/^(localhost|127\.0\.0\.1)$/.test(host)) throw new Error('rehearsal is local-only');
const dbName = `joko_rehearsal_${Date.now()}`;
const dbUrl = admin.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`) + (admin.includes('?') ? '' : '?sslmode=disable');
const report = { database: dbName, steps: [] };
const step = (name, data) => {
  report.steps.push({ name, ...data });
  console.error(`[rehearsal] ${name}${data?.ok === false ? ' — FAILED' : ''}`);
};

const pclient = (url) => new PrismaClient({ datasources: { db: { url } } });
const adminClient = pclient(admin);
await adminClient.$executeRawUnsafe(`CREATE DATABASE ${dbName}`);
await adminClient.$disconnect();

const base = spawnSync(join(root, 'node_modules/.bin/prisma'), ['db', 'execute', '--file', join(root, 'prisma/migrations/0_baseline/migration.sql'), '--url', dbUrl], { cwd: root, encoding: 'utf8' });
if (base.status !== 0) throw new Error(`baseline failed: ${base.stderr}`);
const prismaDb = pclient(dbUrl);
// Minimal pg-like facade over Prisma raw queries.
const db = {
  query: async (sql, params = []) => ({ rows: await prismaDb.$queryRawUnsafe(sql, ...params) }),
  end: () => prismaDb.$disconnect(),
};
step('baseline schema created (production shape)', { ok: true });

// ---------------------------------------------------------------------------
// Introspection-driven seeding for the baseline shape
// ---------------------------------------------------------------------------
async function insert(table, values) {
  const cols = (await db.query(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  )).rows;
  const row = { ...values };
  for (const c of cols) {
    if (c.column_name in row || c.is_nullable === 'YES' || c.column_default != null) continue;
    if (c.column_name === 'id') row.id = randomUUID();
    else if (/timestamp/.test(c.data_type)) row[c.column_name] = new Date();
    else if (/integer|bigint|double|numeric/.test(c.data_type)) row[c.column_name] = 0;
    else if (c.data_type === 'boolean') row[c.column_name] = false;
    else if (c.data_type === 'jsonb') row[c.column_name] = '{}';
    else row[c.column_name] = `${c.column_name}-${randomUUID().slice(0, 8)}`;
  }
  const keys = Object.keys(row);
  const sql = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`;
  return (await db.query(sql, keys.map((k) => row[k]))).rows[0];
}

const users = [];
for (let i = 0; i < 6; i += 1) {
  const u = await insert('User', { id: randomUUID(), phone: `+22177000${1000 + i}`, handle: `legacy${i}`, name: `Legacy ${i}` });
  const w = await insert('Wallet', { id: randomUUID(), userId: u.id, koriBalance: 1000 * (i + 1), balance: i === 5 ? 25_000 : 0 });
  users.push({ ...u, wallet: w });
}
const biz = await insert('Business', { id: randomUUID(), ownerId: users[0].id, name: 'Legacy Shop', type: 'merchant' });
await insert('BusinessWallet', { id: randomUUID(), businessId: biz.id, balance: 7_000 });
await insert('PaymentFund', { id: randomUUID(), userId: users[1].id, name: 'Épargne', balanceKori: 1_500 });
await insert('MerchantVoucher', { id: randomUUID(), userId: users[2].id, businessId: biz.id, balanceKori: 400 });
const agent = await insert('AgentProfile', { id: randomUUID(), userId: users[3].id, agentCode: 'AGT-LEG1', displayName: 'Agent legacy', floatBalance: 120_000 });
// The legacy createAgentProfile also wrote an active agent role.
await insert('AccountRole', { id: randomUUID(), userId: users[3].id, role: 'agent', status: 'active' });
const tontine = await insert('TontineGroup', { id: randomUUID(), name: 'Tontine legacy', createdBy: users[4].id, amountPerMember: 500, potBalance: 1_000 });
await insert('TontineContribution', { id: randomUUID(), groupId: tontine.id, userId: users[4].id, cycleKey: '2026-08', amountKori: 500, reference: 'LEG-TC-1' });
const order = await insert('Order', { id: randomUUID(), buyerId: users[5].id, businessId: biz.id, totalAmount: 1500 });
const task = await insert('DeliveryTask', { id: randomUUID(), orderId: order.id, buyerId: users[5].id, pickupAddress: 'A', dropoffArea: 'B', deliveryFeeNational: 1500, status: 'assigned' });
await insert('DeliveryEscrow', { id: randomUUID(), deliveryTaskId: task.id, buyerId: users[5].id, amountNational: 1500, koriPayout: 150, status: 'reserved', reference: 'LEG-ESC-1' });
const offering = await insert('KebuInvestmentOffering', { id: randomUUID(), businessId: biz.id, title: 'Legacy raise', targetKori: 100_000 });
await insert('KebuInvestment', { id: randomUUID(), offeringId: offering.id, investorId: users[2].id, amountKori: 2_500, reference: 'LEG-INV-1' });
// J5: a legacy product on the legacy shop (pre-J5 catalog row, no SKU/kind).
const legacyProduct = await insert('Product', { id: randomUUID(), businessId: biz.id, title: 'Produit legacy', price: 200, inventory: 6, trackInventory: true, active: true });
await db.query(`UPDATE "Business" SET "verified" = true WHERE id = $1`, [biz.id]);
// J4: a legacy pending money request (pre-expiry) must survive unchanged.
const legacyRequest = await insert('MoneyRequest', { id: randomUUID(), requesterId: users[0].id, payerId: users[1].id, amount: 700, status: 'pending', reference: 'LEG-REQ-1' });
// J7: a legacy trade account + partially paid invoice, and one pre-J7 "waived" invoice (amountKori overwritten to 0 after a payment).
const legacyAccount = await insert('TradeAccount', { id: randomUUID(), supplierBusinessId: biz.id, buyerUserId: users[1].id, paymentTerm: 'net30', creditLimitKori: 20_000, active: true });
const legacyInvoice = await insert('TradeInvoice', { id: randomUUID(), supplierBusinessId: biz.id, buyerUserId: users[1].id, tradeAccountId: legacyAccount.id, reference: 'LEG-INV-T1', amountKori: 5_000, amountPaid: 1_000, status: 'partial', dueAt: new Date(Date.now() + 10 * 86_400_000) });
await insert('TradeInvoice', { id: randomUUID(), supplierBusinessId: biz.id, buyerUserId: users[1].id, tradeAccountId: legacyAccount.id, reference: 'LEG-INV-T2', amountKori: 0, amountPaid: 300, status: 'paid', dueAt: new Date() });

const legacy = (await db.query(`SELECT
  (SELECT SUM("koriBalance") FROM "Wallet")::int AS wallets,
  (SELECT SUM(balance) FROM "BusinessWallet")::int AS business,
  (SELECT SUM("balanceKori") FROM "PaymentFund")::int AS funds,
  (SELECT SUM("balanceKori") FROM "MerchantVoucher")::int AS vouchers,
  (SELECT SUM("floatBalance") FROM "AgentProfile")::int AS agent_float_xof,
  (SELECT SUM("potBalance") FROM "TontineGroup")::int AS pots,
  (SELECT SUM("amountNational") FROM "DeliveryEscrow" WHERE status='reserved')::int AS escrow,
  (SELECT SUM(balance) FROM "Wallet")::int AS legacy_wallet_xof,
  (SELECT COUNT(*) FROM "KebuInvestment")::int AS kebu_investments,
  (SELECT COUNT(*) FROM "TontineContribution")::int AS legacy_tontine_rows`)).rows[0];
step('legacy-shaped value seeded', { ok: true, legacy });
await db.end();

const env = { ...process.env, DATABASE_URL: dbUrl, DIRECT_DATABASE_URL: dbUrl, NODE_ENV: 'development' };
const node = (args, extra = {}) => spawnSync(process.execPath, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });

// Destructive guard sanity: the OLD deploy path (db push) on this shape.
const prismaBin = join(root, 'node_modules/.bin/prisma');
const diffOld = spawnSync(prismaBin, ['migrate', 'diff', '--from-url', dbUrl, '--to-schema-datamodel', join(root, 'prisma/schema.prisma'), '--script'], { cwd: root, env, encoding: 'utf8' });
const destructive = (diffOld.stdout.match(/DROP TABLE|DROP COLUMN|SET DATA TYPE|SET NOT NULL/g) ?? []).length;
step('database → schema diff on production shape', { ok: destructive === 0, destructiveStatements: destructive });

const inert = node(['scripts/db-migrate-deploy.mjs']);
step('migrate deploy without activation refuses', { ok: inert.status === 3, exit: inert.status });
const noBaseline = node(['scripts/db-migrate-deploy.mjs'], { MIGRATION_DEPLOY_ACTIVATED: 'true' });
step('migrate deploy before baselining refuses', { ok: noBaseline.status !== 0, exit: noBaseline.status });

execFileSync(prismaBin, ['migrate', 'resolve', '--applied', '0_baseline'], { cwd: root, env, stdio: 'ignore' });
const deploy = node(['scripts/db-migrate-deploy.mjs'], { MIGRATION_DEPLOY_ACTIVATED: 'true' });
step('baseline resolved + migrate deploy (J1 + J2 migrations) + guards', { ok: deploy.status === 0, exit: deploy.status, output: (deploy.stdout + deploy.stderr).split('\n').filter((l) => l.includes('[db-migrate]')) });
if (deploy.status !== 0) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const dry = node(['scripts/money-backfill.mjs']);
step('backfill dry run', { ok: dry.status === 0, summary: JSON.parse(dry.stdout || '{}') });
const exec = node(['scripts/money-backfill.mjs', '--execute']);
step('backfill execute', { ok: exec.status === 0, summary: JSON.parse(exec.stdout || '{}') });

const check1 = node(['scripts/money-check.mjs', '--json']);
const c1 = JSON.parse(check1.stdout || '{}');
step('invariant checker after backfill', { ok: check1.status === 0, violations: c1.violations, warnings: c1.warnings?.map((w) => ({ id: w.id, count: w.count })), stats: c1.stats });

// Legacy totals vs ledger
const prisma2 = pclient(dbUrl);
const db2 = {
  query: async (sql, params = []) => ({ rows: await prisma2.$queryRawUnsafe(sql, ...params) }),
  end: () => prisma2.$disconnect(),
};
const ledger = (await db2.query(`SELECT
  (SELECT COALESCE(SUM(balance),0) FROM "LedgerAccount" WHERE type='customer_available')::int AS wallets,
  (SELECT COALESCE(SUM(balance),0) FROM "LedgerAccount" WHERE type='business_wallet')::int AS business,
  (SELECT COALESCE(SUM(balance),0) FROM "LedgerAccount" WHERE type='payment_fund')::int AS funds,
  (SELECT COALESCE(SUM(balance),0) FROM "LedgerAccount" WHERE type='voucher')::int AS vouchers,
  (SELECT COALESCE(SUM(balance),0) FROM "LedgerAccount" WHERE type='agent_float')::int AS agent_float_xof,
  (SELECT COALESCE(SUM(balance),0) FROM "LedgerAccount" WHERE type='tontine_pot')::int AS pots,
  (SELECT COALESCE(SUM(balance),0) FROM "LedgerAccount" WHERE type='escrow_delivery')::int AS escrow,
  (SELECT COALESCE(SUM(balance),0) FROM "LedgerAccount" WHERE code='migration:opening:KRI')::int AS migration_opening_kri,
  (SELECT COUNT(*) FROM "JournalEntry" WHERE kind='opening_balance')::int AS opening_entries,
  (SELECT COUNT(*) FROM "TontineContribution")::int AS legacy_tontine_rows_after,
  (SELECT COUNT(*) FROM "KebuInvestment")::int AS kebu_investments_after`)).rows[0];
const keys = ['wallets', 'business', 'funds', 'vouchers', 'agent_float_xof', 'pots', 'escrow'];
const equal = keys.every((k) => Number(ledger[k]) === Number(legacy[k]));
step('legacy totals == ledger balances (per balance type)', { ok: equal && ledger.legacy_tontine_rows_after === legacy.legacy_tontine_rows && ledger.kebu_investments_after === legacy.kebu_investments, legacy, ledger });

// Real kernel flows on migrated data (P2P between legacy users, escrow release).
const flows = node(['--input-type=module', '-e', `
  const { prisma } = await import('./lib/prisma.js');
  const { customerToCustomer, account, move, customer } = await import('./lib/money-kernel/index.js');
  const u = await prisma.user.findMany({ orderBy: { phone: 'asc' }, take: 6 });
  await prisma.$transaction((tx) => customerToCustomer(tx, { fromUserId: u[0].id, toUserId: u[1].id, amount: 300, reference: 'REH-P2P-1', kind: 'p2p_transfer' }));
  const task = await prisma.deliveryEscrow.findFirst({ where: { status: 'reserved' } });
  await prisma.$transaction(async (tx) => move(tx, { from: await account(tx, 'escrowDelivery', task.deliveryTaskId), to: await customer(tx, u[5].id), amount: 1500, reference: 'REH-ESC-REFUND', kind: 'escrow_refund', actor: { type: 'system' }, authorization: 'rehearsal_refund' }));
  await prisma.deliveryEscrow.update({ where: { id: task.id }, data: { status: 'refunded' } });
  await prisma.$disconnect();
  console.log('ok');
`]);
step('kernel flows on migrated data (P2P + legacy escrow refund)', { ok: flows.status === 0, stderr: flows.stderr.slice(0, 500) });
const check2 = node(['scripts/money-check.mjs', '--json']);
const c2 = JSON.parse(check2.stdout || '{}');
step('invariant checker after flows', { ok: check2.status === 0, violations: c2.violations, stats: c2.stats });

// J4 migration (additive): legacy request untouched, never auto-expired (no invented expiry),
// charges table present and empty; the request is still payable through the J4 service.
const j4 = (await db2.query(`SELECT
  (SELECT COUNT(*) FROM "_prisma_migrations" WHERE migration_name LIKE '%_j4_money' AND finished_at IS NOT NULL)::int AS j4_applied,
  (SELECT COUNT(*) FROM "MerchantCharge")::int AS charges,
  (SELECT status FROM "MoneyRequest" WHERE id = $1) AS req_status,
  (SELECT "expiresAt" FROM "MoneyRequest" WHERE id = $1) AS req_expires,
  (SELECT amount FROM "MoneyRequest" WHERE id = $1)::int AS req_amount`, [legacyRequest.id])).rows[0];
const legacyPay = node(['--input-type=module', '-e', `
  const { prisma } = await import('./lib/prisma.js');
  const { acceptMoneyRequest } = await import('./lib/money-request-service.js');
  await acceptMoneyRequest(prisma, { requestId: '${legacyRequest.id}', payerUserId: '${users[1].id}' });
  const r = await prisma.moneyRequest.findUnique({ where: { id: '${legacyRequest.id}' } });
  console.log(r.status);
  await prisma.$disconnect();
`]);
const check3 = node(['scripts/money-check.mjs', '--json']);
step('J4 migration additive on production shape (legacy request preserved, no invented expiry, still payable; charges empty)', {
  ok: j4.j4_applied === 1 && j4.charges === 0 && j4.req_status === 'pending' && j4.req_expires === null && j4.req_amount === 700 && legacyPay.status === 0 && check3.status === 0,
  j4: { ...j4, req_expires: j4.req_expires ?? null },
  legacyRequestPaidThroughJ4: legacyPay.stdout.trim() || legacyPay.stderr.slice(0, 300),
  invariantsAfter: check3.status === 0 ? 'ok' : JSON.parse(check3.stdout || '{}').violations,
});

// J5 migration (additive, behaviour-preserving): the existing shop keeps
// owner-personal settlement, its badge maps to 'verified', stock history is
// append-only, and a real order + customer cancellation run on migrated data.
const j5 = (await db2.query(`SELECT
  (SELECT COUNT(*) FROM "_prisma_migrations" WHERE migration_name LIKE '%_j5_business' AND finished_at IS NOT NULL)::int AS j5_applied,
  (SELECT "settlementMode" FROM "Business" WHERE id = $1) AS settlement,
  (SELECT "verificationStatus" FROM "Business" WHERE id = $1) AS verification,
  (SELECT kind FROM "Product" WHERE id = $2) AS kind,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'StockMovement_append_only')::int AS stock_guard`, [biz.id, legacyProduct.id])).rows[0];
const j5flow = node(['--input-type=module', '-e', `
  const { prisma } = await import('./lib/prisma.js');
  const { placeMarketplaceOrder } = await import('./lib/marketplace-service.js');
  const { cancelOrder } = await import('./lib/commerce/orders.js');
  const buyerId = '${users[2].id}';
  const before = (await prisma.wallet.findUnique({ where: { userId: buyerId } })).koriBalance;
  const { order } = await placeMarketplaceOrder(prisma, { buyerId, businessId: '${biz.id}', items: [{ productId: '${legacyProduct.id}', quantity: 2 }], fulfillmentType: 'pickup', reference: 'REH-J5-ORDER' });
  const mid = (await prisma.wallet.findUnique({ where: { userId: buyerId } })).koriBalance;
  const stockMid = (await prisma.product.findUnique({ where: { id: '${legacyProduct.id}' } })).inventory;
  await cancelOrder(buyerId, order.id, { as: 'buyer', reason: 'répétition J5' });
  const after = (await prisma.wallet.findUnique({ where: { userId: buyerId } })).koriBalance;
  const stockAfter = (await prisma.product.findUnique({ where: { id: '${legacyProduct.id}' } })).inventory;
  console.log(JSON.stringify({ settledTo: order.settledTo, paid: before - mid, refunded: after - mid, stockMid, stockAfter }));
  await prisma.$disconnect();
`]);
const check4 = node(['scripts/money-check.mjs', '--json']);
let flow5 = null;
try { flow5 = JSON.parse(j5flow.stdout.trim().split('\n').pop()); } catch { flow5 = { error: j5flow.stderr.slice(0, 400) }; }
step('J5 migration behaviour-preserving on production shape (owner settlement kept, verification mapped, stock guard, order + cancel on migrated data)', {
  ok: j5.j5_applied === 1 && j5.settlement === 'owner' && j5.verification === 'verified' && j5.kind === 'product' && j5.stock_guard === 1
    && flow5?.settledTo === 'owner' && flow5?.paid === 400 && flow5?.refunded === 400 && flow5?.stockMid === 4 && flow5?.stockAfter === 6 && check4.status === 0,
  j5,
  flow: flow5,
  invariantsAfter: check4.status === 0 ? 'ok' : JSON.parse(check4.stdout || '{}').violations,
});

// J6.0 + J6 (additive): historical partner payments stay legacy-labelled; the
// legacy agent keeps its status and float, cannot operate until adopted and its
// service point approved, then runs a real J6 cash-in on migrated data.
const j6 = (await db2.query(`SELECT
  (SELECT COUNT(*) FROM "_prisma_migrations" WHERE (migration_name LIKE '%_j6_partner_settlement' OR migration_name LIKE '%_j6_cash_network') AND finished_at IS NOT NULL)::int AS j6_applied,
  (SELECT status FROM "AgentProfile" WHERE id = $1) AS agent_status,
  (SELECT "floatBalance" FROM "AgentProfile" WHERE id = $1)::int AS agent_float,
  (SELECT "servicePointId" FROM "AgentProfile" WHERE id = $1) AS agent_point,
  (SELECT status FROM "Business" WHERE id = $2) AS business_status,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('AgentCashTransaction_immutable', 'AgentCashEvent_append_only', 'AgentStatusEvent_append_only'))::int AS j6_guards`, [agent.id, biz.id])).rows[0];
const j6flow = node(['--input-type=module', '-e', `
  const { prisma } = await import('./lib/prisma.js');
  const L = await import('./lib/agents/lifecycle.js');
  const C = await import('./lib/agents/cash.js');
  const out = {};
  try { await L.requireOperatingAgent(prisma, '${users[3].id}', 'cash_in'); out.beforeAdoption = 'operating'; } catch (e) { out.beforeAdoption = e.code; }
  const adopted = await L.adoptLegacyAgent('reh-compliance', '${agent.id}', { reason: 'J6 rehearsal adoption', servicePoint: { name: 'Boutique legacy', publicAddress: 'Marché Sandaga, Dakar' } });
  try { await L.requireOperatingAgent(prisma, '${users[3].id}', 'cash_in'); out.beforeApproval = 'operating'; } catch (e) { out.beforeApproval = e.code; }
  await L.decideServicePoint('reh-compliance-2', adopted.servicePointId, { status: 'active', reason: 'premises visited (rehearsal)' });
  const { row, challenge } = await C.createCashIn('${users[1].id}', { amountXof: 10000, idempotencyKey: 'reh-j6-1' });
  const bound = await C.scanAndBind('${users[3].id}', { qr: challenge.qr });
  await C.customerCommit('${users[1].id}', row.id, { bindingHash: bound.bindingHash });
  const done = await C.agentComplete('${users[3].id}', row.id, { bindingHash: bound.bindingHash });
  const a = await prisma.agentProfile.findUnique({ where: { id: '${agent.id}' } });
  out.state = done.state; out.floatAfter = a.floatBalance; out.statusAfter = a.status;
  console.log(JSON.stringify(out));
  await prisma.$disconnect();
`]);
const check5 = node(['scripts/money-check.mjs', '--json']);
let flow6 = null;
try { flow6 = JSON.parse(j6flow.stdout.trim().split('\n').pop()); } catch { flow6 = { error: j6flow.stderr.slice(0, 600) }; }
step('J6 migrations additive on production shape (legacy agent kept + fail-closed until adopted and point approved; real J6 cash-in on migrated data)', {
  ok: j6.j6_applied === 2 && j6.agent_status === 'active' && j6.agent_float === 120_000 && j6.agent_point === null && j6.business_status === 'active' && j6.j6_guards === 3
    && flow6?.beforeAdoption === 'service_point_inactive' && flow6?.beforeApproval === 'service_point_inactive' && flow6?.state === 'completed' && flow6?.floatAfter === 110_000 && flow6?.statusAfter === 'active' && check5.status === 0,
  j6,
  flow: flow6,
  invariantsAfter: check5.status === 0 ? 'ok' : JSON.parse(check5.stdout || '{}').violations,
});

// J7 (additive): legacy invoices keep principal and payments; guards present; a
// dispute adjustment on a migrated invoice becomes a credit memo (principal
// untouched); deletion refused; pre-J7 overwritten invoices are counted for review.
const j7 = (await db2.query(`SELECT
  (SELECT COUNT(*) FROM "_prisma_migrations" WHERE migration_name LIKE '%_j7_commerce' AND finished_at IS NOT NULL)::int AS j7_applied,
  (SELECT "amountKori" FROM "TradeInvoice" WHERE id = $1)::int AS principal,
  (SELECT "amountPaid" FROM "TradeInvoice" WHERE id = $1)::int AS paid,
  (SELECT "creditedKori" FROM "TradeInvoice" WHERE id = $1)::int AS credited,
  (SELECT COUNT(*) FROM "TradeInvoice" WHERE "amountPaid" > "amountKori")::int AS overwritten_legacy,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('TradeInvoice_guard','PurchaseOrder_guard','PurchaseOrderEvent_append_only','PurchaseOrderLine_append_only','TradeInvoicePayment_append_only','CreditMemo_append_only','DepotStockMovement_append_only'))::int AS j7_guards`, [legacyInvoice.id])).rows[0];
const j7flow = node(['--input-type=module', '-e', `
  const { prisma } = await import('./lib/prisma.js');
  const T = await import('./lib/trade-service.js');
  await T.disputeTradeInvoice(prisma, { invoiceId: '${legacyInvoice.id}', buyerUserId: '${users[1].id}', reason: 'quantité livrée inférieure (répétition)' });
  const adj = await T.resolveTradeInvoiceDispute(prisma, { invoiceId: '${legacyInvoice.id}', supplierOwnerId: '${users[0].id}', action: 'adjust', newAmountKori: 4000, note: 'répétition J7' });
  const row = await prisma.tradeInvoice.findUnique({ where: { id: '${legacyInvoice.id}' } });
  const memos = await prisma.creditMemo.count({ where: { invoiceId: '${legacyInvoice.id}' } });
  let del = 'ACCEPTED';
  try { await prisma.tradeInvoice.delete({ where: { id: '${legacyInvoice.id}' } }); } catch (e) { del = 'refused'; }
  console.log(JSON.stringify({ shownNet: adj.amountKori, principal: row.amountKori, credited: row.creditedKori, memos, del }));
  await prisma.$disconnect();
`]);
const check6 = node(['scripts/money-check.mjs', '--json']);
let flow7 = null;
try { flow7 = JSON.parse(j7flow.stdout.trim().split('\n').pop()); } catch { flow7 = { error: j7flow.stderr.slice(0, 600) }; }
step('J7 migration additive on production shape (legacy invoice principal/payments kept, guards present, dispute adjust = credit memo, no delete; overwritten legacy invoices counted)', {
  ok: j7.j7_applied === 1 && j7.principal === 5000 && j7.paid === 1000 && j7.credited === 0 && j7.j7_guards === 7 && j7.overwritten_legacy === 1
    && flow7?.shownNet === 4000 && flow7?.principal === 5000 && flow7?.credited === 1000 && flow7?.memos === 1 && flow7?.del === 'refused' && check6.status === 0,
  j7,
  flow: flow7,
  invariantsAfter: check6.status === 0 ? 'ok' : JSON.parse(check6.stdout || '{}').violations,
});

// J8 (additive): legacy courier task untouched; custody guards present; a shipment on
// migrated data obeys status ⇒ custody, final states and no-delete; invariants hold.
const j8 = (await db2.query(`SELECT
  (SELECT COUNT(*) FROM "_prisma_migrations" WHERE migration_name LIKE '%_j8_logistics' AND finished_at IS NOT NULL)::int AS j8_applied,
  (SELECT status FROM "DeliveryTask" WHERE id = $1) AS legacy_task_status,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'HubParcel' AND column_name = 'pickupAttempts')::int AS hub_attempts_column,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('Shipment_guard','ShipmentEvent_append_only','ReceivingRecord_append_only','ShipmentDisputeEvidence_append_only'))::int AS j8_guards,
  (SELECT COUNT(*) FROM pg_indexes WHERE indexname IN ('ShipmentEvent_one_delivery','CourierAssignment_one_active'))::int AS j8_indexes,
  (SELECT COUNT(*) FROM "_prisma_migrations" WHERE migration_name LIKE '%_j8_pilot' AND finished_at IS NOT NULL)::int AS j8_pilot_applied,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'UnmatchedReceipt_guard')::int AS unmatched_guard,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'CourierAssignment' AND column_name = 'acceptedAt')::int AS accepted_column`, [task.id])).rows[0];
const j8flow = node(['--input-type=module', '-e', `
  const { prisma } = await import('./lib/prisma.js');
  const { runMoneyTransaction } = await import('./lib/wallet-atomic.js');
  const { createRequestInTx } = await import('./lib/logistics/intake.js');
  const { checkLogisticsInvariants } = await import('./lib/logistics/invariants.js');
  const biz = await prisma.business.findFirst();
  const r = await runMoneyTransaction(prisma, (tx) => createRequestInTx(tx, { sourceSystem: 'jokko_order', sourceId: 'rehearsal-j8', fulfilmentOwner: 'MERCHANT_FULFILLED', fulfillerBusinessId: biz.id, originBusinessId: biz.id, destinationUserId: '${users[2].id}', lines: [], createdBy: biz.ownerId }));
  const again = await runMoneyTransaction(prisma, (tx) => createRequestInTx(tx, { sourceSystem: 'jokko_order', sourceId: 'rehearsal-j8', fulfilmentOwner: 'MERCHANT_FULFILLED', fulfillerBusinessId: biz.id, originBusinessId: biz.id, destinationUserId: '${users[2].id}', lines: [], createdBy: biz.ownerId }));
  const bad = await prisma.shipment.update({ where: { id: r.shipment.id }, data: { status: 'delivered' } }).then(() => 'ACCEPTED', () => 'refused');
  const del = await prisma.shipment.delete({ where: { id: r.shipment.id } }).then(() => 'ACCEPTED', () => 'refused');
  const inv = await checkLogisticsInvariants(prisma);
  console.log(JSON.stringify({ status: r.shipment.status, replayed: again.replayed, sameRequest: again.request.id === r.request.id, deliveredWithoutCustody: bad, del, logisticsOk: inv.ok }));
  await prisma.$disconnect();
`]);
const check7 = node(['scripts/money-check.mjs', '--json']);
let flow8 = null;
try { flow8 = JSON.parse(j8flow.stdout.trim().split('\n').pop()); } catch { flow8 = { error: j8flow.stderr.slice(0, 600) }; }
step('J8 migration additive on production shape (legacy courier task untouched, custody guards present, shipment custody rules + idempotent intake on migrated data)', {
  ok: j8.j8_applied === 1 && j8.j8_pilot_applied === 1 && j8.unmatched_guard === 1 && j8.accepted_column === 1 && j8.legacy_task_status === 'assigned' && j8.hub_attempts_column === 1 && j8.j8_guards === 4 && j8.j8_indexes === 2
    && flow8?.status === 'ready_for_pickup' && flow8?.replayed === true && flow8?.sameRequest === true && flow8?.deliveredWithoutCustody === 'refused' && flow8?.del === 'refused' && flow8?.logisticsOk === true && check7.status === 0,
  j8,
  flow: flow8,
  invariantsAfter: check7.status === 0 ? 'ok' : JSON.parse(check7.stdout || '{}').violations,
});

const directWrite = await prisma2.$executeRawUnsafe(`UPDATE "Wallet" SET "koriBalance" = "koriBalance" + 1 WHERE id = (SELECT id FROM "Wallet" LIMIT 1)`).then(() => 'ACCEPTED', (e) => e.message);
step('direct balance write after migration is refused', { ok: directWrite !== 'ACCEPTED', result: directWrite.slice(0, 120) });
await db2.end();

const pack = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', join(root, 'scripts/forensics/production-exposure.sql')], { encoding: 'utf8' });
step('exposure pack on migrated database', { ok: pack.status === 0, exit: pack.status });

report.ok = report.steps.every((s) => s.ok);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
