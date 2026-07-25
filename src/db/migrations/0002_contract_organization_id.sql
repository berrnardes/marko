ALTER TABLE "leads" DROP CONSTRAINT "leads_phone_e164_unique";--> statement-breakpoint
ALTER TABLE "compliance_records" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "handoff_events" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "import_reports" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
-- drizzle-kit cannot resolve an existing primary key's name, so it emitted a
-- placeholder here. Migration 0000 declared the key inline
-- (`"template_key" text PRIMARY KEY NOT NULL`), which PostgreSQL auto-names
-- `<table>_pkey` — dropped here and re-added below as the composite key.
ALTER TABLE "message_templates" DROP CONSTRAINT "message_templates_pkey";--> statement-breakpoint
ALTER TABLE "message_templates" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_pkey" PRIMARY KEY("organization_id","template_key");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_phone_e164_unique" UNIQUE("organization_id","phone_e164");--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_session_name_unique" UNIQUE("session_name");