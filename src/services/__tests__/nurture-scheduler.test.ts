// Unit tests for the Nurture_Scheduler (task 17.1).
//
// These exercise the design's scheduler against in-memory fakes: `startMonthly`
// transitions a `CADENCE_EXHAUSTED` lead to `MONTHLY_NURTURE` (Req 6.2) and
// schedules the first nurture job one calendar month out (Req 6.3),
// `scheduleNext` perpetuates the monthly chain (Req 6.3), and `cancel` cancels
// the pending nurture jobs and reports the count (Req 6.4). The named property
// test (Property 8, task 17.2) is a separate optional task and is not
// implemented here.

import { nextNurtureDate } from "@/core/cadence";
import type { TransitionResult } from "@/core/lifecycle";
import type { Clock, LifecycleState } from "@/core/types";
import type { LifecycleManager } from "@/services/lifecycle-manager";
import {
	createNurtureScheduler,
	NurtureSchedulingError,
	type NurtureJob,
	type NurtureJobQueue,
} from "@/services/nurture-scheduler";
import type {
	NewScheduledJobInput,
	ScheduledJobRecord,
	ScheduledJobRepository,
	ScheduledJobStatus,
} from "@/services/repositories";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Test fixtures / fakes
// ---------------------------------------------------------------------------

const NOW = new Date("2024-01-31T13:00:00.000Z");

/** A fixed `Clock` returning {@link NOW}. */
const fixedClock: Clock = { now: () => NOW };

/**
 * A `LifecycleManager` that accepts the `CADENCE_EXHAUSTED → MONTHLY_NURTURE`
 * move once, then rejects further starts (mirroring the compare-and-set guard:
 * a lead that already left `CADENCE_EXHAUSTED` cannot start nurture again).
 */
function makeLifecycle(initial: LifecycleState = "CADENCE_EXHAUSTED"): {
	manager: LifecycleManager;
	state: { value: LifecycleState };
} {
	const state = { value: initial };
	const manager: LifecycleManager = {
		apply: vi.fn(
			async (
				_leadId: string,
				to: LifecycleState,
			): Promise<TransitionResult> => {
				if (state.value === "CADENCE_EXHAUSTED" && to === "MONTHLY_NURTURE") {
					const from = state.value;
					state.value = to;
					return { ok: true, from, to };
				}
				return {
					ok: false,
					reason: "invalid_transition",
					state: state.value,
				};
			},
		),
	};
	return { manager, state };
}

/** An in-memory `ScheduledJobRepository` recording mirror rows + status changes. */
function makeScheduledJobs(): {
	repo: ScheduledJobRepository;
	rows: ScheduledJobRecord[];
} {
	const rows: ScheduledJobRecord[] = [];
	let seq = 0;

	const repo: ScheduledJobRepository = {
		create: vi.fn(async (input: NewScheduledJobInput) => {
			seq += 1;
			const record: ScheduledJobRecord = {
				id: `job-row-${seq}`,
				leadId: input.leadId,
				jobKind: input.jobKind,
				touch: input.touch ?? null,
				pgbossJobId: input.pgbossJobId,
				plannedFor: input.plannedFor,
				status: "pending",
			};
			rows.push(record);
			return record;
		}),
		listByLead: vi.fn(async (leadId: string, status?: ScheduledJobStatus) =>
			rows.filter(
				(r) =>
					r.leadId === leadId && (status === undefined || r.status === status),
			),
		),
		updateStatus: vi.fn(async (jobId: string, status: ScheduledJobStatus) => {
			const row = rows.find((r) => r.id === jobId);
			if (row) {
				row.status = status;
			}
		}),
		cancelAllForLead: vi.fn(async () => 0),
	};

	return { repo, rows };
}

/** An in-memory `NurtureJobQueue` recording enqueued jobs and cancellations. */
function makeQueue(): {
	queue: NurtureJobQueue;
	enqueued: { job: NurtureJob; fireAt: Date; jobId: string }[];
	cancelled: string[];
} {
	const enqueued: { job: NurtureJob; fireAt: Date; jobId: string }[] = [];
	const cancelled: string[] = [];
	let seq = 0;

	const queue: NurtureJobQueue = {
		enqueueNurture: vi.fn(async (job: NurtureJob, fireAt: Date) => {
			seq += 1;
			const jobId = `pgboss-nurture-${seq}`;
			enqueued.push({ job, fireAt, jobId });
			return jobId;
		}),
		cancel: vi.fn(async (jobId: string) => {
			cancelled.push(jobId);
		}),
	};

	return { queue, enqueued, cancelled };
}

// ---------------------------------------------------------------------------
// startMonthly
// ---------------------------------------------------------------------------

describe("NurtureScheduler.startMonthly", () => {
	let lifecycle: ReturnType<typeof makeLifecycle>;
	let scheduledJobs: ReturnType<typeof makeScheduledJobs>;
	let queue: ReturnType<typeof makeQueue>;

	beforeEach(() => {
		lifecycle = makeLifecycle();
		scheduledJobs = makeScheduledJobs();
		queue = makeQueue();
	});

	function scheduler() {
		return createNurtureScheduler({
			lifecycle: lifecycle.manager,
			scheduledJobs: scheduledJobs.repo,
			queue: queue.queue,
			clock: fixedClock,
		});
	}

	it("transitions CADENCE_EXHAUSTED → MONTHLY_NURTURE then schedules the first nurture (Req 6.2, 6.3)", async () => {
		await scheduler().startMonthly("lead-1");

		// The lifecycle move happens first, exactly once, to MONTHLY_NURTURE.
		expect(lifecycle.manager.apply).toHaveBeenCalledWith(
			"lead-1",
			"MONTHLY_NURTURE",
		);
		expect(lifecycle.state.value).toBe("MONTHLY_NURTURE");

		// Exactly one nurture job, for this lead.
		expect(queue.enqueued).toHaveLength(1);
		expect(queue.enqueued[0].job).toEqual({ leadId: "lead-1" });
	});

	it("schedules the first nurture exactly one calendar month out, clamping month-length edges (Req 6.3)", async () => {
		await scheduler().startMonthly("lead-1");

		// NOW is Jan 31 → clamps to Feb 29 (2024 is a leap year), via the pure
		// `nextNurtureDate`. The scheduler must reuse that timing, not reimplement it.
		expect(queue.enqueued[0].fireAt).toEqual(nextNurtureDate(NOW));
		expect(queue.enqueued[0].fireAt).toEqual(
			new Date("2024-02-29T13:00:00.000Z"),
		);
	});

	it("persists a cancellable nurture mirror row carrying the queue job id (Req 6.3, 6.4)", async () => {
		await scheduler().startMonthly("lead-1");

		expect(scheduledJobs.rows).toHaveLength(1);
		expect(scheduledJobs.rows[0]).toMatchObject({
			leadId: "lead-1",
			jobKind: "nurture",
			touch: null,
			plannedFor: nextNurtureDate(NOW),
			status: "pending",
		});
		// The mirror row records the queue's job id so it can be cancelled later.
		expect(scheduledJobs.rows[0].pgbossJobId).toBe(queue.enqueued[0].jobId);
	});

	it("refuses to start nurture for a lead that is not CADENCE_EXHAUSTED and schedules nothing", async () => {
		lifecycle = makeLifecycle("IN_CADENCE");

		await expect(scheduler().startMonthly("lead-1")).rejects.toBeInstanceOf(
			NurtureSchedulingError,
		);

		// No nurture job is enqueued or persisted when the transition is refused.
		expect(queue.queue.enqueueNurture).not.toHaveBeenCalled();
		expect(scheduledJobs.repo.create).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// scheduleNext
// ---------------------------------------------------------------------------

describe("NurtureScheduler.scheduleNext", () => {
	let lifecycle: ReturnType<typeof makeLifecycle>;
	let scheduledJobs: ReturnType<typeof makeScheduledJobs>;
	let queue: ReturnType<typeof makeQueue>;

	beforeEach(() => {
		lifecycle = makeLifecycle("MONTHLY_NURTURE");
		scheduledJobs = makeScheduledJobs();
		queue = makeQueue();
	});

	function scheduler() {
		return createNurtureScheduler({
			lifecycle: lifecycle.manager,
			scheduledJobs: scheduledJobs.repo,
			queue: queue.queue,
			clock: fixedClock,
		});
	}

	it("schedules the next month's nurture without any lifecycle transition (Req 6.3)", async () => {
		const jobId = await scheduler().scheduleNext("lead-1");

		// No transition — the lead is already MONTHLY_NURTURE.
		expect(lifecycle.manager.apply).not.toHaveBeenCalled();

		// One nurture job, one calendar month out, mirrored and cancellable.
		expect(queue.enqueued).toHaveLength(1);
		expect(queue.enqueued[0].fireAt).toEqual(nextNurtureDate(NOW));
		expect(jobId).toBe(queue.enqueued[0].jobId);
		expect(scheduledJobs.rows[0]).toMatchObject({
			leadId: "lead-1",
			jobKind: "nurture",
			pgbossJobId: jobId,
			status: "pending",
		});
	});
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe("NurtureScheduler.cancel", () => {
	let lifecycle: ReturnType<typeof makeLifecycle>;
	let scheduledJobs: ReturnType<typeof makeScheduledJobs>;
	let queue: ReturnType<typeof makeQueue>;

	beforeEach(() => {
		lifecycle = makeLifecycle();
		scheduledJobs = makeScheduledJobs();
		queue = makeQueue();
	});

	function scheduler() {
		return createNurtureScheduler({
			lifecycle: lifecycle.manager,
			scheduledJobs: scheduledJobs.repo,
			queue: queue.queue,
			clock: fixedClock,
		});
	}

	it("cancels every pending nurture, marks the rows cancelled, and returns the count (Req 6.4)", async () => {
		const svc = scheduler();
		await svc.startMonthly("lead-1");

		const count = await svc.cancel("lead-1");

		expect(count).toBe(1);
		expect(queue.cancelled).toEqual([queue.enqueued[0].jobId]);

		// Zero pending nurture jobs remain afterward.
		const pending = await scheduledJobs.repo.listByLead("lead-1", "pending");
		expect(pending).toHaveLength(0);
		for (const row of scheduledJobs.rows) {
			expect(row.status).toBe("cancelled");
		}
	});

	it("returns 0 and cancels nothing when the lead has no pending nurture", async () => {
		const count = await scheduler().cancel("unknown-lead");

		expect(count).toBe(0);
		expect(queue.queue.cancel).not.toHaveBeenCalled();
	});

	it("ignores cadence jobs, cancelling only nurture jobs", async () => {
		// Seed one cadence and one nurture pending job for the same lead.
		await scheduledJobs.repo.create({
			leadId: "lead-1",
			jobKind: "cadence",
			touch: "T1",
			pgbossJobId: "pgboss-cadence",
			plannedFor: NOW,
		});
		await scheduledJobs.repo.create({
			leadId: "lead-1",
			jobKind: "nurture",
			touch: null,
			pgbossJobId: "pgboss-nurture",
			plannedFor: NOW,
		});

		const count = await scheduler().cancel("lead-1");

		expect(count).toBe(1);
		expect(queue.cancelled).toEqual(["pgboss-nurture"]);
		const cadence = scheduledJobs.rows.find((r) => r.jobKind === "cadence");
		expect(cadence?.status).toBe("pending");
	});
});
