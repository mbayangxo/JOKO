-- J14-S1: signed partner event delivery (D-J14-2). Additive only: two new tables; nothing existing is touched.
-- Inert unless PARTNER_EVENTS_ENABLED=true. Rollback = leave disabled (tables can stay).
CREATE TABLE "PartnerEventSubscription" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "eventTypesJson" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "previousSecretEnc" TEXT,
    "previousValidUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "fannedThrough" TIMESTAMP(3),

    CONSTRAINT "PartnerEventSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PartnerEventDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerEventDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PartnerEventSubscription_partnerId_status_idx" ON "PartnerEventSubscription"("partnerId", "status");
CREATE UNIQUE INDEX "PartnerEventDelivery_subscriptionId_eventId_key" ON "PartnerEventDelivery"("subscriptionId", "eventId");
CREATE INDEX "PartnerEventDelivery_status_nextAttemptAt_idx" ON "PartnerEventDelivery"("status", "nextAttemptAt");
CREATE INDEX "PartnerEventDelivery_createdAt_idx" ON "PartnerEventDelivery"("createdAt");

ALTER TABLE "PartnerEventDelivery" ADD CONSTRAINT "PartnerEventDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "PartnerEventSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
