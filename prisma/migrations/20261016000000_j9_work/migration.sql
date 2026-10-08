-- J9 Work & Opportunity (additive only: 15 new tables, no change to existing tables).
-- CreateTable
CREATE TABLE "WorkProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "headline" TEXT,
    "skillsJson" TEXT NOT NULL DEFAULT '[]',
    "areasJson" TEXT NOT NULL DEFAULT '[]',
    "availability" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'applications_only',
    "portfolioJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkQualification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "issuer" TEXT,
    "evidenceRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'self_declared',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkQualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOpportunity" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "arrangement" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "area" TEXT,
    "skillsJson" TEXT NOT NULL DEFAULT '[]',
    "headcount" INTEGER NOT NULL DEFAULT 1,
    "payKind" TEXT NOT NULL,
    "rateKori" INTEGER NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 1,
    "funding" TEXT NOT NULL,
    "hazardous" BOOLEAN NOT NULL DEFAULT false,
    "minAge" INTEGER NOT NULL DEFAULT 18,
    "nightWork" BOOLEAN NOT NULL DEFAULT false,
    "hoursPerWeek" INTEGER,
    "durationWeeks" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reviewFlags" TEXT,
    "reviewedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "closesAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkApplication" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "workerUserId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOffer" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "workerUserId" TEXT NOT NULL,
    "arrangement" TEXT NOT NULL,
    "termsJson" TEXT NOT NULL,
    "termsHash" TEXT NOT NULL,
    "totalKori" INTEGER NOT NULL,
    "funding" TEXT NOT NULL,
    "fundingStatus" TEXT NOT NULL DEFAULT 'none',
    "status" TEXT NOT NULL DEFAULT 'sent',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkAssignment" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "workerUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "arrangement" TEXT NOT NULL,
    "totalKori" INTEGER NOT NULL,
    "funding" TEXT NOT NULL,
    "refundedKori" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "checkedInAt" TIMESTAMP(3),
    "checkedOutAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkMilestone" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'work',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "submittedAt" TIMESTAMP(3),
    "acceptDeadline" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedBy" TEXT,

    CONSTRAINT "WorkMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkEvidence" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "disputeId" TEXT,
    "byUserId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkChallenge" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkEarning" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "workerUserId" TEXT,
    "payeeBusinessId" TEXT,
    "payerBusinessId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "milestoneId" TEXT,
    "ruleId" TEXT,
    "classification" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'accrued',
    "releasableAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "payoutReference" TEXT,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkEarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkDispute" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "openedBy" TEXT NOT NULL,
    "openedByRole" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "splitWorkerKori" INTEGER,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "settledBy" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkRule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL DEFAULT 0,
    "minOrderKori" INTEGER NOT NULL DEFAULT 0,
    "pickupPointId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "proposedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOutcome" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "outcomeKey" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "beneficiaryUserId" TEXT,
    "beneficiaryBizId" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "earningId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkFeedback" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "fromRole" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "subjectBusinessId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'published',
    "contestNote" TEXT,
    "ruledBy" TEXT,
    "ruledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkBlock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkProfile_userId_key" ON "WorkProfile"("userId");

-- CreateIndex
CREATE INDEX "WorkQualification_userId_idx" ON "WorkQualification"("userId");

-- CreateIndex
CREATE INDEX "WorkQualification_status_createdAt_idx" ON "WorkQualification"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOpportunity_reference_key" ON "WorkOpportunity"("reference");

-- CreateIndex
CREATE INDEX "WorkOpportunity_status_type_createdAt_idx" ON "WorkOpportunity"("status", "type", "createdAt");

-- CreateIndex
CREATE INDEX "WorkOpportunity_businessId_status_idx" ON "WorkOpportunity"("businessId", "status");

-- CreateIndex
CREATE INDEX "WorkApplication_workerUserId_status_idx" ON "WorkApplication"("workerUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkApplication_opportunityId_workerUserId_key" ON "WorkApplication"("opportunityId", "workerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOffer_reference_key" ON "WorkOffer"("reference");

-- CreateIndex
CREATE INDEX "WorkOffer_workerUserId_status_idx" ON "WorkOffer"("workerUserId", "status");

-- CreateIndex
CREATE INDEX "WorkOffer_businessId_status_idx" ON "WorkOffer"("businessId", "status");

-- CreateIndex
CREATE INDEX "WorkOffer_applicationId_idx" ON "WorkOffer"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkAssignment_reference_key" ON "WorkAssignment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "WorkAssignment_offerId_key" ON "WorkAssignment"("offerId");

-- CreateIndex
CREATE INDEX "WorkAssignment_workerUserId_status_idx" ON "WorkAssignment"("workerUserId", "status");

-- CreateIndex
CREATE INDEX "WorkAssignment_businessId_status_idx" ON "WorkAssignment"("businessId", "status");

-- CreateIndex
CREATE INDEX "WorkMilestone_status_acceptDeadline_idx" ON "WorkMilestone"("status", "acceptDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "WorkMilestone_assignmentId_seq_key" ON "WorkMilestone"("assignmentId", "seq");

-- CreateIndex
CREATE INDEX "WorkEvidence_assignmentId_createdAt_idx" ON "WorkEvidence"("assignmentId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkEvidence_disputeId_idx" ON "WorkEvidence"("disputeId");

-- CreateIndex
CREATE INDEX "WorkChallenge_assignmentId_purpose_idx" ON "WorkChallenge"("assignmentId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "WorkEarning_sourceKey_key" ON "WorkEarning"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkEarning_payoutReference_key" ON "WorkEarning"("payoutReference");

-- CreateIndex
CREATE INDEX "WorkEarning_workerUserId_status_idx" ON "WorkEarning"("workerUserId", "status");

-- CreateIndex
CREATE INDEX "WorkEarning_payeeBusinessId_status_idx" ON "WorkEarning"("payeeBusinessId", "status");

-- CreateIndex
CREATE INDEX "WorkEarning_assignmentId_idx" ON "WorkEarning"("assignmentId");

-- CreateIndex
CREATE INDEX "WorkDispute_assignmentId_status_idx" ON "WorkDispute"("assignmentId", "status");

-- CreateIndex
CREATE INDEX "WorkDispute_status_createdAt_idx" ON "WorkDispute"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WorkRule_businessId_kind_status_idx" ON "WorkRule"("businessId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOutcome_outcomeKey_key" ON "WorkOutcome"("outcomeKey");

-- CreateIndex
CREATE INDEX "WorkOutcome_ruleId_createdAt_idx" ON "WorkOutcome"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkFeedback_subjectUserId_status_idx" ON "WorkFeedback"("subjectUserId", "status");

-- CreateIndex
CREATE INDEX "WorkFeedback_subjectBusinessId_status_idx" ON "WorkFeedback"("subjectBusinessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkFeedback_assignmentId_fromRole_key" ON "WorkFeedback"("assignmentId", "fromRole");

-- CreateIndex
CREATE UNIQUE INDEX "WorkBlock_userId_businessId_key" ON "WorkBlock"("userId", "businessId");

