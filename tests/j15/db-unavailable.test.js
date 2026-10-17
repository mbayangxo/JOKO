/**
 * J15 OI-1 root cause (multi-instance run #553): an API process that could not get a database connection
 * (Prisma P2037 "too many database connections opened", local max_connections exhausted) answered a bare 500, while
 * the same condition on a cold process answered 503 db_unavailable. Reproduced deterministically with a
 * connection-limited role (docs/JOKKO-J15-REPORT.md). And the app treated EVERY 503 on a money call as a definite
 * refusal ("aucun argent n'a été débité"), although a connection failure can come after COMMIT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDatabaseUnavailable } from '../../lib/db-errors.js';
import { classifySubmission } from '../../src/lib/money-ux.js';

test('every connection-level Prisma failure is classified db_unavailable; ordinary errors are not', () => {
  for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2037']) assert.equal(isDatabaseUnavailable({ code }), true, code);
  assert.equal(isDatabaseUnavailable({ name: 'PrismaClientInitializationError' }), true);
  for (const code of ['P2002', 'P2025', 'P2034', undefined]) assert.equal(isDatabaseUnavailable({ code, message: 'x' }), false, String(code));
  assert.equal(isDatabaseUnavailable(null), false);
});

test('both API error mappers use the shared classifier (no narrower copy left)', () => {
  for (const f of ['lib/api-router.js', 'api/_lib/http.js']) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.match(src, /const prismaInit = isDatabaseUnavailable\(error\);/, f);
    assert.doesNotMatch(src, /error\.code === 'P1001'/, f);
  }
});

test('the app never tells a payer "nothing was debited" on db_unavailable — the outcome is unknown and reconciled', () => {
  const r = classifySubmission({ error: { status: 503, code: 'db_unavailable', message: 'Database temporarily unavailable' } });
  assert.equal(r.state, 'checking');
  assert.equal(r.unknown, true);
  assert.equal(r.canRetrySameIntent, false);
  assert.doesNotMatch(r.message, /aucun argent/i);
  // An explicit refusal 503 (feature off / fail-closed enforcement) stays a definite, retryable refusal.
  const off = classifySubmission({ error: { status: 503, code: 'rate_limit_unavailable', message: 'Service momentanément indisponible' } });
  assert.equal(off.state, 'failed_safe');
});
