/**
 * Runtime safety guards — the single place that decides whether mock, sandbox,
 * demo or beta behaviour may run.
 *
 * Rule (J1 financial safety): in production every mock/test path is OFF and
 * every external rail fails closed. No env flag can re-enable a mock in
 * production — flags only widen behaviour in development/test.
 */

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/** Mock rails (instant fake settlement) are allowed only outside production. */
export function mockRailsAllowed() {
  return !isProduction();
}

/** OTP codes may be echoed in API responses only outside production. */
export function otpDisclosureAllowed() {
  return !isProduction();
}

/** Closed-loop beta test credits (POST /api/deposits/national) — never in production. */
export function betaDepositsAllowed() {
  return !isProduction() && process.env.ALLOW_BETA_DEPOSITS === 'true';
}

/**
 * Platform-funded incentives (Kori "earn" rewards) mint value with no funding
 * source. Until J2 introduces a funded incentive pool they are hard-off in
 * production; outside production they are opt-in for demos.
 */
export function unfundedIncentivesAllowed() {
  return !isProduction() && process.env.PLATFORM_INCENTIVES_ENABLED === 'true';
}

/**
 * Tontine money movement (explicit contribution into escrow, rule-based
 * payout, cancellation refunds). The old auto-debit path was a proven wallet
 * drain and is removed. The consent + escrow model runs outside production;
 * in production it stays OFF until an operator explicitly enables it after
 * review (TONTINE_ESCROW_ENABLED=true).
 */
export function tontineMoneyAllowed() {
  if (!isProduction()) return true;
  return process.env.TONTINE_ESCROW_ENABLED === 'true';
}

/** Hardcoded/seeded feed content may be shown only outside production, and is labelled demo. */
export function demoContentAllowed() {
  return !isProduction();
}

export class RailUnavailableError extends Error {
  constructor(rail, message) {
    super(message ?? `${rail} rail is not configured — operation refused`);
    this.name = 'RailUnavailableError';
    this.code = 'rail_unavailable';
    this.status = 503;
    this.rail = rail;
  }
}
