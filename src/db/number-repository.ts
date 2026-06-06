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

import { eq } from "drizzle-orm";

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
 * Concrete {@link NumberRepository} over Drizzle/PostgreSQL. Stateless beyond
 * the injected database client; safe to construct per request.
 */
export class DrizzleNumberRepository implements NumberRepository {
	private readonly database: Database;

	constructor(database: Database = db) {
		this.database = database;
	}

	/** @inheritdoc */
	async findById(numberId: string): Promise<NumberRecord | null> {
		const [row] = await this.database
			.select()
			.from(whatsappNumbers)
			.where(eq(whatsappNumbers.id, numberId));
		return row ? toRecord(row) : null;
	}

	/** @inheritdoc */
	async listAvailable(): Promise<NumberRecord[]> {
		// Only non-blocked numbers are ever offered for assignment; a blocked
		// number must never be assigned a send (Req 18.3).
		const rows = await this.database
			.select()
			.from(whatsappNumbers)
			.where(eq(whatsappNumbers.blocked, false));
		return rows.map(toRecord);
	}

	/** @inheritdoc */
	async setBlocked(numberId: string, blocked: boolean): Promise<void> {
		await this.database
			.update(whatsappNumbers)
			.set({ blocked })
			.where(eq(whatsappNumbers.id, numberId));
	}

	/** @inheritdoc */
	async incrementDailySent(numberId: string, on: Date): Promise<number> {
		const onDay = toDayString(on);
		return this.database.transaction(async (tx) => {
			// Row-lock the number so concurrent sends serialize on the counter.
			const [row] = await tx
				.select()
				.from(whatsappNumbers)
				.where(eq(whatsappNumbers.id, numberId))
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
				.where(eq(whatsappNumbers.id, numberId));
			return newCount;
		});
	}

	/** @inheritdoc */
	async resetDailyCounter(numberId: string, on: Date): Promise<void> {
		await this.database
			.update(whatsappNumbers)
			.set({ dailySent: 0, dailyCounterDate: toDayString(on) })
			.where(eq(whatsappNumbers.id, numberId));
	}
}
