import { LEGACY_TONTINE_MONEY_SUSPENDED, processTontineGroup } from '../tontine-service.js';
import { prisma } from '../prisma.js';
import { writeSecureLog } from '../secure-log.js';

/**
 * Daily 08:00 WAT: collect contributions from members and release pot to rotation winner.
 */
export async function runTontineProcessor(db = prisma) {
  const now = new Date();
  // P0 containment: no automatic collection from members' wallets.
  if (LEGACY_TONTINE_MONEY_SUSPENDED) return { job: 'tontine_processor', processed: 0, skipped: 'legacy_tontine_money_suspended', ranAt: now.toISOString() };
  const due = await db.tontineGroup.findMany({
    where: {
      active: true,
      OR: [{ nextDueAt: { lte: now } }, { nextDueAt: null }],
    },
    select: { id: true },
  });

  const results = [];
  for (const { id } of due) {
    try {
      results.push(await processTontineGroup(id, db, now));
    } catch (error) {
      console.error('[CRON tontine_processor]', id, error);
      results.push({
        groupId: id,
        ok: false,
        error: error instanceof Error ? error.message : 'failed',
      });
    }
  }

  if (results.length > 0) {
    await writeSecureLog({
      category: 'tontine_processor',
      severity: 'info',
      title: `Processed ${results.length} tontine groups`,
      payload: { results },
    });
  }

  return { job: 'tontine_processor', processed: results.length, results, ranAt: now.toISOString() };
}
