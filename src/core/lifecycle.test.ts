import { describe, expect, it } from "vitest";
import { transition } from "./lifecycle";

describe("lifecycle transition", () => {
	it("accepts a valid funnel move: COLD_QUEUED → IN_CADENCE", () => {
		const result = transition("COLD_QUEUED", "IN_CADENCE");
		expect(result).toEqual({ ok: true, from: "COLD_QUEUED", to: "IN_CADENCE" });
	});

	it("accepts opt-out from any non-terminal state", () => {
		const result = transition("IN_CADENCE", "OPTED_OUT");
		expect(result).toEqual({ ok: true, from: "IN_CADENCE", to: "OPTED_OUT" });
	});

	it("rejects transitions out of the terminal OPTED_OUT state", () => {
		const result = transition("OPTED_OUT", "COLD_QUEUED");
		expect(result).toEqual({
			ok: false,
			reason: "invalid_transition",
			state: "OPTED_OUT",
		});
	});

	it("rejects an undefined transition", () => {
		const result = transition("COLD_QUEUED", "HOT");
		// COLD_QUEUED can go to HOT via handoff edge — let's check a truly invalid one
		const invalid = transition("HOT", "COLD_QUEUED");
		expect(invalid).toEqual({
			ok: false,
			reason: "invalid_transition",
			state: "HOT",
		});
	});
});
