// Lifecycle transition table (pure, no I/O).
//
// The executable form of `docs/adr/003-maquina-de-estados-do-lead.md`: seven
// states, and the exact set of moves between them. This module is the single
// source of truth for which lifecycle moves are lawful; the I/O-bound
// `LifecycleManager` wraps `transition` with persistence and writes only when
// the move is `ok`.
//
// Pure and total over its declared domain: no side effects, no I/O. It realizes
// the design's Property 19 ("lifecycle transitions are valid exactly when
// defined, and OPTED_OUT is terminal").
//
// One thing the table deliberately does NOT express: WHO may take an edge.
// `WON → REPLIED` is a lawful move, but only a consultant correcting a
// mis-click may take it — an inbound message must never resurrect a closed
// lead. That distinction is the second export here, {@link stateAfterReply},
// which is what the inbound path asks instead of consulting the table directly.

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
 * (ADR-003 rule 1) and can never leave it, so it is both the universal opt-out
 * target and the one state with no outgoing transitions.
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
	"QUEUED",
	"IN_CADENCE",
	"REPLIED",
	"COMPLETED",
	"WON",
	"LOST",
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
 * The lifecycle edges, excluding the universal opt-out edges derived in
 * {@link buildTransitionTable}. Hand-authored, and a line-by-line mirror of the
 * ADR-003 diagram:
 *
 *   - `QUEUED → IN_CADENCE` — the scheduler enrolls the lead and creates T1–T5.
 *   - `IN_CADENCE → REPLIED` — an inbound reply; cancels the pending touches
 *     and alerts the consultant (rule 3).
 *   - `IN_CADENCE → COMPLETED` — the fifth touch went out with no reply.
 *   - `COMPLETED → REPLIED` — a LATE reply. This single edge is what makes the
 *     late-reply case ordinary instead of a special case in the webhook
 *     (rule 2).
 *   - `COMPLETED → QUEUED` — the consultant re-enqueues the lead by hand
 *     (rule 5). No job or import ever takes this edge.
 *   - `REPLIED → WON` / `REPLIED → LOST` — the consultant records the outcome.
 *   - `WON → REPLIED` / `LOST → REPLIED` — undoing a mis-clicked outcome
 *     (rule 4). These are the edges {@link stateAfterReply} exists to keep the
 *     inbound path away from.
 *
 * `OPTED_OUT` is absent: it is terminal and gains nothing.
 */
const LIFECYCLE_EDGES: {
	readonly [S in LifecycleState]?: readonly LifecycleState[];
} = {
	QUEUED: ["IN_CADENCE"],
	IN_CADENCE: ["REPLIED", "COMPLETED"],
	REPLIED: ["WON", "LOST"],
	COMPLETED: ["REPLIED", "QUEUED"],
	WON: ["REPLIED"],
	LOST: ["REPLIED"],
};

/**
 * Build the complete transition table: every state mapped to the set of states
 * it may transition into. Assembled from {@link LIFECYCLE_EDGES} plus the
 * derived rule that every non-terminal state may transition to `OPTED_OUT`
 * (rule 1). The terminal state keeps an empty set, so no transition out of
 * `OPTED_OUT` is ever permitted.
 */
function buildTransitionTable(): ReadonlyMap<
	LifecycleState,
	ReadonlySet<LifecycleState>
> {
	const table = new Map<LifecycleState, Set<LifecycleState>>();
	for (const state of LIFECYCLE_STATES) {
		table.set(state, new Set<LifecycleState>());
	}

	for (const state of LIFECYCLE_STATES) {
		const targets = LIFECYCLE_EDGES[state];
		if (!targets) continue;
		const allowed = table.get(state)!;
		for (const target of targets) {
			allowed.add(target);
		}
	}

	// Universal opt-out edge from every non-terminal state (rule 1). The terminal
	// state is skipped, which is what keeps `OPTED_OUT` terminal.
	for (const state of LIFECYCLE_STATES) {
		if (state !== TERMINAL_STATE) {
			table.get(state)!.add(TERMINAL_STATE);
		}
	}

	return table;
}

/**
 * The lifecycle transition table — the single source of truth for which moves
 * between {@link LifecycleState} values are lawful. Maps each state to the
 * immutable set of states it may transition into. Consumed by
 * {@link transition} and reused by the `LifecycleManager` service.
 */
export const TRANSITION_TABLE: ReadonlyMap<
	LifecycleState,
	ReadonlySet<LifecycleState>
> = buildTransitionTable();

/**
 * The states an inbound reply may move a lead OUT of (ADR-003 rule 2).
 *
 * Only these two. A lead already in `REPLIED`, `WON`, or `LOST` is with the
 * consultant: further messages are part of that conversation and must not
 * change state or re-alert anybody. `QUEUED` is excluded too — a lead that
 * somehow replies before its first touch has nothing to cancel and no cadence
 * to interrupt.
 */
export const REPLY_SOURCE_STATES: ReadonlySet<LifecycleState> = new Set([
	"IN_CADENCE",
	"COMPLETED",
] satisfies readonly LifecycleState[]);

/**
 * The state a lead should move to when it sends an inbound reply, or `null`
 * when the reply must leave the state untouched (ADR-003 rule 2).
 *
 * This is the rule the inbound path asks — NOT `transition(from, "REPLIED")`.
 * The two differ in exactly the case that matters: `WON → REPLIED` and
 * `LOST → REPLIED` are lawful *manual* corrections, so the table accepts them,
 * but an incoming WhatsApp message must never reopen a closed lead. Asking here
 * keeps that decision in one place instead of leaving each caller to remember
 * it.
 *
 * A `null` result is not an error: the message is still recorded in the lead's
 * history, it simply causes no transition and no consultant alert.
 *
 * @param from - The lead's current lifecycle state.
 * @returns `"REPLIED"` when the reply should transition the lead, else `null`.
 */
export function stateAfterReply(from: LifecycleState): LifecycleState | null {
	return REPLY_SOURCE_STATES.has(from) ? "REPLIED" : null;
}

/**
 * Validate a requested lifecycle transition against the transition table.
 *
 * Pure and total: it reads {@link TRANSITION_TABLE} and never mutates state.
 * A transition succeeds **if and only if** `(from, to)` is present in the
 * table:
 *
 *   - the defined edges succeed (see {@link LIFECYCLE_EDGES});
 *   - `to === "OPTED_OUT"` succeeds from every non-terminal state (rule 1);
 *   - every move out of `OPTED_OUT` is rejected — it is terminal;
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
