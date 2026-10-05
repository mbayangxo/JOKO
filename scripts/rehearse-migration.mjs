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

const directWrite = await prisma2.$executeRawUnsafe(`UPDATE "Wallet" SET "koriBalance" = "koriBalance" + 1 WHERE id = (SELECT id FROM "Wallet" LIMIT 1)`).then(() => 'ACCEPTED', (e) => e.message);
step('direct balance write after migration is refused', { ok: directWrite !== 'ACCEPTED', result: directWrite.slice(0, 120) });
await db2.end();

const pack = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', join(root, 'scripts/forensics/production-exposure.sql')], { encoding: 'utf8' });
step('exposure pack on migrated database', { ok: pack.status === 0, exit: pack.status });

report.ok = report.steps.every((s) => s.ok);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
