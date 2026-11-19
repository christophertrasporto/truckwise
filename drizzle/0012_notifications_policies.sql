-- Replace the single FOR ALL policy: people may read and mark-as-read their OWN notifications, but only the
-- background worker (platform context) may create them. (WITH CHECK on a FOR ALL policy also blocked mark-as-read.)
DROP POLICY notifications_own ON notifications;
--> statement-breakpoint
CREATE POLICY notifications_select ON notifications FOR SELECT
  USING (app_is_platform() OR (tenant_id = app_tenant() AND user_id = app_user()));
--> statement-breakpoint
CREATE POLICY notifications_insert ON notifications FOR INSERT WITH CHECK (app_is_platform());
--> statement-breakpoint
CREATE POLICY notifications_update ON notifications FOR UPDATE
  USING (app_is_platform() OR (tenant_id = app_tenant() AND user_id = app_user()))
  WITH CHECK (app_is_platform() OR (tenant_id = app_tenant() AND user_id = app_user()));
