/**
 * Verification tiers and wallet / activity limits (XOF + Kori).
 * Formal meaning, evidence and eligibility: docs/JOKKO-J3-DESIGN.md §7.
 *
 *  Tier 0  account exists, no verified phone (email-only)      receive only
 *  Tier 1  phone proven by OTP                                  small sends, no cash-out
 *  Tier 2  CNI verified by the KYC provider or compliance       cash-out, agents
 *  Tier 3  Tier 2 + address verified                            business, higher limits
 *
 * A submitted document is NOT verification: cni_pending / address_pending
 * never raise the effective tier.
 */
export const TIER_LIMITS = {
  0: {
    label: 'Tier 0 — compte non vérifié',
    maxNationalBalance: 50_000,
    maxKoriBalance: 5_000,
    maxSendPerDay: 0,
    maxCashOutPerDay: 0,
    canCashOut: false,
    canInternational: false,
    canCreateBusiness: false,
  },
  1: {
    label: 'Tier 1 — téléphone',
    maxNationalBalance: 50_000,
    maxKoriBalance: 5_000,
    maxSendPerDay: 10_000,
    maxCashOutPerDay: 0,
    canCashOut: false,
    canInternational: false,
    canCreateBusiness: false,
  },
  2: {
    label: 'Tier 2 — CNI vérifiée',
    maxNationalBalance: 2_000_000,
    maxKoriBalance: 200_000,
    maxSendPerDay: null,
    maxCashOutPerDay: 500_000,
    canCashOut: true,
    canInternational: true,
    canCreateBusiness: false,
  },
  3: {
    label: 'Tier 3 — adresse vérifiée',
    maxNationalBalance: 10_000_000,
    maxKoriBalance: 1_000_000,
    maxSendPerDay: null,
    maxCashOutPerDay: 2_000_000,
    canCashOut: true,
    canInternational: true,
    canCreateBusiness: true,
  },
};

/** Unknown tiers fail closed to the most restrictive tier (0). */
export function limitsForTier(tier) {
  return TIER_LIMITS[tier] ?? TIER_LIMITS[0];
}

/** Email-only accounts carry a synthetic `e:` phone placeholder (lib/auth-otp.js). */
export function hasVerifiedPhone(user) {
  return typeof user?.phone === 'string' ? !user.phone.startsWith('e:') : true;
}

export function effectiveTier(user) {
  if (user.verificationTier >= 3 && user.addressVerifiedAt && user.cniVerifiedAt) return 3;
  if (user.verificationTier >= 2 && user.cniVerifiedAt) return 2;
  if (!hasVerifiedPhone(user)) return 0;
  return 1;
}

export function tierShape(user) {
  const tier = effectiveTier(user);
  const limits = limitsForTier(tier);
  return {
    tier,
    verificationStatus: user.verificationStatus,
    cniVerifiedAt: user.cniVerifiedAt?.toISOString() ?? null,
    addressVerifiedAt: user.addressVerifiedAt?.toISOString() ?? null,
    limits: {
      maxNationalBalance: limits.maxNationalBalance,
      maxKoriBalance: limits.maxKoriBalance,
      maxSendPerDay: limits.maxSendPerDay,
      maxCashOutPerDay: limits.maxCashOutPerDay,
      canCashOut: limits.canCashOut,
      canInternational: limits.canInternational,
      canCreateBusiness: limits.canCreateBusiness,
    },
  };
}
