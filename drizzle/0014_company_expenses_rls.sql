GRANT SELECT, INSERT ON company_expenses TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (voided_at, voided_by, void_reason) ON company_expenses TO smartload_app;
--> statement-breakpoint
ALTER TABLE company_expenses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_expenses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_expenses_tenant ON company_expenses FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
-- Amounts are fixed once recorded. A mistake is voided (with a reason) and entered again, so the history stays honest.
CREATE OR REPLACE FUNCTION company_expense_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  mutable text[] := ARRAY['voided_at','voided_by','void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company_expenses rows are never deleted';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'a recorded cost cannot be edited; void it and enter it again';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided cost cannot be changed';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER company_expenses_guard BEFORE UPDATE OR DELETE ON company_expenses
  FOR EACH ROW EXECUTE FUNCTION company_expense_guard();
