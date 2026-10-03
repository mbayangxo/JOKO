#!/usr/bin/env node
/**
 * Build-time schema sync (until `prisma migrate deploy` replaces it — see
 * docs/JOKKO-J2-ENTRY-REPORT.md §B).
 *
 * Fail-closed (J0 run 4): the forensic audit found the committed baseline
 * (captured from Postgres on 2026-08-17) holds 9 tables and 17 columns that
 * schema.prisma no longer defines. `db push` would silently DROP them when
 * empty, or fail when not — and the old behaviour then shipped code that
 * needs new columns anyway (every authenticated request reads
 * User.sessionsRevokedAt → whole app 503). So now:
 *
 *  1. The diff (database → schema) is computed first. Any destructive
 *     statement (DROP TABLE/COLUMN, type change, new NOT NULL on existing
 *     column) FAILS THE BUILD, listing table/column names only.
 *     Override: ALLOW_DESTRUCTIVE_SCHEMA_SYNC=true (after a reviewed backup).
 *  2. A failed push FAILS THE BUILD (the previous deployment keeps serving).
 *     Override: ALLOW_DEPLOY_WITHOUT_SCHEMA_SYNC=true.
 *  3. A Vercel build with no database URL fails too (same override).
 *
 * Prefers DIRECT_DATABASE_URL when set: Supabase's transaction pooler
 * (port 6543) can refuse DDL — schema changes want the direct connection.
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (process.env.DIRECT_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL)?.trim();

const allowNoSync = process.env.ALLOW_DEPLOY_WITHOUT_SCHEMA_SYNC === 'true';
const allowDestructive = process.env.ALLOW_DESTRUCTIVE_SCHEMA_SYNC === 'true';
const fail = (msg) => {
  console.error(`[db-sync] ✗ ${msg}`);
  process.exit(1);
};

if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
  console.warn(
    '[db-sync] ⚠️  No database URL available to this build — schema NOT synced.\n' +
      '[db-sync]     Vercel → Settings → Environment Variables → DATABASE_URL → enable for Production.',
  );
  if (process.env.VERCEL && !allowNoSync) fail('Refusing to deploy code against an unsynced database (set ALLOW_DEPLOY_WITHOUT_SCHEMA_SYNC=true to override).');
  process.exit(0);
}

const prismaBin = join(root, 'node_modules', '.bin', 'prisma');

// 1. Destructive-change guard.
const diff = spawnSync(
  prismaBin,
  ['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', join(root, 'prisma', 'schema.prisma'), '--script'],
  { cwd: root, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } },
);
if (diff.status !== 0) {
  if (!allowNoSync) fail('Could not compute the schema diff — refusing to sync blind.');
} else {
  const destructive = destructiveStatements(diff.stdout);
  if (destructive.length) {
    console.error('[db-sync] Destructive schema changes detected (database → schema.prisma):');
    for (const d of destructive) console.error(`[db-sync]   - ${d}`);
    if (!allowDestructive) {
      fail('Refusing: these would drop or rewrite production data. Back up, review, then set ALLOW_DESTRUCTIVE_SCHEMA_SYNC=true — or restore the models in schema.prisma.');
    }
    console.warn('[db-sync] ⚠️  ALLOW_DESTRUCTIVE_SCHEMA_SYNC=true — proceeding.');
  }
}

console.log('[db-sync] Syncing database schema (prisma db push)…');
const push = spawnSync(prismaBin, ['db', 'push', '--skip-generate'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});

if (push.status !== 0) {
  if (!allowNoSync) {
    fail('Schema sync FAILED — build stopped so the previous deployment keeps serving. Fix the schema (or set ALLOW_DEPLOY_WITHOUT_SCHEMA_SYNC=true).');
  }
  console.warn('[db-sync] ⚠️  Schema sync FAILED — ALLOW_DEPLOY_WITHOUT_SCHEMA_SYNC=true, deploying anyway.');
  process.exit(0);
}

console.log('[db-sync] ✓ Database schema is in sync.');

// Financial invariants Prisma can't express (CHECK constraints, append-only
// ledger triggers). Idempotent. A failure here is loud but, like the push
// above, does not block the deploy.
const invariants = spawnSync(
  prismaBin,
  ['db', 'execute', '--file', join(root, 'prisma', 'sql', 'financial-invariants.sql'), '--url', url],
  { cwd: root, stdio: 'inherit' },
);
if (invariants.status !== 0) {
  console.warn('[db-sync] ⚠️  Financial invariant guards NOT applied — run prisma/sql/financial-invariants.sql manually.');
} else {
  console.log('[db-sync] ✓ Financial invariant guards applied.');
}

/** Table/column names of statements that drop or rewrite existing data. */
export function destructiveStatements(sql) {
  const out = [];
  let table = null;
  for (const raw of String(sql ?? '').split('\n')) {
    const line = raw.trim();
    const alter = line.match(/^ALTER TABLE "([^"]+)"/);
    if (alter) table = alter[1];
    let m;
    if ((m = line.match(/^DROP TABLE "([^"]+)"/))) out.push(`DROP TABLE ${m[1]}`);
    else if ((m = line.match(/DROP COLUMN "([^"]+)"/))) out.push(`DROP COLUMN ${table}.${m[1]}`);
    else if ((m = line.match(/ALTER COLUMN "([^"]+)" (SET DATA TYPE|TYPE)/))) out.push(`TYPE CHANGE ${table}.${m[1]}`);
    else if ((m = line.match(/ALTER COLUMN "([^"]+)" SET NOT NULL/))) out.push(`SET NOT NULL ${table}.${m[1]}`);
    else if ((m = line.match(/^DROP TYPE "([^"]+)"/))) out.push(`DROP TYPE ${m[1]}`);
    if (line.endsWith(';')) table = null;
  }
  return out;
}
