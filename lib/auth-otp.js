import { canonicalPhone, phoneVariants as buildPhoneVariants } from './phone-normalize.js';

export function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/** OTP rows store email destinations in the `phone` column with this prefix. */
export function otpKeyForEmail(email) {
  return `e:${normalizeEmail(email)}`;
}

/** Placeholder User.phone for email-only accounts (phone column stays required in DB). */
export function syntheticPhoneForEmail(email) {
  return otpKeyForEmail(email);
}

export function otpKeysForPhone(rawPhone) {
  const normalized = canonicalPhone(rawPhone) ?? rawPhone;
  return buildPhoneVariants(normalized);
}

function isEmailSchemaError(err) {
  const msg = err?.message ?? '';
  return (
    err?.code === 'P2022' ||
    /Unknown arg `email`/i.test(msg) ||
    /column [`"]?User\.email/i.test(msg) ||
    /column [`"]?email/i.test(msg)
  );
}

const AUTH_USER_SELECT = { id: true, phone: true, email: true, otpVerifiedAt: true, name: true, handle: true };

export async function findUserByEmail(prisma, email) {
  const e = normalizeEmail(email);
  if (!e || !e.includes('@')) return null;

  try {
    // Only a VERIFIED email identifies an account — an unverified address
    // typed into a profile must never route someone else's login to it.
    const byEmail = await prisma.user.findFirst({
      where: { email: e, emailVerifiedAt: { not: null } },
      select: AUTH_USER_SELECT,
    });
    if (byEmail) return byEmail;
  } catch (err) {
    if (!isEmailSchemaError(err)) throw err;
  }

  return prisma.user.findFirst({
    where: { phone: syntheticPhoneForEmail(e) },
    select: { id: true, phone: true, otpVerifiedAt: true, name: true, handle: true },
  });
}
