-- J10: group roles / moderation, report snapshots and outcomes, moderation actions + appeals (additive).
ALTER TABLE "MboloThread" ADD COLUMN "postingPolicy" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "MboloMember" ADD COLUMN "mutedUntil" TIMESTAMP(3);
ALTER TABLE "MboloMember" ADD COLUMN "removedById" TEXT;
ALTER TABLE "MboloMember" ADD COLUMN "removedAt" TIMESTAMP(3);
ALTER TABLE "ContentReport" ADD COLUMN "targetThreadId" TEXT;
ALTER TABLE "ContentReport" ADD COLUMN "targetMessageId" TEXT;
ALTER TABLE "ContentReport" ADD COLUMN "evidenceSnapshot" TEXT;
ALTER TABLE "ContentReport" ADD COLUMN "resolution" TEXT;
ALTER TABLE "ContentReport" ADD COLUMN "resolvedBy" TEXT;
ALTER TABLE "ContentReport" ADD COLUMN "resolvedAt" TIMESTAMP(3);

CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "until" TIMESTAMP(3),
    "reportId" TEXT,
    "byAdminId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "appealNote" TEXT,
    "appealedAt" TIMESTAMP(3),
    "appealOutcome" TEXT,
    "appealResolvedBy" TEXT,
    "appealResolvedAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ModerationAction_userId_createdAt_idx" ON "ModerationAction"("userId", "createdAt");
CREATE INDEX "ModerationAction_appealedAt_idx" ON "ModerationAction"("appealedAt");
