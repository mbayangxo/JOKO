#!/usr/bin/env node
/**
 * Credential remediation operator tool (J0 run 3/4 — Mboolo credential exposure).
 *
 * DRY RUN BY DEFAULT. Reads account ids (one per line, "#" comments allowed)
 * produced by the classification in docs/JOKKO-CREDENTIAL-REMEDIATION.md and
 * reports what WOULD change. It never prints names, phones, emails or hashes.
 *
 *   node scripts/forensics/remediate-credentials.mjs --ids class-a.txt --class A
 *   node scripts/forensics/remediate-credentials.mjs --ids class-a.txt --class A \
 *        --execute --reason "mbolo-leak-2026-10" --i-understand-this-revokes-sessions
 *
 * Executing against a production database additionally requires
 * --confirm-production <database host>, so an operator can't run it against
 * the wrong database by accident. Every change writes CredentialSecurityEvent
 * rows (append-only). No user notification is sent by this tool.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

const idsFile = opt('ids');
const classification = opt('class');
const reason = opt('reason') ?? 'credential exposure (mbolo raw user rows)';
const execute = flag('execute');

if (!idsFile || !['A', 'B'].includes(classification)) {
  console.error('Usage: --ids <file> --class A|B [--execute --reason <text> --i-understand-this-revokes-sessions] [--confirm-production <db host>]');
  process.exit(2);
}

const ids = readFileSync(idsFile, 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*/, '').trim())
  .filter((l) => /^[a-z0-9]{20,40}$/i.test(l));

const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
})();
const looksLocal = /^(localhost|127\.0\.0\.1)$/.test(dbHost);

if (execute) {
  if (!flag('i-understand-this-revokes-sessions')) {
    console.error('Refusing: --execute requires --i-understand-this-revokes-sessions');
    process.exit(2);
  }
  if (!looksLocal && opt('confirm-production') !== dbHost) {
    console.error(`Refusing: non-local database (${dbHost || 'unknown'}) requires --confirm-production ${dbHost || '<host>'}`);
    process.exit(2);
  }
}

const { markCredentialsCompromised } = await import('../../lib/credential-remediation.js');
const { prisma } = await import('../../lib/prisma.js');

// Class A (confirmed exposed): invalidate PIN + password AND revoke sessions.
// Class B (potentially exposed): same credential invalidation; sessions are
// revoked too — an offline-cracked PIN is not bound to a session, so there is
// no safe partial option. The difference is recorded for the audit trail and
// for the notification wording.
const summary = await markCredentialsCompromised(ids, {
  reason,
  actorType: 'operator_script',
  actorId: process.env.OPERATOR_ID ?? null,
  classification,
  revokeSessions: true,
  dryRun: !execute,
});

console.log(JSON.stringify({ mode: execute ? 'EXECUTED' : 'DRY_RUN', classification, database: looksLocal ? 'local' : dbHost, ...summary }, null, 2));
await prisma.$disconnect();
