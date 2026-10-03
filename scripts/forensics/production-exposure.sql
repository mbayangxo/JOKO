-- ============================================================================
-- Jokko production exposure investigation — READ ONLY
-- ----------------------------------------------------------------------------
-- Run with a read-only role (or a read replica):
--   psql "$PRODUCTION_READONLY_URL" -v ON_ERROR_STOP=1 -f scripts/forensics/production-exposure.sql
-- The whole script runs inside a READ ONLY transaction and ends with ROLLBACK,
-- so it cannot modify data even with a privileged role. Outputs internal IDs,
-- references and amounts only — no names, phones or emails.
-- Do NOT call the production API for this: every API request writes an
-- ApiAuditLog row.
-- Units: ₭ (Kori) unless the column says Xof. 1 ₭ = 10 XOF.
-- Schema-tolerant: it must run on production BEFORE this branch deploys, so
-- columns/tables added by J1+ are read via to_jsonb()/to_regclass() guards.
-- Validated on a database built from prisma/migrations/0_baseline (the
-- 2026-08-17 production shape) and on the current schema.
-- ============================================================================
BEGIN TRANSACTION READ ONLY;

\echo '== 0. Totals: wallets vs reserve (all custody accounts) =='
SELECT
  (SELECT COALESCE(SUM("koriBalance"),0) FROM "Wallet")                AS wallets_kori,
  (SELECT COALESCE(SUM("balance"),0) FROM "BusinessWallet")             AS business_kori,
  (SELECT COALESCE(SUM("balanceKori"),0) FROM "PaymentFund")            AS funds_kori,
  (SELECT COALESCE(SUM("balanceKori"),0) FROM "MerchantVoucher")        AS vouchers_kori,
  (SELECT COALESCE(SUM("potBalance"),0) FROM "TontineGroup")            AS tontine_pots_kori,
  (SELECT COALESCE(SUM(COALESCE((to_jsonb(de)->>'amountKoriHeld')::bigint, de."amountNational")),0) FROM "DeliveryEscrow" de
     WHERE de.status IN ('reserved','disputed_held'))                  AS escrow_kori,
  r."totalKoriInCirculation", r."totalReserveHeldXof", r."conversionsFrozen", r."lastReconciliationOk"
FROM "KoriReserve" r WHERE r.id = 'global';

\echo '== 1. Mock/sandbox rail settlements (P0-2: Julaya mock auto-settle) =='
SELECT direction, status, COUNT(*) AS n, SUM(amount) AS xof, MIN("createdAt") AS first, MAX("createdAt") AS last
FROM "RailTransaction" WHERE "externalId" LIKE 'sandbox-%' GROUP BY 1,2 ORDER BY 1,2;
SELECT id, reference, "userId", direction, amount AS xof, status, "createdAt"
FROM "RailTransaction" WHERE "externalId" LIKE 'sandbox-%' AND direction = 'in' AND status = 'completed'
ORDER BY "createdAt";

\echo '== 2. Cash-in ledger rows without an authoritative settlement =='
-- A cash_in ledger reference must match a completed non-sandbox rail, a
-- completed Stripe deposit, or a confirmed agent deposit.
SELECT le.reference, le."userId", le.amount AS kori, le."createdAt",
       CASE WHEN le.reference LIKE 'DEP-%'  THEN 'deposits/national (P0-1)'
            WHEN le.reference LIKE 'BETA-%' THEN 'beta credit'
            WHEN le.reference LIKE 'CIN-%'  THEN 'cash/in rail'
            ELSE 'other' END AS source
FROM "LedgerEntry" le
WHERE le.type = 'cash_in'
  AND NOT EXISTS (SELECT 1 FROM "RailTransaction" r WHERE r.reference = le.reference AND r.status = 'completed'
                    AND COALESCE(r."externalId",'') NOT LIKE 'sandbox-%')
  AND NOT EXISTS (SELECT 1 FROM "StripeDeposit" s WHERE s.reference = le.reference AND s.status = 'completed')
  AND NOT EXISTS (SELECT 1 FROM "AgentDeposit" a WHERE a.reference = le.reference AND a.status = 'confirmed')
ORDER BY le."createdAt";
SELECT CASE WHEN reference LIKE 'DEP-%' THEN 'DEP' WHEN reference LIKE 'BETA-%' THEN 'BETA'
            WHEN reference LIKE 'CIN-%' THEN 'CIN' ELSE 'other' END AS prefix,
       COUNT(*) AS n, SUM(amount) AS kori
FROM "LedgerEntry" le WHERE type = 'cash_in'
  AND NOT EXISTS (SELECT 1 FROM "RailTransaction" r WHERE r.reference = le.reference AND r.status = 'completed'
                    AND COALESCE(r."externalId",'') NOT LIKE 'sandbox-%')
  AND NOT EXISTS (SELECT 1 FROM "StripeDeposit" s WHERE s.reference = le.reference AND s.status = 'completed')
  AND NOT EXISTS (SELECT 1 FROM "AgentDeposit" a WHERE a.reference = le.reference AND a.status = 'confirmed')
GROUP BY 1;

\echo '== 3. Unfunded "earn" mints (P2P / merchant / delivery rewards) =='
SELECT note AS earn_type, COUNT(*) AS n, SUM("amountKori") AS kori, COUNT(DISTINCT "recipientId") AS users
FROM "KoriTransaction" WHERE "transactionType" = 'earn' GROUP BY 1 ORDER BY kori DESC;
\echo '-- top earners (possible farming)'
SELECT "recipientId", COUNT(*) AS earns, SUM("amountKori") AS kori,
       MIN("createdAt") AS first, MAX("createdAt") AS last
FROM "KoriTransaction" WHERE "transactionType" = 'earn' AND note = 'send'
GROUP BY 1 HAVING COUNT(*) >= 10 ORDER BY earns DESC LIMIT 50;

\echo '== 4. Self-transfers (P0-6) =='
SELECT COUNT(*) AS n, COALESCE(SUM("amountKori"),0) AS kori FROM "KoriTransaction"
WHERE "transactionType" = 'send' AND "senderId" = "recipientId";
SELECT reference, "senderId", "amountKori", "createdAt" FROM "KoriTransaction"
WHERE "transactionType" = 'send' AND "senderId" = "recipientId" ORDER BY "createdAt" LIMIT 200;
\echo '-- round-trip pairs (A→B and B→A ≥ 5 times each within 24h)'
SELECT LEAST(a."senderId", a."recipientId") AS u1, GREATEST(a."senderId", a."recipientId") AS u2, COUNT(*) AS sends
FROM "KoriTransaction" a
WHERE a."transactionType" = 'send' AND a."senderId" <> a."recipientId"
GROUP BY 1,2, date_trunc('day', a."createdAt")
HAVING COUNT(*) >= 10 AND COUNT(DISTINCT a."senderId") = 2 ORDER BY sends DESC LIMIT 50;

\echo '== 5. Agent monthly payouts credited (10x unit bug, P0-11) =='
SELECT ap.status, COUNT(*) AS n, SUM(ap."totalPaidXof") AS intended_xof,
       SUM(le.amount) AS credited_kori, SUM(le.amount) * 10 AS credited_xof_equiv
FROM "AgentPayout" ap
LEFT JOIN "LedgerEntry" le ON le.reference = ap.reference
GROUP BY 1;
SELECT ap.reference, ap."agentId", ap."totalPaidXof", le.amount AS credited_kori, ap."createdAt"
FROM "AgentPayout" ap JOIN "LedgerEntry" le ON le.reference = ap.reference ORDER BY ap."createdAt";

\echo '== 6. Delivery escrow anomalies (P0-12) =='
SELECT de.status, ((to_jsonb(de)->>'amountKoriHeld')::bigint IS NULL) AS legacy, COUNT(*) AS n,
       SUM(de."amountNational") AS fee_xof, SUM(de."koriPayout") AS rider_kori, SUM((to_jsonb(de)->>'amountKoriHeld')::bigint) AS held_kori
FROM "DeliveryEscrow" de GROUP BY 1,2 ORDER BY 1,2;
\echo '-- legacy escrows: buyer debited fee as ₭ (10x); rider paid minted koriPayout'
SELECT de.reference, de."buyerId", de."riderId", de."amountNational" AS fee_xof,
       -le.amount AS buyer_debited_kori, de."koriPayout" AS rider_minted_kori, de.status, de."createdAt"
FROM "DeliveryEscrow" de LEFT JOIN "LedgerEntry" le ON le.reference = de.reference
WHERE (to_jsonb(de)->>'amountKoriHeld')::bigint IS NULL ORDER BY de."createdAt";

\echo '== 7. Partner payouts that burned settlement funds and failed without refund (P0-13) =='
SELECT to_regclass('public."PartnerPayout"') IS NOT NULL AND to_regclass('public."PartnerPayment"') IS NOT NULL AS has_partner \gset
\if :has_partner
SELECT p.id, p.reference, p."partnerId", p."amountXof", p.status, p."failureReason", p."createdAt",
       EXISTS (SELECT 1 FROM "KoriTransaction" k WHERE k.reference = 'payout_' || p.id) AS burned,
       EXISTS (SELECT 1 FROM "LedgerEntry" l WHERE l.reference = 'payout_' || p.id || '-REFUND') AS refunded
FROM "PartnerPayout" p
WHERE p.status <> 'completed' AND EXISTS (SELECT 1 FROM "KoriTransaction" k WHERE k.reference = 'payout_' || p.id);
\echo '-- payouts burned more than once'
SELECT reference, COUNT(*) FROM "KoriTransaction" WHERE reference LIKE 'payout_%' GROUP BY 1 HAVING COUNT(*) > 1;
\echo '-- partner payments completed without a provider rail (sandbox completion in production?)'
SELECT id, reference, "partnerId", "amountXof", status, "railReference", "completedAt"
FROM "PartnerPayment" WHERE status = 'completed' AND ("railReference" IS NULL OR "railReference" LIKE 'pp_%')
ORDER BY "completedAt";
\else
\echo '(Partner tables absent in this database — partner API never deployed here)'
\endif

\echo '== 8. Cash-outs whose funds stayed spendable while pending (P0-4) =='
SELECT status, "walletDebited", COUNT(*) AS n, SUM(amount) AS xof
FROM "RailTransaction" WHERE direction = 'out' GROUP BY 1,2 ORDER BY 1,2;
SELECT id, reference, "userId", amount AS xof, status, "externalId", "createdAt"
FROM "RailTransaction" WHERE direction = 'out' AND status IN ('pending','completed') AND "walletDebited" = false;

\echo '== 9. Duplicate external settlement / reference processing =='
SELECT "externalId", COUNT(*) FROM "RailTransaction" WHERE "externalId" IS NOT NULL
GROUP BY 1 HAVING COUNT(*) > 1;
SELECT reference, COUNT(*) FROM "LedgerEntry" WHERE reference LIKE '%-REFUND' GROUP BY 1 HAVING COUNT(*) > 1;
SELECT "stripeSessionId", COUNT(*) FROM "StripeDeposit" WHERE "stripeSessionId" IS NOT NULL
GROUP BY 1 HAVING COUNT(*) > 1;

\echo '== 10. Tontine debits under the old auto-collect model (no consent existed) =='
SELECT COUNT(*) AS contributions, COUNT(DISTINCT "userId") AS members_debited, SUM(-amount) AS kori
FROM "LedgerEntry" WHERE type = 'tontine_contribution' AND reference LIKE 'TONTINE-%';
\echo '-- per collection run (old ledger has no group id; run ref = TONTINE-xxxx, creator = receiver of the -R leg)'
SELECT split_part(d.reference, '-C-', 1) AS run_ref,
       r."userId" AS creator_wallet_owner,
       COUNT(*) AS debits,
       SUM(-d.amount) FILTER (WHERE d."userId" <> r."userId") AS kori_from_others,
       MIN(d."createdAt") AS debited_at
FROM "LedgerEntry" d
JOIN "LedgerEntry" r ON r.reference = d.reference || '-R'
WHERE d.type = 'tontine_contribution' AND d.reference LIKE 'TONTINE-%'
GROUP BY 1, 2 ORDER BY kori_from_others DESC NULLS LAST;
\echo '-- payouts from the old model (recipient, amount)'
SELECT reference, "userId" AS recipient, amount AS kori, "createdAt"
FROM "LedgerEntry" WHERE type = 'tontine_receive' AND reference LIKE 'TONTINE-%' ORDER BY "createdAt";
\echo '-- "pot" money that landed in creators'' personal wallets'
SELECT le."userId" AS creator, SUM(le.amount) AS kori_received_as_pot
FROM "LedgerEntry" le WHERE le.type = 'tontine_pot_in' GROUP BY 1 ORDER BY 2 DESC;

\echo '== 11. Kori conversion burns with no destination (P1-23) =='
SELECT COUNT(*) AS n, COALESCE(SUM("amountKori"),0) AS kori_burned, COUNT(DISTINCT "senderId") AS users
FROM "KoriTransaction" WHERE "transactionType" = 'convert';
SELECT reference, "senderId", "amountKori", "createdAt" FROM "KoriTransaction" WHERE "transactionType" = 'convert';

\echo '== 12. Recovery / email-verification anomalies (P0-9, P1-16) =='
-- Phone accounts with an email marked verified: the email came from the
-- profile step (never verified) or from auth/recover (attacker-attachable).
SELECT COUNT(*) AS phone_accounts_with_verified_email
FROM "User" WHERE "emailVerifiedAt" IS NOT NULL AND phone NOT LIKE 'e:%';
SELECT id, "emailVerifiedAt", "createdAt", "pinHash" IS NULL AS pin_reset
FROM "User" WHERE "emailVerifiedAt" IS NOT NULL AND phone NOT LIKE 'e:%' ORDER BY "emailVerifiedAt" DESC LIMIT 500;
\echo '-- OTP codes ever written to the SMS log table (should be redacted)'
SELECT COUNT(*) FROM "SmsMessage" WHERE purpose = 'otp' AND body <> '[otp redacted]';

\echo '== 13. Seeded demo alerts / culture items present in the DB =='
SELECT COUNT(*) AS seeded_alerts FROM "RegionalAlert" WHERE source = 'K21';
SELECT to_regclass('public."CultureFeedItem"') IS NOT NULL AS has_culture \gset
\if :has_culture
SELECT COUNT(*) AS culture_items FROM "CultureFeedItem";
\else
\echo '(CultureFeedItem table absent in this database)'
\endif

\echo '== 15. Credential/PII exposure via Mboolo thread lists (P0: raw User rows) =='
-- Every GET /api/mbolo/threads (or POST create) by a user who shared a thread
-- with someone else returned those members' pinHash/passwordHash/CNI/email/phone.
SELECT COUNT(DISTINCT a."userId") AS readers, COUNT(*) AS reads, MIN(a."createdAt") AS first, MAX(a."createdAt") AS last
FROM "ApiAuditLog" a
WHERE a.path IN ('/api/mbolo/threads') AND a."statusCode" BETWEEN 200 AND 299;
\echo '-- users whose hashes were potentially exposed (member of a thread with ≥2 members)'
SELECT COUNT(DISTINCT m."userId") AS exposed_users,
       COUNT(DISTINCT m."userId") FILTER (WHERE u."pinHash" IS NOT NULL) AS with_pin,
       COUNT(DISTINCT m."userId") FILTER (WHERE u."passwordHash" IS NOT NULL) AS with_password
FROM "MboloMember" m JOIN "User" u ON u.id = m."userId"
WHERE (SELECT COUNT(*) FROM "MboloMember" x WHERE x."threadId" = m."threadId") >= 2;
\echo '-- direct threads created by someone who had no prior friendship with the other member (possible harvesting)'
SELECT t."creatorId", COUNT(*) AS direct_threads_created
FROM "MboloThread" t
WHERE t.type = 'direct'
GROUP BY 1 HAVING COUNT(*) >= 20 ORDER BY 2 DESC LIMIT 50;

\echo '== 16. Credential exposure classification (input for remediate-credentials.mjs) =='
-- Leaking responses: thread list, thread create, add-members, join-by-invite.
-- A = had a PIN or password hash AND shared a thread with another user who
--     made a leaking request while both were members (audit-log evidence).
-- B = shared a thread with someone, but no audit evidence of a leaking read
--     (audit log missing/rotated, or reads predate logging).
-- C = never shared a thread with another user.
-- NOTE: the hash present today may post-date the read; A is conservative.
WITH leak_reads AS (
  SELECT a."userId" AS reader, a."createdAt" AS read_at
  FROM "ApiAuditLog" a
  WHERE a."statusCode" BETWEEN 200 AND 299 AND a."userId" IS NOT NULL
    AND (a.path = '/api/mbolo/threads' OR a.path LIKE '/api/mbolo/threads/%/members'
         OR a.path LIKE '/api/mbolo/threads/%/invite' OR a.path = '/api/mbolo/join-group')
), cred_class AS (
  SELECT u.id AS user_id,
    CASE
      WHEN (u."pinHash" IS NOT NULL OR u."passwordHash" IS NOT NULL) AND EXISTS (
        SELECT 1 FROM "MboloMember" me JOIN "MboloMember" other
          ON other."threadId" = me."threadId" AND other."userId" <> me."userId"
        JOIN leak_reads lr ON lr.reader = other."userId"
        WHERE me."userId" = u.id AND lr.read_at >= me."createdAt" AND lr.read_at >= other."createdAt")
        THEN 'A'
      WHEN EXISTS (
        SELECT 1 FROM "MboloMember" me JOIN "MboloMember" other
          ON other."threadId" = me."threadId" AND other."userId" <> me."userId"
        WHERE me."userId" = u.id)
        THEN 'B'
      ELSE 'C'
    END AS class
  FROM "User" u
)
SELECT class, COUNT(*) AS users FROM cred_class GROUP BY 1 ORDER BY 1;
\echo '-- class A ids (save to class-a.txt for the operator script)'
WITH leak_reads AS (
  SELECT a."userId" AS reader, a."createdAt" AS read_at
  FROM "ApiAuditLog" a
  WHERE a."statusCode" BETWEEN 200 AND 299 AND a."userId" IS NOT NULL
    AND (a.path = '/api/mbolo/threads' OR a.path LIKE '/api/mbolo/threads/%/members'
         OR a.path LIKE '/api/mbolo/threads/%/invite' OR a.path = '/api/mbolo/join-group')
), cred_class AS (
  SELECT u.id AS user_id,
    CASE
      WHEN (u."pinHash" IS NOT NULL OR u."passwordHash" IS NOT NULL) AND EXISTS (
        SELECT 1 FROM "MboloMember" me JOIN "MboloMember" other
          ON other."threadId" = me."threadId" AND other."userId" <> me."userId"
        JOIN leak_reads lr ON lr.reader = other."userId"
        WHERE me."userId" = u.id AND lr.read_at >= me."createdAt" AND lr.read_at >= other."createdAt")
        THEN 'A'
      WHEN EXISTS (
        SELECT 1 FROM "MboloMember" me JOIN "MboloMember" other
          ON other."threadId" = me."threadId" AND other."userId" <> me."userId"
        WHERE me."userId" = u.id)
        THEN 'B'
      ELSE 'C'
    END AS class
  FROM "User" u
)
SELECT user_id FROM cred_class WHERE class = 'A' ORDER BY 1;
\echo '-- class B ids (save to class-b.txt)'
WITH leak_reads AS (
  SELECT a."userId" AS reader, a."createdAt" AS read_at
  FROM "ApiAuditLog" a
  WHERE a."statusCode" BETWEEN 200 AND 299 AND a."userId" IS NOT NULL
    AND (a.path = '/api/mbolo/threads' OR a.path LIKE '/api/mbolo/threads/%/members'
         OR a.path LIKE '/api/mbolo/threads/%/invite' OR a.path = '/api/mbolo/join-group')
), cred_class AS (
  SELECT u.id AS user_id,
    CASE
      WHEN (u."pinHash" IS NOT NULL OR u."passwordHash" IS NOT NULL) AND EXISTS (
        SELECT 1 FROM "MboloMember" me JOIN "MboloMember" other
          ON other."threadId" = me."threadId" AND other."userId" <> me."userId"
        JOIN leak_reads lr ON lr.reader = other."userId"
        WHERE me."userId" = u.id AND lr.read_at >= me."createdAt" AND lr.read_at >= other."createdAt")
        THEN 'A'
      WHEN EXISTS (
        SELECT 1 FROM "MboloMember" me JOIN "MboloMember" other
          ON other."threadId" = me."threadId" AND other."userId" <> me."userId"
        WHERE me."userId" = u.id)
        THEN 'B'
      ELSE 'C'
    END AS class
  FROM "User" u
)
SELECT user_id FROM cred_class WHERE class = 'B' ORDER BY 1;

\echo '== 17. Schema drift: tables/columns in the database that schema.prisma no longer defines (deploy blocker) =='
\echo '-- row counts; any non-zero row means a db push would need --accept-data-loss to drop real data'
SELECT t AS table_name,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', t), false, true, '')))[1]::text::bigint AS row_count
FROM unnest(ARRAY['KebuInvestment','KebuInvestmentOffering','KebuInvestmentPayout','KoriRedemption','KoriRedemptionOffer',
                  'MerchantPromo','MerchantPromoUse','NuLekkShare','NuLekkSplit']) AS t
WHERE to_regclass(format('public.%I', t)) IS NOT NULL
ORDER BY 1;
\echo '-- legacy columns with non-null values'
SELECT c.table_name, c.column_name,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I WHERE %I IS NOT NULL', c.table_name, c.column_name), false, true, '')))[1]::text::bigint AS non_null
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND (c.table_name, c.column_name) IN (
  ('DeliveryTask','proofLat'),('DeliveryTask','proofLng'),('DeliveryTask','proofPhotoUrl'),('DeliveryTask','proofRecipientHandle'),
  ('DeliveryTask','proofRecipientUserId'),('DeliveryTask','proofScannedPayload'),('DeliveryTask','proofSignatureUrl'),('DeliveryTask','proofSubmittedAt'),
  ('Order','discountKori'),('Order','promoCode'),('Order','promoId'),('Order','subtotalKori'),('OrderItem','isPromoFree'),('OrderItem','promoId'),
  ('SolidarityCampaign','kind'),('TontineContribution','cycleKey'),('User','afriClass'))
ORDER BY 1, 2;

\echo '== 18. Mboolo message-request migration: legacy members who would become requests (counts only) =='
SELECT COUNT(*) AS members_to_requested
FROM "MboloMember" m JOIN "MboloThread" t ON t.id = m."threadId"
WHERE m."userId" <> t."creatorId"
  AND t.type IN ('direct','group') AND (to_jsonb(t)->>'commerceType') IS NULL
  AND NOT EXISTS (SELECT 1 FROM "MboloMessage" x WHERE x."threadId" = m."threadId" AND x."senderId" = m."userId")
  AND NOT EXISTS (SELECT 1 FROM "UserFriend" f WHERE f."userId" = m."userId" AND f."friendId" = t."creatorId");

\echo '== 19. KYC sandbox auto-approvals in production (P0 run 4: no KYC key → Tier 2/3 for anyone) =='
SELECT provider, status, COUNT(*) AS jobs, MIN("createdAt") AS first_seen, MAX("createdAt") AS last_seen
FROM "CniVerificationJob"
WHERE "externalJobId" LIKE 'smile-sandbox-%' OR "externalJobId" LIKE 'sumsub-sandbox-%'
GROUP BY 1, 2 ORDER BY 1, 2;
\echo '-- user ids raised to Tier 2+ by a sandbox job (review queue; ids only)'
SELECT DISTINCT j."userId", u."verificationTier"
FROM "CniVerificationJob" j JOIN "User" u ON u.id = j."userId"
WHERE (j."externalJobId" LIKE 'smile-sandbox-%' OR j."externalJobId" LIKE 'sumsub-sandbox-%') AND u."verificationTier" >= 2
ORDER BY 1;
\echo '-- Tier 3 without any provider-backed CNI job (address auto-approved)'
SELECT COUNT(*) AS tier3_without_real_job
FROM "User" u
WHERE u."verificationTier" >= 3
  AND NOT EXISTS (SELECT 1 FROM "CniVerificationJob" j WHERE j."userId" = u.id AND j.status = 'approved'
                  AND j."externalJobId" NOT LIKE '%-sandbox-%');

\echo '== 14. Negative or impossible balances (should be zero rows) =='
SELECT 'wallet' AS kind, id FROM "Wallet" WHERE "koriBalance" < 0 OR balance < 0
UNION ALL SELECT 'business', id FROM "BusinessWallet" WHERE balance < 0
UNION ALL SELECT 'fund', id FROM "PaymentFund" WHERE "balanceKori" < 0
UNION ALL SELECT 'voucher', id FROM "MerchantVoucher" WHERE "balanceKori" < 0
UNION ALL SELECT 'agent', id FROM "AgentProfile" WHERE "floatBalance" < 0
UNION ALL SELECT 'tontine', id FROM "TontineGroup" WHERE "potBalance" < 0;

ROLLBACK;
