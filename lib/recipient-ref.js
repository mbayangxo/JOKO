/**
 * J13-F12 — a payment recipient is bound to an IMMUTABLE account identity, not to a handle.
 *
 * Handles can be changed (auth/complete-profile) and later reclaimed by someone else, so "the person the
 * sender confirmed" and "whoever holds this handle when the payment executes" can differ. The lookup
 * returns `recipientRef`, an opaque server-signed token derived from the account id (the raw id is never
 * exposed); transfers/send recomputes it for the account it resolves and refuses any mismatch before money
 * moves. Deterministic (no storage), unforgeable without the server secret, useless across deployments.
 */
import crypto from 'node:crypto';
import { authNotConfiguredError, jwtSecretConfigured } from './auth-config.js';

const PREFIX = 'r1.';

export function recipientRef(userId) {
  if (!jwtSecretConfigured('JWT_ACCESS_SECRET')) throw authNotConfiguredError();
  const mac = crypto.createHmac('sha256', process.env.JWT_ACCESS_SECRET.trim()).update(`k21-recipient-ref:v1:${userId}`).digest('base64url');
  return `${PREFIX}${mac.slice(0, 32)}`;
}

/** Constant-time comparison of a client-supplied ref against the resolved account. */
export function recipientRefMatches(ref, userId) {
  if (typeof ref !== 'string' || !ref.startsWith(PREFIX)) return false;
  const expected = Buffer.from(recipientRef(userId));
  const got = Buffer.from(ref);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
