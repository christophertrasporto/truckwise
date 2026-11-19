CREATE TABLE "epod_attachment_processing" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"scan_detail" text,
	"scanned_at" timestamp with time zone,
	"display_status" text DEFAULT 'pending' NOT NULL,
	"display_key" text,
	"display_bytes" integer,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "epod_trip_version_uq";--> statement-breakpoint
ALTER TABLE "pod_reviews" ALTER COLUMN "reviewer_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "allow_pdf_receipts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "epod_attachments" ADD COLUMN "captured_source" text;--> statement-breakpoint
ALTER TABLE "epod_attachments" ADD COLUMN "kind" text DEFAULT 'photo' NOT NULL;--> statement-breakpoint
ALTER TABLE "epod_submissions" ADD COLUMN "submitted_offline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "epod_submissions" ADD COLUMN "device_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pod_reviews" ADD COLUMN "automatic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "epod_attachment_processing" ADD CONSTRAINT "epod_attachment_processing_attachment_id_epod_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."epod_attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epod_attachment_processing" ADD CONSTRAINT "epod_attachment_processing_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "epod_stop_version_uq" ON "epod_submissions" USING btree ("stop_id","version");--> statement-breakpoint
CREATE INDEX "epod_trip_idx" ON "epod_submissions" USING btree ("trip_id");