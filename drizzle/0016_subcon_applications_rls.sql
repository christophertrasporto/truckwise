GRANT SELECT, INSERT ON subcon_applications, subcon_application_files TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (status, reviewed_by, reviewed_at, review_note, partner_tenant_id) ON subcon_applications TO smartload_app;
--> statement-breakpoint
ALTER TABLE subcon_applications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subcon_applications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subcon_application_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subcon_application_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Applicants are not signed in: the public form writes in a platform context after proving it holds the company's link
-- token. Staff read and review inside their own company only.
CREATE POLICY subcon_applications_tenant ON subcon_applications FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY subcon_application_files_tenant ON subcon_application_files FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
-- A decided application cannot be changed back, and applicant details are fixed once submitted.
CREATE OR REPLACE FUNCTION subcon_application_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  mutable text[] := ARRAY['status','reviewed_by','reviewed_at','review_note','partner_tenant_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'subcon_applications rows are never deleted';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'application details are fixed once submitted';
  END IF;
  IF OLD.status <> 'new' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a decided application cannot be changed';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER subcon_applications_guard BEFORE UPDATE OR DELETE ON subcon_applications
  FOR EACH ROW EXECUTE FUNCTION subcon_application_guard();
--> statement-breakpoint
CREATE UNIQUE INDEX company_settings_apply_token_uq ON company_settings (apply_token) WHERE apply_token IS NOT NULL;
