// Unit tests for the Nurture_Worker (task 17.1).
//
// These exercise the design's State-Guard path against in-memory fakes: the
// fresh-state re-read (Req 5.1), skip-and-cancel on every stop condition
// (Req 5.2–5.4, 6.4), and the send path that renders the nurture message,
// enqueues it onto the outbound choke point, and schedules the following
// month's job to perpetuate the one-calendar-month recurrence (Req 6.3). The
// named property test (Property 8) is the separate optional task 17.2 and is
// not implemented here.

import { renderNurture } from "@/core/messages";
import type { LeadSnapshot } from "@/core/types";
import { UnknownLeadError } from "@/services/lifecycle-manager";
import type { NurtureScheduler } from "@/services/nurture-scheduler";
import { createNurtureWorker } from "@/services/nurture-worker";
import type { OutboundSendQueue } from "@/services/outbound-worker";
import type { LeadRepository } from "@/services/repositories";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2024-03-10T13:00:00.000Z");

function makeLead(overrides: Partial<LeadSnapshot> = {}): LeadSnapshot {
	return {
		id: "lead-1",
		phoneE164: "+5511987654321",
		source: "csv",
		lifecycleState: "MONTHLY_NURTURE",
		optInStatus: "opt_in",
		optInAt: null,
		score: 0,
		blocked: false,
		unreachableAt: null,
		classificationBand: null,
		qualification: {
			segment: "imóvel",
			creditValue: 200000,
			objective: "housing",
			hasLanceReserve: true,
			income: 9000,
		},
		assignedConsultantId: null,
		lastOutboundAt: null,
		lastInboundAt: null,
		createdAt: FIXED_NOW,
		updatedAt: FIXED_NOW,
		...overrides,
	};
}

/** Build a `LeadRepository` whose `findById` returns `lead` (or null). */
function leadRepoReturning(lead: LeadSnapshot | null): LeadRepository {
	return {
		findById: vi.fn(async () => lead),
		findByPhone: vi.fn(),
		create: vi.fn(),
		updateQualification: vi.fn(),
		updateScore: vi.fn(),
		updateLifecycleState: vi.fn(),
		setOptInStatus: vi.fn(),
		setBlocked: vi.fn(),
		assignConsultant: vi.fn(),
	} as unknown as LeadRepository;
}

/** Build an `OutboundSendQueue` whose `enqueueSend` returns `jobId`. */
function outboundQueue(jobId = "send-job-1"): OutboundSendQueue {
	return { enqueueSend: vi.fn(async () => jobId) };
}

/**
 * Build a `NurtureScheduler` whose `cancel` reports `cancelled` cancelled and
 * whose `scheduleNext` returns `nextJobId`.
 */
function nurtureScheduler(
	cancelled = 2,
	nextJobId = "next-nurture-job",
): NurtureScheduler {
	return {
		startMonthly: vi.fn(async () => undefined),
		scheduleNext: vi.fn(async () => nextJobId),
		cancel: vi.fn(async () => cancelled),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NurtureWorker.process", () => {
	let leads: LeadRepository;
	let outbound: OutboundSendQueue;
	let nurture: NurtureScheduler;

	beforeEach(() => {
		leads = leadRepoReturning(makeLead());
		outbound = outboundQueue();
		nurture = nurtureScheduler();
	});

	function makeWorker(lead: LeadSnapshot | null = makeLead()) {
		leads = leadRepoReturning(lead);
		return createNurtureWorker({ leads, outbound, nurture });
	}

	it("re-reads the fresh lead snapshot before acting (Req 5.1)", async () => {
		const worker = makeWorker(makeLead());

		await worker.process({ leadId: "lead-1" });

		expect(leads.findById).toHaveBeenCalledWith("lead-1");
	});

	it("renders the nurture, enqueues an outbound send, and schedules next month (Req 6.3)", async () => {
		const lead = makeLead();
		const worker = makeWorker(lead);

		const outcome = await worker.process({ leadId: "lead-1" });

		expect(outbound.enqueueSend).toHaveBeenCalledWith({
			leadId: "lead-1",
			content: renderNurture({
				displayName: null,
				qualification: lead.qualification,
			}),
			kind: "nurture",
		});
		// The following month's nurture is scheduled to continue the recurrence.
		expect(nurture.scheduleNext).toHaveBeenCalledWith("lead-1");
		expect(nurture.cancel).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: "sent",
			leadId: "lead-1",
			sendJobId: "send-job-1",
			nextJobId: "next-nurture-job",
		});
	});

	it.each<LeadSnapshot["lifecycleState"]>([
		"REPLIED",
		"QUALIFYING",
		"HOT",
		"WARM",
		"DISQUALIFIED",
		"OPTED_OUT",
	])(
		"skips the nurture, cancels pending jobs, and ends the chain when the lead is %s (Req 5.2, 6.4)",
		async (lifecycleState) => {
			const worker = makeWorker(makeLead({ lifecycleState }));

			const outcome = await worker.process({ leadId: "lead-1" });

			expect(outbound.enqueueSend).not.toHaveBeenCalled();
			expect(nurture.scheduleNext).not.toHaveBeenCalled();
			expect(nurture.cancel).toHaveBeenCalledWith("lead-1");
			expect(outcome).toEqual({
				status: "skipped",
				leadId: "lead-1",
				cancelledJobs: 2,
			});
		},
	);

	it("skips and cancels when the lead is blocked (Req 5.3)", async () => {
		const worker = makeWorker(makeLead({ blocked: true }));

		const outcome = await worker.process({ leadId: "lead-1" });

		expect(outbound.enqueueSend).not.toHaveBeenCalled();
		expect(nurture.cancel).toHaveBeenCalledWith("lead-1");
		expect(outcome.status).toBe("skipped");
	});

	it("skips and cancels when the lead has opted out (Req 5.4)", async () => {
		const worker = makeWorker(makeLead({ optInStatus: "opt_out" }));

		const outcome = await worker.process({ leadId: "lead-1" });

		expect(outbound.enqueueSend).not.toHaveBeenCalled();
		expect(nurture.cancel).toHaveBeenCalledWith("lead-1");
		expect(outcome.status).toBe("skipped");
	});

	it("throws UnknownLeadError when the lead does not exist", async () => {
		const worker = makeWorker(null);

		await expect(worker.process({ leadId: "lead-1" })).rejects.toBeInstanceOf(
			UnknownLeadError,
		);
	});
});
