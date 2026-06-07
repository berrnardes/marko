// Unit tests for the Cadence_Worker (task 16.3).
//
// These exercise the design's State-Guard path against in-memory fakes: the
// fresh-state re-read (Req 5.1), skip-and-cancel on every stop condition
// (Req 5.2–5.4), the send path that renders a touch and enqueues it onto the
// outbound choke point (Req 4.1–4.5), and the T5 special case that exhausts the
// cadence and triggers monthly nurture (Req 4.6, 6.1, 6.2). The named property
// test for enrollment/cancellable touches (Property 4) is the separate task
// 16.2 and is not implemented here.

import { renderTouch } from "@/core/messages";
import type { LeadSnapshot } from "@/core/types";
import type { CadenceScheduler } from "@/services/cadence-scheduler";
import {
	createCadenceWorker,
	type NurtureTrigger,
} from "@/services/cadence-worker";
import {
	UnknownLeadError,
	type LifecycleManager,
} from "@/services/lifecycle-manager";
import type { OutboundSendQueue } from "@/services/outbound-worker";
import type {
	LeadRepository,
	ScheduledJobRecord,
	ScheduledJobRepository,
} from "@/services/repositories";
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
		lifecycleState: "IN_CADENCE",
		optInStatus: "opt_in",
		optInAt: null,
		score: 0,
		blocked: false,
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

/** Build a `CadenceScheduler` whose `cancelAll` reports `cancelled` cancelled. */
function schedulerCancelling(cancelled = 3): CadenceScheduler {
	return {
		enroll: vi.fn(),
		cancelAll: vi.fn(async () => cancelled),
	} as unknown as CadenceScheduler;
}

/** Build an `OutboundSendQueue` whose `enqueueSend` returns `jobId`. */
function outboundQueue(jobId = "send-job-1"): OutboundSendQueue {
	return { enqueueSend: vi.fn(async () => jobId) };
}

/** Build a `LifecycleManager` whose `apply` succeeds (or is rejected). */
function lifecycleApplying(ok = true): LifecycleManager {
	return {
		apply: vi.fn(async (_leadId: string, to: LeadSnapshot["lifecycleState"]) =>
			ok
				? { ok: true as const, from: "IN_CADENCE" as const, to }
				: {
						ok: false as const,
						reason: "invalid_transition" as const,
						state: "REPLIED" as const,
					},
		),
	} as unknown as LifecycleManager;
}

/** Build a `NurtureTrigger` recording its `startMonthly` calls. */
function nurtureTrigger(): NurtureTrigger {
	return { startMonthly: vi.fn(async () => undefined) };
}

/**
 * Build a `ScheduledJobRepository` exposing one pending `cadence` mirror row per
 * touch in `touches`, and recording `updateStatus` calls so tests can assert the
 * worker advances the firing touch out of `pending`.
 */
function scheduledJobsWithPending(
	touches: Array<ScheduledJobRecord["touch"]>,
): {
	repo: ScheduledJobRepository;
	rowIdFor: (touch: ScheduledJobRecord["touch"]) => string;
} {
	const rows: ScheduledJobRecord[] = touches.map((touch, i) => ({
		id: `row-${touch}`,
		leadId: "lead-1",
		jobKind: "cadence",
		touch,
		pgbossJobId: `pgboss-${i}`,
		plannedFor: FIXED_NOW,
		status: "pending",
	}));
	const repo = {
		create: vi.fn(),
		listByLead: vi.fn(async (_leadId: string, status?: string) =>
			status === undefined ? rows : rows.filter((r) => r.status === status),
		),
		updateStatus: vi.fn(async () => undefined),
		cancelAllForLead: vi.fn(async () => 0),
	} as unknown as ScheduledJobRepository;
	return { repo, rowIdFor: (touch) => `row-${touch}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CadenceWorker.process", () => {
	let leads: LeadRepository;
	let cadence: CadenceScheduler;
	let outbound: OutboundSendQueue;
	let lifecycle: LifecycleManager;
	let nurture: NurtureTrigger;

	beforeEach(() => {
		leads = leadRepoReturning(makeLead());
		cadence = schedulerCancelling();
		outbound = outboundQueue();
		lifecycle = lifecycleApplying();
		nurture = nurtureTrigger();
	});

	function makeWorker(lead: LeadSnapshot | null = makeLead()) {
		leads = leadRepoReturning(lead);
		return createCadenceWorker({
			leads,
			cadence,
			outbound,
			lifecycle,
			nurture,
		});
	}

	it("re-reads the fresh lead snapshot before acting (Req 5.1)", async () => {
		const worker = makeWorker(makeLead());

		await worker.process({ leadId: "lead-1", touch: "T1" });

		expect(leads.findById).toHaveBeenCalledWith("lead-1");
	});

	it("renders the touch and enqueues an outbound send on the send path (Req 4.1)", async () => {
		const lead = makeLead();
		const worker = makeWorker(lead);

		const outcome = await worker.process({ leadId: "lead-1", touch: "T1" });

		expect(outbound.enqueueSend).toHaveBeenCalledWith({
			leadId: "lead-1",
			content: renderTouch("T1", {
				displayName: null,
				qualification: lead.qualification,
			}),
			kind: "cadence",
		});
		// No lifecycle change or nurture for a non-T5 touch.
		expect(lifecycle.apply).not.toHaveBeenCalled();
		expect(nurture.startMonthly).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: "sent",
			leadId: "lead-1",
			touch: "T1",
			jobId: "send-job-1",
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
		"skips the touch and cancels remaining jobs when the lead is %s (Req 5.2)",
		async (lifecycleState) => {
			const worker = makeWorker(makeLead({ lifecycleState }));

			const outcome = await worker.process({ leadId: "lead-1", touch: "T2" });

			expect(outbound.enqueueSend).not.toHaveBeenCalled();
			expect(cadence.cancelAll).toHaveBeenCalledWith("lead-1");
			expect(outcome).toEqual({
				status: "skipped",
				leadId: "lead-1",
				touch: "T2",
				cancelledJobs: 3,
			});
		},
	);

	it("skips and cancels when the lead is blocked (Req 5.3)", async () => {
		const worker = makeWorker(makeLead({ blocked: true }));

		const outcome = await worker.process({ leadId: "lead-1", touch: "T3" });

		expect(outbound.enqueueSend).not.toHaveBeenCalled();
		expect(cadence.cancelAll).toHaveBeenCalledWith("lead-1");
		expect(outcome.status).toBe("skipped");
	});

	it("skips and cancels when the lead has opted out (Req 5.4)", async () => {
		const worker = makeWorker(makeLead({ optInStatus: "opt_out" }));

		const outcome = await worker.process({ leadId: "lead-1", touch: "T4" });

		expect(outbound.enqueueSend).not.toHaveBeenCalled();
		expect(cadence.cancelAll).toHaveBeenCalledWith("lead-1");
		expect(outcome.status).toBe("skipped");
	});

	it("on T5 for a non-replying lead, enqueues the breakup then exhausts and nurtures (Req 4.6, 6.1, 6.2)", async () => {
		const worker = makeWorker(makeLead());

		const outcome = await worker.process({ leadId: "lead-1", touch: "T5" });

		// The breakup send is enqueued (Req 4.6).
		expect(outbound.enqueueSend).toHaveBeenCalledTimes(1);
		// Then the lead is exhausted (Req 6.1) and nurture is triggered (Req 6.2).
		expect(lifecycle.apply).toHaveBeenCalledWith("lead-1", "CADENCE_EXHAUSTED");
		expect(nurture.startMonthly).toHaveBeenCalledWith("lead-1");
		expect(outcome).toEqual({
			status: "exhausted",
			leadId: "lead-1",
			touch: "T5",
			jobId: "send-job-1",
		});
	});

	it("does not trigger nurture when the CADENCE_EXHAUSTED transition is rejected", async () => {
		lifecycle = lifecycleApplying(false);
		const worker = makeWorker(makeLead());

		const outcome = await worker.process({ leadId: "lead-1", touch: "T5" });

		expect(outbound.enqueueSend).toHaveBeenCalledTimes(1);
		expect(nurture.startMonthly).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: "sent",
			leadId: "lead-1",
			touch: "T5",
			jobId: "send-job-1",
		});
	});

	it("throws UnknownLeadError when the lead does not exist", async () => {
		const worker = makeWorker(null);

		await expect(
			worker.process({ leadId: "lead-1", touch: "T1" }),
		).rejects.toBeInstanceOf(UnknownLeadError);
	});

	it("advances the firing touch's mirror row to `done` on the send path", async () => {
		const { repo } = scheduledJobsWithPending(["T1", "T2", "T3"]);
		const worker = createCadenceWorker({
			leads: leadRepoReturning(makeLead()),
			cadence,
			outbound,
			lifecycle,
			nurture,
			scheduledJobs: repo,
		});

		await worker.process({ leadId: "lead-1", touch: "T1" });

		expect(repo.updateStatus).toHaveBeenCalledWith("row-T1", "done");
		// Only the firing touch's row is advanced — siblings stay pending.
		expect(repo.updateStatus).toHaveBeenCalledTimes(1);
	});

	it("marks the firing touch's mirror row `skipped` when the guard stops it", async () => {
		const { repo } = scheduledJobsWithPending(["T1", "T2", "T3"]);
		const worker = createCadenceWorker({
			leads: leadRepoReturning(makeLead({ lifecycleState: "REPLIED" })),
			cadence,
			outbound,
			lifecycle,
			nurture,
			scheduledJobs: repo,
		});

		await worker.process({ leadId: "lead-1", touch: "T2" });

		expect(repo.updateStatus).toHaveBeenCalledWith("row-T2", "skipped");
		// The remaining touches are cancelled via the scheduler's cancelAll.
		expect(cadence.cancelAll).toHaveBeenCalledWith("lead-1");
	});
});
