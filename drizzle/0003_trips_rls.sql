GRANT SELECT, INSERT, UPDATE ON trips, trip_slots, trip_offers, trip_assignments TO smartload_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON trip_stops TO smartload_app;
--> statement-breakpoint
-- Evidence and history tables: append-only for the app role.
GRANT SELECT, INSERT ON trip_status_events, epod_attachments, pod_reviews TO smartload_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE trip_status_events_id_seq TO smartload_app;
--> statement-breakpoint
-- ePOD versions are never deleted and only their review status may change.
GRANT SELECT, INSERT ON epod_submissions TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (status) ON epod_submissions TO smartload_app;
--> statement-breakpoint

ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trips FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_stops ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_stops FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_slots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_slots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_offers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_offers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_assignments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_status_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_status_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE epod_submissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE epod_submissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE epod_attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE epod_attachments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pod_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pod_reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY trips_tenant ON trips FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY trip_stops_tenant ON trip_stops FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY trip_slots_tenant ON trip_slots FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY trip_offers_tenant ON trip_offers FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY trip_assignments_tenant ON trip_assignments FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY trip_status_events_tenant ON trip_status_events FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY epod_submissions_tenant ON epod_submissions FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY epod_attachments_tenant ON epod_attachments FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY pod_reviews_tenant ON pod_reviews FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint

-- Immutability triggers (defence in depth, apply to the table owner too).
CREATE OR REPLACE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
--> statement-breakpoint
CREATE TRIGGER trip_status_events_immutable BEFORE UPDATE OR DELETE ON trip_status_events
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
--> statement-breakpoint
CREATE TRIGGER epod_attachments_immutable BEFORE UPDATE OR DELETE ON epod_attachments
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
--> statement-breakpoint
CREATE TRIGGER pod_reviews_immutable BEFORE UPDATE OR DELETE ON pod_reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
--> statement-breakpoint
-- Submissions: no deletes, and nothing but `status` may change.
CREATE OR REPLACE FUNCTION epod_submissions_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'epod_submissions rows are never deleted';
  END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'epod_submissions evidence is immutable; only status may change';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER epod_submissions_guard BEFORE UPDATE OR DELETE ON epod_submissions
  FOR EACH ROW EXECUTE FUNCTION epod_submissions_guard();
