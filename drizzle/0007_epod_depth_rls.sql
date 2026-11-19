GRANT SELECT, INSERT, UPDATE ON epod_attachment_processing, jobs TO smartload_app;
--> statement-breakpoint

ALTER TABLE epod_attachment_processing ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE epod_attachment_processing FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY epod_attachment_processing_tenant ON epod_attachment_processing FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
-- Jobs are enqueued from a company context and run by the worker in a platform context.
CREATE POLICY jobs_tenant ON jobs FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
