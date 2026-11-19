GRANT SELECT, INSERT ON subcon_application_trucks TO smartload_app;
--> statement-breakpoint
ALTER TABLE subcon_application_trucks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subcon_application_trucks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subcon_application_trucks_tenant ON subcon_application_trucks FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
-- Truck details are fixed once submitted, like the rest of the application.
CREATE OR REPLACE FUNCTION subcon_application_truck_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'application trucks are never edited or deleted';
END
$$;
--> statement-breakpoint
CREATE TRIGGER subcon_application_trucks_guard BEFORE UPDATE OR DELETE ON subcon_application_trucks
  FOR EACH ROW EXECUTE FUNCTION subcon_application_truck_guard();
