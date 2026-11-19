CREATE TYPE "public"."document_uploader" AS ENUM('driver', 'dispatcher', 'either');--> statement-breakpoint
CREATE TABLE "customer_document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instructions" text,
	"required" boolean DEFAULT true NOT NULL,
	"uploader" "document_uploader" DEFAULT 'either' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_document_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text
);
--> statement-breakpoint
CREATE TABLE "trip_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"source_type_id" uuid,
	"name" text NOT NULL,
	"instructions" text,
	"required" boolean DEFAULT true NOT NULL,
	"uploader" "document_uploader" DEFAULT 'either' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"waived_at" timestamp with time zone,
	"waived_by" uuid,
	"waive_reason" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_document_types" ADD CONSTRAINT "customer_document_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_document_types" ADD CONSTRAINT "customer_document_types_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_document_files" ADD CONSTRAINT "trip_document_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_document_files" ADD CONSTRAINT "trip_document_files_document_id_trip_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."trip_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_document_files" ADD CONSTRAINT "trip_document_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_document_files" ADD CONSTRAINT "trip_document_files_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_documents" ADD CONSTRAINT "trip_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_documents" ADD CONSTRAINT "trip_documents_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_documents" ADD CONSTRAINT "trip_documents_source_type_id_customer_document_types_id_fk" FOREIGN KEY ("source_type_id") REFERENCES "public"."customer_document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_documents" ADD CONSTRAINT "trip_documents_waived_by_users_id_fk" FOREIGN KEY ("waived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_document_types_customer_idx" ON "customer_document_types" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_document_files_version_uq" ON "trip_document_files" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "trip_documents_trip_idx" ON "trip_documents" USING btree ("tenant_id","trip_id");