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
-- ============================================================================
BEGIN TRANSACTION READ ONLY;

\echo '== 0. Totals: wallets vs reserve (all custody accounts) =='
SELECT
  (SELECT COALESCE(SUM("koriBalance"),0) FROM "Wallet")                AS wallets_kori,
  (SELECT COALESCE(SUM("balance"),0) FROM "BusinessWallet")             AS business_kori,
  (SELECT COALESCE(SUM("balanceKori"),0) FROM "PaymentFund")            AS funds_kori,
  (SELECT COALESCE(SUM("balanceKori"),0) FROM "MerchantVoucher")        AS vouchers_kori,
  (SELECT COALESCE(SUM("potBalance"),0) FROM "TontineGroup")            AS tontine_pots_kori,
  (SELECT COALESCE(SUM(COALESCE("amountKoriHeld","amountNational")),0) FROM "DeliveryEscrow"
     WHERE status IN ('reserved','disputed_held'))                     AS escrow_kori,
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
SELECT status, ("amountKoriHeld" IS NULL) AS legacy, COUNT(*) AS n,
       SUM("amountNational") AS fee_xof, SUM("koriPayout") AS rider_kori, SUM("amountKoriHeld") AS held_kori
FROM "DeliveryEscrow" GROUP BY 1,2 ORDER BY 1,2;
\echo '-- legacy escrows: buyer debited fee as ₭ (10x); rider paid minted koriPayout'
SELECT de.reference, de."buyerId", de."riderId", de."amountNational" AS fee_xof,
       -le.amount AS buyer_debited_kori, de."koriPayout" AS rider_minted_kori, de.status, de."createdAt"
FROM "DeliveryEscrow" de LEFT JOIN "LedgerEntry" le ON le.reference = de.reference
WHERE de."amountKoriHeld" IS NULL ORDER BY de."createdAt";

\echo '== 7. Partner payouts that burned settlement funds and failed without refund (P0-13) =='
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
SELECT COUNT(*) AS culture_items FROM "CultureFeedItem";

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

\echo '== 14. Negative or impossible balances (should be zero rows) =='
SELECT 'wallet' AS kind, id FROM "Wallet" WHERE "koriBalance" < 0 OR balance < 0
UNION ALL SELECT 'business', id FROM "BusinessWallet" WHERE balance < 0
UNION ALL SELECT 'fund', id FROM "PaymentFund" WHERE "balanceKori" < 0
UNION ALL SELECT 'voucher', id FROM "MerchantVoucher" WHERE "balanceKori" < 0
UNION ALL SELECT 'agent', id FROM "AgentProfile" WHERE "floatBalance" < 0
UNION ALL SELECT 'tontine', id FROM "TontineGroup" WHERE "potBalance" < 0;

ROLLBACK;
