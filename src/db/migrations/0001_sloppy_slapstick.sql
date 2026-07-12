ALTER TABLE "member" ADD COLUMN "receives_handoff_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "phone_verified_at" timestamp;