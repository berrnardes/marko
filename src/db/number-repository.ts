// Drizzle-backed NumberRepository implementation (data layer).
//
// Side-effect boundary: implements the `NumberRepository` persistence interface
// from `@/services/repositories` against the shared Drizzle client. It holds
// per-number anti-ban state: the block flag (Req 18), the daily counter and the
// local date it applies to (Req 16), and the warm-up start date driving the
// ramp (Req 16.3). The Anti_Ban_Controller and the outbound choke point read
// and update this state before/after each send.
//
// Date columns (`daily_counter_date`, `warmup_start_date`) are stored as
// PostgreSQL `date` (day granularity, no time) and surfaced to the domain as
// `Date` values at local midnight. `incrementDailySent` resets the counter when
// the stored date is an earlier local day than the send instant, all inside a
// single row-locked transaction so concurrent sends from the same number cannot
// race the counter (Req 16.1, 16.2).

import { and, eq, sql, type SQL } from "drizzle-orm";

import { db, type Database } from "@/db/client";
import { whatsappNumbers } from "@/db/schema";
import type { NumberRecord, NumberRepository } from "@/services/repositories";

type NumberRow = typeof whatsappNumbers.$inferSelect;

/**
 * Raised when a number row carries no usable identity for a write. Surfaced as
 * a hard error rather than silently allowing an unaccounted send.
 */
export class NumberNotFoundError extends Error {
	readonly numberId: string;
	constructor(numberId: string) {
		super(`No WhatsApp number row found for numberId "${numberId}"`);
		this.name = "NumberNotFoundError";
		this.numberId = numberId;
	}
}

/** Format a `Date` as a local-time `YYYY-MM-DD` day string for a `date` column. */
function toDayString(at: Date): string {
	const y = at.getFullYear();
	const m = String(at.getMonth() + 1).padStart(2, "0");
	const d = String(at.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** Parse a `date`-column day string into a `Date` at local midnight. */
function fromDayString(day: string): Date {
	const [y, m, d] = day.split("-").map((part) => Number.parseInt(part, 10));
	return new Date(y, m - 1, d);
}

/**
 * Map a persisted number row to the domain {@link NumberRecord}. The nullable
 * `date` columns are coerced so the pure anti-ban accounting always receives a
 * concrete `Date`: a missing `warmup_start_date` falls back to the row's
 * creation day (ramp starts at creation), and a missing `daily_counter_date`
 * falls back to the epoch so the controller treats today's counter as fresh.
 */
function toRecord(row: NumberRow): NumberRecord {
	return {
		id: row.id,
		sessionName: row.sessionName,
		msisdn: row.msisdn,
		blocked: row.blocked,
		dailySent: row.dailySent,
		dailyCounterDate: row.dailyCounterDate
			? fromDayString(row.dailyCounterDate)
			: new Date(0),
		warmupStartDate: row.warmupStartDate
			? fromDayString(row.warmupStartDate)
			: new Date(
					row.createdAt.getFullYear(),
					row.createdAt.getMonth(),
					row.createdAt.getDate(),
				),
	};
}

/**
 * Concrete {@link NumberRepository} over Drizzle/PostgreSQL, bound to ONE
 * organization at construction. A tenant only ever sees, sends from, blocks, or
 * deletes its own registered numbers. Stateless beyond the injected org +
 * database client; safe to construct per request.
 *
 * The one lookup that cannot be org-scoped — resolving an inbound WAHA session
 * to the organization that owns it — lives outside this class as
 * {@link findNumberBySessionName}.
 */
export class DrizzleNumberRepository implements NumberRepository {
	private readonly organizationId: string;
	private readonly database: Database;

	constructor(organizationId: string, database: Database = db) {
		this.organizationId = organizationId;
		this.database = database;
	}

	/** Narrow `condition` to this repository's organization. */
	private scoped(condition: SQL): SQL {
		return and(
			eq(whatsappNumbers.organizationId, this.organizationId),
			condition,
		) as SQL;
	}

	/** @inheritdoc */
	async findById(numberId: string): Promise<NumberRecord | null> {
		const [row] = await this.database
			.select()
			.from(whatsappNumbers)
			.where(this.scoped(eq(whatsappNumbers.id, numberId)));
		return row ? toRecord(row) : null;
	}

	/** @inheritdoc */
	async listAll(): Promise<NumberRecord[]> {
		const rows = await this.database
			.select()
			.from(whatsappNumbers)
			.where(eq(whatsappNumbers.organizationId, this.organizationId));
		return rows.map(toRecord);
	}

	/** @inheritdoc */
	async listAvailable(): Promise<NumberRecord[]> {
		// Only non-blocked numbers are ever offered for assignment; a blocked
		// number must never be assigned a send (Req 18.3).
		const rows = await this.database
			.select()
			.from(whatsappNumbers)
			.where(this.scoped(eq(whatsappNumbers.blocked, false)));
		return rows.map(toRecord);
	}

	/** @inheritdoc */
	async insert(record: {
		sessionName: string;
		msisdn: string;
	}): Promise<NumberRecord> {
		const [row] = await this.database
			.insert(whatsappNumbers)
			.values({
				organizationId: this.organizationId,
				sessionName: record.sessionName,
				msisdn: record.msisdn,
				warmupStartDate: toDayString(new Date()),
			})
			.returning();
		return toRecord(row);
	}

	/** @inheritdoc */
	async delete(numberId: string): Promise<void> {
		await this.database
			.delete(whatsappNumbers)
			.where(this.scoped(eq(whatsappNumbers.id, numberId)));
	}

	/** @inheritdoc */
	async setBlocked(numberId: string, blocked: boolean): Promise<void> {
		await this.database
			.update(whatsappNumbers)
			.set({ blocked })
			.where(this.scoped(eq(whatsappNumbers.id, numberId)));
	}

	/** @inheritdoc */
	async incrementDailySent(numberId: string, on: Date): Promise<number> {
		const onDay = toDayString(on);
		return this.database.transaction(async (tx) => {
			// Row-lock the number so concurrent sends serialize on the counter.
			const [row] = await tx
				.select()
				.from(whatsappNumbers)
				.where(this.scoped(eq(whatsappNumbers.id, numberId)))
				.for("update");
			if (!row) {
				throw new NumberNotFoundError(numberId);
			}
			// Reset to 1 when the stored counter belongs to an earlier day; else
			// increment today's count (Req 16.1, 16.2).
			const isNewDay = row.dailyCounterDate !== onDay;
			const newCount = isNewDay ? 1 : row.dailySent + 1;
			await tx
				.update(whatsappNumbers)
				.set({ dailySent: newCount, dailyCounterDate: onDay })
				.where(this.scoped(eq(whatsappNumbers.id, numberId)));
			return newCount;
		});
	}

	/** @inheritdoc */
	async resetDailyCounter(numberId: string, on: Date): Promise<void> {
		await this.database
			.update(whatsappNumbers)
			.set({ dailySent: 0, dailyCounterDate: toDayString(on) })
			.where(this.scoped(eq(whatsappNumbers.id, numberId)));
	}
}

/**
 * Resolve an inbound WAHA session name to the number row that owns it —
 * deliberately NOT org-scoped, and the only query in the data layer that is.
 *
 * This is the chicken-and-egg lookup at the inbound boundary: a WAHA webhook
 * delivery identifies itself only by `session`, so the organization is unknown
 * until this resolves. `whatsapp_numbers.session_name` carries a GLOBAL unique
 * constraint precisely so this returns at most one row and one organization.
 * Every subsequent read/write on that delivery goes through repositories bound
 * to the `organizationId` returned here.
 *
 * Under RLS (ADR-004) the plain table read below would return nothing, because
 * no tenant context can exist yet. So once the policies are installed this goes
 * through `app.resolve_session_org()` — a `SECURITY DEFINER` function owned by
 * a `BYPASSRLS` role that exposes exactly this one pair of columns and nothing
 * else. Which path is taken is decided by probing for the function once per
 * process, so the code works both before and after
 * `docs/ops/rls-policies.sql` is applied.
 *
 * @returns The owning organization and domain `numberId`, or `null` when no
 *   registered number claims the session (the caller acks and drops).
 */
export async function findNumberBySessionName(
	sessionName: string,
	database: Database = db,
): Promise<{ numberId: string; organizationId: string } | null> {
	if (await hasSessionOrgResolver(database)) {
		const result = await database.execute<{
			number_id: string;
			organization_id: string;
		}>(sql`select * from app.resolve_session_org(${sessionName})`);
		const row = result.rows[0];
		return row
			? { numberId: row.number_id, organizationId: row.organization_id }
			: null;
	}

	const [row] = await database
		.select({
			numberId: whatsappNumbers.id,
			organizationId: whatsappNumbers.organizationId,
		})
		.from(whatsappNumbers)
		.where(eq(whatsappNumbers.sessionName, sessionName))
		.limit(1);
	return row ?? null;
}

/** Cached answer to "have the RLS policies been installed yet?", per process. */
let sessionOrgResolverProbe: Promise<boolean> | undefined;

/**
 * Whether `app.resolve_session_org()` exists in this database.
 *
 * Probed once per process rather than assumed, because the application code and
 * `docs/ops/rls-policies.sql` are deployed independently: the function is
 * created by hand at the RLS cutover, and inbound must keep working on both
 * sides of it. A failed probe is not cached, so the first delivery after the
 * cutover picks up the new path without a restart.
 *
 * DELETE this probe — and the fallback branch above — once RLS is live
 * everywhere; the direct table read is dead code from that point on.
 */
async function hasSessionOrgResolver(database: Database): Promise<boolean> {
	if (!sessionOrgResolverProbe) {
		sessionOrgResolverProbe = database
			.execute<{ present: boolean }>(
				sql`select to_regprocedure('app.resolve_session_org(text)') is not null as present`,
			)
			.then((result) => result.rows[0]?.present === true)
			.catch(() => {
				sessionOrgResolverProbe = undefined;
				return false;
			});
	}
	return sessionOrgResolverProbe;
}
