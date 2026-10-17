-- J15 (found by the L6 soak): every "did my payment go through?" lookup (intent outcome, void, 5xx / crash
-- recovery, stale-intent release) finds journal entries by the client's Idempotency-Key, stored in
-- metadata.clientKey. Without an index each lookup scanned the whole journal (linear in its size).
-- Additive and partial: only entries that carry a client key are indexed. Not expressible in schema.prisma.
CREATE INDEX IF NOT EXISTS "JournalEntry_clientKey_idx" ON "JournalEntry" ((metadata->>'clientKey')) WHERE metadata ? 'clientKey';
