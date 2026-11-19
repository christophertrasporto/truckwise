GRANT SELECT, INSERT ON notifications TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (read_at) ON notifications TO smartload_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON notification_deliveries, user_notification_settings TO smartload_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO smartload_app;
--> statement-breakpoint

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_notification_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_notification_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A notification belongs to one person in one company: nobody else, not even an owner of the same company, reads it.
-- The background worker (platform context) creates them for recipients in any company.
CREATE POLICY notifications_own ON notifications FOR ALL
  USING (app_is_platform() OR (tenant_id = app_tenant() AND user_id = app_user()))
  WITH CHECK (app_is_platform());
--> statement-breakpoint
-- Delivery bookkeeping is the worker's alone.
CREATE POLICY notification_deliveries_worker ON notification_deliveries FOR ALL
  USING (app_is_platform()) WITH CHECK (app_is_platform());
--> statement-breakpoint
-- Devices and contact settings belong to the person; the worker needs them to deliver.
CREATE POLICY push_subscriptions_own ON push_subscriptions FOR ALL
  USING (app_is_platform() OR user_id = app_user())
  WITH CHECK (app_is_platform() OR user_id = app_user());
--> statement-breakpoint
CREATE POLICY user_notification_settings_own ON user_notification_settings FOR ALL
  USING (app_is_platform() OR user_id = app_user())
  WITH CHECK (app_is_platform() OR user_id = app_user());
