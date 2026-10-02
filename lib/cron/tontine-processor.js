import { remindDueContributions } from '../tontine-service.js';
import { prisma } from '../prisma.js';
import { writeSecureLog } from '../secure-log.js';

/**
 * Daily 08:00 WAT: remind members whose contribution is due. It NEVER debits
 * anyone — every contribution is authorized by the member (tontine-service).
 */
export async function runTontineProcessor(db = prisma) {
  const now = new Date();
  const results = await remindDueContributions(db, now);
  if (results.length > 0) {
    await writeSecureLog({
      category: 'tontine_processor',
      severity: 'info',
      title: `Reminded ${results.length} tontine groups`,
      payload: { results },
    });
  }
  return { job: 'tontine_processor', processed: results.length, results, ranAt: now.toISOString() };
}
