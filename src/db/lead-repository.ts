// Drizzle-backed LeadRepository implementation (data layer).
//
// Side-effect boundary: implements the `LeadRepository` persistence interface
// from `@/services/repositories` against the shared Drizzle client. The CRM_UI
// CSV-import endpoint constructs this to reuse the source-agnostic
// `Lead_Importer` (which depends only on the interface), so importing a CSV
// creates/deduplicates leads through the same data layer the rest of the system
// uses (Req 1.4, 1.5, 2.1, 20.3). Lifecycle moves use a compare-and-set on
// `lifecycle_state` for optimistic concurrency (Req 14.1, 19.4).

import { and, eq, inArray, type SQL } from "drizzle-orm";

import { brazilianPhoneVariants } from "@/core";
import type {
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
		displayName: row.displayName,
		lifecycleState: row.lifecycleState,
		optInStatus: row.optInStatus,
		optInAt: row.optInAt,
		blocked: row.blocked,
		unreachableAt: row.unreachableAt,
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
 * Concrete {@link LeadRepository} over Drizzle/PostgreSQL, bound to ONE
 * organization at construction. Every read and write this repository performs is
 * filtered by that `organizationId`, so a lead id belonging to another tenant
 * simply does not resolve — there is no method that can reach across orgs.
 * Stateless beyond the injected org + database client; safe to construct per
 * request.
 */
export class DrizzleLeadRepository implements LeadRepository {
	private readonly organizationId: string;
	private readonly database: Database;

	constructor(organizationId: string, database: Database = db) {
		this.organizationId = organizationId;
		this.database = database;
	}

	/**
	 * Narrow `condition` to this repository's organization. Every query in this
	 * class goes through here, so the tenant filter cannot be forgotten on a new
	 * method by accident.
	 */
	private scoped(condition: SQL): SQL {
		return and(eq(leads.organizationId, this.organizationId), condition) as SQL;
	}

	/** @inheritdoc */
	async findById(leadId: string): Promise<LeadSnapshot | null> {
		const [row] = await this.database
			.select()
			.from(leads)
			.where(this.scoped(eq(leads.id, leadId)));
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
			.where(this.scoped(inArray(leads.phoneE164, variants)));
		return row ? toSnapshot(row) : null;
	}

	/** @inheritdoc */
	async create(input: NewLeadInput): Promise<LeadSnapshot> {
		// New leads start `COLD_QUEUED` (the column default) recording their
		// originating source (Req 1.5, 2.1) and any name the source supplied. The
		// same phone may exist once per organization — the uniqueness constraint is
		// `(organization_id, phone_e164)`, so two tenants importing the same number
		// get two independent leads.
		const [row] = await this.database
			.insert(leads)
			.values({
				organizationId: this.organizationId,
				phoneE164: input.phoneE164,
				source: input.source,
				displayName: input.displayName ?? null,
			})
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
			.where(this.scoped(eq(leads.id, leadId)))
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
			.where(
				this.scoped(
					and(
						eq(leads.id, leadId),
						eq(leads.lifecycleState, expectedFrom),
					) as SQL,
				),
			)
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
			.where(this.scoped(eq(leads.id, leadId)));
	}

	/** @inheritdoc */
	async setBlocked(leadId: string, blocked: boolean): Promise<void> {
		await this.database
			.update(leads)
			.set({ blocked, updatedAt: new Date() })
			.where(this.scoped(eq(leads.id, leadId)));
	}

	/** @inheritdoc */
	async markUnreachable(leadId: string, at: Date): Promise<void> {
		await this.database
			.update(leads)
			.set({ unreachableAt: at, updatedAt: new Date() })
			.where(this.scoped(eq(leads.id, leadId)));
	}

	/** @inheritdoc */
	async assignConsultant(leadId: string, consultantId: string): Promise<void> {
		await this.database
			.update(leads)
			.set({ assignedConsultantId: consultantId, updatedAt: new Date() })
			.where(this.scoped(eq(leads.id, leadId)));
	}
}

/**
 * Resolve which organization owns a lead — deliberately NOT org-scoped.
 *
 * BACKLOG COMPATIBILITY ONLY. pg-boss holds up to 31 days of jobs enqueued
 * before the tenancy retrofit, whose payloads carry a `leadId` but no
 * `organizationId`. The workers use this to recover the tenant for those jobs
 * so the backlog drains instead of failing. Every job enqueued from this deploy
 * onward carries its organization in the payload.
 *
 * DELETE this function, and the fallback that calls it, once the pre-retrofit
 * backlog has aged out (see the pg-boss retention window).
 *
 * @returns The owning organization, or `null` when the lead no longer exists.
 */
export async function resolveOrganizationIdForLead(
	leadId: string,
	database: Database = db,
): Promise<string | null> {
	const [row] = await database
		.select({ organizationId: leads.organizationId })
		.from(leads)
		.where(eq(leads.id, leadId))
		.limit(1);
	return row?.organizationId ?? null;
}
