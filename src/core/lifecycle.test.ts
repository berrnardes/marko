// The seven-state lifecycle table (ADR-003).
//
// The ADR's diagram is the specification and this file is its executable form:
// the `EXPECTED_EDGES` map below is transcribed from the ADR, and one test
// checks the built table against it EXHAUSTIVELY — all 49 ordered state pairs,
// asserting both that the listed moves are accepted and that every unlisted one
// is rejected. That matters more than spot-checking a few transitions: the bug
// this machine exists to fix was a missing edge, and a table that silently
// gains an extra one is the same class of defect.

import { describe, expect, it } from "vitest";

import type { LifecycleState } from "./types";
import {
	LIFECYCLE_STATES,
	REPLY_SOURCE_STATES,
	stateAfterReply,
	transition,
} from "./lifecycle";

/**
 * Every lawful move, transcribed from the ADR-003 diagram. Opt-out edges are
 * written out rather than derived so this stays an independent statement of the
 * spec — deriving them the way `lifecycle.ts` does would make the test agree
 * with the implementation by construction.
 */
const EXPECTED_EDGES: Record<LifecycleState, readonly LifecycleState[]> = {
	QUEUED: ["IN_CADENCE", "OPTED_OUT"],
	IN_CADENCE: ["REPLIED", "COMPLETED", "OPTED_OUT"],
	REPLIED: ["WON", "LOST", "OPTED_OUT"],
	COMPLETED: ["REPLIED", "QUEUED", "OPTED_OUT"],
	WON: ["REPLIED", "OPTED_OUT"],
	LOST: ["REPLIED", "OPTED_OUT"],
	OPTED_OUT: [],
};

describe("lifecycle transition table", () => {
	it("has exactly seven states", () => {
		expect(LIFECYCLE_STATES).toHaveLength(7);
	});

	it("matches ADR-003 on all 49 state pairs, accepting and rejecting", () => {
		const wrong: string[] = [];

		for (const from of LIFECYCLE_STATES) {
			for (const to of LIFECYCLE_STATES) {
				const shouldAccept = EXPECTED_EDGES[from].includes(to);
				const accepted = transition(from, to).ok;
				if (accepted !== shouldAccept) {
					wrong.push(
						`${from} → ${to}: expected ${shouldAccept ? "accept" : "reject"}, got ${accepted ? "accept" : "reject"}`,
					);
				}
			}
		}

		expect(wrong).toEqual([]);
	});

	it("leaves the state untouched when it rejects (Req 14.5)", () => {
		expect(transition("WON", "IN_CADENCE")).toEqual({
			ok: false,
			reason: "invalid_transition",
			state: "WON",
		});
	});

	it("rejects every self-transition", () => {
		for (const state of LIFECYCLE_STATES) {
			expect(transition(state, state).ok, `${state} → ${state}`).toBe(false);
		}
	});

	it("makes OPTED_OUT reachable from everywhere and escapable from nowhere", () => {
		for (const state of LIFECYCLE_STATES) {
			if (state === "OPTED_OUT") continue;
			expect(transition(state, "OPTED_OUT").ok, `${state} → OPTED_OUT`).toBe(
				true,
			);
			expect(transition("OPTED_OUT", state).ok, `OPTED_OUT → ${state}`).toBe(
				false,
			);
		}
	});

	it("keeps COMPLETED non-terminal: a late reply and a re-enqueue both work", () => {
		// The whole point of `COMPLETED` over the old `CADENCE_EXHAUSTED` dead end.
		expect(transition("COMPLETED", "REPLIED").ok).toBe(true);
		expect(transition("COMPLETED", "QUEUED").ok).toBe(true);
	});

	it("lets a consultant undo a mis-clicked outcome through REPLIED", () => {
		expect(transition("REPLIED", "WON").ok).toBe(true);
		expect(transition("WON", "REPLIED").ok).toBe(true);
		expect(transition("REPLIED", "LOST").ok).toBe(true);
		expect(transition("LOST", "REPLIED").ok).toBe(true);
		// But never directly between the two outcomes — that would skip the
		// deliberate step back through REPLIED.
		expect(transition("WON", "LOST").ok).toBe(false);
		expect(transition("LOST", "WON").ok).toBe(false);
	});
});

describe("stateAfterReply (ADR-003 rule 2)", () => {
	it("transitions only from IN_CADENCE and COMPLETED", () => {
		expect(stateAfterReply("IN_CADENCE")).toBe("REPLIED");
		expect(stateAfterReply("COMPLETED")).toBe("REPLIED");
		expect(REPLY_SOURCE_STATES.size).toBe(2);
	});

	it("ignores replies from a lead already with its consultant", () => {
		// The regression guard for the alert-storm case: a chatty lead must not
		// re-notify on every message.
		expect(stateAfterReply("REPLIED")).toBeNull();
	});

	it("never reopens a closed lead, even though the table allows the manual edge", () => {
		// This is the whole reason `stateAfterReply` exists instead of callers
		// asking `transition(from, "REPLIED")` directly: the table accepts
		// WON → REPLIED as a manual correction, but an inbound WhatsApp message
		// must not take that edge.
		expect(transition("WON", "REPLIED").ok).toBe(true);
		expect(transition("LOST", "REPLIED").ok).toBe(true);
		expect(stateAfterReply("WON")).toBeNull();
		expect(stateAfterReply("LOST")).toBeNull();
	});

	it("ignores replies from QUEUED and OPTED_OUT", () => {
		// QUEUED has no cadence to interrupt; OPTED_OUT is terminal.
		expect(stateAfterReply("QUEUED")).toBeNull();
		expect(stateAfterReply("OPTED_OUT")).toBeNull();
	});
});
