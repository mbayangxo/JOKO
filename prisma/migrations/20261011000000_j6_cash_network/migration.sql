-- J6: agents & cash network. Additive only. Existing AgentProfile rows keep
-- their status (legacy 'pending' ≡ applied); only the column default changes.
-- AlterTable
ALTER TABLE "AgentProfile" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "activatedBy" TEXT,
ADD COLUMN     "agentType" TEXT NOT NULL DEFAULT 'individual',
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "identityVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "identityVerifiedBy" TEXT,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "servicePointId" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspensionReason" TEXT,
ADD COLUMN     "terminatedAt" TIMESTAMP(3),
ADD COLUMN     "terminationReason" TEXT,
ALTER COLUMN "status" SET DEFAULT 'applied';

-- CreateTable
CREATE TABLE "AgentStatusEvent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentOrganization" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "statusReason" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentOrganization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentServicePoint" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicAddress" TEXT NOT NULL,
    "area" TEXT,
    "approxLat" DOUBLE PRECISION,
    "approxLng" DOUBLE PRECISION,
    "hoursJson" TEXT,
    "cashIn" BOOLEAN NOT NULL DEFAULT true,
    "cashOut" BOOLEAN NOT NULL DEFAULT true,
    "merchantAssist" BOOLEAN NOT NULL DEFAULT false,
    "merchantAssistPermitted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentServicePoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCashTransaction" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "agentId" TEXT,
    "servicePointId" TEXT,
    "amountXof" INTEGER NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "challengeExpiresAt" TIMESTAMP(3) NOT NULL,
    "bindingHash" TEXT,
    "boundAt" TIMESTAMP(3),
    "customerConfirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "terminalAt" TIMESTAMP(3),
    "reviewDeadline" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "customerDeviceId" TEXT,
    "failureReason" TEXT,
    "riskReasons" TEXT,
    "commissionKori" INTEGER NOT NULL DEFAULT 0,
    "scanFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCashTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCashEvent" (
    "id" TEXT NOT NULL,
    "txId" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCashEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCommissionRule" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "bps" INTEGER NOT NULL DEFAULT 0,
    "flatKori" INTEGER NOT NULL DEFAULT 0,
    "minAmountXof" INTEGER NOT NULL DEFAULT 0,
    "capKori" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCommission" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "txId" TEXT NOT NULL,
    "ruleId" TEXT,
    "amountKori" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "ineligibleReason" TEXT,
    "ledgerReference" TEXT,
    "settledReference" TEXT,
    "clawbackReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "AgentCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCashReport" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "servicePointId" TEXT,
    "amountXof" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCashReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantOnboardingAssist" (
    "id" TEXT NOT NULL,
    "introducerType" TEXT NOT NULL,
    "introducerId" TEXT NOT NULL,
    "repUserId" TEXT NOT NULL,
    "territoryId" TEXT,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'started',
    "merchantUserId" TEXT,
    "businessId" TEXT,
    "proposedName" TEXT NOT NULL,
    "proposedCategory" TEXT,
    "consentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantOnboardingAssist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentStatusEvent_agentId_createdAt_idx" ON "AgentStatusEvent"("agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentOrganization_businessId_key" ON "AgentOrganization"("businessId");

-- CreateIndex
CREATE INDEX "AgentOrganization_ownerUserId_idx" ON "AgentOrganization"("ownerUserId");

-- CreateIndex
CREATE INDEX "AgentServicePoint_organizationId_idx" ON "AgentServicePoint"("organizationId");

-- CreateIndex
CREATE INDEX "AgentServicePoint_status_idx" ON "AgentServicePoint"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCashTransaction_reference_key" ON "AgentCashTransaction"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCashTransaction_challengeHash_key" ON "AgentCashTransaction"("challengeHash");

-- CreateIndex
CREATE INDEX "AgentCashTransaction_agentId_createdAt_idx" ON "AgentCashTransaction"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCashTransaction_customerId_createdAt_idx" ON "AgentCashTransaction"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCashTransaction_state_challengeExpiresAt_idx" ON "AgentCashTransaction"("state", "challengeExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCashTransaction_customerId_idempotencyKey_key" ON "AgentCashTransaction"("customerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentCashEvent_txId_createdAt_idx" ON "AgentCashEvent"("txId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCommissionRule_purpose_status_idx" ON "AgentCommissionRule"("purpose", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCommission_txId_key" ON "AgentCommission"("txId");

-- CreateIndex
CREATE INDEX "AgentCommission_agentId_status_idx" ON "AgentCommission"("agentId", "status");

-- CreateIndex
CREATE INDEX "AgentCashReport_agentId_createdAt_idx" ON "AgentCashReport"("agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantOnboardingAssist_codeHash_key" ON "MerchantOnboardingAssist"("codeHash");

-- CreateIndex
CREATE INDEX "MerchantOnboardingAssist_introducerType_introducerId_idx" ON "MerchantOnboardingAssist"("introducerType", "introducerId");

-- CreateIndex
CREATE INDEX "MerchantOnboardingAssist_repUserId_idx" ON "MerchantOnboardingAssist"("repUserId");


-- J6: lifecycle history, cash-transaction history and self-reported cash are append-only facts.
DROP TRIGGER IF EXISTS "AgentStatusEvent_append_only" ON "AgentStatusEvent";
CREATE TRIGGER "AgentStatusEvent_append_only" BEFORE UPDATE OR DELETE ON "AgentStatusEvent"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "AgentCashEvent_append_only" ON "AgentCashEvent";
CREATE TRIGGER "AgentCashEvent_append_only" BEFORE UPDATE OR DELETE ON "AgentCashEvent"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "AgentCashReport_append_only" ON "AgentCashReport";
CREATE TRIGGER "AgentCashReport_append_only" BEFORE UPDATE OR DELETE ON "AgentCashReport"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();

-- J6: a cash transaction's amount and parties never change after creation; the
-- challenge only before binding; the agent / service point / binding are write-once.
CREATE OR REPLACE FUNCTION joko_agent_cash_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."amountXof" <> OLD."amountXof" OR NEW."amountKori" <> OLD."amountKori"
     OR NEW."customerId" <> OLD."customerId" OR NEW."kind" <> OLD."kind"
     OR NEW."reference" <> OLD."reference" THEN
    RAISE EXCEPTION 'AgentCashTransaction % : amount / parties / challenge are immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  -- A new handoff challenge may be issued only while nobody has bound the transaction.
  IF NEW."challengeHash" <> OLD."challengeHash" AND (OLD."agentId" IS NOT NULL OR OLD."state" NOT IN ('created', 'funds_held')) THEN
    RAISE EXCEPTION 'AgentCashTransaction % : challenge is fixed once bound', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."agentId" IS NOT NULL AND NEW."agentId" IS DISTINCT FROM OLD."agentId")
     OR (OLD."servicePointId" IS NOT NULL AND NEW."servicePointId" IS DISTINCT FROM OLD."servicePointId")
     OR (OLD."bindingHash" IS NOT NULL AND NEW."bindingHash" IS DISTINCT FROM OLD."bindingHash") THEN
    RAISE EXCEPTION 'AgentCashTransaction % : binding is write-once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AgentCashTransaction rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "AgentCashTransaction_immutable" ON "AgentCashTransaction";
CREATE TRIGGER "AgentCashTransaction_immutable" BEFORE UPDATE ON "AgentCashTransaction"
  FOR EACH ROW EXECUTE FUNCTION joko_agent_cash_immutable();
CREATE OR REPLACE FUNCTION joko_agent_cash_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AgentCashTransaction rows are never deleted' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "AgentCashTransaction_no_delete" ON "AgentCashTransaction";
CREATE TRIGGER "AgentCashTransaction_no_delete" BEFORE DELETE ON "AgentCashTransaction"
  FOR EACH ROW EXECUTE FUNCTION joko_agent_cash_no_delete();
