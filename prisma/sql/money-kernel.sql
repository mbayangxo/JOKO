-- ============================================================================
-- J2 Money Kernel — database enforcement (docs/JOKKO-J2-DESIGN.md §1, §4, §9)
-- Idempotent: safe to run on every deploy / test setup.
--
--  * Posting insert → LedgerAccount.balance (+/-) → legacy projection column.
--  * Every JournalEntry balances per currency at COMMIT (deferred trigger).
--  * Journal tables are append-only.
--  * Balance columns (ledger + legacy projections) can change ONLY through
--    the posting trigger chain: any other UPDATE/INSERT is rejected. This is
--    what makes "no money mutation outside the kernel" a database property.
--  * ExternalOperation transitions follow the state machine.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Constraints Prisma can't express
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_nonneg_chk" CHECK ("allowNegative" OR "balance" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_side_chk" CHECK ("normalSide" IN ('debit','credit'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_status_chk" CHECK ("status" IN ('active','frozen','closed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Posting" ADD CONSTRAINT "Posting_amount_pos_chk" CHECK ("amount" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Posting" ADD CONSTRAINT "Posting_side_chk" CHECK ("side" IN ('debit','credit'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ExternalOperation" ADD CONSTRAINT "ExternalOperation_amounts_chk"
    CHECK ("amountMinor" > 0 AND "amountKori" >= 0 AND "feeMinor" >= 0 AND "direction" IN ('in','out'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ExternalOperation" ADD CONSTRAINT "ExternalOperation_state_chk"
    CHECK ("state" IN ('created','authorized','submitted','confirmed','settled','failed','cancelled','expired','reversed','refunded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Posting → balance → projection
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION j2_posting_apply() RETURNS trigger AS $$
DECLARE
  acc "LedgerAccount"%ROWTYPE;
  delta bigint;
  newbal bigint;
BEGIN
  SELECT * INTO acc FROM "LedgerAccount" WHERE id = NEW."accountId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'J2: posting to unknown account %', NEW."accountId";
  END IF;
  IF acc."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'J2: posting currency % does not match account % currency %', NEW."currency", acc."code", acc."currency";
  END IF;
  IF acc."status" <> 'active' THEN
    RAISE EXCEPTION 'J2: account % is %', acc."code", acc."status" USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."side" = acc."normalSide" THEN delta := NEW."amount"; ELSE delta := -NEW."amount"; END IF;

  UPDATE "LedgerAccount" SET "balance" = "balance" + delta, "updatedAt" = now()
   WHERE id = acc.id RETURNING "balance" INTO newbal;

  IF acc."projTable" IS NOT NULL THEN
    IF acc."projTable" = 'Wallet' THEN
      UPDATE "Wallet" SET "koriBalance" = newbal::int WHERE id = acc."projId";
    ELSIF acc."projTable" = 'BusinessWallet' THEN
      UPDATE "BusinessWallet" SET "balance" = newbal::int WHERE id = acc."projId";
    ELSIF acc."projTable" = 'PaymentFund' THEN
      UPDATE "PaymentFund" SET "balanceKori" = newbal::int WHERE id = acc."projId";
    ELSIF acc."projTable" = 'MerchantVoucher' THEN
      UPDATE "MerchantVoucher" SET "balanceKori" = newbal::int WHERE id = acc."projId";
    ELSIF acc."projTable" = 'AgentProfile' THEN
      UPDATE "AgentProfile" SET "floatBalance" = newbal::int WHERE id = acc."projId";
    ELSIF acc."projTable" = 'TontineGroup' THEN
      UPDATE "TontineGroup" SET "potBalance" = newbal::int WHERE id = acc."projId";
    ELSE
      RAISE EXCEPTION 'J2: unknown projection table %', acc."projTable";
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'J2: projection row %.% missing for account %', acc."projTable", acc."projId", acc."code";
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS j2_posting_apply ON "Posting";
CREATE TRIGGER j2_posting_apply AFTER INSERT ON "Posting"
  FOR EACH ROW EXECUTE FUNCTION j2_posting_apply();

-- ---------------------------------------------------------------------------
-- Balanced entries (checked at COMMIT)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION j2_entry_balanced() RETURNS trigger AS $$
DECLARE
  n int;
  bad record;
BEGIN
  SELECT COUNT(*) INTO n FROM "Posting" WHERE "entryId" = NEW."entryId";
  IF n < 2 THEN
    RAISE EXCEPTION 'J2: journal entry % has % posting(s); at least 2 required', NEW."entryId", n;
  END IF;
  SELECT "currency", SUM(CASE WHEN "side" = 'debit' THEN "amount" ELSE -"amount" END) AS net
    INTO bad
    FROM "Posting" WHERE "entryId" = NEW."entryId"
   GROUP BY "currency"
  HAVING SUM(CASE WHEN "side" = 'debit' THEN "amount" ELSE -"amount" END) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'J2: journal entry % does not balance in % (net %)', NEW."entryId", bad."currency", bad.net;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS j2_entry_balanced ON "Posting";
CREATE CONSTRAINT TRIGGER j2_entry_balanced AFTER INSERT ON "Posting"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION j2_entry_balanced();

-- An entry with zero postings is caught when the entry is inserted.
CREATE OR REPLACE FUNCTION j2_entry_has_postings() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Posting" WHERE "entryId" = NEW.id) THEN
    RAISE EXCEPTION 'J2: journal entry % (%) committed without postings', NEW.id, NEW."reference";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS j2_entry_has_postings ON "JournalEntry";
CREATE CONSTRAINT TRIGGER j2_entry_has_postings AFTER INSERT ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION j2_entry_has_postings();

-- ---------------------------------------------------------------------------
-- Append-only journal
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION j2_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'J2: % is append-only (% refused)', TG_TABLE_NAME, TG_OP;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS j2_append_only ON "JournalEntry";
CREATE TRIGGER j2_append_only BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION j2_append_only();
DROP TRIGGER IF EXISTS j2_append_only_trunc ON "JournalEntry";
CREATE TRIGGER j2_append_only_trunc BEFORE TRUNCATE ON "JournalEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION j2_append_only();

DROP TRIGGER IF EXISTS j2_append_only ON "Posting";
CREATE TRIGGER j2_append_only BEFORE UPDATE OR DELETE ON "Posting"
  FOR EACH ROW EXECUTE FUNCTION j2_append_only();
DROP TRIGGER IF EXISTS j2_append_only_trunc ON "Posting";
CREATE TRIGGER j2_append_only_trunc BEFORE TRUNCATE ON "Posting"
  FOR EACH STATEMENT EXECUTE FUNCTION j2_append_only();

DROP TRIGGER IF EXISTS j2_append_only ON "ExternalOperationEvent";
CREATE TRIGGER j2_append_only BEFORE UPDATE OR DELETE ON "ExternalOperationEvent"
  FOR EACH ROW EXECUTE FUNCTION j2_append_only();
DROP TRIGGER IF EXISTS j2_append_only_trunc ON "ExternalOperationEvent";
CREATE TRIGGER j2_append_only_trunc BEFORE TRUNCATE ON "ExternalOperationEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION j2_append_only();

-- ---------------------------------------------------------------------------
-- LedgerAccount: balance only via postings; identity immutable; no delete
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION j2_ledger_account_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'J2: ledger accounts are never deleted (%).', OLD."code";
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."balance" <> 0 THEN
      RAISE EXCEPTION 'J2: ledger account % must open at 0 (opening balances are postings)', NEW."code";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."balance" IS DISTINCT FROM OLD."balance" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'J2: balance of % can only change through journal postings', OLD."code";
  END IF;
  IF NEW."code" IS DISTINCT FROM OLD."code" OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."normalSide" IS DISTINCT FROM OLD."normalSide" OR NEW."allowNegative" IS DISTINCT FROM OLD."allowNegative"
     OR (OLD."projTable" IS NOT NULL AND (NEW."projTable" IS DISTINCT FROM OLD."projTable" OR NEW."projId" IS DISTINCT FROM OLD."projId")) THEN
    RAISE EXCEPTION 'J2: identity of ledger account % is immutable', OLD."code";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS j2_ledger_account_guard ON "LedgerAccount";
CREATE TRIGGER j2_ledger_account_guard BEFORE INSERT OR UPDATE OR DELETE ON "LedgerAccount"
  FOR EACH ROW EXECUTE FUNCTION j2_ledger_account_guard();

-- ---------------------------------------------------------------------------
-- Legacy balance columns are projections: no direct writes, ever.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION j2_projection_guard() RETURNS trigger AS $$
DECLARE
  col text := TG_ARGV[0];
  col2 text := TG_ARGV[1];
  oldv bigint; newv bigint; oldv2 bigint; newv2 bigint;
BEGIN
  newv := (to_jsonb(NEW) ->> col)::bigint;
  IF col2 IS NOT NULL THEN newv2 := (to_jsonb(NEW) ->> col2)::bigint; END IF;
  IF TG_OP = 'INSERT' THEN
    IF (COALESCE(newv, 0) <> 0 OR COALESCE(newv2, 0) <> 0) AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'J2: %.% must be created at 0 — fund it through the Money Kernel', TG_TABLE_NAME, col;
    END IF;
    RETURN NEW;
  END IF;
  oldv := (to_jsonb(OLD) ->> col)::bigint;
  IF col2 IS NOT NULL THEN oldv2 := (to_jsonb(OLD) ->> col2)::bigint; END IF;
  IF (newv IS DISTINCT FROM oldv OR newv2 IS DISTINCT FROM oldv2) AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'J2: %.% is a ledger projection — direct balance mutation refused (use the Money Kernel)', TG_TABLE_NAME, col;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS j2_projection_guard ON "Wallet";
CREATE TRIGGER j2_projection_guard BEFORE INSERT OR UPDATE ON "Wallet"
  FOR EACH ROW EXECUTE FUNCTION j2_projection_guard('koriBalance', 'balance');
DROP TRIGGER IF EXISTS j2_projection_guard ON "BusinessWallet";
CREATE TRIGGER j2_projection_guard BEFORE INSERT OR UPDATE ON "BusinessWallet"
  FOR EACH ROW EXECUTE FUNCTION j2_projection_guard('balance');
DROP TRIGGER IF EXISTS j2_projection_guard ON "PaymentFund";
CREATE TRIGGER j2_projection_guard BEFORE INSERT OR UPDATE ON "PaymentFund"
  FOR EACH ROW EXECUTE FUNCTION j2_projection_guard('balanceKori');
DROP TRIGGER IF EXISTS j2_projection_guard ON "MerchantVoucher";
CREATE TRIGGER j2_projection_guard BEFORE INSERT OR UPDATE ON "MerchantVoucher"
  FOR EACH ROW EXECUTE FUNCTION j2_projection_guard('balanceKori');
DROP TRIGGER IF EXISTS j2_projection_guard ON "AgentProfile";
CREATE TRIGGER j2_projection_guard BEFORE INSERT OR UPDATE ON "AgentProfile"
  FOR EACH ROW EXECUTE FUNCTION j2_projection_guard('floatBalance');
DROP TRIGGER IF EXISTS j2_projection_guard ON "TontineGroup";
CREATE TRIGGER j2_projection_guard BEFORE INSERT OR UPDATE ON "TontineGroup"
  FOR EACH ROW EXECUTE FUNCTION j2_projection_guard('potBalance');

-- ---------------------------------------------------------------------------
-- ExternalOperation state machine
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION j2_external_op_guard() RETURNS trigger AS $$
DECLARE
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'J2: external operations are never deleted (%)', OLD."reference";
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'created' THEN
      RAISE EXCEPTION 'J2: external operation % must start in state created', NEW."reference";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."provider" IS DISTINCT FROM OLD."provider" OR NEW."direction" IS DISTINCT FROM OLD."direction"
     OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."amountKori" IS DISTINCT FROM OLD."amountKori"
     OR NEW."accountCode" IS DISTINCT FROM OLD."accountCode" OR NEW."providerMode" IS DISTINCT FROM OLD."providerMode"
     OR NEW."feeMinor" IS DISTINCT FROM OLD."feeMinor" THEN
    RAISE EXCEPTION 'J2: financial identity of external operation % is immutable', OLD."reference";
  END IF;
  IF OLD."providerReference" IS NOT NULL AND NEW."providerReference" IS DISTINCT FROM OLD."providerReference" THEN
    RAISE EXCEPTION 'J2: provider reference of % is already set', OLD."reference";
  END IF;
  IF NEW."state" = OLD."state" THEN
    RETURN NEW;
  END IF;
  ok := (OLD."state", NEW."state") IN (
    ('created','authorized'), ('created','submitted'), ('created','failed'), ('created','cancelled'),
    ('authorized','submitted'), ('authorized','failed'), ('authorized','cancelled'), ('authorized','expired'),
    ('submitted','confirmed'), ('submitted','failed'), ('submitted','expired'),
    ('expired','confirmed'), ('expired','failed'),
    ('confirmed','settled'), ('confirmed','reversed'), ('confirmed','refunded'),
    ('settled','reversed'), ('settled','refunded')
  );
  IF NOT ok THEN
    RAISE EXCEPTION 'J2: invalid external operation transition % → % (%)', OLD."state", NEW."state", OLD."reference"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS j2_external_op_guard ON "ExternalOperation";
CREATE TRIGGER j2_external_op_guard BEFORE INSERT OR UPDATE OR DELETE ON "ExternalOperation"
  FOR EACH ROW EXECUTE FUNCTION j2_external_op_guard();
