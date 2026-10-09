-- A4 refund-aware affiliate settlement (additive; existing rows keep settlementMode 'immediate' and status unchanged).
ALTER TABLE "AffiliateCommission" ADD COLUMN "settlementMode" TEXT NOT NULL DEFAULT 'immediate';
ALTER TABLE "AffiliateCommission" ADD COLUMN "completedSeenAt" TIMESTAMP(3);
ALTER TABLE "AffiliateCommission" ADD COLUMN "eligibleAt" TIMESTAMP(3);
ALTER TABLE "AffiliateCommission" ADD COLUMN "earnedKori" INTEGER;
ALTER TABLE "AffiliateCommission" ADD COLUMN "reversedKori" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AffiliateCommission" ADD COLUMN "settledAt" TIMESTAMP(3);
ALTER TABLE "AffiliateCommission" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "AffiliateCommission" ADD COLUMN "payoutReference" TEXT;
ALTER TABLE "AffiliateCommission" ADD COLUMN "reviewReason" TEXT;
CREATE UNIQUE INDEX "AffiliateCommission_payoutReference_key" ON "AffiliateCommission"("payoutReference");
