-- Plans are public to read (a company sees what it is on) but only the platform writes them.
GRANT SELECT, INSERT, UPDATE ON subscription_plans TO smartload_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON subscriptions TO smartload_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON subscription_payments TO smartload_app;
--> statement-breakpoint
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscription_plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscription_payments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subscription_plans_read ON subscription_plans FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY subscription_plans_write ON subscription_plans FOR INSERT WITH CHECK (app_is_platform());
--> statement-breakpoint
CREATE POLICY subscription_plans_update ON subscription_plans FOR UPDATE USING (app_is_platform()) WITH CHECK (app_is_platform());
--> statement-breakpoint
-- A company reads its own subscription and payments; only the platform creates or changes them.
CREATE POLICY subscriptions_read ON subscriptions FOR SELECT USING (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY subscriptions_insert ON subscriptions FOR INSERT WITH CHECK (app_is_platform());
--> statement-breakpoint
CREATE POLICY subscriptions_update ON subscriptions FOR UPDATE USING (app_is_platform()) WITH CHECK (app_is_platform());
--> statement-breakpoint
CREATE POLICY subscription_payments_read ON subscription_payments FOR SELECT USING (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY subscription_payments_insert ON subscription_payments FOR INSERT WITH CHECK (app_is_platform());
--> statement-breakpoint
-- Payments are evidence: never edited, never deleted.
CREATE OR REPLACE FUNCTION subscription_payment_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'subscription payments are never edited or deleted';
END
$$;
--> statement-breakpoint
CREATE TRIGGER subscription_payments_guard BEFORE UPDATE OR DELETE ON subscription_payments
  FOR EACH ROW EXECUTE FUNCTION subscription_payment_guard();
