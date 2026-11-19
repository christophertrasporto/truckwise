GRANT SELECT, INSERT, UPDATE ON trucks, driver_profiles, trip_applications TO smartload_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON trip_offer_targets TO smartload_app;
--> statement-breakpoint

ALTER TABLE trucks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trucks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE driver_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE driver_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_offer_targets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_offer_targets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_applications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_applications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY trucks_tenant ON trucks FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY driver_profiles_tenant ON driver_profiles FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY trip_offer_targets_tenant ON trip_offer_targets FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY trip_applications_tenant ON trip_applications FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Cross-tenant helpers. SECURITY DEFINER so they can see rows RLS hides, but each returns only the
-- minimum needed (ids or a boolean), never row contents. Their use is limited to the partner gateway
-- and scheduling checks.
-- ---------------------------------------------------------------------------------------------

-- Time window a trip occupies: first to last required arrival, at least 8 hours long. NULL if no times were set.
CREATE OR REPLACE FUNCTION trip_window(p_trip uuid) RETURNS tstzrange
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT CASE WHEN min(required_arrival_at) IS NULL THEN NULL
         ELSE tstzrange(min(required_arrival_at),
                        GREATEST(max(required_arrival_at), min(required_arrival_at) + interval '8 hours')) END
  FROM trip_stops WHERE trip_id = p_trip
$$;
--> statement-breakpoint

-- Is this driver already on another live trip whose window overlaps p_window (in ANY company)?
CREATE OR REPLACE FUNCTION driver_has_conflict(p_driver uuid, p_window tstzrange, p_exclude_trip uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT p_window IS NOT NULL AND EXISTS (
    SELECT 1 FROM trip_assignments a JOIN trips t ON t.id = a.trip_id
    WHERE a.driver_user_id = p_driver AND a.status = 'active'
      AND t.id <> p_exclude_trip AND t.status NOT IN ('ready_for_invoice', 'cancelled')
      AND trip_window(t.id) && p_window)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION truck_has_conflict(p_truck uuid, p_window tstzrange, p_exclude_trip uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT p_window IS NOT NULL AND p_truck IS NOT NULL AND EXISTS (
    SELECT 1 FROM trip_assignments a JOIN trips t ON t.id = a.trip_id
    WHERE a.truck_id = p_truck AND a.status = 'active'
      AND t.id <> p_exclude_trip AND t.status NOT IN ('ready_for_invoice', 'cancelled')
      AND trip_window(t.id) && p_window)
$$;
--> statement-breakpoint

-- Companies that have an active job assigned to the calling user (a driver working for a partner) ...
CREATE OR REPLACE FUNCTION my_driver_hauler_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT DISTINCT tenant_id FROM trip_assignments WHERE driver_user_id = app_user() AND status = 'active' $$;
--> statement-breakpoint
-- ... and haulers that have given the calling company (partner) any job.
CREATE OR REPLACE FUNCTION my_partner_hauler_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT DISTINCT tenant_id FROM trip_assignments WHERE assigned_tenant_id = app_tenant() AND tenant_id <> app_tenant() $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trip_window(uuid), driver_has_conflict(uuid, tstzrange, uuid),
  truck_has_conflict(uuid, tstzrange, uuid), my_driver_hauler_ids(), my_partner_hauler_ids() TO smartload_app;
