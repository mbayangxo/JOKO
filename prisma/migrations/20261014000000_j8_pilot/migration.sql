-- J8 pilot (additive): courier acceptance, failure evidence, buyer catalogue mapping, unmatched receipts.
ALTER TABLE "CourierAssignment" ADD COLUMN "acceptedAt" TIMESTAMP(3);
ALTER TABLE "Shipment" ADD COLUMN "failureEvidence" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "failureEvidenceBy" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "failureEvidenceAt" TIMESTAMP(3);

CREATE TABLE "BuyerProductMapping" (
    "id" TEXT NOT NULL,
    "buyerBusinessId" TEXT NOT NULL,
    "sellerBusinessId" TEXT NOT NULL,
    "sellerProductId" TEXT NOT NULL,
    "buyerProductId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuyerProductMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BuyerProductMapping_buyerBusinessId_sellerProductId_key" ON "BuyerProductMapping"("buyerBusinessId", "sellerProductId");
CREATE INDEX "BuyerProductMapping_buyerProductId_idx" ON "BuyerProductMapping"("buyerProductId");

CREATE TABLE "UnmatchedReceipt" (
    "id" TEXT NOT NULL,
    "buyerBusinessId" TEXT NOT NULL,
    "sellerBusinessId" TEXT NOT NULL,
    "sellerProductId" TEXT NOT NULL,
    "sku" TEXT,
    "units" INTEGER NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "shipmentRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "buyerProductId" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UnmatchedReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UnmatchedReceipt_shipmentId_sellerProductId_key" ON "UnmatchedReceipt"("shipmentId", "sellerProductId");
CREATE INDEX "UnmatchedReceipt_buyerBusinessId_status_idx" ON "UnmatchedReceipt"("buyerBusinessId", "status");
