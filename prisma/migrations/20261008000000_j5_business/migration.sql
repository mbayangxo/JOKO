-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "phone" TEXT,
ADD COLUMN     "settlementMode" TEXT NOT NULL DEFAULT 'business',
ADD COLUMN     "verificationNote" TEXT,
ADD COLUMN     "verificationStatus" TEXT NOT NULL DEFAULT 'unverified',
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedBy" TEXT;

-- AlterTable
ALTER TABLE "MerchantCharge" ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "orderId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "refundReference" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "refundedBy" TEXT,
ADD COLUMN     "settledTo" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'product',
ADD COLUMN     "sku" TEXT;

-- CreateTable
CREATE TABLE "BusinessLocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locationId" TEXT,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "orderId" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessLocation_businessId_active_idx" ON "BusinessLocation"("businessId", "active");

-- CreateIndex
CREATE INDEX "StockMovement_productId_createdAt_idx" ON "StockMovement"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_businessId_createdAt_idx" ON "StockMovement"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_orderId_idx" ON "StockMovement"("orderId");

-- CreateIndex
CREATE INDEX "MerchantCharge_businessId_createdAt_idx" ON "MerchantCharge"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_refundReference_key" ON "Order"("refundReference");

-- CreateIndex
CREATE UNIQUE INDEX "Product_businessId_sku_key" ON "Product"("businessId", "sku");

-- AddForeignKey
ALTER TABLE "BusinessLocation" ADD CONSTRAINT "BusinessLocation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- J5: preserve existing behaviour (no change to where money lands for
-- businesses that already exist). Brand / distribution businesses already
-- settled to the business wallet; every other existing business keeps
-- owner-personal settlement until its owner switches. New businesses use
-- the column default ('business').
UPDATE "Business" SET "settlementMode" = 'owner'
 WHERE NOT ("distributionEnabled" = true OR "type" = 'brand');

-- J5: the existing public badge maps onto the verification lifecycle.
UPDATE "Business" SET "verificationStatus" = 'verified' WHERE "verified" = true;

-- J5: stock history is append-only (same guard as the money ledgers). The
-- guard function is (re)defined here because migrations run before the
-- deploy step re-applies prisma/sql/financial-invariants.sql (same body).
CREATE OR REPLACE FUNCTION joko_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger table % is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "StockMovement_append_only" ON "StockMovement";
CREATE TRIGGER "StockMovement_append_only" BEFORE UPDATE OR DELETE ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
