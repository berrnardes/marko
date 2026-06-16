// CRM_UI view DTOs (task 22.3, Req 13.3, 20.1–20.4).
//
// Plain, JSON-serializable shapes shared between the data-layer read queries
// (`@/db/crm-read`, server) and the React Query client hooks (`./api`). They
// are pure types only — no I/O — so importing them into client components pulls
// in no server/database code. Timestamps are ISO-8601 strings because these
// shapes cross the JSON boundary of the internal `/api/crm/*` endpoints.

import type {
	ClassificationBand,
	HandoffReason,
	LifecycleState,
	Objective,
	OptInStatus,
} from "@/core/types";

/** A single row in the lead list — lifecycle state + score (Req 20.1). */
export interface LeadSummaryView {
	id: string;
	phoneE164: string;
	source: string;
	lifecycleState: LifecycleState;
	score: number;
	classificationBand: ClassificationBand | null;
	/** ISO-8601 timestamp of the lead's last update. */
	updatedAt: string;
	/** ISO-8601 timestamp of the lead's creation. */
	createdAt: string;
}

/** A single message in a lead's conversation history (Req 19.3, 20.2). */
export interface MessageView {
	id: string;
	direction: "inbound" | "outbound";
	content: string;
	/** ISO-8601 timestamp the message was recorded. */
	createdAt: string;
}

/** The progressively-collected qualification fields shown on the detail view (Req 20.2). */
export interface QualificationView {
	segment: string | null;
	creditValue: number | null;
	objective: Objective | null;
	hasLanceReserve: boolean | null;
	income: number | null;
}

/** Full lead detail — qualification fields + message history (Req 20.2). */
export interface LeadDetailView {
	id: string;
	phoneE164: string;
	source: string;
	lifecycleState: LifecycleState;
	optInStatus: OptInStatus;
	score: number;
	classificationBand: ClassificationBand | null;
	blocked: boolean;
	qualification: QualificationView;
	assignedConsultantId: string | null;
	createdAt: string;
	updatedAt: string;
	/** Conversation history in chronological order (Req 19.3, 20.2). */
	messages: MessageView[];
}

/** A recorded handoff event and its triggering reason (Req 13.2). */
export interface HandoffEventView {
	id: string;
	reason: HandoffReason;
	/** ISO-8601 timestamp the handoff was recorded. */
	createdAt: string;
}

/**
 * A handed-off lead, exposing its collected qualification data, full message
 * history, and the handoff events that transferred it to a consultant
 * (Req 13.3, 20.4).
 */
export interface HandoffLeadView extends LeadDetailView {
	handoffEvents: HandoffEventView[];
}

// ---------------------------------------------------------------------------
// Import report (mirrors the Lead_Importer report across the JSON boundary)
// ---------------------------------------------------------------------------

/** One row's outcome in an import run (Req 1.3, 1.6, 20.3). */
export interface ImportRowResultView {
	rowNumber: number;
	outcome: "created" | "updated" | "rejected";
	reason?: string;
	leadId?: string;
}

/** The import result report displayed after a CSV upload (Req 1.6, 20.3). */
export interface ImportReportView {
	createdCount: number;
	updatedCount: number;
	rejectedCount: number;
	rows: ImportRowResultView[];
}

// ---------------------------------------------------------------------------
// WhatsApp numbers management
// ---------------------------------------------------------------------------

/** A WhatsApp number row as viewed in the CRM management UI. */
export interface NumberView {
	id: string;
	sessionName: string;
	msisdn: string;
	blocked: boolean;
	dailySent: number;
	/** ISO-8601 date string the daily counter applies to. */
	dailyCounterDate: string;
	/** ISO-8601 date string the warm-up ramp started. */
	warmupStartDate: string;
}
