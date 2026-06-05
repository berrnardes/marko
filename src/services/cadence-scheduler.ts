// Cadence scheduler (I/O boundary — enrollment interface seam).
//
// Implements the design's `Cadence_Scheduler` boundary: the service that enrolls
// a Lead into the fixed 5-touch / 15-day reactivation cadence by transitioning
// the Lead `COLD_QUEUED → IN_CADENCE` and creating five persisted, individually
// cancellable touch jobs T1–T5 at their planned fire times (Req 3.1–3.4).
//
// Side-effect boundary: enrollment is I/O — it writes lifecycle state and
// enqueues durable pg-boss jobs. This module currently defines ONLY the
// interface seam (no concrete implementation): the {@link CadenceScheduler}
// contract and its {@link CadenceSchedule} result shape. The Drizzle/pg-boss
// implementation is added in a later task (16.1); defining the boundary here
// lets earlier consumers — the `Lead_Importer` (Req 2.3) and, later, real-time
// intake sources (Req 2.2) — depend on the enrollment interface and inject it,
// rather than on concrete scheduling code, so they need no rework once the
// concrete scheduler lands.

import type { Touch } from "@/core/types";

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
 * {@link enroll}; the concrete implementation (Task 16.1) owns the lifecycle
 * transition and the durable job creation.
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
