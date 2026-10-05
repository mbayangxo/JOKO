-- AlterTable
ALTER TABLE "BusinessLocation" ADD COLUMN     "addressId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryAddressId" TEXT,
ADD COLUMN     "externalOrderRef" TEXT,
ADD COLUMN     "fulfillmentOwner" TEXT NOT NULL DEFAULT 'merchant',
ADD COLUMN     "inventoryLocationId" TEXT,
ADD COLUMN     "sourceChannel" TEXT NOT NULL DEFAULT 'jokko_app',
ADD COLUMN     "sourceSystem" TEXT NOT NULL DEFAULT 'jokko';

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "inventoryLocationId" TEXT;

-- CreateTable
CREATE TABLE "InventoryLocation" (
    "id" TEXT NOT NULL,
    "operatorBusinessId" TEXT,
    "businessLocationId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'store',
    "status" TEXT NOT NULL DEFAULT 'active',
    "name" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "country" TEXT NOT NULL DEFAULT 'SN',
    "region" TEXT,
    "department" TEXT,
    "city" TEXT,
    "commune" TEXT,
    "neighborhood" TEXT,
    "street" TEXT,
    "building" TEXT,
    "landmark" TEXT,
    "instructions" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "verificationState" TEXT NOT NULL DEFAULT 'unverified',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "sourceChannel" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL DEFAULT 'jokko',
    "settlement" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "ledgerReference" TEXT,
    "orderId" TEXT,
    "chargeCode" TEXT,
    "externalRef" TEXT,
    "recordedBy" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "businessId" TEXT,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "CommerceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Territory" (
    "id" TEXT NOT NULL,
    "distributorBusinessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'SN',
    "region" TEXT,
    "department" TEXT,
    "communes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Territory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantRelationship" (
    "id" TEXT NOT NULL,
    "distributorBusinessId" TEXT NOT NULL,
    "merchantBusinessId" TEXT,
    "invitedUserId" TEXT,
    "introducedByUserId" TEXT NOT NULL,
    "territoryId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "scopesJson" TEXT NOT NULL DEFAULT '["wholesale_catalog","wholesale_ordering"]',
    "assistedOnboarding" BOOLEAN NOT NULL DEFAULT false,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "respondedBy" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalLink" (
    "id" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "jokkoType" TEXT NOT NULL,
    "jokkoId" TEXT NOT NULL,
    "businessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "linkedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessLinkCode" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryLocation_operatorBusinessId_status_idx" ON "InventoryLocation"("operatorBusinessId", "status");

-- CreateIndex
CREATE INDEX "Address_ownerType_ownerId_idx" ON "Address"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecord_ledgerReference_key" ON "PaymentRecord"("ledgerReference");

-- CreateIndex
CREATE INDEX "PaymentRecord_businessId_createdAt_idx" ON "PaymentRecord"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentRecord_orderId_idx" ON "PaymentRecord"("orderId");

-- CreateIndex
CREATE INDEX "CommerceEvent_type_createdAt_idx" ON "CommerceEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceEvent_businessId_createdAt_idx" ON "CommerceEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceEvent_publishedAt_idx" ON "CommerceEvent"("publishedAt");

-- CreateIndex
CREATE INDEX "Territory_distributorBusinessId_active_idx" ON "Territory"("distributorBusinessId", "active");

-- CreateIndex
CREATE INDEX "MerchantRelationship_distributorBusinessId_status_idx" ON "MerchantRelationship"("distributorBusinessId", "status");

-- CreateIndex
CREATE INDEX "MerchantRelationship_merchantBusinessId_status_idx" ON "MerchantRelationship"("merchantBusinessId", "status");

-- CreateIndex
CREATE INDEX "MerchantRelationship_invitedUserId_status_idx" ON "MerchantRelationship"("invitedUserId", "status");

-- CreateIndex
CREATE INDEX "ExternalLink_jokkoType_jokkoId_idx" ON "ExternalLink"("jokkoType", "jokkoId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalLink_system_objectType_externalId_key" ON "ExternalLink"("system", "objectType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessLinkCode_codeHash_key" ON "BusinessLinkCode"("codeHash");

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "operatingMode" TEXT NOT NULL DEFAULT 'retail';


-- J5: businesses already running distribution keep that mode (no behaviour change).
UPDATE "Business" SET "operatingMode" = 'distribution' WHERE "distributionEnabled" = true OR "type" = 'brand';

-- J5: payment records and commerce events are append-only facts.
DROP TRIGGER IF EXISTS "PaymentRecord_append_only" ON "PaymentRecord";
CREATE TRIGGER "PaymentRecord_append_only" BEFORE UPDATE OR DELETE ON "PaymentRecord"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
