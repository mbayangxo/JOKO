/**
 * Critical-route tables for the authorization-boundary gate
 * (tests/sweep/authz-boundary.test.js, static check in tests/j8/authz-boundary-static.test.js).
 */
/** A user route is critical when it moves money and acts on an object id. */
export const isCriticalUserRoute = (key, p) =>
  !key.startsWith('GET ') && p.actor === 'user' && key.includes(':') && (String(p.audit ?? '').includes('ledger') || Boolean(p.stepUp) || p.risk === 'cash_out');
export const isCriticalAdminRoute = (key, p) => !key.startsWith('GET ') && p.actor === 'admin';

const H64 = 'a'.repeat(64);
/** Semantically valid adversarial bodies: they pass the route's schema so the handler reaches its authorization decision. */
export const VALID_BODIES = {
  'POST money/charges/:id/pay': () => ({ expectedAmountKori: 100 }),
  'POST money/payments/:reference/refund': () => ({ amountKori: 100, reason: 'sweep: refund someone else’s payment' }),
  'POST transfers/:reference/undo': () => ({}),
  'POST transfers/requests/:id/accept': () => ({}),
  'POST merchants/:id/pay': () => ({ amount: 100, currency: 'kori' }),
  'POST payment-funds/:id/fund': () => ({ amountKori: 100 }),
  'POST payment-funds/:id/withdraw': () => ({ amountKori: 100 }),
  'POST agent/deposits/:id/confirm': () => ({}),
  'POST agent/withdrawals/:id/confirm': () => ({}),
  'POST agent-cash/tx/:id/confirm': () => ({ bindingHash: H64 }),
  'POST agent-cash/tx/:id/cancel': () => ({}),
  'POST agent/cash/:id/complete': () => ({ bindingHash: H64 }),
  'POST agent/cash/:id/decline': () => ({ reason: 'sweep' }),
  'POST deliveries/:id/accept': () => ({}),
  'POST deliveries/:id/claim': () => ({}),
  'POST deliveries/:id/confirm': () => ({}),
  'POST events/:id/tickets': () => ({ quantity: 1 }),
  'POST jekkal/campaigns/:id/contribute': () => ({ amount: 100 }),
  'POST tontine/groups/:id/contribute': () => ({}),
  'POST tontine/groups/:id/release': () => ({}),
  'POST tontine/groups/:id/cancel': () => ({ reason: 'sweep: cancel someone else’s tontine' }),
  'POST marketplace/orders/:id/confirm': () => ({}),
  'POST marketplace/orders/:id/cancel': () => ({ reason: 'sweep: cancel someone else’s order' }),
  'POST distribution/invoices/:id/pay': () => ({ paymentSource: 'personal' }),
  'POST distribution/invoices/:id/dispute-resolve': () => ({ action: 'waive', note: 'sweep' }),
  'POST businesses/:id/transfer': (ctx) => ({ kind: 'b2b', amount: 100, recipientBusinessId: ctx.ownBizId }),
  'POST businesses/:id/os/orders/:subId/cancel': () => ({ reason: 'sweep: cancel someone else’s order' }),
  'POST businesses/:id/os/orders/:subId/refund': () => ({ reason: 'sweep: refund someone else’s order' }),
  'POST businesses/:id/b2b/purchase-orders': () => ({ sellerBusinessId: 'x', lines: [{ listingId: 'x', packs: 1 }], paymentTerm: 'due_now', expectedTotalKori: 100 }),
  'POST businesses/:id/b2b/purchase-orders/:subId/pay': () => ({ expectedAmountKori: 100 }),
  'POST businesses/:id/b2b/purchase-orders/:subId/cancel': () => ({ reason: 'sweep: cancel someone else’s PO' }),
  'POST businesses/:id/b2b/invoices/:subId/pay': () => ({ amountKori: 100 }),
  'POST businesses/:id/b2b/invoices/:subId/credit-memos': () => ({ amountKori: 100, reason: 'sweep: credit someone else’s invoice', reference: 'SWEEP-1' }),
  'POST businesses/:id/b2b/returns/:subId/resolve': () => ({ resolution: 'none', note: 'sweep: resolve someone else’s return' }),
  'POST businesses/:id/payroll/pay': (ctx) => ({ employeeHandle: ctx.attackerHandle, amount: 100 }),
  'POST businesses/:id/payroll/run': () => ({}),
  'POST businesses/:id/school/pay': () => ({ studentId: 'x', periodId: 'x' }),
  'POST businesses/:id/cooperative/payout': (ctx) => ({ farmerUserId: ctx.attackerId, ratePerTonXof: 100 }),
};
/** Acting on someone else's object by design (the attacker pays from their own wallet / acts in their own role). */
export const PUBLIC_BY_DESIGN = new Set([
  'POST merchants/:id/pay',
  'POST money/charges/:id/pay',
  'POST events/:id/tickets',
  'POST jekkal/campaigns/:id/contribute',
  'POST deliveries/:id/accept',
  'POST deliveries/:id/claim',
  'POST businesses/:id/school/pay', // payer → school (a parent pays a fee from their own wallet)
]);
/** Operator routes with no route-level permission: object-level rules instead (covered by their own suites). */
export const ADMIN_OBJECT_LEVEL = {
  'POST admin/auth/logout': 'own session only',
  'POST admin/approvals/:id/approve': 'maker ≠ checker, permission of the requested action (tests/j3 approvals)',
  'POST admin/approvals/:id/reject': 'maker ≠ checker, permission of the requested action (tests/j3 approvals)',
};

