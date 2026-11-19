GRANT SELECT, INSERT, UPDATE ON customer_document_types TO smartload_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON trip_documents, trip_document_files TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (waived_at, waived_by, waive_reason, removed_at) ON trip_documents TO smartload_app;
--> statement-breakpoint
GRANT UPDATE (status, reviewed_by, reviewed_at, review_note) ON trip_document_files TO smartload_app;
--> statement-breakpoint
ALTER TABLE customer_document_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE customer_document_types FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_document_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trip_document_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY customer_document_types_tenant ON customer_document_types FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant()) WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY trip_documents_tenant ON trip_documents FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant()) WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
CREATE POLICY trip_document_files_tenant ON trip_document_files FOR ALL
  USING (app_is_platform() OR tenant_id = app_tenant()) WITH CHECK (app_is_platform() OR tenant_id = app_tenant());
--> statement-breakpoint
-- Evidence: only the review fields of a file, and only the waive/remove fields of a checklist item, ever change.
CREATE OR REPLACE FUNCTION trip_document_file_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  mutable text[] := ARRAY['status','reviewed_by','reviewed_at','review_note'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trip document files are never deleted';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'an uploaded document cannot be edited; upload a new version';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER trip_document_files_guard BEFORE UPDATE OR DELETE ON trip_document_files
  FOR EACH ROW EXECUTE FUNCTION trip_document_file_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trip_document_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  mutable text[] := ARRAY['waived_at','waived_by','waive_reason','removed_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trip documents are never deleted';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'a checklist item cannot be edited; remove it and add a new one';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER trip_documents_guard BEFORE UPDATE OR DELETE ON trip_documents
  FOR EACH ROW EXECUTE FUNCTION trip_document_guard();
