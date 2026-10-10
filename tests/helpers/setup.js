/**
 * Test environment bootstrap — MUST be the first import of every test file
 * so env vars are set before lib/prisma.js and friends are evaluated.
 *
 * Local test database: `npm run test:db:start` (Prisma dev Postgres on :51214).
 */

import { normalizeDatabaseUrl } from '../../lib/db-url.js';

process.env.NODE_ENV = process.env.NODE_ENV === 'production' ? 'test' : (process.env.NODE_ENV ?? 'test');

const defaultTestUrl =
  'postgres://postgres:postgres@localhost:51214/template1?sslmode=disable&pgbouncer=true&connection_limit=20&pool_timeout=120';

process.env.DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL?.trim() || defaultTestUrl);

// Fail fast and clearly when the database is down (e.g. the dev VM was restored without restarting
// Postgres): one explicit "DATABASE UNAVAILABLE" error instead of dozens of misleading application failures.
// Fix: `npm run db:ensure` (docs/JOKKO-LOCAL-POSTGRES.md).
{
  const net = await import('node:net');
  const u = new URL(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, 'http:'));
  const host = u.hostname || 'localhost';
  const port = Number(u.port || 5432);
  const up = await new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(3000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
  if (!up) throw new Error(`DATABASE UNAVAILABLE at ${host}:${port} — not an application failure. Run \`npm run db:ensure\` and rerun.`);
}

process.env.JWT_ACCESS_SECRET ??= 'test-jwt-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET ??= 'test-jwt-refresh-secret-0123456789';

// Speed up external-API timeout/retry paths (defaults are 30s / 3 / 5s).
process.env.EXTERNAL_API_TIMEOUT_MS ??= '150';
process.env.EXTERNAL_API_RETRY_GAP_MS ??= '10';
