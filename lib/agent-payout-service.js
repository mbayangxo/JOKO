import { prisma } from './prisma.js';
import { runMoneyTransaction } from './wallet-atomic.js';
import { createInAppNotification } from './notify-service.js';

/** Minimum monthly processed volume (XOF) to qualify for flat fee. */
export const AGENT_FLAT_FEE_MIN_VOLUME_XOF = 100_000;

export function agentPayoutShape(row) {
  return {
    id: row.id,
    periodYear: row.periodYear,
    periodMonth: row.periodMonth,
    totalVolumeXof: row.totalVolumeXof,
    depositCount: row.depositCount,
    flatFeeXof: row.flatFeeXof,
    volumeBonusXof: row.volumeBonusXof,
    totalPaidXof: row.totalPaidXof,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export function computeAgentMonthlyPayout(agent, volumeXof, depositCount) {
  const flatFeeXof =
    volumeXof >= AGENT_FLAT_FEE_MIN_VOLUME_XOF ? Math.max(0, agent.monthlyFlatFeeXof ?? 25_000) : 0;
  const volumeBonusXof = Math.floor((volumeXof * (agent.volumeBonusBps ?? 50)) / 10_000);
  const totalPaidXof = flatFeeXof + volumeBonusXof;
  return { flatFeeXof, volumeBonusXof, totalPaidXof, depositCount, totalVolumeXof: volumeXof };
}

function payoutReference(agentId, periodYear, periodMonth) {
  return `APO-${agentId}-${periodYear}-${String(periodMonth).padStart(2, '0')}`;
}

/**
 * Monthly agent payout cron — pays last calendar month.
 * Flat fee (if volume ≥ 100k XOF) + volume bonus (% of processed cash-ins).
 */
export async function runAgentMonthlyPayouts(db = prisma, now = new Date()) {
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodYear = periodStart.getUTCFullYear();
  const periodMonth = periodStart.getUTCMonth() + 1;

  const agents = await db.agentProfile.findMany({
    where: { status: 'active' },
    include: { user: { include: { wallet: true } } },
  });

  const results = [];

  for (const agent of agents) {
    const agg = await db.agentDeposit.aggregate({
      where: {
        agentId: agent.id,
        status: 'confirmed',
        confirmedAt: { gte: periodStart, lt: periodEnd },
      },
      _sum: { amountXof: true },
      _count: true,
    });

    const volumeXof = agg._sum.amountXof ?? 0;
    const depositCount = agg._count ?? 0;
    const calc = computeAgentMonthlyPayout(agent, volumeXof, depositCount);
    const ref = payoutReference(agent.id, periodYear, periodMonth);

    let outcome;
    try {
      outcome = await runMoneyTransaction(db, async (tx) => {
        const existing = await tx.agentPayout.findUnique({
          where: {
            agentId_periodYear_periodMonth: { agentId: agent.id, periodYear, periodMonth },
          },
        });
        if (existing) {
          return { status: 'skipped', reason: 'already_paid' };
        }

        if (calc.totalPaidXof <= 0 || !agent.user?.wallet) {
          await tx.agentPayout.create({
            data: {
              agentId: agent.id,
              periodYear,
              periodMonth,
              totalVolumeXof: volumeXof,
              depositCount,
              flatFeeXof: 0,
              volumeBonusXof: 0,
              totalPaidXof: 0,
              status: 'zero',
              reference: ref,
            },
          });
          return { status: 'zero', volumeXof };
        }

        // J1 safety: agent commissions are a platform expense with no funding
        // source in the closed loop, and the previous code credited the XOF
        // figure as ₭ (10× value). The payout is now recorded as an owed
        // liability ('accrued') and settled out-of-band / from a funded
        // treasury account (J2) — it never mints wallet value here.
        await tx.agentPayout.create({
          data: {
            agentId: agent.id,
            periodYear,
            periodMonth,
            totalVolumeXof: volumeXof,
            depositCount,
            flatFeeXof: calc.flatFeeXof,
            volumeBonusXof: calc.volumeBonusXof,
            totalPaidXof: calc.totalPaidXof,
            status: 'accrued',
            reference: ref,
          },
        });

        return { status: 'accrued', totalPaidXof: calc.totalPaidXof, volumeXof };
      });
    } catch (err) {
      if (err.code === 'P2002') {
        results.push({ agentId: agent.id, status: 'skipped', reason: 'already_paid' });
        continue;
      }
      throw err;
    }

    if (outcome.status === 'accrued') {
      await createInAppNotification(
        agent.userId,
        'Prime agent K21',
        `${calc.totalPaidXof.toLocaleString('fr-FR')} FCFA calculés — ${periodMonth}/${periodYear} (${depositCount} dépôts). Versement par l’équipe Joko.`,
        { kind: 'agent_payout' },
      );
    }

    results.push({ agentId: agent.id, ...outcome });
  }

  return { periodYear, periodMonth, processed: results.length, results };
}

export async function getAgentPayoutHistory(agentId, limit = 12) {
  const rows = await prisma.agentPayout.findMany({
    where: { agentId },
    orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }],
    take: limit,
  });
  return rows.map(agentPayoutShape);
}

export async function previewAgentPayout(agentId, now = new Date()) {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const agent = await prisma.agentProfile.findUnique({ where: { id: agentId } });
  if (!agent) return null;

  const agg = await prisma.agentDeposit.aggregate({
    where: {
      agentId,
      status: 'confirmed',
      confirmedAt: { gte: periodStart },
    },
    _sum: { amountXof: true },
    _count: true,
  });

  return computeAgentMonthlyPayout(agent, agg._sum.amountXof ?? 0, agg._count ?? 0);
}
