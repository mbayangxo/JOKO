-- J14-F1 (S4): partner debit instructions (approval-gated business-wallet debits). Additive only.

-- CreateTable
CREATE TABLE "PartnerDebitInstruction" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "externalLinkId" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "linesJson" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "totalKori" INTEGER NOT NULL,
    "detailsHash" TEXT NOT NULL,
    "memo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "failureCode" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerDebitInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerDebitInstruction_partnerId_externalRef_key" ON "PartnerDebitInstruction"("partnerId", "externalRef");

-- CreateIndex
CREATE INDEX "PartnerDebitInstruction_businessId_status_idx" ON "PartnerDebitInstruction"("businessId", "status");

-- Guard (mirrored in prisma/sql/financial-invariants.sql): request details are immutable, never deleted, and
-- a decided instruction never changes state again.
CREATE OR REPLACE FUNCTION joko_partner_debit_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'partner debit instructions are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."partnerId" IS DISTINCT FROM OLD."partnerId" OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
     OR NEW."externalLinkId" IS DISTINCT FROM OLD."externalLinkId" OR NEW."externalRef" IS DISTINCT FROM OLD."externalRef"
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW."linesJson" IS DISTINCT FROM OLD."linesJson" OR NEW."lineCount" IS DISTINCT FROM OLD."lineCount"
     OR NEW."totalKori" IS DISTINCT FROM OLD."totalKori" OR NEW."detailsHash" IS DISTINCT FROM OLD."detailsHash"
     OR NEW.memo IS DISTINCT FROM OLD.memo OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'partner debit instruction details are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'requested' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a decided partner debit instruction never changes state' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "PartnerDebitInstruction_guard" ON "PartnerDebitInstruction";
CREATE TRIGGER "PartnerDebitInstruction_guard" BEFORE UPDATE OR DELETE ON "PartnerDebitInstruction"
  FOR EACH ROW EXECUTE FUNCTION joko_partner_debit_guard();
ALTER TABLE "PartnerDebitInstruction" ADD CONSTRAINT "PartnerDebitInstruction_shape" CHECK ("totalKori" > 0 AND "lineCount" > 0 AND kind IN ('payout','payroll_batch')
  AND status IN ('requested','executed','rejected','cancelled','expired','invalidated','failed'));
