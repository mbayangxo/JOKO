/**
 * J15 (OI-1): one classification of "the database could not be reached / no connection available", used by every
 * API error mapper. It used to recognize only initialization / P1001, so a refused connection on an already-running
 * instance (Prisma P2037 "too many database connections opened") surfaced as a bare 500 while the same condition on
 * a cold instance answered 503 db_unavailable.
 *
 * A db_unavailable answer is NOT proof that nothing happened: on a money route the failure can come after COMMIT.
 * Clients treat db_unavailable on a money call as an UNKNOWN outcome and reconcile through the intent (F17).
 */
const CONNECTION_CODES = new Set([
  'P1001', // can't reach database server
  'P1002', // database server reached but timed out
  'P1008', // operation timed out
  'P1017', // server closed the connection
  'P2024', // timed out fetching a connection from the pool
  'P2037', // too many database connections opened
]);

export function isDatabaseUnavailable(error) {
  if (!error) return false;
  return error.name === 'PrismaClientInitializationError'
    || CONNECTION_CODES.has(error.code)
    || Boolean(error.message?.includes('DATABASE_URL'));
}
