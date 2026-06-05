// Anti-ban controller (I/O boundary — per-number anti-ban accounting state).
//
// Implements the design's `Anti_Ban_Controller (pure accounting + persistence)`
// as the persistence wrapper around the pure anti-ban functions in
// `@/core/anti-ban` (`currentDailyCap`, `canSend`, `nextDelayMs`,
// `withinSendWindow`). The pure layer holds the deterministic accounting math
// (cap/ramp/delay/window) and owns the correctness properties; this module adds
// the per-number persistent state those functions need and applies the date
// rollover that turns a freshly-read `NumberRecord` into the `NumberState` the
// pure decision consumes.
//
// Side-effect boundary: this module reads and writes per-number anti-ban state
// through the injected `NumberRepository` interface (never concrete Drizzle/DB
// code) and reads time through the injected `Clock` seam (never `Date.now()`);
// randomness for pacing enters through the injected `Rng` seam (never
// `Math.random()` inside the math). It performs no network I/O and does not
// itself call WAHA — the WAHA_Client and the Outbound_Worker's choke point (a
// later task) consult this controller before each send.
//
// Responsibilities (this task — Req 16.1, 16.2, 16.5, 18.1, 18.3):
//   - daily counter with date reset — `recordSend` increments the per-number
//     counter, resetting it on a local-day rollover (Req 16.1, 16.2);
//   - current-cap lookup — `currentCap` derives `dayInRamp` from the number's
//     `warmupStartDate` and applies the warm-up ramp (Req 16.5);
//   - set/read block flag — `markBlocked`/`setBlocked`/`isBlocked` (Req 18.1);
//   - stop assigning new sends to a blocked number — `canAssignSend`/`evaluate`
//     never allow a blocked number to be assigned a new send (Req 18.3),
//     reusing the pure `canSend` decision.

import {
	canSend,
	currentDailyCap,
	nextDelayMs,
	withinSendWindow,
	type SendDecision,
} from "@/core/anti-ban";
import type { AntiBanConfig, Clock, NumberState, Rng } from "@/core/types";
import type { NumberRecord, NumberRepository } from "@/services/repositories";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when an operation references a `numberId` that has no persisted
 * `NumberRecord`. A missing number cannot be evaluated for sending, so callers
 * must treat this as a hard error rather than silently allowing a send.
 */
export class UnknownNumberError extends Error {
	/** The unknown domain `numberId` that was looked up. */
	readonly numberId: string;

	constructor(numberId: string) {
		super(`No WhatsApp number found for numberId "${numberId}"`);
		this.name = "UnknownNumberError";
		this.numberId = numberId;
	}
}

// ---------------------------------------------------------------------------
// Controller interface
// ---------------------------------------------------------------------------

/**
 * The I/O-bound per-number anti-ban controller. Wraps the pure
 * `@/core/anti-ban` accounting with persistent per-number state read/written
 * through a {@link NumberRepository}, plus the injected `Clock`/`Rng` seams.
 *
 * The pure decision functions are stateless over a `NumberState` value; this
 * controller is the component that loads that state, applies the daily-counter
 * date rollover, derives the warm-up `dayInRamp`, and persists block/counter
 * changes (Req 16, 18).
 */
export interface AntiBanController {
	/**
	 * Evaluate the first applicable send decision for a number right now
	 * (Req 16.2, 16.5, 17.4, 18.3), reusing the pure {@link canSend}. The
	 * number's freshly-read state is rolled over to "today" before the cap is
	 * checked, so a counter left at the cap on a previous day does not spuriously
	 * report `"defer_cap"`.
	 *
	 * @throws {UnknownNumberError} when the `numberId` has no persisted record.
	 */
	evaluate(numberId: string): Promise<SendDecision>;

	/**
	 * Whether a number may be assigned a new outbound send right now (Req 16.2,
	 * 18.3). Returns `true` only when {@link evaluate} yields `"allow"`; a
	 * blocked number (or one outside its window / at its cap) is never assigned
	 * a new send. A blocked number must never be assigned a send (Req 18.3).
	 *
	 * @throws {UnknownNumberError} when the `numberId` has no persisted record.
	 */
	canAssignSend(numberId: string): Promise<boolean>;

	/**
	 * The current warm-up-adjusted daily send cap for a number (Req 16.5),
	 * derived by computing `dayInRamp` from the number's `warmupStartDate`
	 * relative to now and applying the pure {@link currentDailyCap} ramp.
	 *
	 * @throws {UnknownNumberError} when the `numberId` has no persisted record.
	 */
	currentCap(numberId: string): Promise<number>;

	/**
	 * Record that an outbound message was sent from a number: increment its
	 * daily counter, resetting the counter first when the stored counter date is
	 * an earlier day than today (Req 16.1, 16.2). Returns the new daily count.
	 *
	 * Callers must gate sends with {@link canAssignSend}/{@link evaluate} before
	 * calling this so the per-number daily count never exceeds the current cap
	 * (Req 16.5); this method itself only accounts a send that has happened.
	 */
	recordSend(numberId: string): Promise<number>;

	/**
	 * Reset a number's daily counter to zero as of today (Req 16.2). Provided
	 * for explicit day-boundary resets; the ordinary path resets lazily inside
	 * {@link recordSend}.
	 */
	resetDailyCounter(numberId: string): Promise<void>;

	/**
	 * Set the block flag on a number to mark it banned (Req 18.1). Equivalent to
	 * `setBlocked(numberId, true)`; the named method documents the
	 * block-on-detection intent.
	 */
	markBlocked(numberId: string): Promise<void>;

	/** Set or clear a number's block flag (Req 18.1). */
	setBlocked(numberId: string, blocked: boolean): Promise<void>;

	/**
	 * Read a number's current block flag (Req 18.1, 18.3).
	 *
	 * @throws {UnknownNumberError} when the `numberId` has no persisted record.
	 */
	isBlocked(numberId: string): Promise<boolean>;

	/**
	 * Compute a randomized inter-send pacing delay in milliseconds within the
	 * configured range (Req 17.1), via the pure {@link nextDelayMs} and the
	 * injected `Rng` seam.
	 */
	nextDelayMs(): number;

	/** Whether the current time is within the configured Send_Window (Req 17.4). */
	withinSendWindow(): boolean;
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link AntiBanControllerService}. */
export interface AntiBanControllerConfig {
	/** Persistence boundary for per-number anti-ban state. */
	numbers: NumberRepository;
	/** Anti-ban configuration (caps, ramp, delay range, send window). */
	config: AntiBanConfig;
	/** Injected time source; all "now" reads go through this seam (no `Date.now()`). */
	clock: Clock;
	/**
	 * Injected random source for pacing, a float in `[0, 1)`. Defaults to
	 * `Math.random` so production wiring is optional, but is injectable so pacing
	 * is deterministic under test.
	 */
	rng?: Rng;
}

// ---------------------------------------------------------------------------
// Internal helpers (pure, local-day arithmetic)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The signed difference in whole local calendar days between two instants
 * (`to - from`), comparing local midnights so the result is unaffected by the
 * time-of-day. `Math.round` absorbs the ±1h skew a DST transition introduces
 * between two local midnights.
 */
function diffInLocalDays(from: Date, to: Date): number {
	const a = new Date(
		from.getFullYear(),
		from.getMonth(),
		from.getDate(),
	).getTime();
	const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
	return Math.round((b - a) / MS_PER_DAY);
}

/** Whether two instants fall on the same local calendar day. */
function isSameLocalDay(a: Date, b: Date): boolean {
	return diffInLocalDays(a, b) === 0;
}

// ---------------------------------------------------------------------------
// AntiBanControllerService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link AntiBanController} backed by a {@link NumberRepository} and
 * the injected `Clock`/`Rng` seams. Stateless beyond its dependencies; every
 * decision reads the number's current persisted state.
 */
export class AntiBanControllerService implements AntiBanController {
	private readonly numbers: NumberRepository;
	private readonly config: AntiBanConfig;
	private readonly clock: Clock;
	private readonly rng: Rng;

	constructor(deps: AntiBanControllerConfig) {
		this.numbers = deps.numbers;
		this.config = deps.config;
		this.clock = deps.clock;
		this.rng = deps.rng ?? Math.random;
	}

	/** @inheritdoc */
	async evaluate(numberId: string): Promise<SendDecision> {
		const record = await this.requireRecord(numberId);
		const now = this.clock.now();
		const state = this.toNumberState(record, now);
		const dayInRamp = diffInLocalDays(record.warmupStartDate, now);
		return canSend(this.config, state, dayInRamp, now);
	}

	/** @inheritdoc */
	async canAssignSend(numberId: string): Promise<boolean> {
		return (await this.evaluate(numberId)) === "allow";
	}

	/** @inheritdoc */
	async currentCap(numberId: string): Promise<number> {
		const record = await this.requireRecord(numberId);
		const now = this.clock.now();
		const dayInRamp = diffInLocalDays(record.warmupStartDate, now);
		return currentDailyCap(this.config, dayInRamp);
	}

	/** @inheritdoc */
	async recordSend(numberId: string): Promise<number> {
		// The repository resets the counter when its stored date is an earlier day
		// than `on`, so the increment is always accounted against today (Req 16.2).
		return this.numbers.incrementDailySent(numberId, this.clock.now());
	}

	/** @inheritdoc */
	async resetDailyCounter(numberId: string): Promise<void> {
		await this.numbers.resetDailyCounter(numberId, this.clock.now());
	}

	/** @inheritdoc */
	async markBlocked(numberId: string): Promise<void> {
		await this.numbers.setBlocked(numberId, true);
	}

	/** @inheritdoc */
	async setBlocked(numberId: string, blocked: boolean): Promise<void> {
		await this.numbers.setBlocked(numberId, blocked);
	}

	/** @inheritdoc */
	async isBlocked(numberId: string): Promise<boolean> {
		const record = await this.requireRecord(numberId);
		return record.blocked;
	}

	/** @inheritdoc */
	nextDelayMs(): number {
		return nextDelayMs(this.config, this.rng);
	}

	/** @inheritdoc */
	withinSendWindow(): boolean {
		return withinSendWindow(this.config, this.clock.now());
	}

	// -- internals ----------------------------------------------------------

	/** Load a number's record or throw {@link UnknownNumberError}. */
	private async requireRecord(numberId: string): Promise<NumberRecord> {
		const record = await this.numbers.findById(numberId);
		if (!record) {
			throw new UnknownNumberError(numberId);
		}
		return record;
	}

	/**
	 * Map a freshly-read {@link NumberRecord} to the pure {@link NumberState}
	 * the accounting functions consume, applying the daily-counter date
	 * rollover: when the record's `dailyCounterDate` is not today, the stored
	 * `dailySent` belongs to an earlier day and is treated as `0` for today's
	 * decision (it would be reset on the next increment). This keeps the pure
	 * `"defer_cap"` check correct across a day boundary without a write
	 * (Req 16.1, 16.2).
	 */
	private toNumberState(record: NumberRecord, now: Date): NumberState {
		const dailySent = isSameLocalDay(record.dailyCounterDate, now)
			? record.dailySent
			: 0;
		return {
			numberId: record.id,
			blocked: record.blocked,
			dailySent,
			warmupStartDate: record.warmupStartDate,
		};
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct an {@link AntiBanController} from {@link AntiBanControllerConfig}. */
export function createAntiBanController(
	config: AntiBanControllerConfig,
): AntiBanController {
	return new AntiBanControllerService(config);
}
