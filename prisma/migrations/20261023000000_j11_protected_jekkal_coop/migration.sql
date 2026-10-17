-- J11.2: protected funds (dormant), Jekkal direct-mode columns (existing campaigns become 'direct', unchanged otherwise), coop capital records. ADDITIVE ONLY.
-- AlterTable
ALTER TABLE "SolidarityCampaign" ADD COLUMN     "beneficiaryConsentAt" TIMESTAMP(3),
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'direct';

-- CreateTable
CREATE TABLE "ProtectedFund" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "recipientBusinessId" TEXT,
    "recipientConsentAt" TIMESTAMP(3),
    "goalKori" INTEGER NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "approverIdsJson" TEXT NOT NULL DEFAULT '[]',
    "approverAcceptedJson" TEXT NOT NULL DEFAULT '[]',
    "approvalsRequired" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "raisedKori" INTEGER NOT NULL DEFAULT 0,
    "releasedKori" INTEGER NOT NULL DEFAULT 0,
    "refundedKori" INTEGER NOT NULL DEFAULT 0,
    "frozenAt" TIMESTAMP(3),
    "frozenReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProtectedFund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtectedMilestone" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "evidenceNote" TEXT,
    "approvedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProtectedMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtectedApproval" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtectedApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtectedContribution" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "contributorId" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "refundedKori" INTEGER NOT NULL DEFAULT 0,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtectedContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoopCapitalRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "memberUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amountXof" INTEGER NOT NULL,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "evidenceRef" TEXT,
    "recordedBy" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "memberConfirmedAt" TIMESTAMP(3),
    "memberDisputedAt" TIMESTAMP(3),
    "memberNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoopCapitalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProtectedFund_status_deadline_idx" ON "ProtectedFund"("status", "deadline");

-- CreateIndex
CREATE INDEX "ProtectedFund_organizerId_idx" ON "ProtectedFund"("organizerId");

-- CreateIndex
CREATE INDEX "ProtectedFund_recipientUserId_idx" ON "ProtectedFund"("recipientUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ProtectedMilestone_releaseRef_key" ON "ProtectedMilestone"("releaseRef");

-- CreateIndex
CREATE UNIQUE INDEX "ProtectedMilestone_fundId_seq_key" ON "ProtectedMilestone"("fundId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ProtectedApproval_milestoneId_approverId_key" ON "ProtectedApproval"("milestoneId", "approverId");

-- CreateIndex
CREATE UNIQUE INDEX "ProtectedContribution_reference_key" ON "ProtectedContribution"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "ProtectedContribution_idempotencyKey_key" ON "ProtectedContribution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ProtectedContribution_fundId_idx" ON "ProtectedContribution"("fundId");

-- CreateIndex
CREATE INDEX "ProtectedContribution_contributorId_idx" ON "ProtectedContribution"("contributorId");

-- CreateIndex
CREATE UNIQUE INDEX "CoopCapitalRecord_reference_key" ON "CoopCapitalRecord"("reference");

-- CreateIndex
CREATE INDEX "CoopCapitalRecord_businessId_memberUserId_idx" ON "CoopCapitalRecord"("businessId", "memberUserId");

-- CreateIndex
CREATE INDEX "CoopCapitalRecord_memberUserId_idx" ON "CoopCapitalRecord"("memberUserId");

-- AddForeignKey
ALTER TABLE "ProtectedMilestone" ADD CONSTRAINT "ProtectedMilestone_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "ProtectedFund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtectedApproval" ADD CONSTRAINT "ProtectedApproval_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "ProtectedMilestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtectedContribution" ADD CONSTRAINT "ProtectedContribution_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "ProtectedFund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Approvals are an immutable record.
DROP TRIGGER IF EXISTS "ProtectedApproval_append_only" ON "ProtectedApproval";
CREATE TRIGGER "ProtectedApproval_append_only" BEFORE UPDATE OR DELETE ON "ProtectedApproval"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();

-- Coop capital records: never deleted, never edited — only the member's own confirm / dispute stamp may be set.
CREATE OR REPLACE FUNCTION joko_coop_record_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'coop capital records are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."businessId" IS DISTINCT FROM OLD."businessId" OR NEW."memberUserId" IS DISTINCT FROM OLD."memberUserId"
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.direction IS DISTINCT FROM OLD.direction OR NEW."amountXof" IS DISTINCT FROM OLD."amountXof"
     OR NEW."occurredOn" IS DISTINCT FROM OLD."occurredOn" OR NEW.note IS DISTINCT FROM OLD.note OR NEW."evidenceRef" IS DISTINCT FROM OLD."evidenceRef"
     OR NEW."recordedBy" IS DISTINCT FROM OLD."recordedBy" OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."memberConfirmedAt" IS NOT NULL AND NEW."memberConfirmedAt" IS DISTINCT FROM OLD."memberConfirmedAt")
     OR (OLD."memberDisputedAt" IS NOT NULL AND NEW."memberDisputedAt" IS DISTINCT FROM OLD."memberDisputedAt") THEN
    RAISE EXCEPTION 'coop capital records are append-only (a correction is a new record)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "CoopCapitalRecord_guard" ON "CoopCapitalRecord";
CREATE TRIGGER "CoopCapitalRecord_guard" BEFORE UPDATE OR DELETE ON "CoopCapitalRecord"
  FOR EACH ROW EXECUTE FUNCTION joko_coop_record_guard();

-- A protected fund never releases or refunds more than it raised.
ALTER TABLE "ProtectedFund" ADD CONSTRAINT "ProtectedFund_money_bounds" CHECK ("raisedKori" >= 0 AND "releasedKori" >= 0 AND "refundedKori" >= 0 AND "releasedKori" + "refundedKori" <= "raisedKori" AND "raisedKori" <= "goalKori");
ALTER TABLE "ProtectedContribution" ADD CONSTRAINT "ProtectedContribution_refund_bounds" CHECK ("amountKori" > 0 AND "refundedKori" >= 0 AND "refundedKori" <= "amountKori");
