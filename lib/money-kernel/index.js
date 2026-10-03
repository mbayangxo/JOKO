/**
 * Jokko Money Kernel — public API. See docs/JOKKO-J2-DESIGN.md.
 * Every movement of value goes through `post()` (directly or via a flow
 * recipe); the database rejects any other balance change.
 */
export * from './errors.js';
export { specs, pegFor, KRI, PROJECTION_COLUMN } from './accounts.js';
export { post, reverse, transfer, ensureAccount, postOpening, balanceOf, toNumber } from './ledger.js';
export * from './flows.js';
