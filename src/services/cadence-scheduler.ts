// Cadence scheduler (I/O boundary — enrollment + durable touch scheduling).
//
// Implements the design's `Cadence_Scheduler`: the service that enrolls a Lead
// into the fixed 5-touch / 15-day reactivation cadence by transitioning the
// Lead `COLD_QUEUED → IN_CADENCE` (via the `Lifecycle_Manager`) and creating
// five persisted, individually cancellable touch jobs T1–T5 at their planned
// fire times (Req 2.3, 3.1, 3.2, 3.4).
//
// Side-effect boundary: enrollment is I/O — it writes lifecycle state, enqueues
// durable pg-boss jobs, and mirrors each job in `scheduled_jobs` so a reply,
// opt-out, or block can cancel the Lead's pending touches by lead id. All of
// that flows through injected INTERFACE dependencies only — never concrete
// Drizzle/DB or pg-boss code:
//   - `LifecycleManager`        — the `COLD_QUEUED → IN_CADENCE` transition
//                                 (Req 3.1), which also serves as the
//                                 enrollment/concurrency guard (see `enroll`);
//   - `ScheduledJobRepository`  — persist a mirror row per touch and cancel a
//                                 Lead's pending touches by lead id (Req 3.4);
//   - `CadenceJobQueue`         — the pg-boss enqueue + cancel seam, injected so
//                                 the scheduler never constructs pg-boss inline
//                                 and stays unit-testable against a fake queue.
//
// The per-touch fire instants come from the pure `plannedFireTime` in
// `@/core/cadence` (Req 3.3); none of that timing math is reimplemented here.

import { CADENCE_OFFSET_DAYS, plannedFireTime } from "@/core/cadence";
import type { LifecycleState, Touch } from "@/core/types";
import type { LifecycleManager } from "@/services/lifecycle-manager";
import type { ScheduledJobRepository } from "@/services/repositories";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * One scheduled cadence touch produced by enrollment (design "Cadence_Scheduler
 * / Cadence_Worker"). Each entry mirrors a persisted, cancellable job so a
 * reply, opt-out, or block can cancel the Lead's pending touches by id
 * (Req 3.4).
 */
export interface CadenceSchedule {
	/** Which touch in the sequence this job fires (T1–T5). */
	touch: Touch;
	/** Offset from the Lead's enrollment time: 0, 3, 7, 11, and 14–15 for T5. */
	offsetDays: number;
	/** The persisted job id, retained so the touch can be cancelled (Req 3.4). */
	jobId: string;
}

// ---------------------------------------------------------------------------
// Scheduler interface
// ---------------------------------------------------------------------------

/**
 * The enrollment boundary for the reactivation cadence (Req 3). Consumers that
 * create a Lead — the `Lead_Importer` today (Req 2.3) and future real-time
 * sources tomorrow (Req 2.2) — depend on this interface and call
 * {@link enroll}; the concrete implementation ({@link CadenceSchedulerService})
 * owns the lifecycle transition and the durable job creation.
 */
export interface CadenceScheduler {
	/**
	 * Enroll a Lead into the cadence: transition it `COLD_QUEUED → IN_CADENCE`
	 * and create the five delayed, cancellable touch jobs T1–T5 at their planned
	 * fire times relative to `enrolledAt` (Req 3.1, 3.2, 3.3, 3.4).
	 *
	 * @param leadId - The Lead to enroll (expected to be `COLD_QUEUED`).
	 * @param enrolledAt - The enrollment instant the touch offsets are measured
	 *        from; injected by the caller (through its `Clock` seam) so the
	 *        planned fire times are deterministic.
	 * @returns The five {@link CadenceSchedule} entries that were scheduled.
	 */
	enroll(leadId: string, enrolledAt: Date): Promise<CadenceSchedule[]>;

	/**
	 * Cancel all of a Lead's pending cadence jobs (e.g. on reply, opt-out, or
	 * block), returning the count cancelled (Req 5.2, 7.2, 15.2).
	 *
	 * @param leadId - The Lead whose pending touches should be cancelled.
	 * @returns The number of pending jobs that were cancelled.
	 */
	cancelAll(leadId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// pg-boss seam (injected; never constructed inline)
// ---------------------------------------------------------------------------

/**
 * The payload of a single cadence touch job. It carries only what the
 * `Cadence_Worker` (a later task) needs to act: the Lead the touch is for and
 * which touch in the sequence fired. The Worker re-reads fresh Lead state at
 * execution time, so nothing time-sensitive is captured in the payload.
 */
export interface CadenceTouchJob {
	/** The Lead this touch is scheduled for. */
	leadId: string;
	/** Which touch in the cadence this job fires (T1–T5). */
	touch: Touch;
}

/**
 * The durable job-queue seam the scheduler depends on — the pg-boss boundary,
 * injected rather than constructed inline so the scheduler stays testable
 * against a fake queue. Production wiring (task 23.1) backs this with the real
 * pg-boss instance (a delayed `send` for {@link enqueueTouch}, `cancel` for
 * {@link cancel}); tests back it with an in-memory fake.
 */
export interface CadenceJobQueue {
	/**
	 * Enqueue a single delayed cadence touch job that fires at `fireAt`,
	 * returning the queue's job id (mirrored in `scheduled_jobs` for later
	 * cancellation by lead id, Req 3.2, 3.4).
	 */
	enqueueTouch(job: CadenceTouchJob, fireAt: Date): Promise<string>;
	/**
	 * Cancel a previously enqueued job by its queue job id so it never fires
	 * (Req 3.4). Cancelling an already-fired/cancelled/unknown job is a no-op.
	 */
	cancel(jobId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when {@link CadenceScheduler.enroll} is asked to enroll a Lead that is
 * not in `COLD_QUEUED`. Enrollment is defined as the move *out of* `COLD_QUEUED`
 * (Req 3.1), so a Lead in any other state (already enrolled, replied, opted
 * out, …) cannot be enrolled; scheduling touches for it would be a bug. The
 * scheduler fails loudly with the actual state rather than silently creating a
 * second set of touch jobs.
 */
export class CadenceEnrollmentError extends Error {
	/** The Lead that could not be enrolled. */
	readonly leadId: string;
	/** The Lead's actual lifecycle state (the reason enrollment was refused). */
	readonly state: LifecycleState;

	constructor(leadId: string, state: LifecycleState) {
		super(
			`Cannot enroll lead "${leadId}" into the cadence from state "${state}" (expected "COLD_QUEUED")`,
		);
		this.name = "CadenceEnrollmentError";
		this.leadId = leadId;
		this.state = state;
	}
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link CadenceSchedulerService}. */
export interface CadenceSchedulerConfig {
	/** Lifecycle manager used to move the Lead `COLD_QUEUED → IN_CADENCE` (Req 3.1). */
	lifecycle: LifecycleManager;
	/** Persistence boundary mirroring each pg-boss job for cancel-by-lead (Req 3.4). */
	scheduledJobs: ScheduledJobRepository;
	/** Durable job-queue seam (the pg-boss enqueue + cancel boundary). */
	queue: CadenceJobQueue;
}

// ---------------------------------------------------------------------------
// Touch order
// ---------------------------------------------------------------------------

/**
 * The five cadence touches in fire order (Req 3.2). Enrollment creates exactly
 * one delayed job per entry, in this order, so the returned schedule is ordered
 * T1 → T5 and the planned fire times are strictly increasing (the offsets in
 * {@link CADENCE_OFFSET_DAYS} are strictly increasing — design Property 5).
 */
const CADENCE_TOUCHES = [
	"T1",
	"T2",
	"T3",
	"T4",
	"T5",
] as const satisfies readonly Touch[];

// ---------------------------------------------------------------------------
// CadenceSchedulerService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link CadenceScheduler} backed by the injected
 * {@link LifecycleManager}, {@link ScheduledJobRepository}, and
 * {@link CadenceJobQueue}. Stateless beyond its dependencies; every call reads
 * and writes only through the interfaces it was constructed with.
 */
export class CadenceSchedulerService implements CadenceScheduler {
	private readonly lifecycle: LifecycleManager;
	private readonly scheduledJobs: ScheduledJobRepository;
	private readonly queue: CadenceJobQueue;

	constructor(deps: CadenceSchedulerConfig) {
		this.lifecycle = deps.lifecycle;
		this.scheduledJobs = deps.scheduledJobs;
		this.queue = deps.queue;
	}

	/** @inheritdoc */
	async enroll(leadId: string, enrolledAt: Date): Promise<CadenceSchedule[]> {
		// Transition `COLD_QUEUED → IN_CADENCE` FIRST (Req 3.1). The lifecycle
		// manager applies this via a compare-and-set on the lead's state, so the
		// transition doubles as the enrollment guard: only a genuinely
		// `COLD_QUEUED` lead is accepted, and under concurrency only one caller
		// wins the move — the loser is rejected here, before any touch jobs are
		// created, so a lead is never enrolled (and never given duplicate touches)
		// twice. A rejected transition means the lead was not `COLD_QUEUED`; we
		// refuse to schedule touches and surface the actual state.
		const result = await this.lifecycle.apply(leadId, "IN_CADENCE");
		if (!result.ok) {
			throw new CadenceEnrollmentError(leadId, result.state);
		}

		// Create the five delayed touch jobs T1–T5 in fire order (Req 3.2). For
		// each touch: compute its planned fire instant from the pure
		// `plannedFireTime` (Req 3.3), enqueue the durable job, then persist a
		// `scheduled_jobs` mirror row carrying the queue's job id so the touch can
		// be cancelled by lead id before it fires (Req 3.4). Enqueue precedes the
		// mirror write so the row always records a real, cancellable job id.
		const schedules: CadenceSchedule[] = [];
		for (const touch of CADENCE_TOUCHES) {
			const fireAt = plannedFireTime(touch, enrolledAt);
			const pgbossJobId = await this.queue.enqueueTouch(
				{ leadId, touch },
				fireAt,
			);
			await this.scheduledJobs.create({
				leadId,
				jobKind: "cadence",
				touch,
				pgbossJobId,
				plannedFor: fireAt,
			});
			schedules.push({
				touch,
				offsetDays: CADENCE_OFFSET_DAYS[touch],
				jobId: pgbossJobId,
			});
		}

		return schedules;
	}

	/** @inheritdoc */
	async cancelAll(leadId: string): Promise<number> {
		// Read the lead's pending cadence touch jobs so each durable queue job can
		// be cancelled before it fires (Req 3.4, 5.2, 7.2). Only `cadence`-kind
		// jobs are this scheduler's concern; any nurture jobs are owned by the
		// Nurture_Scheduler, so they are left untouched here.
		const pending = await this.scheduledJobs.listByLead(leadId, "pending");
		const touchJobs = pending.filter((job) => job.jobKind === "cadence");

		let cancelled = 0;
		for (const job of touchJobs) {
			// Cancel the durable queue job FIRST so it can never wake a worker, then
			// mark the mirror row cancelled to keep the two in lockstep. (Even if a
			// row were left pending, the Cadence_Worker re-reads fresh state and the
			// send guard would stop a stale touch — defense in depth.)
			await this.queue.cancel(job.pgbossJobId);
			await this.scheduledJobs.updateStatus(job.id, "cancelled");
			cancelled += 1;
		}

		return cancelled;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct a {@link CadenceScheduler} from {@link CadenceSchedulerConfig}. */
export function createCadenceScheduler(
	config: CadenceSchedulerConfig,
): CadenceScheduler {
	return new CadenceSchedulerService(config);
}
