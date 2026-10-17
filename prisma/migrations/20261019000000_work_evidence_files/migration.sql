-- A6: private work evidence attachments + access audit (additive).
CREATE TABLE "WorkEvidenceFile" (
    "id" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "disputeId" TEXT,
    "uploaderId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA,
    "stripped" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkEvidenceFile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkEvidenceFile_evidenceId_key" ON "WorkEvidenceFile"("evidenceId");
CREATE INDEX "WorkEvidenceFile_assignmentId_createdAt_idx" ON "WorkEvidenceFile"("assignmentId", "createdAt");
CREATE INDEX "WorkEvidenceFile_uploaderId_createdAt_idx" ON "WorkEvidenceFile"("uploaderId", "createdAt");
CREATE INDEX "WorkEvidenceFile_expiresAt_idx" ON "WorkEvidenceFile"("expiresAt");

CREATE TABLE "WorkEvidenceAccess" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkEvidenceAccess_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkEvidenceAccess_fileId_createdAt_idx" ON "WorkEvidenceAccess"("fileId", "createdAt");
