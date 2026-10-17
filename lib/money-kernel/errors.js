/** Money errors shared by the kernel and legacy helpers (wallet-atomic re-exports them). */

export class InsufficientFundsError extends Error {
  constructor(message = 'Insufficient balance', detail = {}) {
    super(message);
    this.name = 'InsufficientFundsError';
    this.code = 'insufficient';
    this.detail = detail;
  }
}

export class WalletNotFoundError extends Error {
  constructor(message = 'Wallet not found') {
    super(message);
    this.name = 'WalletNotFoundError';
    this.code = 'wallet_missing';
  }
}

/** Same business reference posted again with different postings. */
export class LedgerConflictError extends Error {
  constructor(reference) {
    super(`Ledger reference ${reference} already used for a different movement`);
    this.name = 'LedgerConflictError';
    this.code = 'ledger_conflict';
    this.status = 409;
    this.reference = reference;
  }
}

/** Programming/accounting error: unbalanced entry, bad account, forbidden account in production… */
export class LedgerInvariantError extends Error {
  constructor(message, code = 'ledger_invariant') {
    super(message);
    this.name = 'LedgerInvariantError';
    this.code = code;
    this.status = 500;
  }
}

/** Debit of someone's funds without an authorization basis. */
export class LedgerAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerAuthorizationError';
    this.code = 'ledger_unauthorized';
    this.status = 403;
  }
}
