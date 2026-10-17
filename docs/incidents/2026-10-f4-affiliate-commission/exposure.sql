-- F4: affiliate commission exposure. READ-ONLY. Outputs opaque ids, counts and sums only (no PII).
-- Schema: the legacy (immediate) columns common to 19ac203 and later. The latest successful production
-- deployment 7d262de has NO affiliate tables: query 0 returns NULL there, and then nothing below applies.
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f exposure.sql   (any environment running 19ac203 or later)
BEGIN TRANSACTION READ ONLY;

-- 0. Is the affiliate feature deployed in this database at all?
SELECT to_regclass('"AffiliateCommission"') AS affiliate_table;

-- 1. Totals: commissions paid at purchase (legacy immediate mode).
SELECT COUNT(*) AS commissions, COALESCE(SUM(amount), 0) AS kori, COUNT(DISTINCT "affiliateId") AS affiliates,
       MIN("createdAt") AS first_at, MAX("createdAt") AS last_at
  FROM "AffiliateCommission" WHERE status = 'paid';

-- 2. Commissions kept on orders later cancelled or refunded (the core F4 exposure).
SELECT o.status AS order_status, o."paymentStatus" AS payment_status, COUNT(*) AS commissions, SUM(c.amount) AS kori
  FROM "AffiliateCommission" c JOIN "Order" o ON o.id = c."orderId"
 WHERE c.status = 'paid' AND (o.status IN ('cancelled', 'refunded') OR o."paymentStatus" IN ('refunded', 'partially_refunded'))
 GROUP BY 1, 2 ORDER BY 4 DESC;

-- 3. Partial refunds of the order payment (merchant_refund entries against the order reference).
SELECT COUNT(DISTINCT c.id) AS commissions, SUM(c.amount) AS commission_kori, SUM(r.refunded) AS refunded_kori
  FROM "AffiliateCommission" c JOIN "Order" o ON o.id = c."orderId"
  JOIN LATERAL (
    SELECT SUM(p.amount) AS refunded FROM "JournalEntry" j JOIN "Posting" p ON p."entryId" = j.id
     WHERE j.kind = 'merchant_refund' AND p.side = 'debit'
       AND j.metadata->>'originalReference' IN (o."orderReference", o."orderReference" || '-J')
  ) r ON r.refunded > 0
 WHERE c.status = 'paid';
-- (If "JournalEntry" does not exist in this schema, skip query 3: refunds then show only in query 2.)

-- 4. Self-dealing: the affiliate is the buyer, owns the selling business, or is a member of it.
SELECT 'affiliate_is_buyer' AS pattern, COUNT(*) AS n, COALESCE(SUM(c.amount), 0) AS kori
  FROM "AffiliateCommission" c JOIN "AffiliateProfile" a ON a.id = c."affiliateId" WHERE a."userId" = c."buyerId"
UNION ALL
SELECT 'affiliate_owns_business', COUNT(*), COALESCE(SUM(c.amount), 0)
  FROM "AffiliateCommission" c JOIN "AffiliateProfile" a ON a.id = c."affiliateId" JOIN "Business" b ON b.id = c."businessId" WHERE b."ownerId" = a."userId"
UNION ALL
SELECT 'affiliate_member_of_business', COUNT(*), COALESCE(SUM(c.amount), 0)
  FROM "AffiliateCommission" c JOIN "AffiliateProfile" a ON a.id = c."affiliateId"
 WHERE EXISTS (SELECT 1 FROM "BusinessMember" m WHERE m."businessId" = c."businessId" AND m."userId" = a."userId");

-- 5. Velocity: affiliate × buyer pairs with more than 3 commissions in any 24 h (opaque ids).
SELECT c."affiliateId", md5(c."buyerId") AS buyer_hash, date_trunc('day', c."createdAt") AS day, COUNT(*) AS n, SUM(c.amount) AS kori
  FROM "AffiliateCommission" c GROUP BY 1, 2, 3 HAVING COUNT(*) > 3 ORDER BY n DESC LIMIT 100;

-- 6. Duplicates: more than one commission for the same order.
SELECT c."orderId", COUNT(*) AS n, SUM(c.amount) AS kori FROM "AffiliateCommission" c
 WHERE c."orderId" IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 100;

-- 7. Per affiliate (opaque id): total kept on cancelled/refunded orders, for case review.
SELECT c."affiliateId", COUNT(*) AS n, SUM(c.amount) AS kori
  FROM "AffiliateCommission" c JOIN "Order" o ON o.id = c."orderId"
 WHERE c.status = 'paid' AND (o.status IN ('cancelled', 'refunded') OR o."paymentStatus" IN ('refunded', 'partially_refunded'))
 GROUP BY 1 ORDER BY kori DESC LIMIT 100;

ROLLBACK;
