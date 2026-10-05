-- Joko financial invariants enforced by Postgres (idempotent — safe to re-run).
-- Applied on every deploy by scripts/db-sync-deploy.mjs after `prisma db push`
-- (Prisma does not manage CHECK constraints or triggers, and leaves them intact).

-- 1. Stored balances can never go negative (no designed credit product exists).
--    NOT VALID: enforced on every new write without failing on legacy rows.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('Wallet', 'Wallet_koriBalance_nonnegative', '"koriBalance" >= 0'),
    ('Wallet', 'Wallet_balance_nonnegative', '"balance" >= 0'),
    ('BusinessWallet', 'BusinessWallet_balance_nonnegative', '"balance" >= 0'),
    ('MerchantVoucher', 'MerchantVoucher_balanceKori_nonnegative', '"balanceKori" >= 0'),
    ('PaymentFund', 'PaymentFund_balanceKori_nonnegative', '"balanceKori" >= 0'),
    ('AgentProfile', 'AgentProfile_floatBalance_nonnegative', '"floatBalance" >= 0'),
    ('TontineGroup', 'TontineGroup_potBalance_nonnegative', '"potBalance" >= 0')
  ) AS t(tbl, name, expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.tbl, c.name, c.expr);
    END IF;
  END LOOP;
END $$;

-- 2. Ledger history is append-only: insert yes, update/delete never.
CREATE OR REPLACE FUNCTION joko_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger table % is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['LedgerEntry', 'KoriTransaction', 'BusinessLedgerEntry', 'AgentFloatEntry', 'TontinePotEntry', 'TontinePayout', 'CredentialSecurityEvent', 'StockMovement', 'PaymentRecord', 'AgentStatusEvent', 'AgentCashEvent', 'AgentCashReport']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_append_only') THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only()',
        t || '_append_only', t);
    END IF;
  END LOOP;
END $$;
-- J6: a cash transaction's amount and parties never change after creation; the
-- challenge only before binding; the agent / service point / binding are write-once.
CREATE OR REPLACE FUNCTION joko_agent_cash_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."amountXof" <> OLD."amountXof" OR NEW."amountKori" <> OLD."amountKori"
     OR NEW."customerId" <> OLD."customerId" OR NEW."kind" <> OLD."kind"
     OR NEW."reference" <> OLD."reference" THEN
    RAISE EXCEPTION 'AgentCashTransaction % : amount / parties / challenge are immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  -- A new handoff challenge may be issued only while nobody has bound the transaction.
  IF NEW."challengeHash" <> OLD."challengeHash" AND (OLD."agentId" IS NOT NULL OR OLD."state" NOT IN ('created', 'funds_held')) THEN
    RAISE EXCEPTION 'AgentCashTransaction % : challenge is fixed once bound', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."agentId" IS NOT NULL AND NEW."agentId" IS DISTINCT FROM OLD."agentId")
     OR (OLD."servicePointId" IS NOT NULL AND NEW."servicePointId" IS DISTINCT FROM OLD."servicePointId")
     OR (OLD."bindingHash" IS NOT NULL AND NEW."bindingHash" IS DISTINCT FROM OLD."bindingHash") THEN
    RAISE EXCEPTION 'AgentCashTransaction % : binding is write-once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AgentCashTransaction rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "AgentCashTransaction_immutable" ON "AgentCashTransaction";
CREATE TRIGGER "AgentCashTransaction_immutable" BEFORE UPDATE ON "AgentCashTransaction"
  FOR EACH ROW EXECUTE FUNCTION joko_agent_cash_immutable();
CREATE OR REPLACE FUNCTION joko_agent_cash_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AgentCashTransaction rows are never deleted' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "AgentCashTransaction_no_delete" ON "AgentCashTransaction";
CREATE TRIGGER "AgentCashTransaction_no_delete" BEFORE DELETE ON "AgentCashTransaction"
  FOR EACH ROW EXECUTE FUNCTION joko_agent_cash_no_delete();
