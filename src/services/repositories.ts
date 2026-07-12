// Repository interfaces (I/O boundaries).
//
// These interfaces describe the persistence boundary the domain services depend
// on. They are method signatures only — no implementations, no SQL — returning
// Promises. The Drizzle-backed implementations are added in a later task (9.2).
// Shapes are derived from the design's Components/Interfaces and Data Models
// sections so the services can be written against the interface before the data
// layer exists.

import type {
	ClassificationBand,
	HandoffReason,
	LeadSnapshot,
	LifecycleState,
	OptInStatus,
	QualificationFields,
	TemplateKey,
	Touch,
} from "@/core/types";

// ---------------------------------------------------------------------------
// Shared record/value shapes used at the repository boundary
// ---------------------------------------------------------------------------

/** Direction of a persisted message in a Lead's history (Req 19.3). */
export type MessageDirection = "inbound" | "outbound";

/** Kind of a persisted, cancellable scheduled job (Req 3.4, 6.3, 7.2). */
export type JobKind = "cadence" | "nurture";

/** Lifecycle status of a persisted scheduled job mirror row. */
export type ScheduledJobStatus = "pending" | "done" | "cancelled" | "skipped";

/** The fields needed to create a new Lead from any source (Req 2.2). */
export interface NewLeadInput {
	phoneE164: string;
	source: string;
	/** Optional lead name, when the source carries one (e.g. a CSV name column). */
	displayName?: string | null;
}

/** A persisted message record in a Lead's history (Req 19.3). */
export interface MessageRecord {
	id: string;
	leadId: string;
	direction: MessageDirection;
	content: string;
	/** WAHA message id; used for inbound idempotency by `wa_message_id`. */
	waMessageId: string | null;
	/** Sending WhatsApp number, for outbound messages. */
	numberId: string | null;
	createdAt: Date;
}

/** Input for appending a message to a Lead's history. */
export interface NewMessageInput {
	leadId: string;
	direction: MessageDirection;
	content: string;
	waMessageId?: string | null;
	numberId?: string | null;
	createdAt: Date;
}

/** A persisted scheduled-job mirror row (mirrors the pg-boss job id). */
export interface ScheduledJobRecord {
	id: string;
	leadId: string;
	jobKind: JobKind;
	/** Present for cadence touch jobs (T1–T5); null for nurture jobs. */
	touch: Touch | null;
	pgbossJobId: string;
	plannedFor: Date;
	status: ScheduledJobStatus;
}

/** Input for recording a scheduled-job mirror row. */
export interface NewScheduledJobInput {
	leadId: string;
	jobKind: JobKind;
	touch?: Touch | null;
	pgbossJobId: string;
	plannedFor: Date;
}

/** Per-number anti-ban state as persisted (Req 16, 18). */
export interface NumberRecord {
	id: string;
	sessionName: string;
	msisdn: string;
	blocked: boolean;
	dailySent: number;
	/** Date the `dailySent` counter applies to (reset on day change). */
	dailyCounterDate: Date;
	warmupStartDate: Date;
}

/** An append-only lawful-basis compliance record (Req 15.4). */
export interface ComplianceRecord {
	id: string;
	leadId: string;
	optInStatus: OptInStatus;
	recordedAt: Date;
}

/** A persisted handoff event recording a transfer to a consultant (Req 13.2). */
export interface HandoffRecord {
	id: string;
	leadId: string;
	/** The trigger that caused the handoff (Req 13.1, 13.2). */
	reason: HandoffReason;
	createdAt: Date;
}

/**
 * A patch of qualification fields to persist progressively. Omitting a key
 * leaves the stored value untouched; passing an explicit value sets it
 * (Req 9.4, 9.5).
 */
export type QualificationFieldsPatch = Partial<QualificationFields>;

// ---------------------------------------------------------------------------
// LeadRepository
// ---------------------------------------------------------------------------

/**
 * Persistence boundary for Leads. Used by the importer (lookup by normalized
 * phone, create/update), the inbound handler (attribute by number, create on
 * unknown sender), the qualification agent (progressive field writes), and the
 * scoring/classification path (Req 1, 2, 7, 9, 11, 12, 19).
 */
export interface LeadRepository {
	/** Read a full snapshot by lead id, or null when absent. */
	findById(leadId: string): Promise<LeadSnapshot | null>;
	/** Look up a Lead by its normalized E.164 number (Req 1.4, 7.1). */
	findByPhone(phoneE164: string): Promise<LeadSnapshot | null>;
	/** Create a new Lead in `COLD_QUEUED` recording its source (Req 1.5, 2.1). */
	create(input: NewLeadInput): Promise<LeadSnapshot>;
	/** Progressively persist extracted qualification fields (Req 9.5). */
	updateQualification(
		leadId: string,
		patch: QualificationFieldsPatch,
	): Promise<LeadSnapshot>;
	/** Persist a recomputed score and its band (Req 11.1, 12, 19.4). */
	updateScore(
		leadId: string,
		score: number,
		band: ClassificationBand,
	): Promise<LeadSnapshot>;
	/**
	 * Compare-and-set the lifecycle state for optimistic concurrency: applies
	 * the new state only when the current state still equals `expectedFrom`
	 * (Req 14.1, 19.4). Returns the updated snapshot on success, or null when
	 * the precondition no longer holds.
	 */
	updateLifecycleState(
		leadId: string,
		expectedFrom: LifecycleState,
		to: LifecycleState,
	): Promise<LeadSnapshot | null>;
	/** Set the lawful-basis flag and its timestamp (Req 15.1, 15.4). */
	setOptInStatus(leadId: string, status: OptInStatus, at: Date): Promise<void>;
	/** Set or clear the per-lead block flag (Req 5.3). */
	setBlocked(leadId: string, blocked: boolean): Promise<void>;
	/**
	 * Mark the lead unreachable on WhatsApp: WAHA confirmed its number does not
	 * exist at send time, so automated outreach stops (the send guard treats
	 * `unreachableAt != null` as a stop condition).
	 */
	markUnreachable(leadId: string, at: Date): Promise<void>;
	/** Assign the lead to a consultant on handoff (Req 13). */
	assignConsultant(leadId: string, consultantId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// MessageRepository
// ---------------------------------------------------------------------------

/**
 * Persistence boundary for the message history of a Lead (Req 7.4, 19.3).
 * Supports inbound idempotency lookups by `wa_message_id`.
 */
export interface MessageRepository {
	/** Append a message to a Lead's history. */
	append(input: NewMessageInput): Promise<MessageRecord>;
	/** Read a Lead's messages in chronological order. */
	listByLead(leadId: string): Promise<MessageRecord[]>;
	/** Find a message by its WAHA id, for at-least-once idempotency. */
	findByWaMessageId(waMessageId: string): Promise<MessageRecord | null>;
}

// ---------------------------------------------------------------------------
// ScheduledJobRepository
// ---------------------------------------------------------------------------

/**
 * Persistence boundary mirroring pg-boss jobs so a Lead's pending cadence and
 * nurture jobs can be listed and cancelled by lead id (Req 3.4, 6.3, 7.2).
 */
export interface ScheduledJobRepository {
	/** Record a scheduled-job mirror row. */
	create(input: NewScheduledJobInput): Promise<ScheduledJobRecord>;
	/** List a Lead's jobs filtered to a status (e.g. `pending`). */
	listByLead(
		leadId: string,
		status?: ScheduledJobStatus,
	): Promise<ScheduledJobRecord[]>;
	/** Mark a single job row with a new status. */
	updateStatus(jobId: string, status: ScheduledJobStatus): Promise<void>;
	/**
	 * Mark all of a Lead's pending jobs cancelled; returns the count cancelled
	 * (Req 5.2, 7.2, 15.2).
	 */
	cancelAllForLead(leadId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// NumberRepository
// ---------------------------------------------------------------------------

/**
 * Persistence boundary for per-number anti-ban state: the block flag, the daily
 * counter and its date, and the warm-up start date (Req 16, 18).
 */
export interface NumberRepository {
	findById(numberId: string): Promise<NumberRecord | null>;
	/** List ALL numbers regardless of block status (for CRM management). */
	listAll(): Promise<NumberRecord[]>;
	/** List numbers that are available to send (not blocked). */
	listAvailable(): Promise<NumberRecord[]>;
	/** Insert a new WhatsApp number record for sending. */
	insert(record: {
		sessionName: string;
		msisdn: string;
	}): Promise<NumberRecord>;
	/** Delete a number by id. */
	delete(numberId: string): Promise<void>;
	/** Set or clear the block flag for a number (Req 18.1). */
	setBlocked(numberId: string, blocked: boolean): Promise<void>;
	/**
	 * Increment the daily counter for a number, resetting it when the stored
	 * counter date differs from `on`. Returns the new daily count.
	 */
	incrementDailySent(numberId: string, on: Date): Promise<number>;
	/** Reset the daily counter for a number to zero on the given date. */
	resetDailyCounter(numberId: string, on: Date): Promise<void>;
}

// ---------------------------------------------------------------------------
// ComplianceRepository
// ---------------------------------------------------------------------------

/**
 * Append-only persistence boundary for lawful-basis records (Req 15.4). The
 * current value is also denormalized onto the Lead via `LeadRepository`.
 */
export interface ComplianceRepository {
	/** Append a lawful-basis record with status and timestamp. */
	appendRecord(
		leadId: string,
		status: OptInStatus,
		at: Date,
	): Promise<ComplianceRecord>;
	/** List a Lead's lawful-basis records in chronological order. */
	listByLead(leadId: string): Promise<ComplianceRecord[]>;
}

// ---------------------------------------------------------------------------
// HandoffRepository
// ---------------------------------------------------------------------------

/**
 * Append-only persistence boundary for handoff events (Req 13.2). Each row
 * records that a Lead was transferred to a human consultant and the trigger
 * that caused it; the events are read by the CRM_UI's handoff view alongside
 * the Lead's qualification data and message history (Req 13.3). Mirrors the
 * append-only shape of {@link ComplianceRepository}.
 */
export interface HandoffRepository {
	/** Append a handoff event with its triggering reason and timestamp (Req 13.2). */
	appendEvent(
		leadId: string,
		reason: HandoffReason,
		at: Date,
	): Promise<HandoffRecord>;
	/** List a Lead's handoff events in chronological order. */
	listByLead(leadId: string): Promise<HandoffRecord[]>;
}

// ---------------------------------------------------------------------------
// ConsultantRepository
// ---------------------------------------------------------------------------

/** A member's handoff-alert settings as shown on the CRM settings page. */
export interface ConsultantNotificationSettings {
	/** The user's WhatsApp number (E.164), when one has been entered. */
	phoneE164: string | null;
	/** When the phone was confirmed via the WhatsApp code; null = unverified. */
	phoneVerifiedAt: Date | null;
	/** The per-membership handoff-alert opt-in flag. */
	receivesHandoffAlerts: boolean;
}

/**
 * Boundary over the auth membership tables for consultant handoff alerts. A
 * recipient is a member with alerts enabled whose user has a *verified*
 * WhatsApp number — an unverified phone is never alerted, so a typo can't
 * route lead alerts to a stranger. Writes touch only the domain-owned columns
 * the application added to those tables (`user.phone_e164`,
 * `user.phone_verified_at`, `member.receives_handoff_alerts`); everything
 * Better Auth manages stays Better Auth's. Until `tenant_id` lands on the
 * domain tables the recipient list is org-agnostic; it then becomes scoped to
 * the lead's org.
 */
export interface ConsultantRepository {
	/** Distinct verified E.164 numbers of members opted into handoff alerts. */
	listHandoffAlertRecipients(): Promise<string[]>;
	/**
	 * Read one member's alert settings, or `null` when the user has no
	 * membership in the organization.
	 */
	getNotificationSettings(
		userId: string,
		organizationId: string,
	): Promise<ConsultantNotificationSettings | null>;
	/**
	 * Set the user's phone and reset its verification stamp in the same write,
	 * so a changed number always re-verifies before receiving alerts.
	 */
	setPhone(userId: string, phoneE164: string): Promise<void>;
	/**
	 * Stamp the phone as verified at `at`, only when the user's current phone
	 * still equals `phoneE164` (the number the code was sent to). Returns
	 * whether the stamp was applied.
	 */
	stampPhoneVerified(
		userId: string,
		phoneE164: string,
		at: Date,
	): Promise<boolean>;
	/** Set the membership's handoff-alert opt-in flag. */
	setAlertOptIn(
		userId: string,
		organizationId: string,
		enabled: boolean,
	): Promise<void>;
}

// ---------------------------------------------------------------------------
// PhoneVerificationRepository
// ---------------------------------------------------------------------------

/** A pending phone verification (the hashed code sent by WhatsApp). */
export interface PhoneVerificationRecord {
	userId: string;
	/** The E.164 phone the code was sent to. */
	phoneE164: string;
	/** SHA-256 hex of the 6-digit code. */
	codeHash: string;
	/** Wrong guesses so far; the verification dies at the attempt cap. */
	attempts: number;
	expiresAt: Date;
	createdAt: Date;
}

/**
 * Persistence boundary for pending phone verifications. At most one pending
 * verification exists per user — starting a new one replaces it.
 */
export interface PhoneVerificationRepository {
	/** Create or replace the user's pending verification. */
	upsert(input: {
		userId: string;
		phoneE164: string;
		codeHash: string;
		expiresAt: Date;
	}): Promise<void>;
	/** Read the user's pending verification, when any. */
	findByUser(userId: string): Promise<PhoneVerificationRecord | null>;
	/** Count one wrong guess; returns the new attempt total. */
	incrementAttempts(userId: string): Promise<number>;
	/** Drop the pending verification (on success, expiry, or attempt cap). */
	delete(userId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// MessageTemplateRepository
// ---------------------------------------------------------------------------

/**
 * Persistence boundary for the operator-editable cadence/nurture message
 * templates. Only customized templates are stored; a key with no row falls back
 * to the built-in default (`DEFAULT_TEMPLATES`), so {@link getAll} returns a
 * partial map and {@link reset} deletes the row to restore the default.
 */
export interface MessageTemplateRepository {
	/** Read all stored (customized) template bodies keyed by {@link TemplateKey}. */
	getAll(): Promise<Partial<Record<TemplateKey, string>>>;
	/** Insert or replace the stored body for a template key. */
	upsert(key: TemplateKey, body: string): Promise<void>;
	/** Delete the stored body for a key, restoring its built-in default. */
	reset(key: TemplateKey): Promise<void>;
}
