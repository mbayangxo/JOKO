-- J2 Money Kernel + everything since the J1 migration (runs 3–4: tontine escrow,
-- message requests, credential remediation, sessions, legacy-schema preservation).
-- Generated with: prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel
-- REVIEWED: additive only — no DROP TABLE/COLUMN/CONSTRAINT/INDEX, no type changes, no NOT NULL
-- without default. Database guards (prisma/sql/*.sql) are applied idempotently after deploy.

-- AlterTable
ALTER TABLE "MboloMember" ADD COLUMN     "invitedById" TEXT,
ADD COLUMN     "lastReadAt" TIMESTAMP(3),
ADD COLUMN     "lastTypingAt" TIMESTAMP(3),
ADD COLUMN     "respondedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "MboloMessage" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "mediaAssetId" TEXT,
ADD COLUMN     "retention" TEXT NOT NULL DEFAULT 'thread';

-- AlterTable
ALTER TABLE "MboloThread" ADD COLUMN     "commerceRefId" TEXT,
ADD COLUMN     "commerceType" TEXT,
ADD COLUMN     "inviteCode" TEXT;

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "rotatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TontineGroup" ADD COLUMN     "contributionKori" INTEGER,
ADD COLUMN     "currentCycle" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'forming';

-- AlterTable
ALTER TABLE "TontineMembership" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "invitedById" TEXT,
ADD COLUMN     "leftAt" TIMESTAMP(3),
ADD COLUMN     "respondedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'invited';

-- AlterTable
ALTER TABLE "TradeAccount" ADD COLUMN     "lastKnownBuyerScore" INTEGER,
ADD COLUMN     "lastKnownBuyerTier" TEXT,
ADD COLUMN     "lastScoreCheckAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TradeInvoice" ADD COLUMN     "disputeReason" TEXT,
ADD COLUMN     "disputeResolutionNote" TEXT,
ADD COLUMN     "disputedAt" TIMESTAMP(3),
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "credentialResetReason" TEXT,
ADD COLUMN     "credentialResetRequiredAt" TIMESTAMP(3),
ADD COLUMN     "sessionsRevokedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UserMediaVault" (
    "userId" TEXT NOT NULL,
    "quotaBytes" INTEGER NOT NULL DEFAULT 524288000,
    "usedBytes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMediaVault_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "MbooloMediaAsset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "threadId" TEXT,
    "bucket" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "mimeType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retention" TEXT NOT NULL DEFAULT 'thread',
    "profileVisible" BOOLEAN NOT NULL DEFAULT false,
    "waveformJson" JSONB,
    "durationMs" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MbooloMediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "mediaUrl" TEXT,
    "mediaAssetId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserStory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDeviceKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDeviceKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MbooloGif" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT,
    "label" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/gif',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "scope" TEXT NOT NULL DEFAULT 'k21',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MbooloGif_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TontineCycleContribution" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'settled',
    "authorization" TEXT NOT NULL DEFAULT 'explicit',
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "dueAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TontineCycleContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TontinePayout" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TontinePayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TontinePotEntry" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TontinePotEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CultureFeedItem" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'SN',
    "regionKey" TEXT,
    "tag" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "meta" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CultureFeedItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerPayment" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountXof" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "phone" TEXT,
    "method" TEXT NOT NULL DEFAULT 'auto',
    "description" TEXT,
    "metadataJson" TEXT,
    "webhookUrl" TEXT,
    "returnUrl" TEXT,
    "cancelUrl" TEXT,
    "checkoutToken" TEXT NOT NULL,
    "railReference" TEXT,
    "settlementUserId" TEXT,
    "failureReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerWebhookDelivery" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerMessage" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "channelUsed" TEXT NOT NULL DEFAULT 'none',
    "error" TEXT,
    "metadataJson" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerPayout" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountXof" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "phone" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'auto',
    "description" TEXT,
    "metadataJson" TEXT,
    "webhookUrl" TEXT,
    "railReference" TEXT,
    "settlementUserId" TEXT,
    "failureReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerPayoutDelivery" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerPayoutDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerSupportAgent" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "shopExternalId" TEXT,
    "jokoUserId" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'agent',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerSupportAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerSupportThread" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "shopExternalId" TEXT,
    "orderId" TEXT,
    "customerPhone" TEXT NOT NULL,
    "customerUserId" TEXT,
    "mboloThreadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedAgentId" TEXT,
    "subject" TEXT,
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerSupportThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChartSong" (
    "id" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "titleKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "videoId" TEXT,
    "submittedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChartSong_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SongVote" (
    "id" TEXT NOT NULL,
    "songId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SongVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendingCache" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "meta" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendingCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentFloatTopUpRequest" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amountXof" INTEGER NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "adminId" TEXT,
    "responseNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "AgentFloatTopUpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialSecurityEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "classification" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialSecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "normalSide" TEXT NOT NULL,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "ownerType" TEXT,
    "ownerId" TEXT,
    "projTable" TEXT,
    "projId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "reversesId" TEXT,
    "externalOperationId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Posting" (
    "id" BIGSERIAL NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Posting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOperation" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'created',
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "providerReference" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountKori" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "userId" TEXT,
    "accountCode" TEXT NOT NULL,
    "providerMode" TEXT NOT NULL,
    "reviewReason" TEXT,
    "failureReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "terminalAt" TIMESTAMP(3),
    "outcomeDeadline" TIMESTAMP(3),
    "legacyTable" TEXT,
    "legacyId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOperationEvent" (
    "id" BIGSERIAL NOT NULL,
    "operationId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "signatureOk" BOOLEAN NOT NULL DEFAULT false,
    "evidenceHash" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalOperationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderStatementLine" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerReference" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "statementId" TEXT NOT NULL,
    "matchedOperationId" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationException" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT,
    "providerReference" TEXT,
    "operationId" TEXT,
    "amountMinor" BIGINT,
    "currency" TEXT,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoneyAdjustmentRequest" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "debitAccount" TEXT NOT NULL,
    "creditAccount" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "originalReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "rejectedBy" TEXT,
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "MoneyAdjustmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MbooloMediaAsset_ownerId_createdAt_idx" ON "MbooloMediaAsset"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "MbooloMediaAsset_threadId_idx" ON "MbooloMediaAsset"("threadId");

-- CreateIndex
CREATE INDEX "MbooloMediaAsset_status_idx" ON "MbooloMediaAsset"("status");

-- CreateIndex
CREATE INDEX "UserStory_userId_expiresAt_idx" ON "UserStory"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "UserDeviceKey_userId_active_idx" ON "UserDeviceKey"("userId", "active");

-- CreateIndex
CREATE INDEX "MbooloGif_scope_active_idx" ON "MbooloGif"("scope", "active");

-- CreateIndex
CREATE INDEX "MbooloGif_creatorId_idx" ON "MbooloGif"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "TontineCycleContribution_reference_key" ON "TontineCycleContribution"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "TontineCycleContribution_idempotencyKey_key" ON "TontineCycleContribution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TontineCycleContribution_userId_createdAt_idx" ON "TontineCycleContribution"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TontineCycleContribution_groupId_cycle_userId_key" ON "TontineCycleContribution"("groupId", "cycle", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TontinePayout_reference_key" ON "TontinePayout"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "TontinePayout_groupId_cycle_key" ON "TontinePayout"("groupId", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "TontinePotEntry_reference_key" ON "TontinePotEntry"("reference");

-- CreateIndex
CREATE INDEX "TontinePotEntry_groupId_cycle_idx" ON "TontinePotEntry"("groupId", "cycle");

-- CreateIndex
CREATE INDEX "CultureFeedItem_country_active_sortOrder_idx" ON "CultureFeedItem"("country", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerPayment_checkoutToken_key" ON "PartnerPayment"("checkoutToken");

-- CreateIndex
CREATE INDEX "PartnerPayment_status_createdAt_idx" ON "PartnerPayment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PartnerPayment_phone_idx" ON "PartnerPayment"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerPayment_partnerId_reference_key" ON "PartnerPayment"("partnerId", "reference");

-- CreateIndex
CREATE INDEX "PartnerWebhookDelivery_paymentId_createdAt_idx" ON "PartnerWebhookDelivery"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "PartnerWebhookDelivery_ok_nextRetryAt_idx" ON "PartnerWebhookDelivery"("ok", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerMessage_idempotencyKey_key" ON "PartnerMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PartnerMessage_partnerId_createdAt_idx" ON "PartnerMessage"("partnerId", "createdAt");

-- CreateIndex
CREATE INDEX "PartnerMessage_toPhone_createdAt_idx" ON "PartnerMessage"("toPhone", "createdAt");

-- CreateIndex
CREATE INDEX "PartnerPayout_status_createdAt_idx" ON "PartnerPayout"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PartnerPayout_phone_idx" ON "PartnerPayout"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerPayout_partnerId_reference_key" ON "PartnerPayout"("partnerId", "reference");

-- CreateIndex
CREATE INDEX "PartnerPayoutDelivery_payoutId_createdAt_idx" ON "PartnerPayoutDelivery"("payoutId", "createdAt");

-- CreateIndex
CREATE INDEX "PartnerPayoutDelivery_ok_nextRetryAt_idx" ON "PartnerPayoutDelivery"("ok", "nextRetryAt");

-- CreateIndex
CREATE INDEX "PartnerSupportAgent_partnerId_shopExternalId_idx" ON "PartnerSupportAgent"("partnerId", "shopExternalId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerSupportAgent_partnerId_jokoUserId_key" ON "PartnerSupportAgent"("partnerId", "jokoUserId");

-- CreateIndex
CREATE INDEX "PartnerSupportThread_partnerId_status_updatedAt_idx" ON "PartnerSupportThread"("partnerId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "PartnerSupportThread_customerPhone_idx" ON "PartnerSupportThread"("customerPhone");

-- CreateIndex
CREATE INDEX "PartnerSupportThread_orderId_idx" ON "PartnerSupportThread"("orderId");

-- CreateIndex
CREATE INDEX "PartnerSupportThread_mboloThreadId_idx" ON "PartnerSupportThread"("mboloThreadId");

-- CreateIndex
CREATE INDEX "ChartSong_weekKey_idx" ON "ChartSong"("weekKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChartSong_weekKey_titleKey_key" ON "ChartSong"("weekKey", "titleKey");

-- CreateIndex
CREATE INDEX "SongVote_songId_idx" ON "SongVote"("songId");

-- CreateIndex
CREATE UNIQUE INDEX "SongVote_userId_weekKey_key" ON "SongVote"("userId", "weekKey");

-- CreateIndex
CREATE INDEX "TrendingCache_kind_periodKey_idx" ON "TrendingCache"("kind", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "TrendingCache_kind_periodKey_rank_key" ON "TrendingCache"("kind", "periodKey", "rank");

-- CreateIndex
CREATE INDEX "AgentFloatTopUpRequest_agentId_status_idx" ON "AgentFloatTopUpRequest"("agentId", "status");

-- CreateIndex
CREATE INDEX "AgentFloatTopUpRequest_status_idx" ON "AgentFloatTopUpRequest"("status");

-- CreateIndex
CREATE INDEX "CredentialSecurityEvent_userId_createdAt_idx" ON "CredentialSecurityEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CredentialSecurityEvent_type_createdAt_idx" ON "CredentialSecurityEvent"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_code_key" ON "LedgerAccount"("code");

-- CreateIndex
CREATE INDEX "LedgerAccount_type_idx" ON "LedgerAccount"("type");

-- CreateIndex
CREATE INDEX "LedgerAccount_ownerType_ownerId_idx" ON "LedgerAccount"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_projTable_projId_key" ON "LedgerAccount"("projTable", "projId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reference_key" ON "JournalEntry"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversesId_key" ON "JournalEntry"("reversesId");

-- CreateIndex
CREATE INDEX "JournalEntry_kind_createdAt_idx" ON "JournalEntry"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "JournalEntry_externalOperationId_idx" ON "JournalEntry"("externalOperationId");

-- CreateIndex
CREATE INDEX "Posting_entryId_idx" ON "Posting"("entryId");

-- CreateIndex
CREATE INDEX "Posting_accountId_id_idx" ON "Posting"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOperation_reference_key" ON "ExternalOperation"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOperation_idempotencyKey_key" ON "ExternalOperation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ExternalOperation_state_outcomeDeadline_idx" ON "ExternalOperation"("state", "outcomeDeadline");

-- CreateIndex
CREATE INDEX "ExternalOperation_userId_createdAt_idx" ON "ExternalOperation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ExternalOperation_legacyTable_legacyId_idx" ON "ExternalOperation"("legacyTable", "legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOperation_provider_providerReference_key" ON "ExternalOperation"("provider", "providerReference");

-- CreateIndex
CREATE INDEX "ExternalOperationEvent_operationId_id_idx" ON "ExternalOperationEvent"("operationId", "id");

-- CreateIndex
CREATE INDEX "ProviderStatementLine_provider_statementId_idx" ON "ProviderStatementLine"("provider", "statementId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderStatementLine_provider_providerReference_direction_key" ON "ProviderStatementLine"("provider", "providerReference", "direction");

-- CreateIndex
CREATE INDEX "ReconciliationException_status_createdAt_idx" ON "ReconciliationException"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationException_kind_provider_providerReference_key" ON "ReconciliationException"("kind", "provider", "providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "MoneyAdjustmentRequest_idempotencyKey_key" ON "MoneyAdjustmentRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MoneyAdjustmentRequest_status_createdAt_idx" ON "MoneyAdjustmentRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MboloMember_userId_status_idx" ON "MboloMember"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MboloMessage_mediaAssetId_key" ON "MboloMessage"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "MboloThread_inviteCode_key" ON "MboloThread"("inviteCode");

-- CreateIndex
CREATE INDEX "MboloThread_commerceRefId_idx" ON "MboloThread"("commerceRefId");

-- AddForeignKey
ALTER TABLE "MboloMessage" ADD CONSTRAINT "MboloMessage_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MbooloMediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMediaVault" ADD CONSTRAINT "UserMediaVault_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MbooloMediaAsset" ADD CONSTRAINT "MbooloMediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MbooloMediaAsset" ADD CONSTRAINT "MbooloMediaAsset_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MboloThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStory" ADD CONSTRAINT "UserStory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDeviceKey" ADD CONSTRAINT "UserDeviceKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MbooloGif" ADD CONSTRAINT "MbooloGif_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TontineCycleContribution" ADD CONSTRAINT "TontineCycleContribution_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TontineGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TontineCycleContribution" ADD CONSTRAINT "TontineCycleContribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TontinePayout" ADD CONSTRAINT "TontinePayout_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TontineGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TontinePayout" ADD CONSTRAINT "TontinePayout_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TontinePotEntry" ADD CONSTRAINT "TontinePotEntry_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TontineGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerWebhookDelivery" ADD CONSTRAINT "PartnerWebhookDelivery_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PartnerPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerPayoutDelivery" ADD CONSTRAINT "PartnerPayoutDelivery_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "PartnerPayout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerSupportAgent" ADD CONSTRAINT "PartnerSupportAgent_jokoUserId_fkey" FOREIGN KEY ("jokoUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerSupportThread" ADD CONSTRAINT "PartnerSupportThread_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "PartnerSupportAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SongVote" ADD CONSTRAINT "SongVote_songId_fkey" FOREIGN KEY ("songId") REFERENCES "ChartSong"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFloatTopUpRequest" ADD CONSTRAINT "AgentFloatTopUpRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_externalOperationId_fkey" FOREIGN KEY ("externalOperationId") REFERENCES "ExternalOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Posting" ADD CONSTRAINT "Posting_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Posting" ADD CONSTRAINT "Posting_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOperationEvent" ADD CONSTRAINT "ExternalOperationEvent_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "ExternalOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

