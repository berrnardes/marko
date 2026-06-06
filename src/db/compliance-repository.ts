// Drizzle-backed ComplianceRepository implementation (data layer).
//
// Side-effect boundary: implements the append-only `ComplianceRepository`
// persistence interface from `@/services/repositories` against the shared
// Drizzle client. Each row is an immutable lawful-basis record (Req 15.4); the
// current value is also denormalized onto the lead by the Compliance_Manager
// via the `LeadRepository`. This repository only ever appends and reads.

import { asc, eq } from "drizzle-orm";

import type { OptInStatus } from "@/core/types";
import { db, type Database } from "@/db/client";
import { complianceRecords } from "@/db/schema";
import type {
	ComplianceRecord,
	ComplianceRepository,
} from "@/services/repositories";

type ComplianceRow = typeof complianceRecords.$inferSelect;

/** Map a persisted compliance row to the domain {@link ComplianceRecord}. */
function toRecord(row: ComplianceRow): ComplianceRecord {
	return {
		id: row.id,
		leadId: row.leadId,
		optInStatus: row.optInStatus,
		recordedAt: row.recordedAt,
	};
}

/**
 * Concrete {@link ComplianceRepository} over Drizzle/PostgreSQL. Stateless
 * beyond the injected database client; safe to construct per request.
 */
export class DrizzleComplianceRepository implements ComplianceRepository {
	private readonly database: Database;

	constructor(database: Database = db) {
		this.database = database;
	}

	/** @inheritdoc */
	async appendRecord(
		leadId: string,
		status: OptInStatus,
		at: Date,
	): Promise<ComplianceRecord> {
		const [row] = await this.database
			.insert(complianceRecords)
			.values({ leadId, optInStatus: status, recordedAt: at })
			.returning();
		return toRecord(row);
	}

	/** @inheritdoc */
	async listByLead(leadId: string): Promise<ComplianceRecord[]> {
		const rows = await this.database
			.select()
			.from(complianceRecords)
			.where(eq(complianceRecords.leadId, leadId))
			.orderBy(asc(complianceRecords.recordedAt));
		return rows.map(toRecord);
	}
}
