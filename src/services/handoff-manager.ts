// Handoff manager (I/O boundary — hot-lead handoff to a human consultant).
//
// Implements the design's `Handoff_Manager` as the persistence wrapper that
// transfers a Lead to a human consultant (Req 13). Handoff is *triggered*
// elsewhere — the Qualification_Agent's `detect_triggers`/`handoff` graph nodes
// invoke this manager with the reason when the Lead's Score crosses 70
// (`hot_score`), when frustration is detected (`frustration`), or when the Lead
// asks for a fact outside the agent's available data (`out_of_data`). This
// module owns the *consequences* of a handoff; it does not re-evaluate the
// trigger.
//
// Side-effect boundary: this module performs all I/O through injected interface
// dependencies only (never concrete Drizzle/DB code):
//   - `LifecycleManager`       — move the Lead to `HOT` regardless of stage;
//   - `HandoffRepository`      — append the immutable handoff event + reason;
//   - `ScheduledJobRepository` — cancel the Lead's pending cadence/nurture jobs.
// It makes no network/WAHA calls and holds no state beyond its dependencies.
//
// Responsibilities (this task — Req 13.1–13.4):
//   - transition the Lead to `HOT` immediately regardless of its current funnel
//     stage, via the injected `LifecycleManager` (Req 13.1). The lifecycle
//     transition table permits `→ HOT` from every non-terminal state precisely
//     so handoff can be honored from any stage (see `@/core/lifecycle`);
//   - persist a handoff event recording the triggering reason (Req 13.2);
//   - make the Lead's collected qualification data and message history available
//     to the consultant in the CRM_UI (Req 13.3) — satisfied by the `HOT`
//     transition plus the persisted handoff event: the CRM_UI handoff view
//     lists HOT/handed-off Leads and surfaces their already-persisted
//     qualification fields and message history (see note on consultant
//     assignment below);
//   - stop further automated outbound for the Lead (Req 13.4) by cancelling its
//     pending cadence/nurture jobs, with the `HOT` state acting as a
//     defense-in-depth send-guard stop condition.
//
// Consultant assignment: the design's `handoff(leadId, reason)` signature
// carries no consultant id, and there is no consultant-assignment target at this
// layer (a specific consultant is chosen when one picks the Lead up in the
// CRM_UI). So this manager does NOT call `LeadRepository.assignConsultant` — it
// would have no id to pass. Req 13.3 is met by making the handed-off Lead
// discoverable (HOT + recorded handoff event) with its data already persisted,
// which is exactly what the CRM_UI handoff view reads.

import type { HandoffReason } from "@/core/types";
import type { LifecycleManager } from "@/services/lifecycle-manager";
import type {
	HandoffRepository,
	ScheduledJobRepository,
} from "@/services/repositories";

// ---------------------------------------------------------------------------
// Manager interface
// ---------------------------------------------------------------------------

/**
 * The I/O-bound handoff manager. Wraps the persistence boundary for hot-lead
 * handoff, coordinating the {@link LifecycleManager}, the append-only handoff
 * event log, and the scheduled-job mirror. It is the single component that
 * performs a handoff, so the "handed-off Leads are HOT and silenced" invariant
 * is enforced in one place (Req 13).
 *
 * Handoff *triggering* (the agent's `detect_triggers`/`handoff` nodes) is not
 * part of this interface; the Qualification_Agent calls {@link handoff} with
 * the matched reason.
 */
export interface HandoffManager {
	/**
	 * Hand a Lead off to a human consultant (Req 13). The steps are ordered so
	 * the silencing invariant (Req 13.4) holds even against a cadence/nurture job
	 * that is already in flight when the handoff fires:
	 *
	 *   1. Transition the Lead to `HOT` via the injected
	 *      {@link LifecycleManager} (Req 13.1). The transition table permits
	 *      `→ HOT` from every non-terminal state, so the move succeeds regardless
	 *      of the Lead's current funnel stage. `HOT` is also a send-guard stop
	 *      state (see `evaluateSendGuard`), so persisting it is the primary
	 *      silencing signal (Req 13.4). The result is intentionally not
	 *      inspected: the only rejections here are the idempotent re-handoff case
	 *      (the Lead is already `HOT`, a no-op self-transition) and an opted-out
	 *      Lead (the terminal `OPTED_OUT` state, which must not be resurrected);
	 *      the unknown-lead case surfaces as a thrown `UnknownLeadError`.
	 *   2. Persist the handoff event recording the triggering `reason`
	 *      (Req 13.2). Together with the `HOT` state this makes the Lead and its
	 *      already-persisted qualification data + message history discoverable in
	 *      the CRM_UI handoff view (Req 13.3).
	 *   3. Cancel all pending cadence/nurture jobs via
	 *      `ScheduledJobRepository.cancelAllForLead` (Req 13.4) — defense in depth
	 *      that removes the queued outreach so it never wakes a worker. Done last
	 *      so the `HOT` silencing signal (step 1) is already persisted: any
	 *      in-flight job re-reading fresh state is stopped by the send guard.
	 *
	 * Idempotent: handing off an already-handed-off (`HOT`) Lead simply appends
	 * another handoff event and re-cancels already-cancelled jobs (a no-op); the
	 * redundant `HOT → HOT` transition is harmlessly rejected by the lifecycle
	 * manager.
	 *
	 * @param leadId - The Lead to hand off.
	 * @param reason - The trigger that caused the handoff (Req 13.1, 13.2).
	 * @throws {UnknownLeadError} when the `leadId` has no persisted Lead —
	 *         surfaced by the injected {@link LifecycleManager}.
	 */
	handoff(leadId: string, reason: HandoffReason): Promise<void>;
}

// ---------------------------------------------------------------------------
// Consultant notification boundary
// ---------------------------------------------------------------------------

/**
 * Best-effort notification that a Lead has been handed off, so a human
 * consultant is alerted on their own phone (rather than having to watch the
 * CRM). Invoked by {@link HandoffManager} only when a Lead *newly* transitions
 * to `HOT` — not on a redundant re-handoff of an already-`HOT` Lead — so a Lead
 * that keeps replying does not re-alert the consultant on every message.
 *
 * Implementations must never throw into the handoff path: a notification is a
 * courtesy and must not roll back or fail the handoff itself. The concrete
 * {@link import("./handoff-notifier").WahaHandoffNotifier} sends a WhatsApp
 * message with the Lead's context to the configured consultant number(s).
 */
export interface HandoffNotifier {
	/** Alert the consultant(s) that `leadId` was handed off for `reason`. */
	notify(leadId: string, reason: HandoffReason): Promise<void>;
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link HandoffManagerService}. */
export interface HandoffManagerConfig {
	/** Lifecycle manager used to move the Lead to `HOT` regardless of stage (Req 13.1). */
	lifecycle: LifecycleManager;
	/** Append-only persistence boundary for handoff events (Req 13.2). */
	handoffEvents: HandoffRepository;
	/** Persistence boundary for cancelling the Lead's pending outreach (Req 13.4). */
	scheduledJobs: ScheduledJobRepository;
	/**
	 * Optional consultant alert, fired best-effort when a Lead newly becomes
	 * `HOT`. Omitted in tests and when no consultant numbers are configured.
	 */
	notifier?: HandoffNotifier;
}

// ---------------------------------------------------------------------------
// HandoffManagerService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link HandoffManager} backed by the injected lifecycle and
 * repository dependencies. Stateless beyond its dependencies; every call writes
 * through the interfaces it was constructed with and performs no other I/O.
 */
export class HandoffManagerService implements HandoffManager {
	private readonly lifecycle: LifecycleManager;
	private readonly handoffEvents: HandoffRepository;
	private readonly scheduledJobs: ScheduledJobRepository;
	private readonly notifier?: HandoffNotifier;

	constructor(deps: HandoffManagerConfig) {
		this.lifecycle = deps.lifecycle;
		this.handoffEvents = deps.handoffEvents;
		this.scheduledJobs = deps.scheduledJobs;
		this.notifier = deps.notifier;
	}

	/** @inheritdoc */
	async handoff(leadId: string, reason: HandoffReason): Promise<void> {
		// 1. Transition to `HOT` immediately, regardless of the current funnel
		//    stage (Req 13.1). `HOT` is a send-guard stop state, so persisting it
		//    is the primary silencing signal (Req 13.4). The result drives only the
		//    notification decision below — see the interface JSDoc for the
		//    idempotent/terminal rejection cases; an unknown lead throws
		//    `UnknownLeadError`.
		const transition = await this.lifecycle.apply(leadId, "HOT");

		// 2. Record the handoff event with its triggering reason (Req 13.2). With
		//    the `HOT` state this makes the Lead and its already-persisted
		//    qualification data + message history surface in the CRM_UI handoff
		//    view for the consultant (Req 13.3).
		await this.handoffEvents.appendEvent(leadId, reason, new Date());

		// 3. Cancel all pending cadence/nurture jobs (Req 13.4) — defense in depth
		//    that removes the queued outreach so it never wakes a worker. Done
		//    last so the `HOT` silencing signal (step 1) is already persisted and
		//    any in-flight job re-reading state is stopped by the send guard.
		await this.scheduledJobs.cancelAllForLead(leadId);

		// 4. Alert the consultant, best-effort, only when the Lead *newly* became
		//    `HOT` (`transition.ok`). A redundant re-handoff of an already-`HOT`
		//    Lead is rejected by the lifecycle manager, so a Lead that keeps
		//    replying never re-alerts. A notification failure must never fail the
		//    handoff itself, so it is swallowed.
		if (transition.ok && this.notifier) {
			try {
				await this.notifier.notify(leadId, reason);
			} catch (err) {
				console.error("[handoff] consultant notification failed", leadId, err);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct a {@link HandoffManager} from {@link HandoffManagerConfig}. */
export function createHandoffManager(
	config: HandoffManagerConfig,
): HandoffManager {
	return new HandoffManagerService(config);
}
