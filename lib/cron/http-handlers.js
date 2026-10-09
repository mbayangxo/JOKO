import { assertCronAuth } from '../cron-auth.js';
import { runFinancialIntegrityCheck } from './financial-integrity.js';
import { runPendingTransactionResolver } from './pending-transactions.js';
import { runFraudMonitor } from './fraud-monitor.js';
import { runTontineProcessor } from './tontine-processor.js';
import { runRiderStatusUpdater } from './rider-status.js';
import { runDailyFinancialReport } from './daily-financial-report.js';
import { runDeliveryAutoRelease } from './delivery-auto-release.js';
import { purgeExpiredKycImageMetadata } from '../kyc-service.js';
import { runScheduledPayrollCron } from './payroll-processor.js';
import { runScheduledPaymentsCron } from './scheduled-payments-processor.js';
import { runAgentMonthlyPayoutCron } from './agent-payout-processor.js';
import { runSchoolFeeReminders } from './school-reminders.js';
import { runTradeInvoiceReminders } from './trade-invoice-reminders.js';
import { runKebuScoreAlerts } from './kebu-score-alerts.js';
import { refreshYouTubeChartCache } from '../youtube-music.js';
import { sweepCash } from '../agents/cash.js';

function cronHandler(runner) {
  return async (req, res) => {
    if (!assertCronAuth(req, res)) return;
    try {
      const result = await runner();
      res.json(result);
    } catch (error) {
      console.error('[CRON]', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Cron job failed',
      });
    }
  };
}

/** Hobby beta: one Vercel cron hits this; runs every former /api/cron/* job once daily. */
export async function runAllDailyCronJobs() {
  const jobs = [
    { name: 'financial_integrity', run: runFinancialIntegrityCheck },
    { name: 'pending_transactions', run: runPendingTransactionResolver },
    { name: 'fraud_monitor', run: runFraudMonitor },
    { name: 'tontine_processor', run: runTontineProcessor },
    { name: 'rider_status', run: runRiderStatusUpdater },
    { name: 'daily_financial_report', run: runDailyFinancialReport },
    { name: 'delivery_auto_release', run: runDeliveryAutoRelease },
    { name: 'kyc_purge', run: purgeExpiredKycImageMetadata },
    { name: 'payroll_processor', run: runScheduledPayrollCron },
    { name: 'scheduled_payments', run: runScheduledPaymentsCron },
    { name: 'agent_monthly_payout', run: runAgentMonthlyPayoutCron },
    { name: 'agent_cash_sweep', run: () => sweepCash() },
    { name: 'school_fee_reminders', run: runSchoolFeeReminders },
    { name: 'trade_invoice_reminders', run: runTradeInvoiceReminders },
    { name: 'kebu_score_alerts', run: runKebuScoreAlerts },
    { name: 'youtube_chart_refresh', run: refreshYouTubeChartCache },
    { name: 'mbolo_ephemeral', run: () => import('./mbolo-ephemeral.js').then((m) => m.cronMboloEphemeral()) },
  ];

  const results = [];
  for (const job of jobs) {
    try {
      results.push({ name: job.name, ok: true, result: await job.run() });
    } catch (error) {
      console.error(`[CRON daily] ${job.name}`, error);
      results.push({
        name: job.name,
        ok: false,
        error: error instanceof Error ? error.message : 'Cron job failed',
      });
    }
  }

  return {
    ranAt: new Date().toISOString(),
    jobs: results,
    failed: results.filter((r) => !r.ok).length,
  };
}

export const cronDailyAll = cronHandler(runAllDailyCronJobs);

export const cronFinancialIntegrity = cronHandler(runFinancialIntegrityCheck);
export const cronPendingTransactions = cronHandler(runPendingTransactionResolver);
export const cronFraudMonitor = cronHandler(runFraudMonitor);
export const cronTontineProcessor = cronHandler(runTontineProcessor);
export const cronRiderStatus = cronHandler(runRiderStatusUpdater);
export const cronDailyFinancialReport = cronHandler(runDailyFinancialReport);
export const cronDeliveryAutoRelease = cronHandler(runDeliveryAutoRelease);
export const cronScheduledPayments = cronHandler(runScheduledPaymentsCron);

export const cronAgentMonthlyPayout = cronHandler(runAgentMonthlyPayoutCron);
export const cronAgentCashSweep = cronHandler(() => sweepCash());
export const cronLogistics = cronHandler(async () => (await import('../logistics/handlers.js')).runLogisticsCron());
export const cronWork = cronHandler(async () => (await import('../work/handlers.js')).runWorkCron());

/** @deprecated use cronFinancialIntegrity */
export const cronKoriReconcile = cronFinancialIntegrity;

/** @deprecated use cronDeliveryAutoRelease */
export const cronDeliveriesAutoRelease = cronDeliveryAutoRelease;

/** A4: deferred affiliate settlement (no-op unless AFFILIATE_DEFERRED_SETTLEMENT=true). */
export const cronAffiliateSettlement = cronHandler(async () => {
  const m = await import('../affiliate-settlement.js');
  if (!m.affiliateDeferredEnabled()) return { skipped: 'affiliate_deferred_disabled' };
  return m.settleAffiliateCommissions();
});
