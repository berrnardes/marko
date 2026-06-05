// Lifecycle transition table (pure, no I/O).
//
// Implements the deterministic `transition` function and the lifecycle
// transition table per Req 14 and the design's "Lifecycle_Manager (pure
// transition + persistence wrapper)" and "Lifecycle State Machine" sections.
// The transition table here is the single source of truth for which lifecycle
// moves are lawful; the I/O-bound `LifecycleManager` service (a later task)
// wraps this pure check with persistence, writing only when a transition is
// `ok`.
//
// The function is total over its declared domain, has no side effects, and
// performs no I/O. It realizes the design's Property 19 ("Lifecycle
// transitions are valid exactly when defined, and OPTED_OUT is terminal").

import type { LifecycleState } from "./types";

/**
 * The result of validating a requested lifecycle transition.
 *
 *   - On success, carries the `from`/`to` pair that was accepted.
 *   - On rejection, carries `state`: the lead's unchanged lifecycle state
 *     (Req 14.5 — a rejected transition leaves the state untouched). The
 *     `reason` is always `"invalid_transition"`; it is a discriminant kept
 *     for symmetry with the design and to leave room for future reasons.
 */
export type TransitionResult =
	| { ok: true; from: LifecycleState; to: LifecycleState }
	| { ok: false; reason: "invalid_transition"; state: LifecycleState };

/**
 * The terminal lifecycle state. A lead enters `OPTED_OUT` from any other state
 * (Req 14.3) and can never leave it (Req 14.4), so it is both the universal
 * opt-out target and the one state with no outgoing transitions.
 */
const TERMINAL_STATE = "OPTED_OUT" satisfies LifecycleState;

/**
 * Every lifecycle state, as a runtime array. The string-literal union
 * {@link LifecycleState} is erased at runtime, so this array is the runtime
 * companion the transition table is built over (and a useful export for the
 * property test that enumerates state pairs).
 *
 * The `satisfies` clause checks each entry is a valid {@link LifecycleState};
 * the `_AllStatesCovered` guard below additionally checks the array is
 * *complete*, so adding a state to the union without adding it here is a
 * compile error.
 */
export const LIFECYCLE_STATES = [
	"COLD_QUEUED",
	"IN_CADENCE",
	"REPLIED",
	"QUALIFYING",
	"HOT",
	"WARM",
	"DISQUALIFIED",
	"CADENCE_EXHAUSTED",
	"MONTHLY_NURTURE",
	"OPTED_OUT",
] as const satisfies readonly LifecycleState[];

// Compile-time exhaustiveness guard: if a member of `LifecycleState` is missing
// from `LIFECYCLE_STATES`, `Exclude<...>` is non-`never` and this assignment
// fails to type-check. (Purely a type check; the value is never used.)
type _AllStatesCovered =
	Exclude<LifecycleState, (typeof LIFECYCLE_STATES)[number]> extends never
		? true
		: never;
const _allStatesCovered: _AllStatesCovered = true;
void _allStatesCovered;

/**
 * The funnel transitions of the lifecycle (Req 14.2), excluding the universal
 * opt-out edges which are derived in {@link buildTransitionTable}. This is the
 * hand-authored portion of the single source of truth and mirrors the design's
 * state-machine diagram exactly:
 *
 *   - the primary path
 *     `COLD_QUEUED → IN_CADENCE → REPLIED → QUALIFYING → {HOT, WARM, DISQUALIFIED}`,
 *   - the parallel cadence-exhaustion path
 *     `IN_CADENCE → CADENCE_EXHAUSTED → MONTHLY_NURTURE`,
 *   - `MONTHLY_NURTURE → REPLIED` (a nurtured lead that replies re-qualifies,
 *     Req 6.4), and
 *   - `WARM → HOT` (a rising score promotes to hot regardless of stage,
 *     Req 13.1).
 *
 * States with no funnel-outgoing edge (`HOT`, `DISQUALIFIED`, and the terminal
 * `OPTED_OUT`) are intentionally absent; they gain only the derived opt-out
 * edge (except `OPTED_OUT`, which gains nothing).
 */
const FUNNEL_TRANSITIONS: {
	readonly [S in LifecycleState]?: readonly LifecycleState[];
} = {
	COLD_QUEUED: ["IN_CADENCE"],
	IN_CADENCE: ["REPLIED", "CADENCE_EXHAUSTED"],
	REPLIED: ["QUALIFYING"],
	QUALIFYING: ["HOT", "WARM", "DISQUALIFIED"],
	WARM: ["HOT"],
	CADENCE_EXHAUSTED: ["MONTHLY_NURTURE"],
	MONTHLY_NURTURE: ["REPLIED"],
};

/**
 * Build the complete transition table: every state mapped to the set of states
 * it may transition into. It is assembled from {@link FUNNEL_TRANSITIONS} plus
 * the derived rule that every non-terminal state may transition to
 * `OPTED_OUT` (Req 14.3). The terminal state keeps an empty set, so no
 * transition out of `OPTED_OUT` is ever permitted (Req 14.4).
 */
function buildTransitionTable(): ReadonlyMap<
	LifecycleState,
	ReadonlySet<LifecycleState>
> {
	const table = new Map<LifecycleState, Set<LifecycleState>>();
	for (const state of LIFECYCLE_STATES) {
		table.set(state, new Set<LifecycleState>());
	}

	// Funnel edges (Req 14.2).
	for (const state of LIFECYCLE_STATES) {
		const targets = FUNNEL_TRANSITIONS[state];
		if (!targets) continue;
		const allowed = table.get(state)!;
		for (const target of targets) {
			allowed.add(target);
		}
	}

	// Universal opt-out edge from every non-terminal state (Req 14.3). The
	// terminal state is skipped, which is what keeps `OPTED_OUT` terminal
	// (Req 14.4).
	for (const state of LIFECYCLE_STATES) {
		if (state !== TERMINAL_STATE) {
			table.get(state)!.add(TERMINAL_STATE);
		}
	}

	return table;
}

/**
 * The lifecycle transition table — the single source of truth for which moves
 * between {@link LifecycleState} values are lawful (Req 14). Maps each state to
 * the immutable set of states it may transition into. Consumed by
 * {@link transition} and reused by the `LifecycleManager` service.
 */
export const TRANSITION_TABLE: ReadonlyMap<
	LifecycleState,
	ReadonlySet<LifecycleState>
> = buildTransitionTable();

/**
 * Validate a requested lifecycle transition against the transition table.
 *
 * Pure and total: it reads {@link TRANSITION_TABLE} and never mutates state.
 * A transition succeeds **if and only if** `(from, to)` is present in the
 * table:
 *
 *   - defined funnel moves succeed (Req 14.2);
 *   - `to === "OPTED_OUT"` succeeds from every non-terminal state (Req 14.3);
 *   - every move out of `OPTED_OUT` is rejected — it is terminal (Req 14.4);
 *   - every other pair (including self-transitions and undefined moves) is
 *     rejected, leaving the state unchanged (Req 14.5).
 *
 * Because exactly one valid state is reported back on success and the original
 * state is preserved on rejection, callers that persist only on `ok` keep a
 * lead in exactly one valid state at all times (Req 14.1).
 *
 * @param from - The lead's current lifecycle state.
 * @param to - The requested next lifecycle state.
 * @returns A {@link TransitionResult}: `ok: true` with the accepted pair, or
 *          `ok: false` with the unchanged `state`.
 */
export function transition(
	from: LifecycleState,
	to: LifecycleState,
): TransitionResult {
	const allowed = TRANSITION_TABLE.get(from);
	if (allowed?.has(to)) {
		return { ok: true, from, to };
	}
	return { ok: false, reason: "invalid_transition", state: from };
}
