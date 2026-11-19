CREATE TYPE "public"."assignment_status" AS ENUM('active', 'released');--> statement-breakpoint
CREATE TYPE "public"."gps_consent" AS ENUM('granted', 'denied', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."offer_mode" AS ENUM('broadcast_internal', 'direct');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('open', 'accepted', 'declined', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."pod_outcome" AS ENUM('complete', 'partial', 'discrepancy', 'failed');--> statement-breakpoint
CREATE TYPE "public"."pod_status" AS ENUM('pending', 'approved', 'rejected', 'more_info_requested');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('approve', 'reject', 'request_more');--> statement-breakpoint
CREATE TYPE "public"."stop_kind" AS ENUM('pickup', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('created', 'offered', 'assigned', 'started', 'arrived_pickup', 'loaded', 'in_transit', 'arrived_destination', 'pod_submitted', 'delivery_exception', 'ready_for_invoice', 'cancelled');--> statement-breakpoint
CREATE TABLE "epod_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"captured_at" timestamp with time zone,
	"upload_status" text DEFAULT 'stored' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epod_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"stop_id" uuid,
	"version" integer NOT NULL,
	"status" "pod_status" DEFAULT 'pending' NOT NULL,
	"outcome" "pod_outcome" NOT NULL,
	"receiver_name" text NOT NULL,
	"delivered_quantity" integer,
	"discrepancy_notes" text,
	"comments" text,
	"actual_delivery_at" timestamp with time zone NOT NULL,
	"actual_delivery_source" text DEFAULT 'driver_entered' NOT NULL,
	"delivery_verification" text DEFAULT 'unverified' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid NOT NULL,
	"on_behalf_of_user_id" uuid,
	"driver_user_id" uuid NOT NULL,
	"gps_consent" "gps_consent" DEFAULT 'unavailable' NOT NULL,
	"gps_lat" double precision,
	"gps_lng" double precision,
	"gps_accuracy_m" double precision,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pod_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"driver_user_id" uuid NOT NULL,
	"offer_id" uuid,
	"status" "assignment_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"mode" "offer_mode" NOT NULL,
	"target_user_id" uuid,
	"status" "offer_status" DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trip_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"slot_no" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_status_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"from_status" "trip_status",
	"to_status" "trip_status" NOT NULL,
	"actor_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" "stop_kind" NOT NULL,
	"address" text NOT NULL,
	"required_arrival_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"status" "trip_status" DEFAULT 'created' NOT NULL,
	"cargo_description" text NOT NULL,
	"cargo_type" text,
	"weight_kg" integer,
	"quantity" integer,
	"truck_requirement" text,
	"handling_instructions" text,
	"notes" text,
	"contract_rate_centavos" bigint NOT NULL,
	"payout_centavos" bigint NOT NULL,
	"fuel_included" boolean DEFAULT false NOT NULL,
	"toll_included" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "epod_attachments" ADD CONSTRAINT "epod_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epod_attachments" ADD CONSTRAINT "epod_attachments_submission_id_epod_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."epod_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epod_submissions" ADD CONSTRAINT "epod_submissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epod_submissions" ADD CONSTRAINT "epod_submissions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epod_submissions" ADD CONSTRAINT "epod_submissions_stop_id_trip_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."trip_stops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epod_submissions" ADD CONSTRAINT "epod_submissions_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epod_submissions" ADD CONSTRAINT "epod_submissions_on_behalf_of_user_id_users_id_fk" FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epod_submissions" ADD CONSTRAINT "epod_submissions_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_reviews" ADD CONSTRAINT "pod_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_reviews" ADD CONSTRAINT "pod_reviews_submission_id_epod_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."epod_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_reviews" ADD CONSTRAINT "pod_reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_slot_id_trip_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."trip_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_assignments" ADD CONSTRAINT "trip_assignments_offer_id_trip_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."trip_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_offers" ADD CONSTRAINT "trip_offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_offers" ADD CONSTRAINT "trip_offers_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_offers" ADD CONSTRAINT "trip_offers_slot_id_trip_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."trip_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_offers" ADD CONSTRAINT "trip_offers_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_offers" ADD CONSTRAINT "trip_offers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_slots" ADD CONSTRAINT "trip_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_slots" ADD CONSTRAINT "trip_slots_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_status_events" ADD CONSTRAINT "trip_status_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_status_events" ADD CONSTRAINT "trip_status_events_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_status_events" ADD CONSTRAINT "trip_status_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "epod_attachments_submission_idx" ON "epod_attachments" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epod_trip_version_uq" ON "epod_submissions" USING btree ("trip_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "epod_idempotency_uq" ON "epod_submissions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "pod_reviews_submission_idx" ON "pod_reviews" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_assignments_one_active_per_slot" ON "trip_assignments" USING btree ("slot_id") WHERE "trip_assignments"."status" = 'active';--> statement-breakpoint
CREATE INDEX "trip_assignments_driver_idx" ON "trip_assignments" USING btree ("driver_user_id");--> statement-breakpoint
CREATE INDEX "trip_offers_trip_idx" ON "trip_offers" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "trip_offers_target_idx" ON "trip_offers" USING btree ("target_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_slots_trip_no_uq" ON "trip_slots" USING btree ("trip_id","slot_no");--> statement-breakpoint
CREATE INDEX "trip_status_events_trip_idx" ON "trip_status_events" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_stops_trip_seq_uq" ON "trip_stops" USING btree ("trip_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_tenant_reference_uq" ON "trips" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "trips_tenant_status_idx" ON "trips" USING btree ("tenant_id","status");