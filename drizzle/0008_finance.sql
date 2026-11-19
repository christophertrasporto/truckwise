CREATE TYPE "public"."expense_category" AS ENUM('fuel', 'toll', 'parking', 'loading', 'repair', 'other');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('issued', 'paid', 'void');--> statement-breakpoint
CREATE TABLE "document_counters" (
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"year" integer NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "invoice_status" DEFAULT 'issued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"subtotal_centavos" bigint NOT NULL,
	"vat_bps" integer DEFAULT 0 NOT NULL,
	"vat_centavos" bigint DEFAULT 0 NOT NULL,
	"total_centavos" bigint NOT NULL,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"notes" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"paid_at" timestamp with time zone,
	"payment_reference" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "settlement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"partner_tenant_id" uuid NOT NULL,
	"status" "invoice_status" DEFAULT 'issued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"total_centavos" bigint NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"paid_at" timestamp with time zone,
	"payment_reference" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "trip_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"category" "expense_category" NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"incurred_at" timestamp with time zone NOT NULL,
	"note" text,
	"status" "expense_status" DEFAULT 'submitted' NOT NULL,
	"company_bears" boolean DEFAULT false NOT NULL,
	"submitted_by" uuid NOT NULL,
	"paid_by_driver_id" uuid,
	"receipt_key" text,
	"receipt_mime" text,
	"receipt_sha256" text,
	"receipt_bytes" integer,
	"idempotency_key" text NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "vat_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_partner_tenant_id_tenants_id_fk" FOREIGN KEY ("partner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_paid_by_driver_id_users_id_fk" FOREIGN KEY ("paid_by_driver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_counters_pk" ON "document_counters" USING btree ("tenant_id","kind","year");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_one_active_per_trip" ON "invoice_lines" USING btree ("trip_id") WHERE "invoice_lines"."active";--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_number_uq" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_idem_uq" ON "invoices" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_lines_one_active_per_trip" ON "settlement_lines" USING btree ("trip_id") WHERE "settlement_lines"."active";--> statement-breakpoint
CREATE INDEX "settlement_lines_settlement_idx" ON "settlement_lines" USING btree ("settlement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_tenant_number_uq" ON "settlements" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_tenant_idem_uq" ON "settlements" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "settlements_partner_idx" ON "settlements" USING btree ("partner_tenant_id");--> statement-breakpoint
CREATE INDEX "trip_expenses_trip_idx" ON "trip_expenses" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_expenses_idem_uq" ON "trip_expenses" USING btree ("tenant_id","idempotency_key");