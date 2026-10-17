-- P0 tontine drain: historical exposure. READ-ONLY. Production schema as of 7d262de.
-- Run ONLY on the verified Jokko production database, ONLY with separate authorization:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f historical-tontine-exposure.sql
-- Output: opaque ids (cuid), counts, sums and timestamps. No names, phones or group names
-- (pot_in legs carry member names in counterpartyName, so that column is never selected).
-- Amounts are national-wallet units (XOF), as moved by transferNational.
-- Nothing here reverses, refunds, deletes or updates anything. Remediation is a finance/legal decision.
BEGIN TRANSACTION READ ONLY;

\echo '== 1. Groups: size, non-consenting members (no consent step existed: every non-creator was added by the creator)'
SELECT g.id AS group_id, g."createdBy" AS creator_id, g."amountPerMember", g.frequency, g.active,
       COUNT(m.id) AS members, COUNT(m.id) FILTER (WHERE m."userId" <> g."createdBy") AS members_added_without_consent,
       g."createdAt", g."lastProcessedAt", g."nextDueAt", g."potBalance"
  FROM "TontineGroup" g LEFT JOIN "TontineMembership" m ON m."groupId" = g.id
 GROUP BY g.id ORDER BY g."createdAt";

\echo '== 2. Collection runs (one TONTINE-xxxx reference per run), attributed to a creator via the -R (pot_in) leg'
WITH debits AS (
  SELECT split_part(d.reference, '-C-', 1) AS run_ref, d."userId" AS debited_user, -d.amount AS amount, d."createdAt",
         r."userId" AS creator_id
    FROM "LedgerEntry" d JOIN "LedgerEntry" r ON r.reference = d.reference || '-R'
   WHERE d.type = 'tontine_contribution' AND d.reference LIKE 'TONTINE-%'
)
SELECT run_ref, creator_id, MIN("createdAt") AS run_at,
       COUNT(*) AS debits, COUNT(*) FILTER (WHERE debited_user <> creator_id) AS debits_of_others,
       SUM(amount) FILTER (WHERE debited_user <> creator_id) AS amount_from_others,
       SUM(amount) FILTER (WHERE debited_user = creator_id) AS amount_from_creator
  FROM debits GROUP BY run_ref, creator_id ORDER BY run_at;

\echo '== 3. Scheduled (daily cron) vs manual (creator release): a run within 10 minutes after a tontine_processor secure-log entry is classified scheduled'
WITH runs AS (
  SELECT split_part(reference, '-C-', 1) AS run_ref, MIN("createdAt") AS run_at
    FROM "LedgerEntry" WHERE type = 'tontine_contribution' AND reference LIKE 'TONTINE-%' GROUP BY 1
), cron AS (
  SELECT "createdAt" FROM "SecureLog" WHERE category = 'tontine_processor'
)
SELECT CASE WHEN EXISTS (SELECT 1 FROM cron c WHERE c."createdAt" BETWEEN r.run_at AND r.run_at + interval '10 minutes') THEN 'scheduled' ELSE 'manual_release' END AS trigger,
       COUNT(*) AS runs, MIN(run_at) AS first_run, MAX(run_at) AS last_run
  FROM runs r GROUP BY 1;

\echo '== 4. Repeat collections: members debited more than once by the same creator'
WITH debits AS (
  SELECT d."userId" AS debited_user, r."userId" AS creator_id, -d.amount AS amount, d."createdAt"
    FROM "LedgerEntry" d JOIN "LedgerEntry" r ON r.reference = d.reference || '-R'
   WHERE d.type = 'tontine_contribution' AND d.reference LIKE 'TONTINE-%' AND d."userId" <> r."userId"
)
SELECT creator_id, debited_user, COUNT(*) AS times_debited, SUM(amount) AS total_debited, MIN("createdAt") AS first_at, MAX("createdAt") AS last_at
  FROM debits GROUP BY 1, 2 HAVING COUNT(*) > 1 ORDER BY total_debited DESC;

\echo '== 5. Creator wallets: credited as "pot" vs paid out to others (net retained = exposure to investigate)'
WITH pot_in AS (
  SELECT "userId" AS creator_id, SUM(amount) AS credited, COUNT(*) AS credits FROM "LedgerEntry" WHERE type = 'tontine_pot_in' GROUP BY 1
), paid_out AS (
  SELECT p."userId" AS creator_id,
         SUM(-p.amount) FILTER (WHERE rcv."userId" <> p."userId") AS paid_to_others,
         SUM(-p.amount) FILTER (WHERE rcv."userId" = p."userId") AS paid_to_self
    FROM "LedgerEntry" p JOIN "LedgerEntry" rcv ON rcv.reference = p.reference || '-R'
   WHERE p.type = 'tontine_payout' GROUP BY 1
)
SELECT i.creator_id, i.credits, i.credited, COALESCE(o.paid_to_others, 0) AS paid_to_others, COALESCE(o.paid_to_self, 0) AS paid_to_self,
       i.credited - COALESCE(o.paid_to_others, 0) AS retained_by_creator
  FROM pot_in i LEFT JOIN paid_out o USING (creator_id) ORDER BY retained_by_creator DESC;

\echo '== 6. Time periods'
SELECT MIN("createdAt") AS first_collection, MAX("createdAt") AS last_collection, COUNT(DISTINCT split_part(reference, '-C-', 1)) AS runs,
       COUNT(DISTINCT "userId") AS distinct_users_debited
  FROM "LedgerEntry" WHERE type = 'tontine_contribution' AND reference LIKE 'TONTINE-%';

\echo '== 7. Totals for finance/legal review'
SELECT
  (SELECT COALESCE(SUM(-amount), 0) FROM "LedgerEntry" WHERE type = 'tontine_contribution' AND reference LIKE 'TONTINE-%') AS total_collected,
  (SELECT COALESCE(SUM(amount), 0) FROM "LedgerEntry" WHERE type = 'tontine_pot_in') AS total_credited_to_creators,
  (SELECT COALESCE(SUM(amount), 0) FROM "LedgerEntry" WHERE type = 'tontine_receive') AS total_payouts_received,
  (SELECT COUNT(*) FROM "TontineGroup") AS groups,
  (SELECT COUNT(*) FROM "TontineMembership" m JOIN "TontineGroup" g ON g.id = m."groupId" WHERE m."userId" <> g."createdBy") AS memberships_without_consent;

ROLLBACK;
