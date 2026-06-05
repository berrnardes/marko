// Send guard (pure, no I/O).
//
// Implements the deterministic State_Guard predicate per Req 5.2–5.4 (and the
// opt-out stop condition of Req 4.6) and the design's "State Guard (pure
// predicate + worker step)" section. `evaluateSendGuard` is the pure decision
// the Cadence_Worker runs against a freshly-read lead snapshot (Req 5.1) before
// any touch; the I/O-bound worker is what actually skips the touch and cancels
// the lead's remaining cadence jobs when this returns `skip_and_cancel`.
//
// The function is total over its declared domain, has no side effects, and
// performs no I/O. It realizes the design's Property 7 ("Send guard stops
// outreach exactly on the defined stop conditions").

import type { LeadSnapshot, LifecycleState } from "./types";

/**
 * The decision returned by {@link evaluateSendGuard}.
 *
 *   - `"send"` — none of the stop conditions hold; the worker may render and
 *     enqueue the touch.
 *   - `"skip_and_cancel"` — at least one stop condition holds; the worker skips
 *     the touch and cancels the lead's remaining cadence jobs (Req 5.2–5.4).
 */
export type GuardDecision = "send" | "skip_and_cancel";

/**
 * The lifecycle states that, when observed at touch-execution time, stop
 * outreach (Req 5.2). The single source of truth for the state-based stop
 * condition, mirroring the `lifecycle.ts` style:
 *
 *   - `REPLIED`, `QUALIFYING` — the lead is already engaged and being handled
 *     conversationally, so a stale cadence touch must not be sent.
 *   - `HOT`, `WARM`, `DISQUALIFIED` — the lead has been classified out of the
 *     cadence (handed off or scored), so cadence outreach stops.
 *   - `OPTED_OUT` — the terminal opt-out state; no outbound is ever permitted
 *     (Req 5.4, 15.3).
 *
 * The funnel states `COLD_QUEUED`, `IN_CADENCE`, `CADENCE_EXHAUSTED`, and
 * `MONTHLY_NURTURE` are intentionally absent: a touch may legitimately fire
 * while the lead is still progressing through the cadence/nurture flow.
 *
 * The `satisfies` clause checks each entry is a valid {@link LifecycleState}.
 */
export const STOP_STATES: ReadonlySet<LifecycleState> = new Set([
	"REPLIED",
	"QUALIFYING",
	"HOT",
	"WARM",
	"DISQUALIFIED",
	"OPTED_OUT",
] satisfies readonly LifecycleState[]);

/**
 * Decide whether the cadence worker may send the current touch, given a
 * freshly-read snapshot of the lead (Req 5.1).
 *
 * Pure and total: it reads only {@link STOP_STATES} and the snapshot's own
 * fields, and never mutates state. Returns `"skip_and_cancel"` when **any** of
 * the defined stop conditions holds:
 *
 *   - the lead's lifecycle state is one of the {@link STOP_STATES} —
 *     `REPLIED`, `QUALIFYING`, `HOT`, `WARM`, `DISQUALIFIED`, `OPTED_OUT`
 *     (Req 5.2);
 *   - the lead's block flag is set (Req 5.3, 18.2); or
 *   - the lead's opt-in status is `"opt_out"` (Req 4.6, 5.4, 15.3).
 *
 * Otherwise returns `"send"`. The conditions are an inclusive OR: a lead that
 * triggers several of them still yields a single `"skip_and_cancel"`.
 *
 * @param lead - The freshly-read lead snapshot to evaluate.
 * @returns `"skip_and_cancel"` if any stop condition holds, else `"send"`.
 */
export function evaluateSendGuard(lead: LeadSnapshot): GuardDecision {
	if (
		STOP_STATES.has(lead.lifecycleState) ||
		lead.blocked ||
		lead.optInStatus === "opt_out"
	) {
		return "skip_and_cancel";
	}
	return "send";
}
