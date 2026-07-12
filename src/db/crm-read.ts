// CRM_UI read queries (data layer — Drizzle over PostgreSQL).
//
// Side-effect boundary: this module reads from the live database through the
// shared Drizzle client (`@/db/client`). It is the persistence boundary for the
// CRM_UI's read surface — the lead list, lead detail, and handed-off leads view
// (Req 13.3, 20.1, 20.2, 20.4) — so the App Router pages and their internal API
// routes never embed SQL/Drizzle directly. Each function returns the plain,
// JSON-serializable view DTOs from `@/app/crm/_lib/types`, with timestamps
// already mapped to ISO-8601 strings so the `/api/crm/*` handlers can return
// them verbatim.

import { asc, desc, eq, inArray } from "drizzle-orm";

import type {
	HandoffEventView,
	HandoffLeadView,
	LeadDetailView,
	LeadSummaryView,
	MessageView,
	QualificationView,
} from "@/app/crm/_lib/types";
import { db } from "@/db/client";
import { handoffEvents, leads, messages } from "@/db/schema";

// ---------------------------------------------------------------------------
// Row → view mappers
// ---------------------------------------------------------------------------

type LeadRow = typeof leads.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type HandoffRow = typeof handoffEvents.$inferSelect;

/** Project a lead row's qualification columns into the view shape. */
function toQualificationView(row: LeadRow): QualificationView {
	return {
		segment: row.segment,
		creditValue: row.creditValue,
		objective: row.objective,
		hasLanceReserve: row.hasLanceReserve,
		income: row.income,
	};
}

/** Map a message row to its chronological-history view shape (Req 19.3). */
function toMessageView(row: MessageRow): MessageView {
	return {
		id: row.id,
		direction: row.direction,
		content: row.content,
		createdAt: row.createdAt.toISOString(),
	};
}

/** Map a handoff-event row to its view shape (Req 13.2). */
function toHandoffEventView(row: HandoffRow): HandoffEventView {
	return {
		id: row.id,
		reason: row.reason,
		createdAt: row.createdAt.toISOString(),
	};
}

/** Map a lead row + its messages to the full detail view (Req 20.2). */
function toLeadDetailView(
	row: LeadRow,
	leadMessages: MessageRow[],
): LeadDetailView {
	return {
		id: row.id,
		phoneE164: row.phoneE164,
		source: row.source,
		displayName: row.displayName,
		lifecycleState: row.lifecycleState,
		optInStatus: row.optInStatus,
		score: row.score,
		classificationBand: row.classificationBand,
		blocked: row.blocked,
		qualification: toQualificationView(row),
		assignedConsultantId: row.assignedConsultantId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		messages: leadMessages.map(toMessageView),
	};
}

// ---------------------------------------------------------------------------
// Lead list (Req 20.1)
// ---------------------------------------------------------------------------

/**
 * List every lead as a summary carrying its lifecycle state and score (Req
 * 20.1), most-recently-updated first. Selects only the columns the list view
 * renders rather than full rows.
 */
export async function listLeadSummaries(): Promise<LeadSummaryView[]> {
	const rows = await db
		.select({
			id: leads.id,
			phoneE164: leads.phoneE164,
			source: leads.source,
			displayName: leads.displayName,
			lifecycleState: leads.lifecycleState,
			score: leads.score,
			classificationBand: leads.classificationBand,
			updatedAt: leads.updatedAt,
			createdAt: leads.createdAt,
		})
		.from(leads)
		.orderBy(desc(leads.updatedAt));

	return rows.map((row) => ({
		id: row.id,
		phoneE164: row.phoneE164,
		source: row.source,
		displayName: row.displayName,
		lifecycleState: row.lifecycleState,
		score: row.score,
		classificationBand: row.classificationBand,
		updatedAt: row.updatedAt.toISOString(),
		createdAt: row.createdAt.toISOString(),
	}));
}

// ---------------------------------------------------------------------------
// Lead detail (Req 20.2)
// ---------------------------------------------------------------------------

/**
 * Read a single lead's qualification fields and full message history (Req
 * 20.2). Returns `null` when no lead matches `leadId`. Messages are ordered
 * chronologically (oldest first) to read as a conversation.
 */
export async function getLeadDetail(
	leadId: string,
): Promise<LeadDetailView | null> {
	const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
	if (!row) {
		return null;
	}

	const leadMessages = await db
		.select()
		.from(messages)
		.where(eq(messages.leadId, leadId))
		.orderBy(asc(messages.createdAt));

	return toLeadDetailView(row, leadMessages);
}

// ---------------------------------------------------------------------------
// Handed-off leads (Req 13.3, 20.4)
// ---------------------------------------------------------------------------

/**
 * List the leads that have been handed off to a consultant — those with at
 * least one recorded handoff event — exposing each lead's collected
 * qualification data, full message history, and its handoff events (Req 13.3,
 * 20.4). Leads are ordered by their most recent handoff first.
 *
 * Implemented with a small number of set-based reads (events, then the leads
 * and their messages by id) and grouped in memory, which is appropriate for the
 * internal CRM's scale (a handful of handed-off leads out of ~1,000).
 */
export async function listHandedOffLeads(): Promise<HandoffLeadView[]> {
	// All handoff events, newest first, so the first-seen lead id order already
	// reflects "most recently handed off first".
	const events = await db
		.select()
		.from(handoffEvents)
		.orderBy(desc(handoffEvents.createdAt));

	if (events.length === 0) {
		return [];
	}

	// Distinct lead ids preserving most-recent-handoff order, plus events grouped
	// per lead (kept newest-first as read).
	const orderedLeadIds: string[] = [];
	const eventsByLead = new Map<string, HandoffEventView[]>();
	for (const event of events) {
		let bucket = eventsByLead.get(event.leadId);
		if (!bucket) {
			bucket = [];
			eventsByLead.set(event.leadId, bucket);
			orderedLeadIds.push(event.leadId);
		}
		bucket.push(toHandoffEventView(event));
	}

	// Fetch the handed-off leads and their messages in two set-based reads.
	const leadRows = await db
		.select()
		.from(leads)
		.where(inArray(leads.id, orderedLeadIds));
	const leadById = new Map<string, LeadRow>(
		leadRows.map((row) => [row.id, row]),
	);

	const messageRows = await db
		.select()
		.from(messages)
		.where(inArray(messages.leadId, orderedLeadIds))
		.orderBy(asc(messages.createdAt));
	const messagesByLead = new Map<string, MessageRow[]>();
	for (const message of messageRows) {
		const bucket = messagesByLead.get(message.leadId);
		if (bucket) {
			bucket.push(message);
		} else {
			messagesByLead.set(message.leadId, [message]);
		}
	}

	// Assemble in handoff order, skipping any event whose lead row is missing.
	const result: HandoffLeadView[] = [];
	for (const leadId of orderedLeadIds) {
		const row = leadById.get(leadId);
		if (!row) {
			continue;
		}
		result.push({
			...toLeadDetailView(row, messagesByLead.get(leadId) ?? []),
			handoffEvents: eventsByLead.get(leadId) ?? [],
		});
	}

	return result;
}
