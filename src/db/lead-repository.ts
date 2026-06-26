// Drizzle-backed LeadRepository implementation (data layer).
//
// Side-effect boundary: implements the `LeadRepository` persistence interface
// from `@/services/repositories` against the shared Drizzle client. The CRM_UI
// CSV-import endpoint constructs this to reuse the source-agnostic
// `Lead_Importer` (which depends only on the interface), so importing a CSV
// creates/deduplicates leads through the same data layer the rest of the system
// uses (Req 1.4, 1.5, 2.1, 20.3). Lifecycle moves use a compare-and-set on
// `lifecycle_state` for optimistic concurrency (Req 14.1, 19.4).

import { and, eq, inArray } from "drizzle-orm";

import { brazilianPhoneVariants } from "@/core";
import type {
	ClassificationBand,
	LeadSnapshot,
	LifecycleState,
	OptInStatus,
} from "@/core/types";
import { db, type Database } from "@/db/client";
import { leads } from "@/db/schema";
import type {
	LeadRepository,
	NewLeadInput,
	QualificationFieldsPatch,
} from "@/services/repositories";

type LeadRow = typeof leads.$inferSelect;

/** Map a persisted lead row to the domain {@link LeadSnapshot}. */
function toSnapshot(row: LeadRow): LeadSnapshot {
	return {
		id: row.id,
		phoneE164: row.phoneE164,
		source: row.source,
		lifecycleState: row.lifecycleState,
		optInStatus: row.optInStatus,
		optInAt: row.optInAt,
		score: row.score,
		blocked: row.blocked,
		unreachableAt: row.unreachableAt,
		classificationBand: row.classificationBand,
		qualification: {
			segment: row.segment,
			creditValue: row.creditValue,
			objective: row.objective,
			hasLanceReserve: row.hasLanceReserve,
			income: row.income,
		},
		assignedConsultantId: row.assignedConsultantId,
		lastOutboundAt: row.lastOutboundAt,
		lastInboundAt: row.lastInboundAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Concrete {@link LeadRepository} over Drizzle/PostgreSQL. Stateless beyond the
 * injected database client; safe to construct per request.
 */
export class DrizzleLeadRepository implements LeadRepository {
	private readonly database: Database;

	constructor(database: Database = db) {
		this.database = database;
	}

	/** @inheritdoc */
	async findById(leadId: string): Promise<LeadSnapshot | null> {
		const [row] = await this.database
			.select()
			.from(leads)
			.where(eq(leads.id, leadId));
		return row ? toSnapshot(row) : null;
	}

	/** @inheritdoc */
	async findByPhone(phoneE164: string): Promise<LeadSnapshot | null> {
		// Match across the Brazilian 9th-digit-equivalent forms of the number so
		// a Lead imported as the modern form (`+5547996334573`) and an inbound
		// reply delivered as the legacy short form (`+554796334573`) — or vice
		// versa — resolve to the SAME Lead instead of duplicating it (Req 1.4,
		// 7.1). For non-Brazilian inputs this collapses to the exact number.
		const variants = brazilianPhoneVariants(phoneE164);
		const [row] = await this.database
			.select()
			.from(leads)
			.where(inArray(leads.phoneE164, variants));
		return row ? toSnapshot(row) : null;
	}

	/** @inheritdoc */
	async create(input: NewLeadInput): Promise<LeadSnapshot> {
		// New leads start `COLD_QUEUED` (the column default) recording their
		// originating source (Req 1.5, 2.1).
		const [row] = await this.database
			.insert(leads)
			.values({ phoneE164: input.phoneE164, source: input.source })
			.returning();
		return toSnapshot(row);
	}

	/** @inheritdoc */
	async updateQualification(
		leadId: string,
		patch: QualificationFieldsPatch,
	): Promise<LeadSnapshot> {
		const [row] = await this.database
			.update(leads)
			.set({ ...patch, updatedAt: new Date() })
			.where(eq(leads.id, leadId))
			.returning();
		return toSnapshot(row);
	}

	/** @inheritdoc */
	async updateScore(
		leadId: string,
		score: number,
		band: ClassificationBand,
	): Promise<LeadSnapshot> {
		const [row] = await this.database
			.update(leads)
			.set({ score, classificationBand: band, updatedAt: new Date() })
			.where(eq(leads.id, leadId))
			.returning();
		return toSnapshot(row);
	}

	/** @inheritdoc */
	async updateLifecycleState(
		leadId: string,
		expectedFrom: LifecycleState,
		to: LifecycleState,
	): Promise<LeadSnapshot | null> {
		// Compare-and-set: apply only while the current state still matches the
		// state the caller read, so a concurrent writer cannot be overwritten
		// (optimistic concurrency, Req 14.1, 19.4).
		const [row] = await this.database
			.update(leads)
			.set({ lifecycleState: to, updatedAt: new Date() })
			.where(and(eq(leads.id, leadId), eq(leads.lifecycleState, expectedFrom)))
			.returning();
		return row ? toSnapshot(row) : null;
	}

	/** @inheritdoc */
	async setOptInStatus(
		leadId: string,
		status: OptInStatus,
		at: Date,
	): Promise<void> {
		await this.database
			.update(leads)
			.set({ optInStatus: status, optInAt: at, updatedAt: new Date() })
			.where(eq(leads.id, leadId));
	}

	/** @inheritdoc */
	async setBlocked(leadId: string, blocked: boolean): Promise<void> {
		await this.database
			.update(leads)
			.set({ blocked, updatedAt: new Date() })
			.where(eq(leads.id, leadId));
	}

	/** @inheritdoc */
	async markUnreachable(leadId: string, at: Date): Promise<void> {
		await this.database
			.update(leads)
			.set({ unreachableAt: at, updatedAt: new Date() })
			.where(eq(leads.id, leadId));
	}

	/** @inheritdoc */
	async assignConsultant(leadId: string, consultantId: string): Promise<void> {
		await this.database
			.update(leads)
			.set({ assignedConsultantId: consultantId, updatedAt: new Date() })
			.where(eq(leads.id, leadId));
	}
}
