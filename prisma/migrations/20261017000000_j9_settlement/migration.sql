-- J9 settlement policy (additive): contest deadline on earnings; appeal + ruling version on disputes.
ALTER TABLE "WorkEarning" ADD COLUMN "contestableUntil" TIMESTAMP(3);
ALTER TABLE "WorkDispute" ADD COLUMN "rulingVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "WorkDispute" ADD COLUMN "executableAfter" TIMESTAMP(3);
ALTER TABLE "WorkDispute" ADD COLUMN "appealedBy" TEXT;
ALTER TABLE "WorkDispute" ADD COLUMN "appealedByRole" TEXT;
ALTER TABLE "WorkDispute" ADD COLUMN "appealedAt" TIMESTAMP(3);
ALTER TABLE "WorkDispute" ADD COLUMN "appealNote" TEXT;
ALTER TABLE "WorkDispute" ADD COLUMN "appealResolvedBy" TEXT;
-- Earnings accrued before this policy keep their existing payout time as their contest deadline.
UPDATE "WorkEarning" SET "contestableUntil" = "releasableAt" WHERE "contestableUntil" IS NULL;
