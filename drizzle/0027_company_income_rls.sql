GRANT SELECT, INSERT ON company_income TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (voided_at, voided_by, void_reason) ON company_income TO smartload_app;
--> statement-breakpoint
ALTER TABLE company_income ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_income FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_income_tenant ON company_income FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
-- A recorded payment is fixed. A mistake is voided with a reason and entered again.
CREATE OR REPLACE FUNCTION company_income_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  mutable text[] := ARRAY['voided_at','voided_by','void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company_income rows are never deleted';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'a recorded payment cannot be edited; void it and enter it again';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided entry cannot be changed';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER company_income_guard BEFORE UPDATE OR DELETE ON company_income
  FOR EACH ROW EXECUTE FUNCTION company_income_guard();
