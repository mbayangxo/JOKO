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
  FOREACH t IN ARRAY ARRAY['LedgerEntry', 'KoriTransaction', 'BusinessLedgerEntry', 'AgentFloatEntry', 'TontinePotEntry', 'TontinePayout', 'CredentialSecurityEvent', 'StockMovement', 'PaymentRecord']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_append_only') THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only()',
        t || '_append_only', t);
    END IF;
  END LOOP;
END $$;
