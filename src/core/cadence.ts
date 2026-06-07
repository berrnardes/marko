// Cadence / nurture timing (pure, no I/O).
//
// Implements the deterministic timing functions the Cadence_Scheduler and
// Nurture_Scheduler (later, I/O-bound tasks) wrap with persistence:
// `plannedFireTime(touch, enrolledAt)` maps each of the five cadence touches to
// its planned fire instant relative to enrollment (Req 3.3), and
// `nextNurtureDate(from)` advances a nurture date by exactly one calendar month
// (Req 6.3). The I/O-bound schedulers consume these to create the persisted,
// cancellable pg-boss jobs; the timing math itself lives here so it can be
// property-tested in isolation.
//
// Everything here is total over its declared domain, has no side effects, and
// performs no I/O: time enters only via the `enrolledAt` / `from` parameters
// (never `Date.now()`) and there is no randomness, so the functions are
// deterministic and exhaustively property-testable. `plannedFireTime` realizes
// the design's Property 5 ("Cadence fire times follow the fixed offsets and are
// strictly increasing").

import type { Touch } from "./types";

/** Milliseconds in one 24-hour day, used to offset cadence fire times. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Test-mode configuration (env-driven, non-destructive)
// ---------------------------------------------------------------------------

/**
 * When `CADENCE_TEST_MODE=1` is set, the cadence runs on a compressed timeline
 * for real-world functional testing:
 *
 *   - Offsets are in **seconds** (T1 → 0 s immediate, T2 → 10 s, T3 → 20 s)
 *     so the full cadence completes in under a minute with short delays between
 *     touches.
 *   - Only three touches (T1–T3) are meaningful; T4 and T5 are collapsed to the
 *     same offset as T3 so they fire immediately after it if still scheduled,
 *     but the scheduler can be limited to 3 touches via {@link CADENCE_TOUCHES_COUNT}.
 *
 * This is intended **exclusively for local/staging functional tests** against a
 * real database and WAHA instance. Production deploys MUST NOT set this flag.
 */
export const CADENCE_TEST_MODE =
	process.env.CADENCE_TEST_MODE === "1" ||
	process.env.CADENCE_TEST_MODE === "true";

/**
 * In test mode the offsets are expressed in seconds (the unit multiplier is
 * 1 000 ms); in production they are expressed in days (86 400 000 ms).
 */
const OFFSET_UNIT_MS = CADENCE_TEST_MODE ? 1_000 : MS_PER_DAY;

/**
 * The number of cadence touches to schedule. In test mode this is reduced to 3
 * for a faster feedback loop; in production the full 5-touch sequence is used.
 */
export const CADENCE_TOUCHES_COUNT: number = CADENCE_TEST_MODE ? 3 : 5;

/**
 * The fixed per-touch day offset, measured relative to the Lead's enrollment
 * time — the single source of truth for the cadence schedule (Req 3.3).
 *
 *   - `T1` → day 0  (immediate context re-opener)
 *   - `T2` → day 3
 *   - `T3` → day 7
 *   - `T4` → day 11
 *   - `T5` → day 14 (the breakup touch)
 *
 * Req 3.3 specifies T5 for the **interval** day 14 through day 15. A single
 * deterministic fire instant is required (the function must be pure and total),
 * so the **start of that interval, day 14, is chosen** as T5's offset. Day 14
 * sits strictly after T4's day 11 and inside the permitted 14–15 window, so it
 * both honors the requirement and keeps the offsets strictly increasing
 * (`0 < 3 < 7 < 11 < 14`) — the ordering Property 5 asserts. The downstream
 * Cadence_Scheduler remains free to add jitter within the 14–15 window when it
 * materializes the job; the deterministic core anchors that window at its
 * lower edge.
 *
 * In **test mode** (`CADENCE_TEST_MODE=1`), offsets are in seconds:
 *   - T1 → 0 s (immediate), T2 → 10 s, T3 → 20 s, T4 → 30 s, T5 → 40 s
 */
export const CADENCE_OFFSET_DAYS = (
	CADENCE_TEST_MODE
		? { T1: 0, T2: 10, T3: 20, T4: 30, T5: 40 }
		: { T1: 0, T2: 3, T3: 7, T4: 11, T5: 14 }
) as { readonly [K in Touch]: number };

/**
 * Compute the planned fire instant for a cadence touch, relative to the Lead's
 * enrollment time (Req 3.3).
 *
 * The fire time is `enrolledAt` shifted forward by the touch's fixed offset
 * from {@link CADENCE_OFFSET_DAYS}, applied as a whole number of 24-hour days
 * in milliseconds:
 *
 * ```text
 *   plannedFireTime(touch, enrolledAt)
 *     = enrolledAt + CADENCE_OFFSET_DAYS[touch] * 24h
 * ```
 *
 * Design choices and the invariants they preserve:
 *
 *   - **Fixed millisecond offsets, not calendar-date arithmetic.** The cadence
 *     is defined as elapsed days *relative to enrollment* (Req 3.3), so adding
 *     a fixed `offsetDays * 24h` to the enrollment instant is the faithful
 *     reading. It also makes the result a pure, total function of
 *     `(touch, enrolledAt)` with no timezone/calendar branching.
 *   - **Strictly increasing across T1<T2<T3<T4<T5.** Because the offset table
 *     is strictly increasing and the same `enrolledAt` is shifted by it, the
 *     fire instants are strictly increasing for any fixed enrollment time —
 *     exactly what Property 5 requires. (A whole-day, fixed-duration offset is
 *     immune to the ±1h wall-clock shifts a DST boundary would introduce into
 *     calendar-date arithmetic, so the ordering can never invert.)
 *   - **The enrollment time-of-day is preserved** (e.g. enrolling at 14:30
 *     fires every later touch at 14:30, modulo any DST shift in the local wall
 *     clock), since only whole days are added to the underlying instant.
 *
 * The function does not mutate `enrolledAt`; it returns a fresh `Date`.
 *
 * @param touch - The cadence touch (`T1`–`T5`) to schedule.
 * @param enrolledAt - The Lead's enrollment instant; offsets are measured from
 *   here (time enters via this parameter, never `Date.now()`).
 * @returns A new `Date` for the touch's planned fire instant.
 */
export function plannedFireTime(touch: Touch, enrolledAt: Date): Date {
	const offset = CADENCE_OFFSET_DAYS[touch];
	return new Date(enrolledAt.getTime() + offset * OFFSET_UNIT_MS);
}

/**
 * Compute the last calendar day (28–31) of a given month, used to clamp a
 * day-of-month that does not exist in the target month.
 *
 * Constructing a local-time `Date` for day 0 of the *following* month yields
 * the last day of `monthIndex` (JavaScript normalizes day 0 to the prior
 * month's final day), so `getDate()` on it is the month length. This correctly
 * accounts for leap-year February (29) versus common-year February (28).
 *
 * @param year - The full (four-digit) year.
 * @param monthIndex - The zero-based month index (0 = January, 11 = December).
 * @returns The number of days in that month (28, 29, 30, or 31).
 */
function lastDayOfMonth(year: number, monthIndex: number): number {
	return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * Advance a date by exactly one calendar month, handling month-length edges
 * (Req 6.3).
 *
 * While a Lead is in `MONTHLY_NURTURE`, nurture outreach is spaced one calendar
 * month apart (Req 6.3). "One calendar month later" means the same day-of-month
 * in the next month — not a fixed 30/31-day duration — so the interval tracks
 * the calendar rather than drifting across months of different lengths.
 *
 * Month-length edge handling (clamp-to-end-of-month):
 *
 *   - When the source day-of-month does not exist in the target month, the
 *     result is **clamped to that month's last day**. For example
 *     Jan 31 → Feb 28 (or Feb 29 in a leap year), Mar 31 → Apr 30. This is the
 *     conventional, monotonic "end-of-month sticks to end-of-month" behavior
 *     and avoids JavaScript's native overflow (where naively bumping the month
 *     would spill Jan 31 into early March).
 *   - December rolls over into January of the next year (Req 6.3 month math is
 *     year-aware).
 *   - The **time-of-day is preserved** (hours, minutes, seconds, milliseconds
 *     are carried over unchanged), so only the calendar date advances.
 *
 * The target month and year are computed explicitly (rather than mutating the
 * month field and risking an intermediate overflow), the day is clamped against
 * the target month's length, and all three date components are then set
 * together — so no intermediate, invalid date is ever observed. The input
 * `from` is not mutated; a fresh `Date` is returned.
 *
 * @param from - The current nurture date/instant to advance from (time enters
 *   via this parameter, never `Date.now()`).
 * @returns A new `Date` exactly one calendar month after `from`, with the
 *   day-of-month clamped to the target month's length when necessary.
 */
export function nextNurtureDate(from: Date): Date {
	const year = from.getFullYear();
	const monthIndex = from.getMonth();
	const day = from.getDate();

	// Advance the (zero-based) month by one, carrying into the next year when it
	// passes December. Computing year/month explicitly avoids the native
	// month-overflow that would otherwise spill, e.g., Jan 31 into March.
	const advancedMonthIndex = monthIndex + 1;
	const targetYear = year + Math.floor(advancedMonthIndex / 12);
	const targetMonthIndex = advancedMonthIndex % 12;

	// Clamp the day-of-month to the target month's length so an end-of-month
	// source date sticks to the end of the (possibly shorter) target month.
	const clampedDay = Math.min(
		day,
		lastDayOfMonth(targetYear, targetMonthIndex),
	);

	// Start from the original instant to preserve the time-of-day, then set the
	// date components together so no intermediate invalid date is observed.
	const result = new Date(from.getTime());
	result.setFullYear(targetYear, targetMonthIndex, clampedDay);
	return result;
}
