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

-- J8 pilot: an unmatched receipt is resolved once (pending → mapped), never deleted, units never change.
CREATE OR REPLACE FUNCTION joko_unmatched_receipt_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UnmatchedReceipt rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.units <> OLD.units OR NEW."shipmentId" <> OLD."shipmentId" OR NEW."sellerProductId" <> OLD."sellerProductId" OR NEW."buyerBusinessId" <> OLD."buyerBusinessId" THEN
    RAISE EXCEPTION 'UnmatchedReceipt %: facts are immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'mapped' THEN
    RAISE EXCEPTION 'UnmatchedReceipt %: already mapped', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "UnmatchedReceipt_guard" ON "UnmatchedReceipt";
CREATE TRIGGER "UnmatchedReceipt_guard" BEFORE UPDATE OR DELETE ON "UnmatchedReceipt"
  FOR EACH ROW EXECUTE FUNCTION joko_unmatched_receipt_guard();
ALTER TABLE "UnmatchedReceipt" DROP CONSTRAINT IF EXISTS "UnmatchedReceipt_units_check";
ALTER TABLE "UnmatchedReceipt" ADD CONSTRAINT "UnmatchedReceipt_units_check" CHECK ("units" > 0);
