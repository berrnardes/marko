// Drizzle-backed HandoffRepository implementation (data layer).
//
// Side-effect boundary: implements the append-only `HandoffRepository`
// persistence interface from `@/services/repositories` against the shared
// Drizzle client. Each row records that a Lead was transferred to a human
// consultant and the trigger that caused it (Req 13.2); the events are read by
// the CRM_UI handoff view alongside the Lead's qualification data and message
// history (Req 13.3). This repository only ever appends and reads.

import { and, asc, eq } from "drizzle-orm";

import type { HandoffReason } from "@/core/types";
import { db, type Database } from "@/db/client";
import { handoffEvents } from "@/db/schema";
import type { HandoffRecord, HandoffRepository } from "@/services/repositories";

type HandoffRow = typeof handoffEvents.$inferSelect;

/** Map a persisted handoff-event row to the domain {@link HandoffRecord}. */
function toRecord(row: HandoffRow): HandoffRecord {
	return {
		id: row.id,
		leadId: row.leadId,
		reason: row.reason,
		createdAt: row.createdAt,
	};
}

/**
 * Concrete {@link HandoffRepository} over Drizzle/PostgreSQL, bound to ONE
 * organization at construction. Stateless beyond the injected org + database
 * client; safe to construct per request.
 */
export class DrizzleHandoffRepository implements HandoffRepository {
	private readonly organizationId: string;
	private readonly database: Database;

	constructor(organizationId: string, database: Database = db) {
		this.organizationId = organizationId;
		this.database = database;
	}

	/** @inheritdoc */
	async appendEvent(
		leadId: string,
		reason: HandoffReason,
		at: Date,
	): Promise<HandoffRecord> {
		const [row] = await this.database
			.insert(handoffEvents)
			.values({
				organizationId: this.organizationId,
				leadId,
				reason,
				createdAt: at,
			})
			.returning();
		return toRecord(row);
	}

	/** @inheritdoc */
	async listByLead(leadId: string): Promise<HandoffRecord[]> {
		const rows = await this.database
			.select()
			.from(handoffEvents)
			.where(
				and(
					eq(handoffEvents.organizationId, this.organizationId),
					eq(handoffEvents.leadId, leadId),
				),
			)
			.orderBy(asc(handoffEvents.createdAt));
		return rows.map(toRecord);
	}
}
