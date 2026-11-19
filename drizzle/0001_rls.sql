-- Application role: no superuser, no BYPASSRLS. Password is set by scripts/migrate.ts from APP_DB_PASSWORD.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'smartload_app') THEN
    CREATE ROLE smartload_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

-- Request context, set per transaction by the data-access layer (SET LOCAL semantics via set_config(..., true)).
CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_platform() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.is_platform', true), '') = 'on' $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO smartload_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, memberships, sessions, partner_approvals, company_settings, customers TO smartload_app;
--> statement-breakpoint
-- Audit log is append-only for the app role.
GRANT SELECT, INSERT ON audit_log TO smartload_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE audit_log_id_seq TO smartload_app;
--> statement-breakpoint

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE partner_approvals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE partner_approvals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- tenants: see own tenant, tenants you are a member of, and approved/pending partner counterparties.
CREATE POLICY tenants_select ON tenants FOR SELECT USING (
  app_is_platform()
  OR id = app_tenant()
  OR id IN (SELECT tenant_id FROM memberships WHERE user_id = app_user())
  OR id IN (SELECT partner_tenant_id FROM partner_approvals WHERE tenant_id = app_tenant())
  OR id IN (SELECT tenant_id FROM partner_approvals WHERE partner_tenant_id = app_tenant())
);
--> statement-breakpoint
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (app_is_platform());
--> statement-breakpoint
CREATE POLICY tenants_update ON tenants FOR UPDATE
  USING (app_is_platform() OR id = app_tenant())
  WITH CHECK (app_is_platform() OR id = app_tenant());
--> statement-breakpoint
CREATE POLICY tenants_delete ON tenants FOR DELETE USING (app_is_platform());
--> statement-breakpoint

-- memberships: a user can read their own memberships (needed at login, before a tenant is chosen).
CREATE POLICY memberships_select ON memberships FOR SELECT USING (
  app_is_platform() OR tenant_id = app_tenant() OR user_id = app_user()
);
--> statement-breakpoint
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY memberships_delete ON memberships FOR DELETE USING (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint

-- partner_approvals: both sides can read; only the approving hauler writes.
CREATE POLICY partner_select ON partner_approvals FOR SELECT USING (
  app_is_platform() OR tenant_id = app_tenant() OR partner_tenant_id = app_tenant()
);
--> statement-breakpoint
CREATE POLICY partner_insert ON partner_approvals FOR INSERT WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY partner_update ON partner_approvals FOR UPDATE
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY partner_delete ON partner_approvals FOR DELETE USING (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint

-- Plain tenant-owned tables.
CREATE POLICY company_settings_tenant ON company_settings FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY customers_tenant ON customers FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint

-- audit_log: tenant-scoped read/insert. Platform-level events have tenant_id NULL.
CREATE POLICY audit_select ON audit_log FOR SELECT USING (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (
  tenant_id IS NOT DISTINCT FROM app_tenant() OR app_is_platform()
);
--> statement-breakpoint

-- Defence in depth: nobody (including the owner) can modify or delete audit rows.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
