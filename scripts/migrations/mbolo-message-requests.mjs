#!/usr/bin/env node
/**
 * One-time: convert legacy Mboolo conversations opened without consent into
 * message requests (see migrateLegacyThreadsToRequests in lib/mbolo-access.js).
 *
 *   node scripts/migrations/mbolo-message-requests.mjs            # dry run (counts only)
 *   node scripts/migrations/mbolo-message-requests.mjs --execute  # apply
 *
 * Non-local databases additionally need --confirm-production <db host>.
 * Prints counts only — never names, handles or message content.
 */
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const confirmIdx = args.indexOf('--confirm-production');
const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
})();
const local = /^(localhost|127\.0\.0\.1)$/.test(dbHost);
if (execute && !local && (confirmIdx < 0 || args[confirmIdx + 1] !== dbHost)) {
  console.error(`Refusing: non-local database (${dbHost || 'unknown'}) requires --confirm-production ${dbHost || '<host>'}`);
  process.exit(2);
}
const { migrateLegacyThreadsToRequests } = await import('../../lib/mbolo-access.js');
const { prisma } = await import('../../lib/prisma.js');
const result = await migrateLegacyThreadsToRequests(prisma, { dryRun: !execute });
console.log(JSON.stringify({ database: local ? 'local' : dbHost, ...result }, null, 2));
await prisma.$disconnect();
