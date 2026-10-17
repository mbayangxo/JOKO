-- J7: commerce & distribution network. Additive; existing TradeInvoice rows keep their amounts
-- (creditedKori defaults to 0). Legacy invoice amounts that were previously overwritten by waive/adjust
-- are not reconstructed (history before J7 is preserved as-is).
-- AlterTable
ALTER TABLE "MerchantRelationship" ADD COLUMN     "assignedRepUserId" TEXT,
ADD COLUMN     "priceListId" TEXT;

-- AlterTable
ALTER TABLE "TradeAccount" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedBy" TEXT;

-- AlterTable
ALTER TABLE "TradeInvoice" ADD COLUMN     "creditedKori" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "purchaseOrderId" TEXT;

-- CreateTable
CREATE TABLE "WholesaleListing" (
    "id" TEXT NOT NULL,
    "sellerBusinessId" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'pack',
    "unitsPerPack" INTEGER NOT NULL DEFAULT 1,
    "priceKori" INTEGER NOT NULL,
    "moqPacks" INTEGER NOT NULL DEFAULT 1,
    "stepPacks" INTEGER NOT NULL DEFAULT 1,
    "availability" TEXT NOT NULL DEFAULT 'available',
    "visibility" TEXT NOT NULL DEFAULT 'relationships',
    "territoryIdsJson" TEXT,
    "depotLocationId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WholesaleListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesalePriceTier" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "minPacks" INTEGER NOT NULL,
    "priceKori" INTEGER NOT NULL,

    CONSTRAINT "WholesalePriceTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceList" (
    "id" TEXT NOT NULL,
    "sellerBusinessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceListEntry" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "priceKori" INTEGER NOT NULL,

    CONSTRAINT "PriceListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerritoryRep" (
    "id" TEXT NOT NULL,
    "territoryId" TEXT NOT NULL,
    "repUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "assignedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerritoryRep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "buyerBusinessId" TEXT NOT NULL,
    "sellerBusinessId" TEXT NOT NULL,
    "relationshipId" TEXT,
    "tradeAccountId" TEXT,
    "territoryId" TEXT,
    "status" TEXT NOT NULL,
    "paymentTerm" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
    "subtotalKori" INTEGER NOT NULL,
    "totalKori" INTEGER NOT NULL,
    "creditReservedKori" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "submittedBy" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedBy" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "paymentReference" TEXT,
    "invoiceId" TEXT,
    "fulfilmentMode" TEXT,
    "fulfilmentRequestedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "deliveryRecordedBy" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "refundReference" TEXT,
    "disputedAt" TIMESTAMP(3),
    "disputeReason" TEXT,
    "depotLocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "unitsPerPack" INTEGER NOT NULL,
    "packs" INTEGER NOT NULL,
    "unitPriceKori" INTEGER NOT NULL,
    "lineTotalKori" INTEGER NOT NULL,
    "priceSource" TEXT NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderEvent" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorBusinessId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeInvoicePayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "ledgerReference" TEXT NOT NULL,
    "paidByUserId" TEXT NOT NULL,
    "paymentSource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeInvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditMemo" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditMemo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepotStock" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepotStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepotStockMovement" (
    "id" TEXT NOT NULL,
    "depotStockId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "deltaOnHand" INTEGER NOT NULL,
    "deltaReserved" INTEGER NOT NULL,
    "onHandAfter" INTEGER NOT NULL,
    "reservedAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "returnId" TEXT,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepotStockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialReturn" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "buyerBusinessId" TEXT NOT NULL,
    "sellerBusinessId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "reason" TEXT NOT NULL,
    "linesJson" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "shippedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "restocked" BOOLEAN NOT NULL DEFAULT false,
    "resolution" TEXT,
    "creditMemoId" TEXT,
    "refundReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommercialReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WholesaleListing_sellerBusinessId_status_idx" ON "WholesaleListing"("sellerBusinessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WholesaleListing_sellerBusinessId_sku_key" ON "WholesaleListing"("sellerBusinessId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "WholesalePriceTier_listingId_minPacks_key" ON "WholesalePriceTier"("listingId", "minPacks");

-- CreateIndex
CREATE INDEX "PriceList_sellerBusinessId_status_idx" ON "PriceList"("sellerBusinessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListEntry_priceListId_listingId_key" ON "PriceListEntry"("priceListId", "listingId");

-- CreateIndex
CREATE INDEX "TerritoryRep_repUserId_status_idx" ON "TerritoryRep"("repUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TerritoryRep_territoryId_repUserId_key" ON "TerritoryRep"("territoryId", "repUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_reference_key" ON "PurchaseOrder"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_paymentReference_key" ON "PurchaseOrder"("paymentReference");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_refundReference_key" ON "PurchaseOrder"("refundReference");

-- CreateIndex
CREATE INDEX "PurchaseOrder_sellerBusinessId_status_createdAt_idx" ON "PurchaseOrder"("sellerBusinessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseOrder_buyerBusinessId_createdAt_idx" ON "PurchaseOrder"("buyerBusinessId", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tradeAccountId_status_idx" ON "PurchaseOrder"("tradeAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_buyerBusinessId_idempotencyKey_key" ON "PurchaseOrder"("buyerBusinessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_listingId_idx" ON "PurchaseOrderLine"("listingId");

-- CreateIndex
CREATE INDEX "PurchaseOrderEvent_purchaseOrderId_createdAt_idx" ON "PurchaseOrderEvent"("purchaseOrderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradeInvoicePayment_ledgerReference_key" ON "TradeInvoicePayment"("ledgerReference");

-- CreateIndex
CREATE INDEX "TradeInvoicePayment_invoiceId_idx" ON "TradeInvoicePayment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditMemo_reference_key" ON "CreditMemo"("reference");

-- CreateIndex
CREATE INDEX "CreditMemo_invoiceId_idx" ON "CreditMemo"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "DepotStock_locationId_productId_key" ON "DepotStock"("locationId", "productId");

-- CreateIndex
CREATE INDEX "DepotStockMovement_locationId_productId_createdAt_idx" ON "DepotStockMovement"("locationId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "DepotStockMovement_purchaseOrderId_idx" ON "DepotStockMovement"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialReturn_reference_key" ON "CommercialReturn"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialReturn_refundReference_key" ON "CommercialReturn"("refundReference");

-- CreateIndex
CREATE INDEX "CommercialReturn_purchaseOrderId_idx" ON "CommercialReturn"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "CommercialReturn_sellerBusinessId_status_idx" ON "CommercialReturn"("sellerBusinessId", "status");

-- CreateIndex
CREATE INDEX "CommercialReturn_buyerBusinessId_status_idx" ON "CommercialReturn"("buyerBusinessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TradeInvoice_purchaseOrderId_key" ON "TradeInvoice"("purchaseOrderId");


-- J7: commercial history is append-only; stock can never go negative or over-reserved;
-- an issued invoice's principal and parties never change and invoices are never deleted;
-- a purchase order's parties and agreed totals never change and orders are never deleted.
DROP TRIGGER IF EXISTS "PurchaseOrderEvent_append_only" ON "PurchaseOrderEvent";
CREATE TRIGGER "PurchaseOrderEvent_append_only" BEFORE UPDATE OR DELETE ON "PurchaseOrderEvent"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "PurchaseOrderLine_append_only" ON "PurchaseOrderLine";
CREATE TRIGGER "PurchaseOrderLine_append_only" BEFORE UPDATE OR DELETE ON "PurchaseOrderLine"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "TradeInvoicePayment_append_only" ON "TradeInvoicePayment";
CREATE TRIGGER "TradeInvoicePayment_append_only" BEFORE UPDATE OR DELETE ON "TradeInvoicePayment"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "CreditMemo_append_only" ON "CreditMemo";
CREATE TRIGGER "CreditMemo_append_only" BEFORE UPDATE OR DELETE ON "CreditMemo"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "DepotStockMovement_append_only" ON "DepotStockMovement";
CREATE TRIGGER "DepotStockMovement_append_only" BEFORE UPDATE OR DELETE ON "DepotStockMovement"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();

ALTER TABLE "DepotStock" DROP CONSTRAINT IF EXISTS "DepotStock_quantities_check";
ALTER TABLE "DepotStock" ADD CONSTRAINT "DepotStock_quantities_check" CHECK ("onHand" >= 0 AND "reserved" >= 0 AND "reserved" <= "onHand");

CREATE OR REPLACE FUNCTION joko_trade_invoice_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TradeInvoice rows are never deleted (use a credit memo)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."amountKori" <> OLD."amountKori" OR NEW."supplierBusinessId" <> OLD."supplierBusinessId"
     OR NEW."buyerUserId" <> OLD."buyerUserId" OR NEW."reference" <> OLD."reference" THEN
    RAISE EXCEPTION 'TradeInvoice % : principal and parties are immutable (use a credit memo)', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."amountPaid" < 0 OR NEW."creditedKori" < 0 OR NEW."amountPaid" + NEW."creditedKori" > NEW."amountKori" THEN
    RAISE EXCEPTION 'TradeInvoice % : paid + credited exceeds principal', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "TradeInvoice_guard" ON "TradeInvoice";
CREATE TRIGGER "TradeInvoice_guard" BEFORE UPDATE OR DELETE ON "TradeInvoice"
  FOR EACH ROW EXECUTE FUNCTION joko_trade_invoice_guard();

CREATE OR REPLACE FUNCTION joko_purchase_order_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PurchaseOrder rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."buyerBusinessId" <> OLD."buyerBusinessId" OR NEW."sellerBusinessId" <> OLD."sellerBusinessId"
     OR NEW."totalKori" <> OLD."totalKori" OR NEW."subtotalKori" <> OLD."subtotalKori"
     OR NEW."paymentTerm" <> OLD."paymentTerm" OR NEW."reference" <> OLD."reference" THEN
    RAISE EXCEPTION 'PurchaseOrder % : parties, totals and terms are immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."creditReservedKori" < 0 OR NEW."creditReservedKori" > NEW."totalKori" THEN
    RAISE EXCEPTION 'PurchaseOrder % : invalid credit reservation', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "PurchaseOrder_guard" ON "PurchaseOrder";
CREATE TRIGGER "PurchaseOrder_guard" BEFORE UPDATE OR DELETE ON "PurchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION joko_purchase_order_guard();
