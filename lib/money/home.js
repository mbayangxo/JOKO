import { prisma } from '../prisma.js';
import { providers } from '../money-kernel/providers.js';
import { collectSignals, decide } from '../risk/engine.js';
import { readDailyUsage } from '../tier-service.js';
import { effectiveTier, limitsForTier } from '../tier-limits.js';
import { listActivity } from './activity.js';
import { UNIT, limitsFor } from './policy.js';
import { CATEGORIES, explain } from './user-reasons.js';

/**
 * J4 Money home: real state only.
 *  - available: spendable ₭ (customer:{u}:available)
 *  - held: reserved ₭ (pending cash-outs) — shown, never spendable
 *  - pendingIn: cash-ins awaiting provider confirmation — shown, not credited
 *  - actions: what this account can do now, each with a user-safe reason and
 *    next step when it cannot (no fraud logic disclosed; viewing the home
 *    screen records no risk decision).
 */
const ok = () => ({ allowed: true });
const no = (category) => ({ allowed: false, category, ...CATEGORIES[category] });

function providerUp(name) {
  try {
    const mode = providers[name]?.mode();
    if (!mode || mode === 'unavailable') return false;
    if (process.env.NODE_ENV === 'production' && mode !== 'live') return false;
    return true;
  } catch {
    return false;
  }
}

export async function moneyHome(userId, req, db = prisma) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true, phone: true, verificationTier: true, cniVerifiedAt: true, addressVerifiedAt: true,
      frozenByAdminAt: true, credentialResetRequiredAt: true, pinHash: true,
    },
  });
  const [accounts, pendingInOps, usage, recent] = await Promise.all([
    db.ledgerAccount.findMany({ where: { code: { in: [`customer:${userId}:available`, `customer:${userId}:held`] } }, select: { code: true, balance: true } }),
    db.externalOperation.findMany({ where: { userId, direction: 'in', state: { in: ['created', 'authorized', 'submitted', 'expired'] } }, select: { amountKori: true } }),
    readDailyUsage(db, userId),
    listActivity(userId, { limit: 5, db }),
  ]);
  const bal = (suffix) => Number(accounts.find((a) => a.code.endsWith(suffix))?.balance ?? 0);
  const wallet = await db.wallet.findUnique({ where: { userId }, select: { koriBalance: true } });
  // Before the first posting the ledger account may not exist yet: the projection is authoritative-equal.
  const available = accounts.length ? bal(':available') : wallet?.koriBalance ?? 0;
  const held = bal(':held');
  const pendingIn = pendingInOps.reduce((s, o) => s + Number(o.amountKori), 0);

  const limits = limitsFor(user, usage);
  const tier = effectiveTier(user);
  const tierLimits = limitsForTier(tier);

  const actions = { receive: ok(), request: ok() };
  if (user.frozenByAdminAt) {
    for (const a of ['send', 'merchantPay', 'cashOut', 'cashIn', 'request']) actions[a] = no('account_suspended');
  } else {
    const outgoing =
      user.credentialResetRequiredAt ? no('credentials_reset')
      : tierLimits.maxSendPerDay === 0 ? no('verify_phone')
      : limits.sendRemainingTodayKori === 0 ? no('limit_reached')
      : available <= 0 ? no('insufficient_funds')
      : ok();
    actions.send = outgoing;
    actions.merchantPay = outgoing;
    actions.cashIn = providerUp('julaya') || providerUp('stripe') ? ok() : no('provider_unavailable');

    if (!tierLimits.canCashOut) actions.cashOut = no(tier === 0 ? 'verify_phone' : 'verify_identity');
    else if (limits.cashOutRemainingTodayKori === 0) actions.cashOut = no('limit_reached');
    else if (available <= 0) actions.cashOut = no('insufficient_funds');
    else if (!providerUp('julaya')) actions.cashOut = no('provider_unavailable');
    else {
      const { signals } = await collectSignals(db, { userId, req, action: 'cash_out', amountNational: 0 });
      const { decision } = decide('cash_out', signals);
      if (decision === 'deny' || decision === 'hold') {
        const ex = explain(signals.map((s) => s.code));
        actions.cashOut = { allowed: false, category: ex.category, message: ex.message, nextStep: ex.nextStep };
      } else {
        // 'review' is not disclosed: the request is accepted and routed to review.
        actions.cashOut = { allowed: true, requiresPin: true };
      }
    }
  }
  if (actions.send.allowed) actions.send.requiresPinAtOrAboveKori = limits.stepUpAtOrAboveKori;

  return {
    unit: UNIT,
    balance: { availableKori: available, heldKori: held, pendingInKori: pendingIn },
    explain: {
      held: held ? 'Montant réservé pour un retrait en cours — non disponible.' : null,
      pendingIn: pendingIn ? 'Rechargement en attente de confirmation — pas encore disponible.' : null,
    },
    tier: { level: tier, label: tierLimits.label, next: limits.nextTier },
    limits,
    pinConfigured: Boolean(user.pinHash),
    actions,
    recent: recent.items,
  };
}
