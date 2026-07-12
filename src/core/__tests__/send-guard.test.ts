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
		score: 0,
		blocked: false,
		unreachableAt: null,
		classificationBand: null,
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

	it.each(["blocked", "opt_out", "stop_state"] as const)(
		'returns "skip_and_cancel" for the existing %s stop condition',
		(condition) => {
			const lead =
				condition === "blocked"
					? makeLead({ blocked: true })
					: condition === "opt_out"
						? makeLead({ optInStatus: "opt_out" })
						: makeLead({ lifecycleState: "HOT" });
			expect(evaluateSendGuard(lead)).toBe("skip_and_cancel");
		},
	);
});
