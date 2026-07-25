ALTER TABLE "compliance_records" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "handoff_events" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "import_reports" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "message_templates" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_events" ADD CONSTRAINT "handoff_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_reports" ADD CONSTRAINT "import_reports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_records_organization_id_idx" ON "compliance_records" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "handoff_events_organization_id_idx" ON "handoff_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "import_reports_organization_id_idx" ON "import_reports" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "import_rows_organization_id_idx" ON "import_rows" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "leads_organization_id_idx" ON "leads" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "messages_organization_id_idx" ON "messages" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_organization_id_idx" ON "scheduled_jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "whatsapp_numbers_organization_id_idx" ON "whatsapp_numbers" USING btree ("organization_id");