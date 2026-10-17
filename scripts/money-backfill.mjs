#!/usr/bin/env node
/**
 * J2 opening-balance backfill — DRY RUN BY DEFAULT.
 *   DATABASE_URL=… node scripts/money-backfill.mjs            # counts only
 *   DATABASE_URL=… node scripts/money-backfill.mjs --execute  # local/rehearsal
 * Non-local databases additionally need --confirm-production <db host>.
 * Prints counts/ids only (no PII). See lib/money-kernel/backfill.js.
 */
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const i = args.indexOf('--confirm-production');
const host = (() => { try { return new URL(process.env.DATABASE_URL ?? '').hostname; } catch { return ''; } })();
const local = /^(localhost|127\.0\.0\.1)$/.test(host);
if (execute && !local && (i < 0 || args[i + 1] !== host)) {
  console.error(`Refusing: non-local database (${host || 'unknown'}) requires --confirm-production ${host || '<host>'}`);
  process.exit(2);
}
const { prisma } = await import('../lib/prisma.js');
const { runBackfill } = await import('../lib/money-kernel/backfill.js');
try {
  const summary = await runBackfill(prisma, { execute });
  console.log(JSON.stringify({ database: local ? 'local' : host, ...summary }, null, 2));
  process.exitCode = summary.mismatches.length ? 1 : 0;
} catch (error) {
  console.error(`Backfill stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
