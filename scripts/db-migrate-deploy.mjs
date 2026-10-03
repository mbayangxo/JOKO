#!/usr/bin/env node
/**
 * Schema delivery with reviewed migrations (J2 — replaces `prisma db push`).
 *
 * INERT UNLESS ACTIVATED: without MIGRATION_DEPLOY_ACTIVATED=true it refuses
 * and exits non-zero, so no build can migrate a database by accident. It is
 * not activated against production (decision pending, see
 * docs/JOKKO-J2-GATE-REPORT.md).
 *
 * Steps (each fails closed):
 *  1. The database must be baselined (_prisma_migrations has 0_baseline).
 *  2. Destructive guard: the database → schema diff may not DROP/narrow
 *     anything (legacy data is preserved — docs/JOKKO-LEGACY-SCHEMA.md).
 *     Pending migration files are scanned too.
 *  3. `prisma migrate deploy`.
 *  4. Post-check: database == schema.prisma (no drift left).
 *  5. Database guards (prisma/sql/*.sql, idempotent).
 * Opening balances are a separate, reviewed step: scripts/money-backfill.mjs.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const prismaBin = join(root, 'node_modules', '.bin', 'prisma');
const schema = join(root, 'prisma', 'schema.prisma');
const url = (process.env.DIRECT_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL)?.trim();

const fail = (msg, code = 1) => {
  console.error(`[db-migrate] ✗ ${msg}`);
  process.exit(code);
};
const run = (args, opts = {}) =>
  spawnSync(prismaBin, args, { cwd: root, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url }, ...opts });

if (process.env.MIGRATION_DEPLOY_ACTIVATED !== 'true') {
  fail('Migration deploy is not activated (MIGRATION_DEPLOY_ACTIVATED=true after review). Refusing — nothing was changed.', 3);
}
if (!url || !/^postgres(ql)?:\/\//i.test(url)) fail('No database URL.');

/** Table/column names of statements that drop or rewrite existing data. */
export function destructiveStatements(sql) {
  const out = [];
  let table = null;
  for (const raw of String(sql ?? '').split('\n')) {
    const line = raw.trim();
    const alter = line.match(/^ALTER TABLE "([^"]+)"/);
    if (alter) table = alter[1];
    let m;
    if ((m = line.match(/^DROP TABLE (?:IF EXISTS )?"([^"]+)"/))) out.push(`DROP TABLE ${m[1]}`);
    else if ((m = line.match(/DROP COLUMN "([^"]+)"/))) out.push(`DROP COLUMN ${table}.${m[1]}`);
    else if ((m = line.match(/ALTER COLUMN "([^"]+)" (SET DATA TYPE|TYPE)/))) out.push(`TYPE CHANGE ${table}.${m[1]}`);
    else if ((m = line.match(/ALTER COLUMN "([^"]+)" SET NOT NULL/))) out.push(`SET NOT NULL ${table}.${m[1]}`);
    else if ((m = line.match(/^DROP TYPE "([^"]+)"/))) out.push(`DROP TYPE ${m[1]}`);
    else if (/^TRUNCATE\b/i.test(line) || /^DELETE FROM\b/i.test(line)) out.push(`DATA DELETE: ${line.slice(0, 80)}`);
    if (line.endsWith(';')) table = null;
  }
  return out;
}

// 1. Baseline
const { PrismaClient } = await import('@prisma/client');
const client = new PrismaClient({ datasources: { db: { url } } });
let appliedSet;
try {
  const rows = await client.$queryRawUnsafe(
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  appliedSet = new Set(rows.map((r) => r.migration_name));
} catch {
  fail('Database is not baselined (no _prisma_migrations). Review, then run: npm run db:resolve-baseline (marks 0_baseline as applied without executing it).');
} finally {
  await client.$disconnect();
}
if (!appliedSet.has('0_baseline')) fail('0_baseline is not marked applied — baseline the database first (npm run db:resolve-baseline).');

// 2. Destructive guard (database → schema, and pending migration files)
const diff = run(['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', schema, '--script']);
if (diff.status !== 0) fail(`Could not compute the schema diff: ${diff.stderr?.slice(0, 300)}`);
const pending = readdirSync(join(root, 'prisma', 'migrations'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !appliedSet.has(d.name))
  .map((d) => d.name)
  .sort();
const destructive = [
  ...destructiveStatements(diff.stdout),
  ...pending.flatMap((m) => destructiveStatements(readFileSync(join(root, 'prisma', 'migrations', m, 'migration.sql'), 'utf8')).map((d) => `${m}: ${d}`)),
];
if (destructive.length && process.env.ALLOW_DESTRUCTIVE_MIGRATION !== 'true') {
  for (const d of destructive) console.error(`[db-migrate]   - ${d}`);
  fail('Destructive change detected — refusing (legacy data is preserved by policy).');
}
console.log(`[db-migrate] pending migrations: ${pending.length ? pending.join(', ') : 'none'}`);

// 3. Deploy
const deploy = run(['migrate', 'deploy', '--schema', schema], { stdio: 'inherit' });
if (deploy.status !== 0) fail('prisma migrate deploy failed — build stopped (previous deployment keeps serving).');

// 4. Post-check: no drift left
const post = run(['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', schema, '--exit-code']);
if (post.status !== 0) fail('Drift after migrate deploy: the database does not match schema.prisma. Investigate before deploying.');

// 5. Guards
for (const file of ['financial-invariants.sql', 'money-kernel.sql']) {
  const r = run(['db', 'execute', '--file', join(root, 'prisma', 'sql', file), '--url', url], { stdio: 'inherit' });
  if (r.status !== 0) fail(`Database guards ${file} could not be applied.`);
}
console.log('[db-migrate] ✓ migrations applied, no drift, guards in place. Next (reviewed): node scripts/money-backfill.mjs');
