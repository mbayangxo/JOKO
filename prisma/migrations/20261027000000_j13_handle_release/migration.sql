-- J13-4: append-only log of released handles (recipient identity binding, legacy-client compatibility).
-- Additive only: a new table and index; no existing row or column is touched. Rollback = stop writing it.
CREATE TABLE "HandleRelease" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandleRelease_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HandleRelease_handle_releasedAt_idx" ON "HandleRelease"("handle", "releasedAt");
