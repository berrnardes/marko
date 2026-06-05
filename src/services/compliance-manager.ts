// Compliance manager (I/O boundary — LGPD opt-out application + lawful-basis log).
//
// Implements the design's `Compliance_Manager (pure detection + persistence)`
// as the persistence wrapper for LGPD compliance (Req 15). Opt-out *detection*
// is the pure `detectOptOut` predicate in `@/core/opt-out`, invoked by the
// Inbound_Handler (a later task) on each inbound message; this module owns the
// downstream *application* of an opt-out and the recording of lawful basis.
// Because detection lives elsewhere, `applyOptOut` does not re-detect — it
// assumes a detection (or an explicit operator/admin action) has already
// matched and applies the consequences.
//
// Side-effect boundary: this module performs all I/O through injected interface
// dependencies only (never concrete Drizzle/DB code):
//   - `LeadRepository`         — denormalize the current opt-in value onto the lead;
//   - `ComplianceRepository`   — append the immutable lawful-basis record;
//   - `ScheduledJobRepository` — cancel a lead's pending cadence/nurture outreach;
//   - `LifecycleManager`       — move the lead to the terminal `OPTED_OUT` state.
// It makes no network/WAHA calls and holds no state beyond its dependencies.
//
// Responsibilities (this task — Req 15.1–15.4):
//   - `recordLawfulBasis` — append an append-only lawful-basis record with its
//     status and timestamp AND denormalize the current value onto the lead so
//     reads (the send guard, the outbound choke point, the CRM_UI) see it
//     without scanning the log (Req 15.4);
//   - `applyOptOut` — set the lead's `Opt_In_Status` to `opt_out`, transition
//     the lead to the terminal `OPTED_OUT` state, and cancel all scheduled
//     outreach, together guaranteeing no outbound is sent while opted out
//     (Req 15.1, 15.2, 15.3).

import type { OptInStatus } from "@/core/types";
import type { LifecycleManager } from "@/services/lifecycle-manager";
import type {
	ComplianceRepository,
	LeadRepository,
	ScheduledJobRepository,
} from "@/services/repositories";

// ---------------------------------------------------------------------------
// Manager interface
// ---------------------------------------------------------------------------

/**
 * The I/O-bound compliance manager. Wraps the persistence boundary for LGPD
 * opt-out application and lawful-basis recording, coordinating the lead record,
 * the append-only compliance log, the scheduled-job mirror, and the
 * {@link LifecycleManager}. It is the single component that applies an opt-out,
 * so the "no outbound while opted out" invariant is enforced in one place
 * (Req 15).
 *
 * Opt-out *detection* (the pure `detectOptOut` in `@/core/opt-out`) is not part
 * of this interface; the Inbound_Handler runs detection and calls
 * {@link applyOptOut} when it matches.
 */
export interface ComplianceManager {
	/**
	 * Apply an opt-out for a lead: set `Opt_In_Status` to `opt_out`, move the
	 * lead to the terminal `OPTED_OUT` state, and cancel all of its scheduled
	 * outreach (Req 15.1, 15.2). Together these guarantee no further outbound is
	 * sent to the lead (Req 15.3).
	 *
	 * The steps are ordered so the silencing invariant holds even against a job
	 * that is already in flight when opt-out is applied:
	 *
	 *   1. Record `opt_out` via {@link recordLawfulBasis} (Req 15.1, 15.4). The
	 *      denormalized `opt_out` flag is itself a hard silencing signal — the
	 *      outbound choke point drops any send for an opted-out lead, and the
	 *      pure send guard returns `skip_and_cancel` on `Opt_In_Status ===
	 *      "opt_out"`.
	 *   2. Transition to `OPTED_OUT` via the injected {@link LifecycleManager}
	 *      (Req 15.2). Per the transition table `OPTED_OUT` is reachable from
	 *      every non-terminal state (Req 14.3); a second silencing signal, since
	 *      the send guard also stops on the `OPTED_OUT` state.
	 *   3. Cancel all pending cadence/nurture jobs via
	 *      `ScheduledJobRepository.cancelAllForLead` (Req 15.2) — defense in
	 *      depth that removes the queued work so it never wakes a worker.
	 *
	 * Setting the silencing signals (steps 1–2) *before* cancelling (step 3)
	 * closes the race window: any touch/nurture job that the worker picked up
	 * just before cancellation re-reads fresh state and is stopped by the guard,
	 * because the `opt_out` flag and `OPTED_OUT` state are already persisted.
	 *
	 * Idempotent: applying opt-out to an already-opted-out lead simply re-appends
	 * a lawful-basis record and re-denormalizes the same value; the redundant
	 * `OPTED_OUT → OPTED_OUT` transition is harmlessly rejected by the lifecycle
	 * manager (it is terminal), and cancelling already-cancelled jobs is a no-op.
	 *
	 * @param leadId - The lead opting out.
	 * @param at - The timestamp of the opt-out (the lawful-basis record time).
	 * @throws {UnknownLeadError} when the `leadId` has no persisted lead —
	 *         surfaced by the injected {@link LifecycleManager} (and ultimately
	 *         by the lead foreign key on the persistence writes); this manager
	 *         adds no redundant existence pre-check (see note on
	 *         {@link recordLawfulBasis}).
	 */
	applyOptOut(leadId: string, at: Date): Promise<void>;

	/**
	 * Record a change of lawful basis for a lead (Req 15.4). Writes to two
	 * places that must stay consistent:
	 *
	 *   - the append-only `compliance_records` log, via
	 *     `ComplianceRepository.appendRecord` — the immutable audit history of
	 *     every lawful-basis value the lead has held; and
	 *   - the denormalized current value on the lead, via
	 *     `LeadRepository.setOptInStatus` — so reads do not have to scan the log.
	 *
	 * The immutable log is appended first (it is the authoritative history),
	 * then the denormalized value is set.
	 *
	 * This wrapper performs no existence pre-check: per the design, a missing
	 * lead is surfaced by the persistence layer (the lead foreign key on the
	 * compliance/lead writes) and by the {@link LifecycleManager} on the
	 * {@link applyOptOut} path, rather than by a redundant read here. Callers
	 * (the Inbound_Handler) ensure the lead exists before recording its basis.
	 *
	 * @param leadId - The lead whose lawful basis changed.
	 * @param status - The new {@link OptInStatus} (`opt_in` or `opt_out`).
	 * @param at - The timestamp recorded on both the log entry and the lead.
	 */
	recordLawfulBasis(
		leadId: string,
		status: OptInStatus,
		at: Date,
	): Promise<void>;
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link ComplianceManagerService}. */
export interface ComplianceManagerConfig {
	/** Persistence boundary for the denormalized current opt-in value on the lead. */
	leads: LeadRepository;
	/** Append-only persistence boundary for lawful-basis records (Req 15.4). */
	compliance: ComplianceRepository;
	/** Persistence boundary for cancelling a lead's pending outreach (Req 15.2). */
	scheduledJobs: ScheduledJobRepository;
	/** Lifecycle manager used to move the lead to `OPTED_OUT` (Req 15.2). */
	lifecycle: LifecycleManager;
}

// ---------------------------------------------------------------------------
// ComplianceManagerService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link ComplianceManager} backed by the injected repository and
 * lifecycle dependencies. Stateless beyond its dependencies; every call writes
 * through the interfaces it was constructed with and performs no other I/O.
 */
export class ComplianceManagerService implements ComplianceManager {
	private readonly leads: LeadRepository;
	private readonly compliance: ComplianceRepository;
	private readonly scheduledJobs: ScheduledJobRepository;
	private readonly lifecycle: LifecycleManager;

	constructor(deps: ComplianceManagerConfig) {
		this.leads = deps.leads;
		this.compliance = deps.compliance;
		this.scheduledJobs = deps.scheduledJobs;
		this.lifecycle = deps.lifecycle;
	}

	/** @inheritdoc */
	async recordLawfulBasis(
		leadId: string,
		status: OptInStatus,
		at: Date,
	): Promise<void> {
		// Append the immutable audit record first (the authoritative history,
		// Req 15.4), then denormalize the current value onto the lead so reads
		// (send guard, outbound choke point, CRM_UI) see it without scanning the
		// log.
		await this.compliance.appendRecord(leadId, status, at);
		await this.leads.setOptInStatus(leadId, status, at);
	}

	/** @inheritdoc */
	async applyOptOut(leadId: string, at: Date): Promise<void> {
		// 1. Set `opt_out` (+ append the lawful-basis record). The denormalized
		//    flag is the primary silencing signal: the outbound choke point drops
		//    sends for an opted-out lead and the send guard stops on it
		//    (Req 15.1, 15.3, 15.4).
		await this.recordLawfulBasis(leadId, "opt_out", at);

		// 2. Transition to the terminal `OPTED_OUT` state — a second silencing
		//    signal the send guard also stops on (Req 15.2). `OPTED_OUT` is
		//    reachable from every non-terminal state (Req 14.3); the result is
		//    intentionally not inspected because the only rejection here is the
		//    idempotent re-application case (the lead is already `OPTED_OUT`,
		//    which is terminal), and the unknown-lead case surfaces as a thrown
		//    `UnknownLeadError`.
		await this.lifecycle.apply(leadId, "OPTED_OUT");

		// 3. Cancel all pending cadence/nurture jobs (Req 15.2) — defense in depth
		//    that removes the queued outreach so it never wakes a worker. Done
		//    last so the silencing signals (steps 1–2) are already persisted and
		//    any in-flight job re-reading state is stopped by the guard.
		await this.scheduledJobs.cancelAllForLead(leadId);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct a {@link ComplianceManager} from {@link ComplianceManagerConfig}. */
export function createComplianceManager(
	config: ComplianceManagerConfig,
): ComplianceManager {
	return new ComplianceManagerService(config);
}
