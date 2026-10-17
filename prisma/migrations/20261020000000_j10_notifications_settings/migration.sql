-- J10: notification categories + dedupe, community settings (additive).
ALTER TABLE "Notification" ADD COLUMN "category" TEXT;
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");
CREATE INDEX "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt");

CREATE TABLE "CommunitySettings" (
    "userId" TEXT NOT NULL,
    "discoverableByPhone" TEXT NOT NULL DEFAULT 'everyone',
    "neighbourhoodVisible" BOOLEAN NOT NULL DEFAULT false,
    "mutedCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunitySettings_pkey" PRIMARY KEY ("userId")
);
