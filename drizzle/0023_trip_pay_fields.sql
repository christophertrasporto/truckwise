ALTER TABLE "trips" ADD COLUMN "subcontractor_payout_centavos" bigint;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "helper_pay_centavos" bigint DEFAULT 0 NOT NULL;