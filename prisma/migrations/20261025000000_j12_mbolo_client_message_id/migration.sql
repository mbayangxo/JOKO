-- J12 (P-J12-3): chat message de-duplication. ADDITIVE and backward-compatible:
-- a nullable column (old clients send nothing → NULL) and a unique index on (senderId, clientMessageId).
-- PostgreSQL treats NULLs as distinct, so every existing row and every old client stays valid.
-- Operational note: on a large table, build the index CONCURRENTLY in a maintenance window before
-- running this migration (Prisma runs migrations in a transaction); the IF NOT EXISTS makes that safe.
ALTER TABLE "MboloMessage" ADD COLUMN IF NOT EXISTS "clientMessageId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "MboloMessage_senderId_clientMessageId_key" ON "MboloMessage"("senderId", "clientMessageId");
