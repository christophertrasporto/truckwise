CREATE TYPE "public"."subcon_application_status" AS ENUM('new', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "subcon_application_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"scan_status" text DEFAULT 'clean' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subcon_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" "subcon_application_status" DEFAULT 'new' NOT NULL,
	"company_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"address" text,
	"plate_number" text NOT NULL,
	"truck_type" text NOT NULL,
	"truck_size" text NOT NULL,
	"capacity_kg" integer,
	"driver_name" text NOT NULL,
	"license_number" text,
	"license_expiry" date,
	"notes" text,
	"submitted_from_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"partner_tenant_id" uuid
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "apply_token" text;--> statement-breakpoint
ALTER TABLE "subcon_application_files" ADD CONSTRAINT "subcon_application_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcon_application_files" ADD CONSTRAINT "subcon_application_files_application_id_subcon_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."subcon_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcon_applications" ADD CONSTRAINT "subcon_applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcon_applications" ADD CONSTRAINT "subcon_applications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcon_applications" ADD CONSTRAINT "subcon_applications_partner_tenant_id_tenants_id_fk" FOREIGN KEY ("partner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subcon_application_files_kind_uq" ON "subcon_application_files" USING btree ("application_id","kind");--> statement-breakpoint
CREATE INDEX "subcon_applications_tenant_status_idx" ON "subcon_applications" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "subcon_applications_plate_idx" ON "subcon_applications" USING btree ("tenant_id","plate_number");