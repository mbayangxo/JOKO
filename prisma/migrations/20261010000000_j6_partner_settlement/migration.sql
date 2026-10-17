-- J6.0: per-merchant partner settlement (D23/D24). Additive only; existing
-- PartnerPayment rows keep settlementTarget='legacy_platform' (history is not rewritten).
-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "statusChangedAt" TIMESTAMP(3),
ADD COLUMN     "statusChangedBy" TEXT,
ADD COLUMN     "statusReason" TEXT;

-- AlterTable
ALTER TABLE "PartnerPayment" ADD COLUMN     "externalBusinessId" TEXT,
ADD COLUMN     "externalLinkId" TEXT,
ADD COLUMN     "settlementBusinessId" TEXT,
ADD COLUMN     "settlementReference" TEXT,
ADD COLUMN     "settlementTarget" TEXT NOT NULL DEFAULT 'legacy_platform';


CREATE INDEX "PartnerPayment_settlementBusinessId_idx" ON "PartnerPayment"("settlementBusinessId");
