// Nurture scheduler (I/O boundary — cadence-exhaustion → durable monthly nurture).
//
// Implements the design's `Nurture_Scheduler`: the service that takes a Lead
// which exhausted the 5-touch cadence and drives the low-frequency monthly
// nurture flow. On `CADENCE_EXHAUSTED` it transitions the Lead to
// `MONTHLY_NURTURE` (via the `Lifecycle_Manager`) and schedules recurring
// monthly outreach, with each nurture message one calendar month apart
// (Req 6.2, 6.3). It also cancels a Lead's pending nurture job when the Lead
// leaves the flow (e.g. on a reply, Req 6.4).
//
// Recurrence model: pg-boss cron cannot express "one calendar month later with
// month-length clamping" (Jan 31 → Feb 28, etc.), so the monthly cadence is a
// self-perpetuating chain rather than a fixed cron. `startMonthly` schedules
// the FIRST nurture job one calendar month out; when that job fires the
// `Nurture_Worker` enqueues the outbound send and calls {@link scheduleNext} to
// schedule the following month's job. Every fire instant comes from the pure
// `nextNurtureDate` in `@/core/cadence` (Req 6.3); none of that calendar math
// is reimplemented here.
//
// Side-effect boundary: this is I/O — it writes lifecycle state, enqueues
// durable pg-boss jobs, and mirrors each job in `scheduled_jobs` so a reply can
// cancel the Lead's pending nurture by lead id. All of that flows through
// injected INTERFACE dependencies only — never concrete Drizzle/DB or pg-boss
// code:
//   - `LifecycleManager`        — the `CADENCE_EXHAUSTED → MONTHLY_NURTURE`
//                                 transition (Req 6.2);
//   - `ScheduledJobRepository`  — persist a mirror row per nurture job and
//                                 cancel a Lead's pending nurture by lead id
//                                 (Req 6.3, 6.4);
//   - `NurtureJobQueue`         — the pg-boss enqueue + cancel seam, injected so
//                                 the scheduler never constructs pg-boss inline
//                                 and stays unit-testable against a fake queue;
//   - `Clock`                   — the injected time source the monthly fire
//                                 instant is measured from (never `Date.now()`).

import { nextNurtureDate } from "@/core/cadence";
import type { Clock, LifecycleState } from "@/core/types";
import type { LifecycleManager } from "@/services/lifecycle-manager";
import type { ScheduledJobRepository } from "@/services/repositories";

// ---------------------------------------------------------------------------
// pg-boss seam (injected; never constructed inline)
// ---------------------------------------------------------------------------

/**
 * The payload of a single monthly nurture job. It carries only the Lead the
 * nurture is for; the `Nurture_Worker` re-reads fresh Lead state at execution
 * time, so nothing time-sensitive is captured in the payload.
 */
export interface NurtureJob {
	/** The Lead this monthly nurture is scheduled for. */
	leadId: string;
}

/**
 * The durable job-queue seam the nurture scheduler depends on — the pg-boss
 * boundary, injected rather than constructed inline so the scheduler stays
 * testable against a fake queue. Production wiring (task 23.1) backs this with
 * the real pg-boss instance (a delayed `send` for {@link enqueueNurture},
 * `cancel` for {@link cancel}); tests back it with an in-memory fake.
 */
export interface NurtureJobQueue {
	/**
	 * Enqueue a single delayed monthly nurture job that fires at `fireAt`,
	 * returning the queue's job id (mirrored in `scheduled_jobs` for later
	 * cancellation by lead id, Req 6.3, 6.4).
	 */
	enqueueNurture(job: NurtureJob, fireAt: Date): Promise<string>;
	/**
	 * Cancel a previously enqueued job by its queue job id so it never fires
	 * (Req 6.4). Cancelling an already-fired/cancelled/unknown job is a no-op.
	 */
	cancel(jobId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Scheduler interface
// ---------------------------------------------------------------------------

/**
 * The monthly-nurture boundary (Req 6). The `Cadence_Worker` hands an exhausted
 * Lead to this service via {@link startMonthly} (it satisfies the worker's
 * `NurtureTrigger` seam directly), the `Nurture_Worker` continues the recurring
 * chain via {@link scheduleNext}, and the `Inbound_Handler` cancels a Lead's
 * pending nurture via {@link cancel} when the Lead replies (Req 6.4).
 */
export interface NurtureScheduler {
	/**
	 * Begin the monthly nurture flow for a Lead that has entered
	 * `CADENCE_EXHAUSTED`: transition it `CADENCE_EXHAUSTED → MONTHLY_NURTURE`
	 * and schedule the first monthly nurture job one calendar month out
	 * (Req 6.2, 6.3).
	 *
	 * The signature matches the design's `NurtureScheduler.startMonthly(leadId)`
	 * and the `Cadence_Worker`'s `NurtureTrigger` seam, so this service can be
	 * injected into the worker with no adapter.
	 *
	 * @param leadId - The Lead to move into monthly nurture (expected to be
	 *        `CADENCE_EXHAUSTED`).
	 * @throws {NurtureSchedulingError} when the Lead is not `CADENCE_EXHAUSTED`
	 *         (the transition is rejected); nothing is scheduled in that case.
	 */
	startMonthly(leadId: string): Promise<void>;

	/**
	 * Schedule the NEXT monthly nurture job, one calendar month from now
	 * (Req 6.3). Called by the `Nurture_Worker` after it enqueues a nurture
	 * outbound send, perpetuating the monthly chain. Does not transition the
	 * Lead (it is already `MONTHLY_NURTURE`).
	 *
	 * @param leadId - The Lead whose next nurture should be scheduled.
	 * @returns The persisted queue job id of the scheduled nurture.
	 */
	scheduleNext(leadId: string): Promise<string>;

	/**
	 * Cancel all of a Lead's pending nurture jobs (e.g. when the Lead replies,
	 * Req 6.4), returning the count cancelled. Returns a count to mirror the
	 * `Cadence_Scheduler`'s `cancelAll`, so callers (and the `Nurture_Worker`'s
	 * skip path) can report how many jobs were stopped.
	 *
	 * @param leadId - The Lead whose pending nurture should be cancelled.
	 * @returns The number of pending nurture jobs that were cancelled.
	 */
	cancel(leadId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when {@link NurtureScheduler.startMonthly} is asked to start the
 * monthly flow for a Lead that is not `CADENCE_EXHAUSTED`. The monthly flow is
 * defined as the move *out of* `CADENCE_EXHAUSTED` (Req 6.2), so a Lead in any
 * other state cannot enter it; scheduling nurture for it would be a bug. The
 * scheduler fails loudly with the actual state rather than silently scheduling
 * outreach for a Lead that should not receive it.
 */
export class NurtureSchedulingError extends Error {
	/** The Lead that could not be moved into monthly nurture. */
	readonly leadId: string;
	/** The Lead's actual lifecycle state (the reason scheduling was refused). */
	readonly state: LifecycleState;

	constructor(leadId: string, state: LifecycleState) {
		super(
			`Cannot start monthly nurture for lead "${leadId}" from state "${state}" (expected "CADENCE_EXHAUSTED")`,
		);
		this.name = "NurtureSchedulingError";
		this.leadId = leadId;
		this.state = state;
	}
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link NurtureSchedulerService}. */
export interface NurtureSchedulerConfig {
	/** Lifecycle manager used to move the Lead `CADENCE_EXHAUSTED → MONTHLY_NURTURE` (Req 6.2). */
	lifecycle: LifecycleManager;
	/** Persistence boundary mirroring each pg-boss job for cancel-by-lead (Req 6.3, 6.4). */
	scheduledJobs: ScheduledJobRepository;
	/** Durable job-queue seam (the pg-boss enqueue + cancel boundary). */
	queue: NurtureJobQueue;
	/** Injected time source; the monthly fire instant is measured from this seam. */
	clock: Clock;
}

// ---------------------------------------------------------------------------
// NurtureSchedulerService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link NurtureScheduler} backed by the injected
 * {@link LifecycleManager}, {@link ScheduledJobRepository},
 * {@link NurtureJobQueue}, and {@link Clock}. Stateless beyond its
 * dependencies; every call reads and writes only through the interfaces it was
 * constructed with.
 */
export class NurtureSchedulerService implements NurtureScheduler {
	private readonly lifecycle: LifecycleManager;
	private readonly scheduledJobs: ScheduledJobRepository;
	private readonly queue: NurtureJobQueue;
	private readonly clock: Clock;

	constructor(deps: NurtureSchedulerConfig) {
		this.lifecycle = deps.lifecycle;
		this.scheduledJobs = deps.scheduledJobs;
		this.queue = deps.queue;
		this.clock = deps.clock;
	}

	/** @inheritdoc */
	async startMonthly(leadId: string): Promise<void> {
		// Transition `CADENCE_EXHAUSTED → MONTHLY_NURTURE` FIRST (Req 6.2). The
		// lifecycle manager applies this via a compare-and-set on the lead's
		// state, so the transition doubles as the guard: only a genuinely
		// `CADENCE_EXHAUSTED` lead is accepted, and under concurrency only one
		// caller wins the move. A rejected transition means the lead was not
		// `CADENCE_EXHAUSTED`; we refuse to schedule nurture and surface the
		// actual state rather than silently scheduling outreach.
		const result = await this.lifecycle.apply(leadId, "MONTHLY_NURTURE");
		if (!result.ok) {
			throw new NurtureSchedulingError(leadId, result.state);
		}

		// Schedule the first monthly nurture job, one calendar month out (Req 6.3).
		await this.enqueueMonthly(leadId);
	}

	/** @inheritdoc */
	async scheduleNext(leadId: string): Promise<string> {
		// Schedule the following month's nurture job (Req 6.3). The lead is already
		// `MONTHLY_NURTURE`, so no transition is performed — this only perpetuates
		// the monthly chain after the worker enqueued the current send.
		return this.enqueueMonthly(leadId);
	}

	/** @inheritdoc */
	async cancel(leadId: string): Promise<number> {
		// Read the lead's pending nurture jobs so each durable queue job can be
		// cancelled before it fires (Req 6.4). Only `nurture`-kind jobs are this
		// scheduler's concern; any cadence touches are owned by the
		// Cadence_Scheduler, so they are left untouched here.
		const pending = await this.scheduledJobs.listByLead(leadId, "pending");
		const nurtureJobs = pending.filter((job) => job.jobKind === "nurture");

		let cancelled = 0;
		for (const job of nurtureJobs) {
			// Cancel the durable queue job FIRST so it can never wake a worker, then
			// mark the mirror row cancelled to keep the two in lockstep. (Even if a
			// row were left pending, the Nurture_Worker re-reads fresh state and the
			// send guard would stop a stale nurture — defense in depth.)
			await this.queue.cancel(job.pgbossJobId);
			await this.scheduledJobs.updateStatus(job.id, "cancelled");
			cancelled += 1;
		}

		return cancelled;
	}

	/**
	 * Enqueue one monthly nurture job, one calendar month from the current time,
	 * and persist its `scheduled_jobs` mirror row so it can be cancelled by lead
	 * id before it fires (Req 6.3, 6.4). Shared by {@link startMonthly} (first
	 * job) and {@link scheduleNext} (subsequent jobs) so the calendar-month
	 * scheduling lives in exactly one place. Enqueue precedes the mirror write so
	 * the row always records a real, cancellable job id.
	 *
	 * @param leadId - The Lead the nurture job is for.
	 * @returns The persisted queue job id of the scheduled nurture.
	 */
	private async enqueueMonthly(leadId: string): Promise<string> {
		// One calendar month later via the pure `nextNurtureDate` (Req 6.3), with
		// time entering only through the injected clock seam (never `Date.now()`).
		const fireAt = nextNurtureDate(this.clock.now());
		const pgbossJobId = await this.queue.enqueueNurture({ leadId }, fireAt);
		await this.scheduledJobs.create({
			leadId,
			jobKind: "nurture",
			touch: null,
			pgbossJobId,
			plannedFor: fireAt,
		});
		return pgbossJobId;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct a {@link NurtureScheduler} from {@link NurtureSchedulerConfig}. */
export function createNurtureScheduler(
	config: NurtureSchedulerConfig,
): NurtureScheduler {
	return new NurtureSchedulerService(config);
}
