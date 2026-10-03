#!/usr/bin/env node
/**
 * Money Kernel invariant checker (read-only). Exits 1 on any violation.
 *   DATABASE_URL=… node scripts/money-check.mjs [--json]
 */
const { prisma } = await import('../lib/prisma.js');
const { checkInvariants } = await import('../lib/money-kernel/invariants.js');
const result = await prisma.$transaction(async (tx) => {
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  return checkInvariants(tx);
}, { timeout: 120_000 });
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`stats: ${JSON.stringify(result.stats)}`);
  for (const v of result.violations) console.log(`VIOLATION ${v.id}: ${v.detail} (${v.count}) ${JSON.stringify(v.rows.slice(0, 3))}`);
  for (const w of result.warnings) console.log(`warning ${w.id}: ${w.detail} (${w.count})`);
  console.log(result.ok ? 'OK — all money invariants hold' : 'FAILED');
}
await prisma.$disconnect();
process.exit(result.ok ? 0 : 1);
