CREATE TABLE "subcon_application_trucks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"plate_number" text NOT NULL,
	"truck_type" text NOT NULL,
	"truck_size" text NOT NULL,
	"capacity_kg" integer,
	"driver_name" text NOT NULL,
	"license_number" text,
	"license_expiry" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "subcon_application_files_kind_uq";--> statement-breakpoint
ALTER TABLE "subcon_application_files" ADD COLUMN "truck_id" uuid;--> statement-breakpoint
ALTER TABLE "subcon_application_trucks" ADD CONSTRAINT "subcon_application_trucks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcon_application_trucks" ADD CONSTRAINT "subcon_application_trucks_application_id_subcon_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."subcon_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subcon_application_trucks_plate_uq" ON "subcon_application_trucks" USING btree ("application_id","plate_number");--> statement-breakpoint
ALTER TABLE "subcon_application_files" ADD CONSTRAINT "subcon_application_files_truck_id_subcon_application_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."subcon_application_trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subcon_application_files_kind_uq" ON "subcon_application_files" USING btree ("application_id",coalesce("truck_id", '00000000-0000-0000-0000-000000000000'::uuid),"kind");