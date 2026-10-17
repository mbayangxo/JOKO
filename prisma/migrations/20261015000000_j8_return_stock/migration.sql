-- D44 (additive): buyer-side return stock holds.
CREATE TABLE "ReturnStockHold" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "buyerBusinessId" TEXT NOT NULL,
    "sellerProductId" TEXT NOT NULL,
    "buyerProductId" TEXT,
    "sellableUnits" INTEGER NOT NULL,
    "damagedUnits" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'quarantined',
    "handoverEvidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReturnStockHold_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReturnStockHold_returnId_sellerProductId_attempt_key" ON "ReturnStockHold"("returnId", "sellerProductId", "attempt");
CREATE INDEX "ReturnStockHold_buyerBusinessId_state_idx" ON "ReturnStockHold"("buyerBusinessId", "state");

-- D44: per-return ship attempts (re-ship after a cancelled / failed collection).
ALTER TABLE "CommercialReturn" ADD COLUMN "shipAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CommercialReturn" ADD COLUMN "shipTracked" BOOLEAN NOT NULL DEFAULT false;
-- Returns shipped before D44 count as attempt 1 (tracked iff a collection was requested).
UPDATE "CommercialReturn" SET "shipAttempts" = 1 WHERE "shippedAt" IS NOT NULL;
UPDATE "CommercialReturn" cr SET "shipTracked" = true
 WHERE EXISTS (SELECT 1 FROM "CommerceEvent" e WHERE e.type = 'return.collection_requested' AND e."aggregateType" = 'commercial_return' AND e."aggregateId" = cr.id);
