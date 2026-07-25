import { describe, expect, it } from "vitest";

import { evaluateSendGuard } from "@/core/send-guard";
import type { LeadSnapshot } from "@/core/types";

/** A sendable lead: no stop condition holds. */
function makeLead(overrides: Partial<LeadSnapshot> = {}): LeadSnapshot {
	return {
		id: "lead-1",
		phoneE164: "+5547996334573",
		source: "test",
		displayName: null,
		lifecycleState: "IN_CADENCE",
		optInStatus: "opt_in",
		optInAt: null,
		blocked: false,
		unreachableAt: null,
		qualification: {
			segment: null,
			creditValue: null,
			objective: null,
			hasLanceReserve: null,
			income: null,
		},
		assignedConsultantId: null,
		lastOutboundAt: null,
		lastInboundAt: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

describe("evaluateSendGuard", () => {
	it('returns "send" when no stop condition holds', () => {
		expect(evaluateSendGuard(makeLead())).toBe("send");
	});

	it('returns "skip_and_cancel" when the lead is marked unreachable', () => {
		const lead = makeLead({ unreachableAt: new Date("2026-06-26T12:00:00Z") });
		expect(evaluateSendGuard(lead)).toBe("skip_and_cancel");
	});

	it('still returns "send" while unreachableAt is null (other fields clear)', () => {
		expect(evaluateSendGuard(makeLead({ unreachableAt: null }))).toBe("send");
	});

	it.each(["blocked", "opt_out"] as const)(
		'returns "skip_and_cancel" for the %s stop condition',
		(condition) => {
			const lead =
				condition === "blocked"
					? makeLead({ blocked: true })
					: makeLead({ optInStatus: "opt_out" });
			expect(evaluateSendGuard(lead)).toBe("skip_and_cancel");
		},
	);

	// The state-based stop conditions, stated per state so a change to
	// STOP_STATES has to be made deliberately (ADR-003).
	it.each(["REPLIED", "WON", "LOST", "OPTED_OUT"] as const)(
		'returns "skip_and_cancel" when the lead is %s',
		(lifecycleState) => {
			expect(evaluateSendGuard(makeLead({ lifecycleState }))).toBe(
				"skip_and_cancel",
			);
		},
	);

	it.each(["QUEUED", "IN_CADENCE"] as const)(
		'returns "send" while the lead is %s',
		(lifecycleState) => {
			expect(evaluateSendGuard(makeLead({ lifecycleState }))).toBe("send");
		},
	);

	it('returns "send" for a COMPLETED lead, so the T5 breakup still goes out', () => {
		// The cadence worker enqueues the fifth touch and THEN moves the lead to
		// COMPLETED, so the outbound choke point always drains that job against an
		// already-COMPLETED lead. Treating COMPLETED as a stop state would silently
		// drop the breakup message every single time.
		expect(evaluateSendGuard(makeLead({ lifecycleState: "COMPLETED" }))).toBe(
			"send",
		);
	});
});
