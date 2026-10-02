/**
 * Last line of defence: credential material must never leave the API, no
 * matter how a handler serializes a row (several handlers returned raw Prisma
 * User rows, leaking bcrypt PIN/password hashes of other users — J0 audit).
 * Applied to every JSON response in dispatchApi.
 */
export const SECRET_KEYS = new Set([
  'pinHash',
  'passwordHash',
  'cniNumberEnc',
  'cniHash',
  'tokenHash',
  'totpSecret',
  'totpSecretEnc',
  'pendingTotpSecretEnc',
  'pinFailedAttempts',
  'checkoutToken',
]);

export function scrubSecrets(value, depth = 0) {
  if (depth > 40 || value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k)) continue;
    out[k] = scrubSecrets(v, depth + 1);
  }
  return out;
}
