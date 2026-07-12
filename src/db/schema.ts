// Drizzle schema (PostgreSQL, default schema).
//
// Declares the application tables for the WhatsApp lead-reactivation agent and
// CRM, plus their CHECK constraints. Column shapes and enum-constrained values
// mirror the core domain types in `@/core/types` (and `ClassificationBand` from
// `@/core/classify`) exactly, so the Drizzle-backed repositories (task 9.2) can
// be implemented against `LeadRepository`, `MessageRepository`,
// `ScheduledJobRepository`, `NumberRepository`, and `ComplianceRepository`
// without re-deriving the field shapes. Requirements references appear inline.
//
// Schema ownership (deliberately NOT declared here):
//   - Better Auth owns its own tables (`user`, `session`, `account`,
//     `verification`) and manages their migrations through its CLI; they are
//     intentionally absent from this file (Req 21).
//   - pg-boss owns its queue tables, which it creates and migrates inside a
//     dedicated `pgboss` schema at runtime; they are likewise not declared
//     here. The `scheduled_jobs` table below is only an application-side mirror
//     of pg-boss job ids (so a lead's pending jobs can be listed/cancelled by
//     lead id, Req 3.4, 7.2) — it is not the pg-boss queue itself.

import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	date,
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import type {
	ClassificationBand,
	HandoffReason,
	LifecycleState,
	Objective,
	OptInStatus,
	TemplateKey,
	Touch,
} from "@/core/types";

// ---------------------------------------------------------------------------
// Enum value tuples
// ---------------------------------------------------------------------------
//
// Each tuple is the source of truth for the corresponding column's CHECK
// constraint. The `satisfies` clauses tie the tuples to the core union types so
// a typo or a value that drifts from the domain types fails to compile; the
// derived `(typeof tuple)[number]` types are reused as the columns' `$type`, so
// the inferred row types match the domain exactly.

/** All {@link LifecycleState} values — constrains `leads.lifecycle_state` (Req 14.1, 19.1). */
export const lifecycleStates = [
	"COLD_QUEUED",
	"IN_CADENCE",
	"REPLIED",
	"QUALIFYING",
	"HOT",
	"WARM",
	"DISQUALIFIED",
	"CADENCE_EXHAUSTED",
	"MONTHLY_NURTURE",
	"OPTED_OUT",
] as const satisfies readonly LifecycleState[];

/** All {@link OptInStatus} values — constrains `leads.opt_in_status` and `compliance_records.opt_in_status` (Req 15). */
export const optInStatuses = [
	"opt_in",
	"opt_out",
] as const satisfies readonly OptInStatus[];

/** All {@link Objective} values — constrains the nullable `leads.objective` (Req 9, 19.2). */
export const objectives = [
	"housing",
	"investment",
] as const satisfies readonly Objective[];

/** All {@link ClassificationBand} values — constrains the nullable `leads.classification_band` (Req 12). */
export const classificationBands = [
	"HOT",
	"WARM",
	"cold",
	"DISQUALIFIED",
] as const satisfies readonly ClassificationBand[];

/** All {@link Touch} values — constrains the nullable `scheduled_jobs.touch` (Req 3). */
export const touches = [
	"T1",
	"T2",
	"T3",
	"T4",
	"T5",
] as const satisfies readonly Touch[];

/** All {@link TemplateKey} values — constrains `message_templates.template_key`. */
export const templateKeys = [
	"T1",
	"T2",
	"T3",
	"T4",
	"T5",
	"nurture",
] as const satisfies readonly TemplateKey[];

/** Persisted message direction — constrains `messages.direction` (Req 19.3). */
export const messageDirections = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof messageDirections)[number];

/** Kind of a scheduled-job mirror row — constrains `scheduled_jobs.job_kind` (Req 3.4, 6.3). */
export const jobKinds = ["cadence", "nurture"] as const;
export type JobKind = (typeof jobKinds)[number];

/** Lifecycle status of a scheduled-job mirror row — constrains `scheduled_jobs.status`. */
export const scheduledJobStatuses = [
	"pending",
	"done",
	"cancelled",
	"skipped",
] as const;
export type ScheduledJobStatus = (typeof scheduledJobStatuses)[number];

/** Handoff trigger reason — constrains `handoff_events.reason` (Req 13). */
export const handoffReasons = [
	"replied",
	"hot_score",
	"frustration",
	"out_of_data",
] as const satisfies readonly HandoffReason[];
export type { HandoffReason };

/** Per-row import outcome — constrains `import_rows.outcome` (Req 1.3, 1.6). */
export const importOutcomes = ["created", "updated", "rejected"] as const;
export type ImportOutcome = (typeof importOutcomes)[number];

// ---------------------------------------------------------------------------
// CHECK constraint helpers
// ---------------------------------------------------------------------------

/**
 * Build an `IN (...)` CHECK constraint restricting `column` to `values`. The
 * values are trusted internal enum literals (no embedded quotes), so they are
 * inlined as single-quoted SQL literals via {@link sql.raw}. A `NULL` column
 * value satisfies the constraint (`NULL IN (...)` is unknown, not false), so
 * this helper is reused for both NOT NULL and nullable enum columns.
 */
function enumCheck(
	name: string,
	column: AnyPgColumn,
	values: readonly string[],
): ReturnType<typeof check> {
	const list = sql.raw(values.map((value) => `'${value}'`).join(", "));
	return check(name, sql`${column} IN (${list})`);
}

/** Build a `column BETWEEN lo AND hi` CHECK constraint. */
function rangeCheck(
	name: string,
	column: AnyPgColumn,
	lo: number,
	hi: number,
): ReturnType<typeof check> {
	return check(
		name,
		sql`${column} BETWEEN ${sql.raw(String(lo))} AND ${sql.raw(String(hi))}`,
	);
}

// ---------------------------------------------------------------------------
// leads
// ---------------------------------------------------------------------------

/**
 * The central Lead record (Req 19.1, 19.2). `phone_e164` is the deduplication
 * key and is UNIQUE so duplicate imports/inbound collapse onto one row at the
 * database level as well as in the importer (Req 1.4, 2.2). Qualification
 * fields are all nullable so they fill progressively across messages (Req 9.4,
 * 19.2). `lifecycle_state` and `opt_in_status` are CHECK-constrained to their
 * enum values (Req 14.1, 19.1, 15); `score` is constrained to 0–100 (Req 10).
 */
export const leads = pgTable(
	"leads",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** Normalized E.164 phone number; the unique dedup key (Req 1.4, 2.2). */
		phoneE164: text("phone_e164").notNull().unique(),
		/** Originating source recorded on the lead (Req 2.1). */
		source: text("source").notNull(),
		lifecycleState: text("lifecycle_state")
			.$type<LifecycleState>()
			.notNull()
			.default("COLD_QUEUED"),
		optInStatus: text("opt_in_status")
			.$type<OptInStatus>()
			.notNull()
			.default("opt_in"),
		/** Timestamp of the current lawful-basis value, when known (Req 15.4). */
		optInAt: timestamp("opt_in_at", { withTimezone: true }),
		/** Qualification score in the inclusive range 0–100 (Req 10). */
		score: integer("score").notNull().default(0),
		/** Per-lead block flag re-checked by the send guard (Req 5.3, 18). */
		blocked: boolean("blocked").notNull().default(false),
		/**
		 * Set when WAHA confirmed the number does not exist on WhatsApp at send
		 * time; the send guard treats a non-null value as a stop condition so no
		 * further automated outreach is attempted.
		 */
		unreachableAt: timestamp("unreachable_at", { withTimezone: true }),
		// Progressively-collected qualification fields, all nullable (Req 9.4, 19.2).
		segment: text("segment"),
		creditValue: numeric("credit_value", { mode: "number" }),
		objective: text("objective").$type<Objective>(),
		hasLanceReserve: boolean("has_lance_reserve"),
		income: numeric("income", { mode: "number" }),
		/** Current score-band label, when classified (Req 12). */
		classificationBand: text("classification_band").$type<ClassificationBand>(),
		/** Consultant the lead is assigned to after handoff, when any (Req 13). */
		assignedConsultantId: text("assigned_consultant_id"),
		lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
		lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		enumCheck(
			"leads_lifecycle_state_check",
			table.lifecycleState,
			lifecycleStates,
		),
		enumCheck("leads_opt_in_status_check", table.optInStatus, optInStatuses),
		enumCheck("leads_objective_check", table.objective, objectives),
		enumCheck(
			"leads_classification_band_check",
			table.classificationBand,
			classificationBands,
		),
		rangeCheck("leads_score_range_check", table.score, 0, 100),
	],
);

// ---------------------------------------------------------------------------
// whatsapp_numbers
// ---------------------------------------------------------------------------

/**
 * Per-number anti-ban state: the block flag (Req 18), the daily counter and the
 * date it applies to (Req 16), and the warm-up start date driving the ramp
 * (Req 16.3).
 */
export const whatsappNumbers = pgTable("whatsapp_numbers", {
	id: uuid("id").primaryKey().defaultRandom(),
	sessionName: text("session_name").notNull(),
	msisdn: text("msisdn").notNull(),
	blocked: boolean("blocked").notNull().default(false),
	dailySent: integer("daily_sent").notNull().default(0),
	/** Date the `daily_sent` counter applies to; reset on day change (Req 16). */
	dailyCounterDate: date("daily_counter_date"),
	/** Date the warm-up ramp started, for the day-in-ramp calculation (Req 16.3). */
	warmupStartDate: date("warmup_start_date"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/**
 * Full inbound/outbound message history for a lead (Req 19.3). `wa_message_id`
 * carries the WAHA message id used for at-least-once inbound idempotency;
 * `number_id` records the sending WhatsApp number for outbound messages.
 */
export const messages = pgTable(
	"messages",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		leadId: uuid("lead_id")
			.notNull()
			.references(() => leads.id),
		direction: text("direction").$type<MessageDirection>().notNull(),
		content: text("content").notNull(),
		waMessageId: text("wa_message_id"),
		numberId: uuid("number_id").references(() => whatsappNumbers.id),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		enumCheck("messages_direction_check", table.direction, messageDirections),
	],
);

// ---------------------------------------------------------------------------
// scheduled_jobs
// ---------------------------------------------------------------------------

/**
 * Application-side mirror of pg-boss jobs, so a lead's pending cadence touches
 * and nurture jobs can be listed and cancelled by lead id (Req 3.4, 7.2). The
 * actual queue lives in pg-boss's own `pgboss` schema; `pgboss_job_id` links
 * back to it.
 */
export const scheduledJobs = pgTable(
	"scheduled_jobs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		leadId: uuid("lead_id")
			.notNull()
			.references(() => leads.id),
		jobKind: text("job_kind").$type<JobKind>().notNull(),
		/** Present for cadence touch jobs (T1–T5); null for nurture jobs (Req 3). */
		touch: text("touch").$type<Touch>(),
		pgbossJobId: text("pgboss_job_id").notNull(),
		plannedFor: timestamp("planned_for", { withTimezone: true }).notNull(),
		status: text("status")
			.$type<ScheduledJobStatus>()
			.notNull()
			.default("pending"),
	},
	(table) => [
		enumCheck("scheduled_jobs_job_kind_check", table.jobKind, jobKinds),
		enumCheck("scheduled_jobs_touch_check", table.touch, touches),
		enumCheck(
			"scheduled_jobs_status_check",
			table.status,
			scheduledJobStatuses,
		),
	],
);

// ---------------------------------------------------------------------------
// handoff_events
// ---------------------------------------------------------------------------

/** Audit log of handoffs to a human consultant and their trigger reason (Req 13). */
export const handoffEvents = pgTable(
	"handoff_events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		leadId: uuid("lead_id")
			.notNull()
			.references(() => leads.id),
		reason: text("reason").$type<HandoffReason>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		enumCheck("handoff_events_reason_check", table.reason, handoffReasons),
	],
);

// ---------------------------------------------------------------------------
// compliance_records
// ---------------------------------------------------------------------------

/**
 * Append-only lawful-basis log (Req 15.4). Each row records the opt-in status
 * at a point in time; the current value is also denormalized onto
 * `leads.opt_in_status` / `leads.opt_in_at`.
 */
export const complianceRecords = pgTable(
	"compliance_records",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		leadId: uuid("lead_id")
			.notNull()
			.references(() => leads.id),
		optInStatus: text("opt_in_status").$type<OptInStatus>().notNull(),
		recordedAt: timestamp("recorded_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		enumCheck(
			"compliance_records_opt_in_status_check",
			table.optInStatus,
			optInStatuses,
		),
	],
);

// ---------------------------------------------------------------------------
// import_reports
// ---------------------------------------------------------------------------

/** Summary of a single lead-import run (Req 1.6). */
export const importReports = pgTable("import_reports", {
	id: uuid("id").primaryKey().defaultRandom(),
	createdCount: integer("created_count").notNull().default(0),
	updatedCount: integer("updated_count").notNull().default(0),
	rejectedCount: integer("rejected_count").notNull().default(0),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

// ---------------------------------------------------------------------------
// import_rows
// ---------------------------------------------------------------------------

/**
 * Per-row outcome of an import run (Req 1.3, 1.6). `lead_id` references the
 * created/matched lead for `created`/`updated` outcomes and is null for
 * `rejected` rows; it is intentionally not a foreign key so a rejected row's
 * report survives even when no lead exists.
 */
export const importRows = pgTable(
	"import_rows",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		reportId: uuid("report_id")
			.notNull()
			.references(() => importReports.id),
		rowNumber: integer("row_number").notNull(),
		outcome: text("outcome").$type<ImportOutcome>().notNull(),
		reason: text("reason"),
		leadId: uuid("lead_id"),
	},
	(table) => [
		enumCheck("import_rows_outcome_check", table.outcome, importOutcomes),
	],
);

// ---------------------------------------------------------------------------
// message_templates
// ---------------------------------------------------------------------------

/**
 * Operator-editable cadence/nurture message templates. One row per
 * {@link TemplateKey}; a missing row means the built-in default template is
 * used (so a fresh database needs no seed, and "reset to default" deletes the
 * row). `body` carries the template text with `{placeholder}` variables.
 */
export const messageTemplates = pgTable(
	"message_templates",
	{
		templateKey: text("template_key").$type<TemplateKey>().primaryKey(),
		body: text("body").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		enumCheck(
			"message_templates_template_key_check",
			table.templateKey,
			templateKeys,
		),
	],
);

// ---------------------------------------------------------------------------
// phone_verifications
// ---------------------------------------------------------------------------

/**
 * Pending consultant phone verification: the hashed 6-digit code sent by
 * WhatsApp to the phone being claimed, with its expiry and a wrong-guess
 * counter. One row per user (`user_id` is the primary key, so starting a new
 * verification replaces any pending one). On a successful confirm the row is
 * deleted and `user.phone_verified_at` is stamped — only a verified phone ever
 * receives handoff alerts.
 *
 * `user_id` references Better Auth's `user` table by convention (no FK — like
 * `leads.assigned_consultant_id`, domain tables do not declare constraints
 * into the auth schema).
 */
export const phoneVerifications = pgTable("phone_verifications", {
	userId: text("user_id").primaryKey(),
	/** The E.164 phone this code was sent to; must still match at confirm time. */
	phoneE164: text("phone_e164").notNull(),
	/** SHA-256 hex of the 6-digit code (never stored in the clear). */
	codeHash: text("code_hash").notNull(),
	attempts: integer("attempts").notNull().default(0),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});
