CREATE TYPE "public"."application_status" AS ENUM('pending', 'approved', 'declined', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."offer_audience" AS ENUM('internal', 'partners', 'all');--> statement-breakpoint
CREATE TYPE "public"."truck_status" AS ENUM('active', 'maintenance', 'retired');--> statement-breakpoint
ALTER TYPE "public"."offer_mode" ADD VALUE 'broadcast_partners';--> statement-breakpoint
ALTER TYPE "public"."offer_mode" ADD VALUE 'broadcast_all';--> statement-breakpoint
ALTER TYPE "public"."offer_mode" ADD VALUE 'selected';--> statement-breakpoint
ALTER TYPE "public"."offer_mode" ADD VALUE 'applicants';--> statement-breakpoint
CREATE TABLE "driver_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"license_number" text,
	"license_expiry" date,
	"phone" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"applicant_user_id" uuid NOT NULL,
	"applicant_tenant_id" uuid NOT NULL,
	"truck_id" uuid,
	"driver_user_id" uuid NOT NULL,
	"truck_plate" text,
	"driver_name" text,
	"status" "application_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_offer_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trucks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plate" text NOT NULL,
	"truck_type" text NOT NULL,
	"capacity_kg" integer NOT NULL,
	"registration_expiry" date,
	"inspection_expiry" date,
	"status" "truck_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD COLUMN "assigned_tenant_id" uuid;--> statement-breakpoint
UPDATE "trip_assignments" SET "assigned_tenant_id" = "tenant_id";--> statement-breakpoint
ALTER TABLE "trip_assignments" ALTER COLUMN "assigned_tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD COLUMN "truck_id" uuid;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD COLUMN "truck_plate" text;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD COLUMN "driver_name" text;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD COLUMN "released_by" uuid;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD COLUMN "released_reason" text;--> statement-breakpoint
ALTER TABLE "trip_offers" ADD COLUMN "target_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "trip_offers" ADD COLUMN "audience" "offer_audience";--> statement-breakpoint
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_applications" ADD CONSTRAINT "trip_applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_applications" ADD CONSTRAINT "trip_applications_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_applications" ADD CONSTRAINT "trip_applications_slot_id_trip_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."trip_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_applications" ADD CONSTRAINT "trip_applications_offer_id_trip_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."trip_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_applications" ADD CONSTRAINT "trip_applications_applicant_user_id_users_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_applications" ADD CONSTRAINT "trip_applications_applicant_tenant_id_tenants_id_fk" FOREIGN KEY ("applicant_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_applications" ADD CONSTRAINT "trip_applications_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_applications" ADD CONSTRAINT "trip_applications_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_offer_targets" ADD CONSTRAINT "trip_offer_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_offer_targets" ADD CONSTRAINT "trip_offer_targets_offer_id_trip_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."trip_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_offer_targets" ADD CONSTRAINT "trip_offer_targets_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "driver_profiles_tenant_user_uq" ON "driver_profiles" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_applications_one_pending" ON "trip_applications" USING btree ("slot_id","applicant_user_id") WHERE "trip_applications"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "trip_applications_trip_idx" ON "trip_applications" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_offer_targets_uq" ON "trip_offer_targets" USING btree ("offer_id","target_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trucks_tenant_plate_uq" ON "trucks" USING btree ("tenant_id","plate");--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_assigned_tenant_id_tenants_id_fk" FOREIGN KEY ("assigned_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_offers" ADD CONSTRAINT "trip_offers_target_tenant_id_tenants_id_fk" FOREIGN KEY ("target_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;