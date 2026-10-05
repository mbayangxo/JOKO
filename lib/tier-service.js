import { prisma } from './prisma.js';
import { koriToNational, nationalToKori } from './kori.js';
import { effectiveTier, limitsForTier } from './tier-limits.js';

export class TierLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'TierLimitError';
    this.status = 403;
  }
}

export function tierErrorStatus(code) {
  switch (code) {
    case 'tier_cash_out_blocked':
    case 'tier_international_blocked':
    case 'tier_business_blocked':
    case 'tier_send_daily_limit':
    case 'tier_send_blocked':
    case 'tier_cash_out_daily_limit':
    case 'tier_balance_cap':
    case 'tier_receive_cap':
      return 403;
    default:
      return 403;
  }
}

export function dakarDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Dakar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Read-only view of today's usage (no row created). */
export async function readDailyUsage(db, userId) {
  const row = await db.userDailyUsage.findUnique({ where: { userId_usageDate: { userId, usageDate: dakarDateString() } } });
  return row ?? { sentNational: 0, cashOutNational: 0 };
}

async function getDailyUsage(db, userId) {
  const usageDate = dakarDateString();
  return db.userDailyUsage.upsert({
    where: { userId_usageDate: { userId, usageDate } },
    create: { userId, usageDate },
    update: {},
  });
}

export async function assertCanSend(db, user, amountNational) {
  const tier = effectiveTier(user);
  const limits = limitsForTier(tier);

  if (limits.maxSendPerDay === 0) {
    throw new TierLimitError(
      'tier_send_blocked',
      'Envoi indisponible — vérifie ton numéro de téléphone pour débloquer les envois',
    );
  }
  if (limits.maxSendPerDay != null) {
    const usage = await getDailyUsage(db, user.id);
    if (usage.sentNational + amountNational > limits.maxSendPerDay) {
      throw new TierLimitError(
        'tier_send_daily_limit',
        `Limite d'envoi Tier ${tier} : ${limits.maxSendPerDay.toLocaleString('fr-FR')} XOF par jour`,
      );
    }
  }
}

export async function assertCanCashOut(db, user, amountNational) {
  const tier = effectiveTier(user);
  const limits = limitsForTier(tier);

  if (!limits.canCashOut) {
    throw new TierLimitError(
      'tier_cash_out_blocked',
      'Retrait indisponible — vérifie ta CNI pour débloquer les retraits',
    );
  }

  const usage = await getDailyUsage(db, user.id);
  if (usage.cashOutNational + amountNational > limits.maxCashOutPerDay) {
    throw new TierLimitError(
      'tier_cash_out_daily_limit',
      `Limite de retrait : ${limits.maxCashOutPerDay.toLocaleString('fr-FR')} XOF par jour`,
    );
  }
}

export async function assertCanInternational(user) {
  const limits = limitsForTier(effectiveTier(user));
  if (!limits.canInternational) {
    throw new TierLimitError(
      'tier_international_blocked',
      'Transferts internationaux disponibles après vérification CNI (Tier 2)',
    );
  }
}

export async function assertCanCreateBusiness(user) {
  if (process.env.ALLOW_BETA_DEPOSITS === 'true') return;
  // Tier 1 + AFRI ID (identité personnelle) is enough to open a KEBU business account.
  if (user.afriId) return;
  const limits = limitsForTier(effectiveTier(user));
  if (!limits.canCreateBusiness) {
    throw new TierLimitError(
      'tier_business_blocked',
      'Compte pro : il te faut ton AFRI ID (identité personnelle) — complète ton profil K21',
    );
  }
}

export async function assertWalletWithinCaps(user, wallet, { incomingNational = 0, incomingKori = 0 } = {}) {
  const limits = limitsForTier(effectiveTier(user));
  const incoming =
    incomingKori > 0
      ? incomingKori
      : nationalToKori(incomingNational, user.country ?? 'SN');
  const nextKori = wallet.koriBalance + incoming;

  if (nextKori > limits.maxKoriBalance) {
    throw new TierLimitError(
      'tier_balance_cap',
      `Plafond Tier ${effectiveTier(user)} : C ${limits.maxKoriBalance.toLocaleString('fr-FR')} maximum`,
    );
  }
}

export async function assertCanReceive(db, user, wallet, amountNational, amountKori = 0) {
  await assertWalletWithinCaps(user, wallet, {
    incomingNational: amountNational,
    incomingKori: amountKori,
  });
}

export function nationalEquivalent(amount, currency, country) {
  if (currency === 'kori') return koriToNational(amount, country);
  return amount;
}

export async function recordDailySend(db, userId, amountNational) {
  const usageDate = dakarDateString();
  await db.userDailyUsage.upsert({
    where: { userId_usageDate: { userId, usageDate } },
    create: { userId, usageDate, sentNational: amountNational },
    update: { sentNational: { increment: amountNational } },
  });
}

export async function recordDailyCashOut(db, userId, amountNational) {
  const usageDate = dakarDateString();
  await db.userDailyUsage.upsert({
    where: { userId_usageDate: { userId, usageDate } },
    create: { userId, usageDate, cashOutNational: amountNational },
    update: { cashOutNational: { increment: amountNational } },
  });
}

export async function loadUserWithWallet(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: { wallet: true },
  });
}
