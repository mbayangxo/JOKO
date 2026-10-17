import { prisma } from './prisma.js';
import { isDakarNightWindow } from './geo-ip.js';
import { assertDeviceVerified, countDevicesLast24h } from './device-session.js';
import { OUTBOUND_LEDGER_TYPES, RISK_LIMITS } from './risk-constants.js';
import { amountToNationalXof } from './step-up.js';

export const RECOVERY_COOL_OFF_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluate fraud/risk flags. Returns { hold, flags, reasons }.
 * hold=true means transaction must not execute — queue for human review.
 */
export async function assessTransactionRisk(db, ctx) {
  const {
    userId,
    req,
    operationType,
    amountNational,
    recipientHandle,
    recipientId,
    forceHold = false,
  } = ctx;

  const flags = [];
  const reasons = [];
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { hold: true, flags: ['user_missing'], reasons: ['User not found'] };

  // 24h cool-off after access recovery: a stolen SIM / recovered account must
  // not be able to drain the wallet immediately.
  if (user.accountRecoveredAt && now.getTime() - user.accountRecoveredAt.getTime() < RECOVERY_COOL_OFF_MS) {
    flags.push('recent_recovery');
    reasons.push('Account access was recovered less than 24 hours ago');
  }

  if (user.credentialResetRequiredAt) {
    flags.push('credential_reset_required');
    reasons.push('Credentials must be re-established before money can leave the account');
  }

  const deviceCheck = await assertDeviceVerified(userId, req);
  if (!deviceCheck.ok) {
    flags.push(deviceCheck.code);
    reasons.push(deviceCheck.message);
  }

  const devices24h = await countDevicesLast24h(userId);
  if (devices24h >= RISK_LIMITS.DEVICES_24H) {
    flags.push('device_multi_login');
    reasons.push(`${devices24h} devices in 24 hours`);
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (wallet) {
    const txCountHour = await db.ledgerEntry.count({
      where: {
        walletId: wallet.id,
        createdAt: { gte: oneHourAgo },
        amount: { lt: 0 },
      },
    });

    const koriSendHour = await db.koriTransaction.count({
      where: { senderId: userId, createdAt: { gte: oneHourAgo } },
    });

    const heldHour = await db.heldTransaction.count({
      where: {
        userId,
        createdAt: { gte: oneHourAgo },
        status: { in: ['pending_review', 'approved'] },
      },
    });

    const totalHour = txCountHour + koriSendHour + heldHour;
    if (totalHour >= RISK_LIMITS.TX_PER_HOUR) {
      flags.push('velocity_tx_hour');
      reasons.push(`More than ${RISK_LIMITS.TX_PER_HOUR} transactions in 1 hour`);
    }

    const outbound = await db.ledgerEntry.aggregate({
      where: {
        walletId: wallet.id,
        createdAt: { gte: oneDayAgo },
        type: { in: OUTBOUND_LEDGER_TYPES },
        amount: { lt: 0 },
      },
      _sum: { amount: true },
    });
    const sent24h = Math.abs(outbound._sum.amount ?? 0);
    if (sent24h + amountNational > RISK_LIMITS.OUTBOUND_24H_XOF) {
      flags.push('velocity_daily_outbound');
      reasons.push(`Over ${RISK_LIMITS.OUTBOUND_24H_XOF.toLocaleString('fr-FR')} XOF sent in 24h`);
    }

    if (recipientHandle) {
      const repeat = await db.ledgerEntry.count({
        where: {
          walletId: wallet.id,
          createdAt: { gte: oneHourAgo },
          type: 'send',
          counterpartyHandle: recipientHandle,
          amount: -amountNational,
        },
      });
      if (repeat >= RISK_LIMITS.REPEAT_SAME_RECIPIENT_HOUR - 1) {
        flags.push('velocity_repeat_recipient');
        reasons.push('Same amount to same recipient repeatedly');
      }
    }
  }

  if (isDakarNightWindow(now) && amountNational > RISK_LIMITS.NIGHT_LARGE_XOF) {
    flags.push('velocity_night_large');
    reasons.push('Large transaction between 2am–4am Dakar time');
  }

  if (operationType === 'kori_convert' && amountNational >= RISK_LIMITS.KORI_CONVERT_REVIEW_XOF) {
    flags.push('kori_convert_review');
    reasons.push('Kori conversion above manual review threshold');
  }

  if (operationType === 'kori_mint' && !ctx.hasNationalDepositProof) {
    flags.push('kori_unbacked_increase');
    reasons.push('Kori increase without verified national deposit');
  }

  if (forceHold) {
    flags.push('manual_review_required');
    reasons.push('Policy requires manual review');
  }

  const hold = flags.length > 0;
  return { hold, flags, reasons };
}

export function nationalAmountForOperation(operationType, payload, country) {
  if (payload.amountNational != null) return payload.amountNational;
  if (payload.amount != null && payload.currency !== 'kori') return payload.amount;
  if (payload.amountKori != null) return amountToNationalXof(payload.amountKori, 'kori', country);
  if (payload.amount != null && payload.currency === 'kori') {
    return amountToNationalXof(payload.amount, 'kori', country);
  }
  return 0;
}
