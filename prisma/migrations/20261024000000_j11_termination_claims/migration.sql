-- J11 P-J11-8: explicit immutable claims at group close. ADDITIVE ONLY.
-- CreateTable
CREATE TABLE "CollectiveClaim" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "paidKori" INTEGER NOT NULL,
    "receivedKori" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectiveClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectiveClaim_userId_idx" ON "CollectiveClaim"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectiveClaim_groupId_userId_key" ON "CollectiveClaim"("groupId", "userId");

-- AddForeignKey
ALTER TABLE "CollectiveClaim" ADD CONSTRAINT "CollectiveClaim_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CollectiveGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Claims are an immutable record (a later recovery or write-off would be a separate, approved record).
DROP TRIGGER IF EXISTS "CollectiveClaim_append_only" ON "CollectiveClaim";
CREATE TRIGGER "CollectiveClaim_append_only" BEFORE UPDATE OR DELETE ON "CollectiveClaim"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
ALTER TABLE "CollectiveClaim" DROP CONSTRAINT IF EXISTS "CollectiveClaim_shape";
ALTER TABLE "CollectiveClaim" ADD CONSTRAINT "CollectiveClaim_shape" CHECK ("amountKori" > 0 AND direction IN ('owes','owed') AND "paidKori" >= 0 AND "receivedKori" >= 0
  AND "amountKori" = abs("receivedKori" - "paidKori") AND (direction = 'owes') = ("receivedKori" > "paidKori"));
