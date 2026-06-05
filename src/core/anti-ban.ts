// Anti-ban accounting (pure, no I/O).
//
// Implements the deterministic Anti_Ban_Controller accounting per Req 16
// (per-number daily cap + warm-up ramp), Req 17.1 / 17.4 (randomized send
// pacing + send-window restriction), and Req 18.2 (a blocked number sends
// nothing), mirroring the design's "Anti_Ban_Controller (pure accounting +
// persistence)" section. These functions are the testable core that the
// I/O-bound `Anti_Ban_Controller` and `Outbound_Worker` (later tasks) wrap with
// per-number persistence: the controller reads/writes `NumberState`, resets the
// daily counter on date rollover, derives `dayInRamp` from `warmupStartDate`,
// and applies the `SendDecision` returned here at the single outbound choke
// point.
//
// Everything here is total over its declared domain, has no side effects, and
// performs no I/O: time enters via the `now` parameter (never `Date.now()`) and
// randomness enters via the injected `Rng` seam (never `Math.random()`), so the
// functions are deterministic and exhaustively property-testable. They realize
// the design's Property 21 ("Per-number daily cap is never exceeded and the
// warm-up ramp is monotonic") and Property 22 ("Send pacing stays within the
// configured delay range and send window").

import type { AntiBanConfig, NumberState, Rng } from "./types";

/**
 * The decision returned by {@link canSend} for a given number at a given time.
 *
 *   - `"allow"`        — none of the stop/defer conditions hold; the number may
 *     send now (subject to the randomized pacing delay applied separately).
 *   - `"defer_cap"`    — the number has reached its current daily cap; further
 *     sends wait until the next day (Req 16.2, 16.5).
 *   - `"defer_window"` — the current time is outside the configured
 *     Send_Window; sends wait until the window reopens (Req 17.4).
 *   - `"blocked"`      — the number's block flag is set; it sends nothing at all
 *     (Req 18.2).
 */
export type SendDecision = "allow" | "defer_cap" | "defer_window" | "blocked";

/**
 * Compute the current per-number daily send cap for a given day within the
 * warm-up ramp (Req 16.3, 16.4).
 *
 * The cap follows a warm-up ramp that rises monotonically from
 * `cfg.warmupInitialCap` (on the first day) to `cfg.baseDailyCap` (at the end
 * of the ramp), then holds at `cfg.baseDailyCap` thereafter. `dayInRamp` is the
 * integer day index since the ramp began (day 0 = the number's first day).
 *
 * Formula (assuming the expected configuration `warmupInitialCap <=
 * baseDailyCap` and a positive `warmupRampDays`):
 *
 * ```text
 *   day = clamp(dayInRamp, 0, warmupRampDays)
 *   cap(0)              = warmupInitialCap                         // exact (Req 16.4)
 *   cap(day)            = round(                                   // 0 < day < rampDays
 *       warmupInitialCap
 *       + (baseDailyCap - warmupInitialCap) * (day / warmupRampDays)
 *     )
 *   cap(day >= rampDays) = baseDailyCap                            // steady state
 * ```
 *
 * Design choices and why they hold the required invariants:
 *
 *   - **Day 0 is exact (Req 16.4).** Day 0 returns `warmupInitialCap` directly
 *     (no interpolation, no rounding), so the first-day cap equals the
 *     configured initial value precisely — the boundary asserted by the day-0
 *     unit test (task 6.4).
 *   - **Monotonic non-decreasing.** The interpolation is a linear,
 *     non-decreasing function of `day` (the slope `baseDailyCap -
 *     warmupInitialCap` is `>= 0` under the documented precondition), and
 *     `Math.round` is itself monotonic non-decreasing, so their composition is
 *     monotonic across every integer day — including the day-0→day-1 step and
 *     the step into the post-ramp steady state. This is what Property 21
 *     requires.
 *   - **Never exceeds `baseDailyCap`.** For `day < warmupRampDays` the
 *     interpolated value is strictly below `baseDailyCap`, and at/after
 *     `warmupRampDays` the cap is clamped to exactly `baseDailyCap`, so the cap
 *     can never overshoot the steady-state value (Req 16.5).
 *   - **Negative days clamp to day 0** behavior, so a misconfigured/negative
 *     day index can never yield a cap below the initial cap.
 *   - **Degenerate ramp guard (`warmupRampDays <= 0`).** With no ramp window
 *     there is nothing to interpolate and dividing by the ramp length would be
 *     undefined, so day 0 still respects the initial-cap rule and every later
 *     day takes the steady-state `baseDailyCap` immediately.
 *
 * Note: callers are expected to supply `warmupInitialCap <= baseDailyCap` (the
 * ramp warms *up*). The function does not enforce that precondition; a config
 * with `warmupInitialCap > baseDailyCap` would describe a downward ramp, for
 * which monotonicity cannot also hold.
 *
 * @param cfg - The anti-ban configuration (caps and ramp length).
 * @param dayInRamp - Integer day index since the ramp began (day 0 = first day).
 * @returns The integer daily send cap in force on that day.
 */
export function currentDailyCap(cfg: AntiBanConfig, dayInRamp: number): number {
	const { baseDailyCap, warmupInitialCap, warmupRampDays } = cfg;

	// Clamp a negative day index to day-0 behavior (Req 16.4 boundary).
	const day = dayInRamp < 0 ? 0 : dayInRamp;

	// Day 0 always holds exactly the configured initial cap (Req 16.4). Returned
	// directly so the first-day boundary is exact for the day-0 unit test.
	if (day === 0) {
		return warmupInitialCap;
	}

	// Degenerate ramp: no interpolation window (and division by it is undefined).
	// After day 0 the cap is the steady-state base cap immediately.
	if (warmupRampDays <= 0) {
		return baseDailyCap;
	}

	// At or beyond the end of the ramp, hold the steady-state base cap. Clamping
	// here guarantees the cap never exceeds `baseDailyCap` (Req 16.5).
	if (day >= warmupRampDays) {
		return baseDailyCap;
	}

	// Linear interpolation across the open interval (0, warmupRampDays). Rounding
	// to an integer keeps the cap a whole number of messages while preserving
	// monotonicity (round is non-decreasing).
	const interpolated =
		warmupInitialCap +
		((baseDailyCap - warmupInitialCap) * day) / warmupRampDays;
	return Math.round(interpolated);
}

/**
 * Decide whether the given time falls within the configured Send_Window
 * (Req 17.4).
 *
 * The window is **half-open**: the start hour is inclusive and the end hour is
 * exclusive, i.e. `now`'s local hour must lie in `[startHour, endHour)`. For
 * example, a window of `{ startHour: 9, endHour: 18 }` admits any time from
 * 09:00:00 up to but not including 18:00:00 (so 17:59 is inside, 18:00 is
 * outside). The local hour is taken from `now.getHours()`, so the comparison is
 * in the host's local timezone (the design specifies a local-timezone window).
 *
 * Handles the normal case where `startHour <= endHour`. A window where
 * `startHour > endHour` (wrapping past midnight) is out of scope for this
 * function and would simply admit nothing under this comparison.
 *
 * @param cfg - The anti-ban configuration carrying the Send_Window bounds.
 * @param now - The instant to test (time enters via this parameter, never
 *   `Date.now()`).
 * @returns `true` if `now`'s local hour is within `[startHour, endHour)`.
 */
export function withinSendWindow(cfg: AntiBanConfig, now: Date): boolean {
	const hour = now.getHours();
	const { startHour, endHour } = cfg.sendWindow;
	return hour >= startHour && hour < endHour;
}

/**
 * Decide whether a number may send right now, returning the first applicable
 * stop/defer reason (Req 16.1, 16.2, 16.5, 17.4, 18.2).
 *
 * The checks are evaluated in a fixed priority order, returning the first that
 * applies:
 *
 *   1. `"blocked"`      — `n.blocked` is set. A blocked number sends nothing,
 *      so the block flag dominates every other consideration (Req 18.2); there
 *      is no point inspecting the window or the cap for a number that must stay
 *      silent.
 *   2. `"defer_window"` — the current time is outside the Send_Window
 *      (Req 17.4). Outside business hours nothing may go out, so the window is
 *      checked before the cap: deferring to the window reopening is a
 *      time-based wait independent of how many messages remain in the cap.
 *   3. `"defer_cap"`    — the number has already sent its current daily cap's
 *      worth of messages (`n.dailySent >= currentDailyCap(...)`), so further
 *      sends wait until the next day (Req 16.1, 16.2, 16.5). Checked last
 *      because it is only meaningful once the number is unblocked and inside
 *      the window.
 *   4. `"allow"`        — none of the above; the number may send now.
 *
 * The ordering (block → window → cap) reflects increasing specificity and the
 * cost of being wrong: never message from a banned number, never message
 * outside permitted hours, and never exceed the daily volume.
 *
 * @param cfg - The anti-ban configuration.
 * @param n - The number's current anti-ban state (block flag + daily counter).
 * @param dayInRamp - Integer day index since the number's ramp began.
 * @param now - The instant the decision is evaluated at.
 * @returns The first applicable {@link SendDecision}.
 */
export function canSend(
	cfg: AntiBanConfig,
	n: NumberState,
	dayInRamp: number,
	now: Date,
): SendDecision {
	if (n.blocked) {
		return "blocked";
	}
	if (!withinSendWindow(cfg, now)) {
		return "defer_window";
	}
	if (n.dailySent >= currentDailyCap(cfg, dayInRamp)) {
		return "defer_cap";
	}
	return "allow";
}

/**
 * Compute a randomized inter-send delay, in milliseconds, within the configured
 * range (Req 17.1).
 *
 * Pacing draws a delay uniformly from the **inclusive** range `[cfg.delayMinMs,
 * cfg.delayMaxMs]`:
 *
 * ```text
 *   delayMinMs + floor(rng() * (delayMaxMs - delayMinMs + 1))
 * ```
 *
 * Because the injected `rng()` returns a float in `[0, 1)`, the
 * `floor(rng() * span)` term lands in the integer range `[0, span - 1]` where
 * `span = delayMaxMs - delayMinMs + 1`, so the result is always `>= delayMinMs`
 * and `<= delayMaxMs`. With integer bounds the result is an integer count of
 * milliseconds.
 *
 * Edge cases:
 *   - `delayMinMs === delayMaxMs` — the range is a single point; that value is
 *     returned directly (the formula would also yield it, but the early return
 *     avoids any dependence on `rng()`).
 *   - **Inverted range** (`delayMaxMs < delayMinMs`, a misconfiguration) — the
 *     function defensively returns `delayMinMs` rather than computing a negative
 *     span, so the result is never below the configured minimum.
 *
 * @param cfg - The anti-ban configuration carrying the delay bounds.
 * @param rng - Injected random source returning a float in `[0, 1)` (the seam
 *   that keeps pacing deterministic under test, never `Math.random()`).
 * @returns An integer delay in milliseconds within `[delayMinMs, delayMaxMs]`.
 */
export function nextDelayMs(cfg: AntiBanConfig, rng: Rng): number {
	const { delayMinMs, delayMaxMs } = cfg;

	// Defensive guard against an inverted range: never return below the minimum.
	if (delayMaxMs <= delayMinMs) {
		return delayMinMs;
	}

	// Inclusive-of-max span: floor(rng() * span) ∈ [0, span - 1] for rng ∈ [0,1).
	const span = delayMaxMs - delayMinMs + 1;
	return delayMinMs + Math.floor(rng() * span);
}
