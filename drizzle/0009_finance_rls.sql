GRANT SELECT, INSERT, UPDATE ON document_counters TO smartload_app;
--> statement-breakpoint
-- Financial documents are insert-only; only their status and payment/void fields can change afterwards.
GRANT SELECT, INSERT ON invoices, invoice_lines, settlements, settlement_lines, trip_expenses TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (status, paid_at, payment_reference, voided_at, voided_by, void_reason, notes) ON invoices TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (status, paid_at, payment_reference, voided_at, voided_by, void_reason) ON settlements TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (active) ON invoice_lines, settlement_lines TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (status, company_bears, reviewed_by, reviewed_at, review_note) ON trip_expenses TO smartload_app;
--> statement-breakpoint

ALTER TABLE document_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE settlements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE settlement_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE settlement_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_expenses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_expenses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY document_counters_tenant ON document_counters FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY invoices_tenant ON invoices FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY invoice_lines_tenant ON invoice_lines FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY settlements_tenant ON settlements FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY settlement_lines_tenant ON settlement_lines FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY trip_expenses_tenant ON trip_expenses FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Defence in depth: even the table owner cannot alter an issued amount, and a document only moves
-- issued -> paid or issued -> void (never back, never paid -> void).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION financial_document_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  mutable text[] := ARRAY['status','paid_at','payment_reference','voided_at','voided_by','void_reason','notes'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION '% amounts and parties are fixed once issued', TG_TABLE_NAME;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'issued' AND NEW.status IN ('paid', 'void')) THEN
    RAISE EXCEPTION 'a % cannot move from % to %', TG_TABLE_NAME, OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION financial_document_guard();
--> statement-breakpoint
CREATE TRIGGER settlements_guard BEFORE UPDATE OR DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION financial_document_guard();
--> statement-breakpoint

-- Lines: nothing but active true -> false.
CREATE OR REPLACE FUNCTION financial_line_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
  END IF;
  IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
    RAISE EXCEPTION '% rows are fixed once issued', TG_TABLE_NAME;
  END IF;
  IF NEW.active AND NOT OLD.active THEN
    RAISE EXCEPTION 'a released % cannot be reactivated', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_guard BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION financial_line_guard();
--> statement-breakpoint
CREATE TRIGGER settlement_lines_guard BEFORE UPDATE OR DELETE ON settlement_lines
  FOR EACH ROW EXECUTE FUNCTION financial_line_guard();
--> statement-breakpoint

-- Expenses: amounts and receipts are fixed; a review decision is final.
CREATE OR REPLACE FUNCTION trip_expense_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  mutable text[] := ARRAY['status','company_bears','reviewed_by','reviewed_at','review_note'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trip_expenses rows are never deleted';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'expense amounts and receipts are fixed once submitted';
  END IF;
  IF OLD.status <> 'submitted' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.company_bears IS DISTINCT FROM OLD.company_bears) THEN
    RAISE EXCEPTION 'a reviewed expense cannot be changed';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER trip_expenses_guard BEFORE UPDATE OR DELETE ON trip_expenses
  FOR EACH ROW EXECUTE FUNCTION trip_expense_guard();
--> statement-breakpoint

-- Companies (haulers) that have issued a settlement to the calling partner company. Returns only ids.
CREATE OR REPLACE FUNCTION my_settlement_hauler_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT DISTINCT tenant_id FROM settlements WHERE partner_tenant_id = app_tenant() $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION my_settlement_hauler_ids() TO smartload_app;
