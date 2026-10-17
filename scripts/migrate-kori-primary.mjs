#!/usr/bin/env node
/**
 * RETIRED (J2). This one-time script converted legacy XOF `Wallet.balance`
 * into ₭ by writing balance columns directly. Under the Money Kernel those
 * columns are ledger projections and the database refuses direct writes.
 *
 * Legacy XOF balances are now handled explicitly:
 *  - `npm run money:check` reports them (warning W1, ids only);
 *  - `node scripts/money-backfill.mjs` reports them in its dry run and never
 *    converts them without a reviewed decision (docs/JOKKO-J2-DESIGN.md §10).
 */
console.error('migrate-kori-primary is retired under J2 — see scripts/money-backfill.mjs');
process.exit(2);
