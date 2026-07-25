// Drizzle-backed ScheduledJobRepository implementation (data layer).
//
// Side-effect boundary: implements the `ScheduledJobRepository` persistence
// interface from `@/services/repositories` against the shared Drizzle client.
// The `scheduled_jobs` table is an application-side mirror of pg-boss job ids
// so a Lead's pending cadence touches and nurture jobs can be listed and
// cancelled by lead id (Req 3.4, 6.3, 7.2); the actual queue lives in pg-boss's
// own schema. The cadence/nurture schedulers create one mirror row per enqueued
// job, and the compliance/handoff managers cancel a Lead's pending jobs en
// masse through `cancelAllForLead`.

import { and, eq, type SQL } from "drizzle-orm";

import { db, type Database } from "@/db/client";
import { scheduledJobs } from "@/db/schema";
import type {
	NewScheduledJobInput,
	ScheduledJobRecord,
	ScheduledJobRepository,
	ScheduledJobStatus,
} from "@/services/repositories";

type ScheduledJobRow = typeof scheduledJobs.$inferSelect;

/** Map a persisted scheduled-job row to the domain {@link ScheduledJobRecord}. */
function toRecord(row: ScheduledJobRow): ScheduledJobRecord {
	return {
		id: row.id,
		leadId: row.leadId,
		jobKind: row.jobKind,
		touch: row.touch,
		pgbossJobId: row.pgbossJobId,
		plannedFor: row.plannedFor,
		status: row.status,
	};
}

/**
 * Concrete {@link ScheduledJobRepository} over Drizzle/PostgreSQL, bound to ONE
 * organization at construction. Stateless beyond the injected org + database
 * client; safe to construct per request.
 */
export class DrizzleScheduledJobRepository implements ScheduledJobRepository {
	private readonly organizationId: string;
	private readonly database: Database;

	constructor(organizationId: string, database: Database = db) {
		this.organizationId = organizationId;
		this.database = database;
	}

	/** Narrow `condition` to this repository's organization. */
	private scoped(condition: SQL): SQL {
		return and(
			eq(scheduledJobs.organizationId, this.organizationId),
			condition,
		) as SQL;
	}

	/** @inheritdoc */
	async create(input: NewScheduledJobInput): Promise<ScheduledJobRecord> {
		const [row] = await this.database
			.insert(scheduledJobs)
			.values({
				organizationId: this.organizationId,
				leadId: input.leadId,
				jobKind: input.jobKind,
				touch: input.touch ?? null,
				pgbossJobId: input.pgbossJobId,
				plannedFor: input.plannedFor,
			})
			.returning();
		return toRecord(row);
	}

	/** @inheritdoc */
	async listByLead(
		leadId: string,
		status?: ScheduledJobStatus,
	): Promise<ScheduledJobRecord[]> {
		const where =
			status === undefined
				? this.scoped(eq(scheduledJobs.leadId, leadId))
				: this.scoped(
						and(
							eq(scheduledJobs.leadId, leadId),
							eq(scheduledJobs.status, status),
						) as SQL,
					);
		const rows = await this.database.select().from(scheduledJobs).where(where);
		return rows.map(toRecord);
	}

	/** @inheritdoc */
	async updateStatus(jobId: string, status: ScheduledJobStatus): Promise<void> {
		await this.database
			.update(scheduledJobs)
			.set({ status })
			.where(this.scoped(eq(scheduledJobs.id, jobId)));
	}

	/** @inheritdoc */
	async cancelAllForLead(leadId: string): Promise<number> {
		// Mark every still-pending job for the lead cancelled and count the rows
		// that transitioned (Req 5.2, 7.2, 15.2). Already-done/cancelled rows are
		// left untouched by the status precondition.
		const cancelled = await this.database
			.update(scheduledJobs)
			.set({ status: "cancelled" })
			.where(
				this.scoped(
					and(
						eq(scheduledJobs.leadId, leadId),
						eq(scheduledJobs.status, "pending"),
					) as SQL,
				),
			)
			.returning({ id: scheduledJobs.id });
		return cancelled.length;
	}
}
