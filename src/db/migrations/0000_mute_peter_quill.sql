CREATE TABLE "compliance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"opt_in_status" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_records_opt_in_status_check" CHECK ("compliance_records"."opt_in_status" IN ('opt_in', 'opt_out'))
);
--> statement-breakpoint
CREATE TABLE "handoff_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoff_events_reason_check" CHECK ("handoff_events"."reason" IN ('hot_score', 'frustration', 'out_of_data'))
);
--> statement-breakpoint
CREATE TABLE "import_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"lead_id" uuid,
	CONSTRAINT "import_rows_outcome_check" CHECK ("import_rows"."outcome" IN ('created', 'updated', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"source" text NOT NULL,
	"lifecycle_state" text DEFAULT 'COLD_QUEUED' NOT NULL,
	"opt_in_status" text DEFAULT 'opt_in' NOT NULL,
	"opt_in_at" timestamp with time zone,
	"score" integer DEFAULT 0 NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"segment" text,
	"credit_value" numeric,
	"objective" text,
	"has_lance_reserve" boolean,
	"income" numeric,
	"classification_band" text,
	"assigned_consultant_id" text,
	"last_outbound_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_phone_e164_unique" UNIQUE("phone_e164"),
	CONSTRAINT "leads_lifecycle_state_check" CHECK ("leads"."lifecycle_state" IN ('COLD_QUEUED', 'IN_CADENCE', 'REPLIED', 'QUALIFYING', 'HOT', 'WARM', 'DISQUALIFIED', 'CADENCE_EXHAUSTED', 'MONTHLY_NURTURE', 'OPTED_OUT')),
	CONSTRAINT "leads_opt_in_status_check" CHECK ("leads"."opt_in_status" IN ('opt_in', 'opt_out')),
	CONSTRAINT "leads_objective_check" CHECK ("leads"."objective" IN ('housing', 'investment')),
	CONSTRAINT "leads_classification_band_check" CHECK ("leads"."classification_band" IN ('HOT', 'WARM', 'cold', 'DISQUALIFIED')),
	CONSTRAINT "leads_score_range_check" CHECK ("leads"."score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"content" text NOT NULL,
	"wa_message_id" text,
	"number_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" IN ('inbound', 'outbound'))
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"job_kind" text NOT NULL,
	"touch" text,
	"pgboss_job_id" text NOT NULL,
	"planned_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "scheduled_jobs_job_kind_check" CHECK ("scheduled_jobs"."job_kind" IN ('cadence', 'nurture')),
	CONSTRAINT "scheduled_jobs_touch_check" CHECK ("scheduled_jobs"."touch" IN ('T1', 'T2', 'T3', 'T4', 'T5')),
	CONSTRAINT "scheduled_jobs_status_check" CHECK ("scheduled_jobs"."status" IN ('pending', 'done', 'cancelled', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_name" text NOT NULL,
	"msisdn" text NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"daily_sent" integer DEFAULT 0 NOT NULL,
	"daily_counter_date" date,
	"warmup_start_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_events" ADD CONSTRAINT "handoff_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_report_id_import_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."import_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_number_id_whatsapp_numbers_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."whatsapp_numbers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;