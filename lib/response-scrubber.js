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

/**
 * @param onStrip optional (key) => void, called for every key removed. The
 *   dispatcher logs these (key + route only, never values): a strip means a
 *   handler serialized a row it should have shaped explicitly — a bug to fix,
 *   which the data-exposure sweep test fails on.
 */
export function scrubSecrets(value, depth = 0, onStrip) {
  if (depth > 40 || value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1, onStrip));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k)) {
      onStrip?.(k);
      continue;
    }
    out[k] = scrubSecrets(v, depth + 1, onStrip);
  }
  return out;
}
