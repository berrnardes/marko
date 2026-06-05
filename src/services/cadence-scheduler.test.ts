// Unit tests for the Cadence_Scheduler enrollment + cancellation (task 16.1).
//
// These exercise the design's scheduler against in-memory fakes: enrollment
// transitions a `COLD_QUEUED` lead to `IN_CADENCE` (Req 3.1), creates five
// delayed, cancellable touch jobs T1–T5 at their planned fire times (Req 3.2,
// 3.3), persists a mirror row per job so it can be cancelled by lead id
// (Req 3.4), and `cancelAll` cancels the pending touches and reports the count.
// The named property test (Property 4, task 16.2) is a separate optional task
// and is not implemented here.

import { CADENCE_OFFSET_DAYS, plannedFireTime } from "@/core/cadence";
import type { TransitionResult } from "@/core/lifecycle";
import type { LifecycleState, Touch } from "@/core/types";
import {
	CadenceEnrollmentError,
	createCadenceScheduler,
	type CadenceJobQueue,
	type CadenceTouchJob,
} from "@/services/cadence-scheduler";
import type { LifecycleManager } from "@/services/lifecycle-manager";
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

const ENROLLED_AT = new Date("2024-03-10T13:00:00.000Z");

/**
 * A `LifecycleManager` that accepts the `COLD_QUEUED → IN_CADENCE` move once,
 * then rejects further enrollments (mirroring the compare-and-set guard: a lead
 * that already left `COLD_QUEUED` cannot be enrolled again).
 */
function makeLifecycle(initial: LifecycleState = "COLD_QUEUED"): {
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
				if (state.value === "COLD_QUEUED" && to === "IN_CADENCE") {
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

/**
 * An in-memory `ScheduledJobRepository` recording created mirror rows and
 * status changes. Covers exactly what the scheduler touches: `create`,
 * `listByLead`, and `updateStatus`.
 */
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

/** An in-memory `CadenceJobQueue` recording enqueued jobs and cancellations. */
function makeQueue(): {
	queue: CadenceJobQueue;
	enqueued: { job: CadenceTouchJob; fireAt: Date; jobId: string }[];
	cancelled: string[];
} {
	const enqueued: { job: CadenceTouchJob; fireAt: Date; jobId: string }[] = [];
	const cancelled: string[] = [];
	let seq = 0;

	const queue: CadenceJobQueue = {
		enqueueTouch: vi.fn(async (job: CadenceTouchJob, fireAt: Date) => {
			seq += 1;
			const jobId = `pgboss-${seq}`;
			enqueued.push({ job, fireAt, jobId });
			return jobId;
		}),
		cancel: vi.fn(async (jobId: string) => {
			cancelled.push(jobId);
		}),
	};

	return { queue, enqueued, cancelled };
}

const ORDERED_TOUCHES: readonly Touch[] = ["T1", "T2", "T3", "T4", "T5"];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CadenceScheduler.enroll", () => {
	let lifecycle: ReturnType<typeof makeLifecycle>;
	let scheduledJobs: ReturnType<typeof makeScheduledJobs>;
	let queue: ReturnType<typeof makeQueue>;

	beforeEach(() => {
		lifecycle = makeLifecycle();
		scheduledJobs = makeScheduledJobs();
		queue = makeQueue();
	});

	function scheduler() {
		return createCadenceScheduler({
			lifecycle: lifecycle.manager,
			scheduledJobs: scheduledJobs.repo,
			queue: queue.queue,
		});
	}

	it("transitions COLD_QUEUED → IN_CADENCE then schedules five touches (Req 3.1, 3.2)", async () => {
		const schedules = await scheduler().enroll("lead-1", ENROLLED_AT);

		// The lifecycle move happens first, exactly once, to IN_CADENCE (Req 3.1).
		expect(lifecycle.manager.apply).toHaveBeenCalledWith(
			"lead-1",
			"IN_CADENCE",
		);
		expect(lifecycle.state.value).toBe("IN_CADENCE");

		// Exactly five jobs, labeled T1–T5 in order (Req 3.2).
		expect(schedules).toHaveLength(5);
		expect(schedules.map((s) => s.touch)).toEqual(ORDERED_TOUCHES);
		expect(queue.enqueued).toHaveLength(5);
		expect(queue.enqueued.map((e) => e.job.touch)).toEqual(ORDERED_TOUCHES);
		for (const e of queue.enqueued) {
			expect(e.job.leadId).toBe("lead-1");
		}
	});

	it("schedules each touch at its planned fire time with strictly increasing offsets (Req 3.3)", async () => {
		const schedules = await scheduler().enroll("lead-1", ENROLLED_AT);

		for (const touch of ORDERED_TOUCHES) {
			const enqueued = queue.enqueued.find((e) => e.job.touch === touch);
			const schedule = schedules.find((s) => s.touch === touch);
			expect(enqueued?.fireAt).toEqual(plannedFireTime(touch, ENROLLED_AT));
			expect(schedule?.offsetDays).toBe(CADENCE_OFFSET_DAYS[touch]);
		}

		// Offsets and fire times are strictly increasing in touch order.
		const offsets = schedules.map((s) => s.offsetDays);
		expect(offsets).toEqual([0, 3, 7, 11, 14]);
		const fireTimes = queue.enqueued.map((e) => e.fireAt.getTime());
		for (let i = 1; i < fireTimes.length; i++) {
			expect(fireTimes[i]).toBeGreaterThan(fireTimes[i - 1]);
		}
	});

	it("persists a cancellable cadence mirror row per touch carrying the queue job id (Req 3.4)", async () => {
		const schedules = await scheduler().enroll("lead-1", ENROLLED_AT);

		expect(scheduledJobs.rows).toHaveLength(5);
		for (const touch of ORDERED_TOUCHES) {
			const row = scheduledJobs.rows.find((r) => r.touch === touch);
			expect(row).toMatchObject({
				leadId: "lead-1",
				jobKind: "cadence",
				touch,
				plannedFor: plannedFireTime(touch, ENROLLED_AT),
				status: "pending",
			});
			// The mirror row records the queue's job id so it can be cancelled later.
			const schedule = schedules.find((s) => s.touch === touch);
			expect(row?.pgbossJobId).toBe(schedule?.jobId);
		}
	});

	it("refuses to enroll a lead that is not COLD_QUEUED and schedules nothing", async () => {
		lifecycle = makeLifecycle("IN_CADENCE");

		await expect(
			scheduler().enroll("lead-1", ENROLLED_AT),
		).rejects.toBeInstanceOf(CadenceEnrollmentError);

		// No touch jobs are enqueued or persisted when enrollment is refused.
		expect(queue.queue.enqueueTouch).not.toHaveBeenCalled();
		expect(scheduledJobs.repo.create).not.toHaveBeenCalled();
	});
});

describe("CadenceScheduler.cancelAll", () => {
	let lifecycle: ReturnType<typeof makeLifecycle>;
	let scheduledJobs: ReturnType<typeof makeScheduledJobs>;
	let queue: ReturnType<typeof makeQueue>;

	beforeEach(() => {
		lifecycle = makeLifecycle();
		scheduledJobs = makeScheduledJobs();
		queue = makeQueue();
	});

	function scheduler() {
		return createCadenceScheduler({
			lifecycle: lifecycle.manager,
			scheduledJobs: scheduledJobs.repo,
			queue: queue.queue,
		});
	}

	it("cancels every pending touch, marks the rows cancelled, and returns the count (Req 3.4, 5.2)", async () => {
		const svc = scheduler();
		await svc.enroll("lead-1", ENROLLED_AT);

		const count = await svc.cancelAll("lead-1");

		// All five durable jobs were cancelled.
		expect(count).toBe(5);
		expect(queue.cancelled).toHaveLength(5);
		expect([...queue.cancelled].sort()).toEqual(
			queue.enqueued.map((e) => e.jobId).sort(),
		);

		// Zero pending cadence jobs remain afterward (Property 4 closing clause).
		const pending = await scheduledJobs.repo.listByLead("lead-1", "pending");
		expect(pending).toHaveLength(0);
		for (const row of scheduledJobs.rows) {
			expect(row.status).toBe("cancelled");
		}
	});

	it("returns 0 and cancels nothing when the lead has no pending touches", async () => {
		const count = await scheduler().cancelAll("unknown-lead");

		expect(count).toBe(0);
		expect(queue.queue.cancel).not.toHaveBeenCalled();
	});

	it("ignores nurture jobs, cancelling only cadence touches", async () => {
		// Seed one cadence and one nurture pending job for the same lead.
		await scheduledJobs.repo.create({
			leadId: "lead-1",
			jobKind: "cadence",
			touch: "T1",
			pgbossJobId: "pgboss-cadence",
			plannedFor: ENROLLED_AT,
		});
		await scheduledJobs.repo.create({
			leadId: "lead-1",
			jobKind: "nurture",
			touch: null,
			pgbossJobId: "pgboss-nurture",
			plannedFor: ENROLLED_AT,
		});

		const count = await scheduler().cancelAll("lead-1");

		expect(count).toBe(1);
		expect(queue.cancelled).toEqual(["pgboss-cadence"]);
		const nurture = scheduledJobs.rows.find((r) => r.jobKind === "nurture");
		expect(nurture?.status).toBe("pending");
	});
});
