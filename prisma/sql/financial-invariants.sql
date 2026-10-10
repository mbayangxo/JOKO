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

-- D44: a return stock hold's quantities never change; state only moves forward; never deleted.
CREATE OR REPLACE FUNCTION joko_return_hold_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ReturnStockHold rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."sellableUnits" <> OLD."sellableUnits" OR NEW."damagedUnits" <> OLD."damagedUnits" OR NEW."returnId" <> OLD."returnId"
     OR NEW."sellerProductId" <> OLD."sellerProductId" OR NEW."buyerProductId" IS DISTINCT FROM OLD."buyerProductId" THEN
    RAISE EXCEPTION 'ReturnStockHold %: quantities are immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT ((OLD.state = NEW.state) OR (OLD.state = 'quarantined' AND NEW.state IN ('handed_over', 'released')) OR (OLD.state = 'handed_over' AND NEW.state = 'released')) THEN
    RAISE EXCEPTION 'ReturnStockHold %: % → % not allowed', OLD.id, OLD.state, NEW.state USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "ReturnStockHold_guard" ON "ReturnStockHold";
CREATE TRIGGER "ReturnStockHold_guard" BEFORE UPDATE OR DELETE ON "ReturnStockHold"
  FOR EACH ROW EXECUTE FUNCTION joko_return_hold_guard();
ALTER TABLE "ReturnStockHold" DROP CONSTRAINT IF EXISTS "ReturnStockHold_units_check";
ALTER TABLE "ReturnStockHold" ADD CONSTRAINT "ReturnStockHold_units_check" CHECK ("sellableUnits" >= 0 AND "damagedUnits" >= 0 AND "sellableUnits" + "damagedUnits" > 0);

-- ─────────────────────────── J9 Work & Opportunity guards ───────────────────────────
-- Evidence and outcomes are append-only.
CREATE OR REPLACE FUNCTION joko_work_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "WorkEvidence_append_only" ON "WorkEvidence";
CREATE TRIGGER "WorkEvidence_append_only" BEFORE UPDATE OR DELETE ON "WorkEvidence" FOR EACH ROW EXECUTE FUNCTION joko_work_append_only();
DROP TRIGGER IF EXISTS "WorkOutcome_append_only" ON "WorkOutcome";
CREATE TRIGGER "WorkOutcome_append_only" BEFORE UPDATE OR DELETE ON "WorkOutcome" FOR EACH ROW EXECUTE FUNCTION joko_work_append_only();

-- Offer terms never change once sent; status only leaves `sent`.
CREATE OR REPLACE FUNCTION joko_work_offer_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'WorkOffer rows are never deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF NEW."termsJson" <> OLD."termsJson" OR NEW."termsHash" <> OLD."termsHash" OR NEW."totalKori" <> OLD."totalKori"
     OR NEW."workerUserId" <> OLD."workerUserId" OR NEW."businessId" <> OLD."businessId" OR NEW.arrangement <> OLD.arrangement OR NEW.funding <> OLD.funding THEN
    RAISE EXCEPTION 'WorkOffer %: terms are immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'sent' AND NEW.status IN ('accepted','declined','withdrawn','expired')) THEN
    RAISE EXCEPTION 'WorkOffer %: % → % not allowed', OLD.id, OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "WorkOffer_guard" ON "WorkOffer";
CREATE TRIGGER "WorkOffer_guard" BEFORE UPDATE OR DELETE ON "WorkOffer" FOR EACH ROW EXECUTE FUNCTION joko_work_offer_guard();

-- Milestone amounts are immutable; status moves forward only.
CREATE OR REPLACE FUNCTION joko_work_milestone_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'WorkMilestone rows are never deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF NEW."amountKori" <> OLD."amountKori" OR NEW."assignmentId" <> OLD."assignmentId" OR NEW.seq <> OLD.seq OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'WorkMilestone %: amount is immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('submitted','refunded'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('accepted','disputed'))
    OR (OLD.status = 'disputed' AND NEW.status IN ('accepted','refunded','split'))) THEN
    RAISE EXCEPTION 'WorkMilestone %: % → % not allowed', OLD.id, OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "WorkMilestone_guard" ON "WorkMilestone";
CREATE TRIGGER "WorkMilestone_guard" BEFORE UPDATE OR DELETE ON "WorkMilestone" FOR EACH ROW EXECUTE FUNCTION joko_work_milestone_guard();

-- Earnings: amount / payee / source immutable; accrued → releasable → paid; accrued | releasable → reversed.
CREATE OR REPLACE FUNCTION joko_work_earning_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'WorkEarning rows are never deleted' USING ERRCODE = 'restrict_violation'; END IF;
  IF NEW."amountKori" <> OLD."amountKori" OR NEW."sourceKey" <> OLD."sourceKey" OR NEW.classification <> OLD.classification
     OR NEW."workerUserId" IS DISTINCT FROM OLD."workerUserId" OR NEW."payeeBusinessId" IS DISTINCT FROM OLD."payeeBusinessId"
     OR NEW."payerBusinessId" <> OLD."payerBusinessId" THEN
    RAISE EXCEPTION 'WorkEarning %: amount and parties are immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'accrued' AND NEW.status IN ('releasable','reversed'))
    OR (OLD.status = 'releasable' AND NEW.status IN ('paid','reversed'))) THEN
    RAISE EXCEPTION 'WorkEarning %: % → % not allowed', OLD.id, OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "WorkEarning_guard" ON "WorkEarning";
CREATE TRIGGER "WorkEarning_guard" BEFORE UPDATE OR DELETE ON "WorkEarning" FOR EACH ROW EXECUTE FUNCTION joko_work_earning_guard();

DROP TRIGGER IF EXISTS "WorkDispute_no_delete" ON "WorkDispute";
CREATE TRIGGER "WorkDispute_no_delete" BEFORE DELETE ON "WorkDispute" FOR EACH ROW EXECUTE FUNCTION joko_work_append_only();

ALTER TABLE "WorkOpportunity" DROP CONSTRAINT IF EXISTS "WorkOpportunity_amounts_check";
ALTER TABLE "WorkOpportunity" ADD CONSTRAINT "WorkOpportunity_amounts_check" CHECK ("rateKori" >= 0 AND units >= 1 AND headcount >= 1 AND "minAge" >= 16);
ALTER TABLE "WorkOffer" DROP CONSTRAINT IF EXISTS "WorkOffer_amounts_check";
ALTER TABLE "WorkOffer" ADD CONSTRAINT "WorkOffer_amounts_check" CHECK ("totalKori" >= 0);
ALTER TABLE "WorkMilestone" DROP CONSTRAINT IF EXISTS "WorkMilestone_amounts_check";
ALTER TABLE "WorkMilestone" ADD CONSTRAINT "WorkMilestone_amounts_check" CHECK ("amountKori" >= 0);
ALTER TABLE "WorkEarning" DROP CONSTRAINT IF EXISTS "WorkEarning_amounts_check";
ALTER TABLE "WorkEarning" ADD CONSTRAINT "WorkEarning_amounts_check" CHECK ("amountKori" > 0 AND (("workerUserId" IS NULL) <> ("payeeBusinessId" IS NULL)));
ALTER TABLE "WorkRule" DROP CONSTRAINT IF EXISTS "WorkRule_amounts_check";
ALTER TABLE "WorkRule" ADD CONSTRAINT "WorkRule_amounts_check" CHECK ("amountKori" >= 0 AND "minOrderKori" >= 0);
ALTER TABLE "WorkFeedback" DROP CONSTRAINT IF EXISTS "WorkFeedback_rating_check";
ALTER TABLE "WorkFeedback" ADD CONSTRAINT "WorkFeedback_rating_check" CHECK (rating BETWEEN 1 AND 5);

-- J11 (mirrors migrations 20261022000000_j11_collective_engine and 20261023000000_j11_protected_jekkal_coop).
-- J11: group money history, payouts and ballots are append-only.
DROP TRIGGER IF EXISTS "CollectivePayment_append_only" ON "CollectivePayment";
CREATE TRIGGER "CollectivePayment_append_only" BEFORE UPDATE OR DELETE ON "CollectivePayment"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "CollectivePayout_append_only" ON "CollectivePayout";
CREATE TRIGGER "CollectivePayout_append_only" BEFORE UPDATE OR DELETE ON "CollectivePayout"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "CollectiveEvent_append_only" ON "CollectiveEvent";
CREATE TRIGGER "CollectiveEvent_append_only" BEFORE UPDATE OR DELETE ON "CollectiveEvent"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "CollectiveBallot_append_only" ON "CollectiveBallot";
CREATE TRIGGER "CollectiveBallot_append_only" BEFORE UPDATE OR DELETE ON "CollectiveBallot"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();

-- J11: rules are locked once a group is active. Nobody (organizer, code bug or operator) can change
-- the accepted terms, rotation, amount or schedule afterwards; groups are never deleted.
CREATE OR REPLACE FUNCTION joko_collective_rules_locked() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'collective groups are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('active', 'completed', 'cancelled') AND (
       NEW."rulesHash" IS DISTINCT FROM OLD."rulesHash" OR NEW."rulesJson" IS DISTINCT FROM OLD."rulesJson"
    OR NEW."rulesVersion" IS DISTINCT FROM OLD."rulesVersion" OR NEW."contributionKori" IS DISTINCT FROM OLD."contributionKori"
    OR NEW.frequency IS DISTINCT FROM OLD.frequency OR NEW."cycleCount" IS DISTINCT FROM OLD."cycleCount"
    OR NEW."targetKori" IS DISTINCT FROM OLD."targetKori" OR NEW."withdrawPolicy" IS DISTINCT FROM OLD."withdrawPolicy"
    OR NEW."organizerId" IS DISTINCT FROM OLD."organizerId" OR NEW.kind IS DISTINCT FROM OLD.kind) THEN
    RAISE EXCEPTION 'collective rules are locked after activation' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('completed', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a closed collective group cannot reopen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "CollectiveGroup_rules_locked" ON "CollectiveGroup";
CREATE TRIGGER "CollectiveGroup_rules_locked" BEFORE UPDATE OR DELETE ON "CollectiveGroup"
  FOR EACH ROW EXECUTE FUNCTION joko_collective_rules_locked();

-- A member's position in the rotation is unique within a group.
CREATE UNIQUE INDEX IF NOT EXISTS "CollectiveMember_group_position_key" ON "CollectiveMember"("groupId", "position") WHERE "position" IS NOT NULL;

-- Approvals are an immutable record.
DROP TRIGGER IF EXISTS "ProtectedApproval_append_only" ON "ProtectedApproval";
CREATE TRIGGER "ProtectedApproval_append_only" BEFORE UPDATE OR DELETE ON "ProtectedApproval"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();

-- Coop capital records: never deleted, never edited — only the member's own confirm / dispute stamp may be set.
CREATE OR REPLACE FUNCTION joko_coop_record_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'coop capital records are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."businessId" IS DISTINCT FROM OLD."businessId" OR NEW."memberUserId" IS DISTINCT FROM OLD."memberUserId"
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.direction IS DISTINCT FROM OLD.direction OR NEW."amountXof" IS DISTINCT FROM OLD."amountXof"
     OR NEW."occurredOn" IS DISTINCT FROM OLD."occurredOn" OR NEW.note IS DISTINCT FROM OLD.note OR NEW."evidenceRef" IS DISTINCT FROM OLD."evidenceRef"
     OR NEW."recordedBy" IS DISTINCT FROM OLD."recordedBy" OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."memberConfirmedAt" IS NOT NULL AND NEW."memberConfirmedAt" IS DISTINCT FROM OLD."memberConfirmedAt")
     OR (OLD."memberDisputedAt" IS NOT NULL AND NEW."memberDisputedAt" IS DISTINCT FROM OLD."memberDisputedAt") THEN
    RAISE EXCEPTION 'coop capital records are append-only (a correction is a new record)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "CoopCapitalRecord_guard" ON "CoopCapitalRecord";
CREATE TRIGGER "CoopCapitalRecord_guard" BEFORE UPDATE OR DELETE ON "CoopCapitalRecord"
  FOR EACH ROW EXECUTE FUNCTION joko_coop_record_guard();

-- A protected fund never releases or refunds more than it raised.
ALTER TABLE "ProtectedFund" DROP CONSTRAINT IF EXISTS "ProtectedFund_money_bounds";
ALTER TABLE "ProtectedFund" ADD CONSTRAINT "ProtectedFund_money_bounds" CHECK ("raisedKori" >= 0 AND "releasedKori" >= 0 AND "refundedKori" >= 0 AND "releasedKori" + "refundedKori" <= "raisedKori" AND "raisedKori" <= "goalKori");
ALTER TABLE "ProtectedContribution" DROP CONSTRAINT IF EXISTS "ProtectedContribution_refund_bounds";
ALTER TABLE "ProtectedContribution" ADD CONSTRAINT "ProtectedContribution_refund_bounds" CHECK ("amountKori" > 0 AND "refundedKori" >= 0 AND "refundedKori" <= "amountKori");
