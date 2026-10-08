-- J8: movement, logistics & fulfilment. Additive only: new tables, one defaulted column, guards; no existing row's data is changed.
-- AlterTable
ALTER TABLE "HubParcel" ADD COLUMN     "pickupAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PickupPoint" (
    "id" TEXT NOT NULL,
    "operatorBusinessId" TEXT NOT NULL,
    "hubId" TEXT,
    "addressId" TEXT,
    "name" TEXT NOT NULL,
    "servicesJson" TEXT NOT NULL DEFAULT '["customer_pickup"]',
    "hoursText" TEXT,
    "capacityParcels" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "appliedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PickupPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfilmentRequest" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'outbound',
    "sourceKey" TEXT NOT NULL,
    "fulfilmentOwner" TEXT NOT NULL,
    "fulfillerBusinessId" TEXT,
    "serviceType" TEXT NOT NULL DEFAULT 'local',
    "originLocationId" TEXT,
    "originBusinessId" TEXT NOT NULL,
    "destinationBusinessId" TEXT,
    "destinationUserId" TEXT,
    "destinationAddressId" TEXT,
    "pickupPointId" TEXT,
    "feePayer" TEXT NOT NULL DEFAULT 'none',
    "feeKori" INTEGER NOT NULL DEFAULT 0,
    "courierEarningKori" INTEGER NOT NULL DEFAULT 0,
    "feeStatus" TEXT NOT NULL DEFAULT 'none',
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfilmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "custody" TEXT NOT NULL DEFAULT 'source',
    "custodianUserId" TEXT,
    "deliveryProof" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "routeId" TEXT,
    "destArea" TEXT,
    "destPrecise" TEXT,
    "destLat" DOUBLE PRECISION,
    "destLng" DOUBLE PRECISION,
    "preciseRedactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentPackage" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "linesJson" TEXT NOT NULL,
    "weightGrams" INTEGER,
    "dimsCm" TEXT,
    "handling" TEXT,

    CONSTRAINT "ShipmentPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentEvent" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "custodyBefore" TEXT,
    "custodyAfter" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "evidence" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierAssignment" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "courierUserId" TEXT NOT NULL,
    "courierKind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "assignedBy" TEXT NOT NULL,
    "assignedByType" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustodyChallenge" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "boundUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedBy" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustodyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivingRecord" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "receiverBusinessId" TEXT,
    "receiverUserId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "linesJson" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "linesJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierEarning" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "courierUserId" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'accrued',
    "releasableAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "payoutReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierEarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentDispute" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "openedBy" TEXT NOT NULL,
    "openedByRole" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentDisputeEvidence" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentDisputeEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryRoute" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "ownerBusinessId" TEXT NOT NULL,
    "depotLocationId" TEXT,
    "serviceDate" TIMESTAMP(3) NOT NULL,
    "driverUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteStop" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "shipmentId" TEXT NOT NULL,

    CONSTRAINT "RouteStop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PickupPoint_hubId_key" ON "PickupPoint"("hubId");

-- CreateIndex
CREATE INDEX "PickupPoint_operatorBusinessId_status_idx" ON "PickupPoint"("operatorBusinessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FulfilmentRequest_reference_key" ON "FulfilmentRequest"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "FulfilmentRequest_sourceKey_key" ON "FulfilmentRequest"("sourceKey");

-- CreateIndex
CREATE INDEX "FulfilmentRequest_fulfillerBusinessId_status_idx" ON "FulfilmentRequest"("fulfillerBusinessId", "status");

-- CreateIndex
CREATE INDEX "FulfilmentRequest_originBusinessId_createdAt_idx" ON "FulfilmentRequest"("originBusinessId", "createdAt");

-- CreateIndex
CREATE INDEX "FulfilmentRequest_destinationBusinessId_createdAt_idx" ON "FulfilmentRequest"("destinationBusinessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_reference_key" ON "Shipment"("reference");

-- CreateIndex
CREATE INDEX "Shipment_requestId_idx" ON "Shipment"("requestId");

-- CreateIndex
CREATE INDEX "Shipment_status_updatedAt_idx" ON "Shipment"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Shipment_routeId_idx" ON "Shipment"("routeId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentPackage_reference_key" ON "ShipmentPackage"("reference");

-- CreateIndex
CREATE INDEX "ShipmentPackage_shipmentId_idx" ON "ShipmentPackage"("shipmentId");

-- CreateIndex
CREATE INDEX "ShipmentEvent_shipmentId_createdAt_idx" ON "ShipmentEvent"("shipmentId", "createdAt");

-- CreateIndex
CREATE INDEX "CourierAssignment_shipmentId_status_idx" ON "CourierAssignment"("shipmentId", "status");

-- CreateIndex
CREATE INDEX "CourierAssignment_courierUserId_status_idx" ON "CourierAssignment"("courierUserId", "status");

-- CreateIndex
CREATE INDEX "CustodyChallenge_shipmentId_purpose_idx" ON "CustodyChallenge"("shipmentId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivingRecord_shipmentId_key" ON "ReceivingRecord"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_reference_key" ON "StockTransfer"("reference");

-- CreateIndex
CREATE INDEX "StockTransfer_businessId_status_idx" ON "StockTransfer"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CourierEarning_shipmentId_key" ON "CourierEarning"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "CourierEarning_payoutReference_key" ON "CourierEarning"("payoutReference");

-- CreateIndex
CREATE INDEX "CourierEarning_courierUserId_status_idx" ON "CourierEarning"("courierUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentDispute_shipmentId_key" ON "ShipmentDispute"("shipmentId");

-- CreateIndex
CREATE INDEX "ShipmentDisputeEvidence_disputeId_idx" ON "ShipmentDisputeEvidence"("disputeId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRoute_reference_key" ON "DeliveryRoute"("reference");

-- CreateIndex
CREATE INDEX "DeliveryRoute_ownerBusinessId_serviceDate_idx" ON "DeliveryRoute"("ownerBusinessId", "serviceDate");

-- CreateIndex
CREATE UNIQUE INDEX "RouteStop_shipmentId_key" ON "RouteStop"("shipmentId");

-- CreateIndex
CREATE INDEX "RouteStop_routeId_sequence_idx" ON "RouteStop"("routeId", "sequence");


-- J8: physical custody invariants, enforced by the database.
-- Shipment / receiving / dispute-evidence history is append-only.
DROP TRIGGER IF EXISTS "ShipmentEvent_append_only" ON "ShipmentEvent";
CREATE TRIGGER "ShipmentEvent_append_only" BEFORE UPDATE OR DELETE ON "ShipmentEvent"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "ReceivingRecord_append_only" ON "ReceivingRecord";
CREATE TRIGGER "ReceivingRecord_append_only" BEFORE UPDATE OR DELETE ON "ReceivingRecord"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "ShipmentDisputeEvidence_append_only" ON "ShipmentDisputeEvidence";
CREATE TRIGGER "ShipmentDisputeEvidence_append_only" BEFORE UPDATE OR DELETE ON "ShipmentDisputeEvidence"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();

-- A shipment is delivered at most once; at most one active courier assignment per shipment.
CREATE UNIQUE INDEX IF NOT EXISTS "ShipmentEvent_one_delivery" ON "ShipmentEvent" ("shipmentId") WHERE "toStatus" = 'delivered';
CREATE UNIQUE INDEX IF NOT EXISTS "CourierAssignment_one_active" ON "CourierAssignment" ("shipmentId") WHERE "status" = 'active';

ALTER TABLE "CourierEarning" DROP CONSTRAINT IF EXISTS "CourierEarning_amount_check";
ALTER TABLE "CourierEarning" ADD CONSTRAINT "CourierEarning_amount_check" CHECK ("amountKori" > 0);
ALTER TABLE "FulfilmentRequest" DROP CONSTRAINT IF EXISTS "FulfilmentRequest_fee_check";
ALTER TABLE "FulfilmentRequest" ADD CONSTRAINT "FulfilmentRequest_fee_check" CHECK ("feeKori" >= 0 AND "courierEarningKori" >= 0 AND "courierEarningKori" <= "feeKori");

-- Status ⇒ custody: one custodian at a time, consistent with the physical state; terminal states are final.
CREATE OR REPLACE FUNCTION joko_shipment_guard() RETURNS trigger AS $$
DECLARE expected TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shipment rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  expected := CASE
    WHEN NEW.status IN ('requested','accepted','ready_for_pickup','assigned','pickup_arrived','cancelled','returned') THEN 'source'
    WHEN NEW.status IN ('picked_up','in_transit','delivery_arrived','delivery_failed','delivery_exception','return_requested','return_in_transit') THEN 'courier'
    WHEN NEW.status = 'at_pickup_point' THEN 'pickup_point'
    WHEN NEW.status = 'delivered' THEN 'receiver'
    ELSE NULL END;
  IF expected IS NULL THEN
    RAISE EXCEPTION 'Shipment %: unknown status %', NEW.id, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.custody <> expected THEN
    RAISE EXCEPTION 'Shipment %: status % requires custody %, got %', NEW.id, NEW.status, expected, NEW.custody USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('delivered','returned','cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Shipment %: % is final', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Shipment_guard" ON "Shipment";
CREATE TRIGGER "Shipment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION joko_shipment_guard();
