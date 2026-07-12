// Unit tests for the concrete Scoring_Engine (recompute + persist).
//
// Exercises the signal derivation from a Lead snapshot (Req 10.1), the base
// score via the pure core (Req 10.2–10.4), band classification (Req 12), and
// persistence of the recomputed `{ score, band }` (Req 11.1, 19.4) against an
// in-memory LeadRepository.

import { describe, expect, it, vi } from "vitest";

import type { Clock, LeadSnapshot, QualificationFields } from "@/core/types";
import type { LeadRepository } from "@/services/repositories";
import {
	createScoringEngine,
	deriveScoringSignals,
} from "@/services/scoring-engine";

const FIXED_NOW = new Date("2024-03-10T13:00:00.000Z");
const clock: Clock = { now: () => FIXED_NOW };
const sendWindow = { startHour: 9, endHour: 20 };

function snapshot(
	overrides: Partial<Omit<LeadSnapshot, "qualification">> & {
		qualification?: Partial<QualificationFields>;
	} = {},
): LeadSnapshot {
	const { qualification: qOverride, ...rest } = overrides;
	const qualification: QualificationFields = {
		segment: null,
		creditValue: null,
		objective: null,
		hasLanceReserve: null,
		income: null,
		...(qOverride ?? {}),
	};
	return {
		id: "lead-1",
		phoneE164: "+5547996334573",
		source: "csv",
		displayName: null,
		lifecycleState: "QUALIFYING",
		optInStatus: "opt_in",
		optInAt: null,
		score: 0,
		blocked: false,
		unreachableAt: null,
		classificationBand: null,
		assignedConsultantId: null,
		lastOutboundAt: null,
		lastInboundAt: null,
		createdAt: FIXED_NOW,
		updatedAt: FIXED_NOW,
		...rest,
		qualification,
	};
}

describe("deriveScoringSignals", () => {
	it("treats a BR mobile (13-digit, 9th digit) as non-VoIP mobile", () => {
		const s = deriveScoringSignals(snapshot(), sendWindow);
		expect(s.mobileNonVoip).toBe(true);
	});

	it("does not flag a landline (no 9th digit) as mobile", () => {
		const s = deriveScoringSignals(
			snapshot({ phoneE164: "+554733334444" }),
			sendWindow,
		);
		expect(s.mobileNonVoip).toBe(false);
	});

	it("marks all questions answered only when every field is filled", () => {
		const partial = deriveScoringSignals(
			snapshot({
				qualification: {
					segment: "real_estate",
					creditValue: 100_000,
					objective: "housing",
					hasLanceReserve: true,
					income: null,
				},
			}),
			sendWindow,
		);
		expect(partial.allQuestionsAnswered).toBe(false);

		const complete = deriveScoringSignals(
			snapshot({
				qualification: {
					segment: "real_estate",
					creditValue: 100_000,
					objective: "housing",
					hasLanceReserve: true,
					income: 8_000,
				},
			}),
			sendWindow,
		);
		expect(complete.allQuestionsAnswered).toBe(true);
	});

	it("disqualifies when income clearly cannot carry the credit value", () => {
		const s = deriveScoringSignals(
			snapshot({ qualification: { income: 1_000, creditValue: 500_000 } }),
			sendWindow,
		);
		expect(s.incomeCompatible).toBe(false);
		expect(s.disqualifying).toBe(true);
	});

	it("does not disqualify on an unknown income", () => {
		const s = deriveScoringSignals(
			snapshot({ qualification: { income: null, creditValue: 500_000 } }),
			sendWindow,
		);
		expect(s.disqualifying).toBe(false);
	});

	it("derives reply-window and 10-minute signals from the snapshot timestamps", () => {
		const lastOutboundAt = new Date("2024-03-10T13:00:00.000Z");
		const within = deriveScoringSignals(
			snapshot({
				lastOutboundAt,
				lastInboundAt: new Date("2024-03-10T13:05:00.000Z"),
			}),
			sendWindow,
		);
		expect(within.repliedWithin10Min).toBe(true);
		// 13:05 local is inside 9–20.
		expect(within.repliedInSendWindow).toBe(true);

		const late = deriveScoringSignals(
			snapshot({
				lastOutboundAt,
				lastInboundAt: new Date("2024-03-10T13:30:00.000Z"),
			}),
			sendWindow,
		);
		expect(late.repliedWithin10Min).toBe(false);
	});
});

describe("ScoringEngineService.recompute", () => {
	it("computes, classifies, and persists the score for a hot lead", async () => {
		const lead = snapshot({
			lastOutboundAt: new Date("2024-03-10T13:00:00.000Z"),
			lastInboundAt: new Date("2024-03-10T13:01:00.000Z"),
			qualification: {
				segment: "real_estate",
				creditValue: 100_000,
				objective: "housing",
				hasLanceReserve: true,
				income: 8_000,
			},
		});
		const updateScore = vi.fn(async () => lead);
		const leads = {
			findById: vi.fn(async () => lead),
			updateScore,
		} as unknown as LeadRepository;

		const engine = createScoringEngine({ leads, clock, sendWindow });
		const result = await engine.recompute("lead-1");

		// allQuestionsAnswered(20)+incomeCompatible(25)+hasLanceReserve(20)
		// +clearObjective(15)+repliedWithin10Min(10)+repliedInSendWindow(5)
		// +mobileNonVoip(5) = 100 → HOT.
		expect(result.score).toBe(100);
		expect(result.band).toBe("HOT");
		expect(updateScore).toHaveBeenCalledWith("lead-1", 100, "HOT");
	});

	it("throws for an unknown lead", async () => {
		const leads = {
			findById: vi.fn(async () => null),
			updateScore: vi.fn(),
		} as unknown as LeadRepository;
		const engine = createScoringEngine({ leads, clock, sendWindow });
		await expect(engine.recompute("missing")).rejects.toThrow();
	});
});
