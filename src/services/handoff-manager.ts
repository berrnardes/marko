// Handoff manager (I/O boundary — hand a replying Lead to a human consultant).
//
// The consequences of a Lead replying, in one place. The *trigger* lives in the
// Inbound_Handler, which decides whether a given inbound message is a handoff at
// all (ADR-003 rule 2 — a message from an already-engaged Lead is not); this
// module owns what follows.
//
// Side-effect boundary: all I/O through injected interface dependencies only
// (never concrete Drizzle/DB code):
//   - `LifecycleManager`       — move the Lead to `REPLIED`;
//   - `HandoffRepository`      — append the immutable handoff event + reason;
//   - `ScheduledJobRepository` — cancel the Lead's pending cadence jobs.
// It makes no network/WAHA calls itself; the consultant alert goes through the
// injected {@link HandoffNotifier}, best-effort.
//
// Responsibilities (Req 13.1–13.4, ADR-003 rule 3):
//   - transition the Lead to `REPLIED` via the injected `LifecycleManager`.
//     Unlike the pre-ADR-003 `→ HOT` edge — which was reachable from every
//     non-terminal state — the table accepts this ONLY from `IN_CADENCE` and
//     `COMPLETED`. That rejection is load-bearing: it is what stops a Lead that
//     keeps typing from re-alerting the consultant on every message, and it
//     covers the late reply (`COMPLETED → REPLIED`) with the same edge;
//   - persist a handoff event recording the triggering reason (Req 13.2);
//   - make the Lead's collected data and message history available to the
//     consultant in the CRM_UI (Req 13.3) — satisfied by the `REPLIED`
//     transition plus the persisted handoff event, which is what the CRM_UI
//     handoff view reads;
//   - stop further automated outbound (Req 13.4) by cancelling the Lead's
//     pending cadence jobs, with `REPLIED` acting as a defense-in-depth
//     send-guard stop condition.
//
// Consultant assignment: `handoff(leadId, reason)` carries no consultant id, and
// there is no assignment target at this layer (a consultant is chosen when one
// picks the Lead up in the CRM_UI). So this manager does NOT call
// `LeadRepository.assignConsultant` — it would have no id to pass.

import type { HandoffReason } from "@/core/types";
import { logger } from "@/logger";
import type { LifecycleManager } from "@/services/lifecycle-manager";
import type {
	HandoffRepository,
	ScheduledJobRepository,
} from "@/services/repositories";

// ---------------------------------------------------------------------------
// Manager interface
// ---------------------------------------------------------------------------

/**
 * The I/O-bound handoff manager. Wraps the persistence boundary for handing a
 * replying Lead over, coordinating the {@link LifecycleManager}, the handoff
 * event log, and the scheduled-job mirror. It is the single component that
 * performs a handoff, so the "handed-off Leads are REPLIED and silenced"
 * invariant is enforced in one place (Req 13).
 *
 * Handoff *triggering* is not part of this interface: the Inbound_Handler
 * decides whether an inbound message is a handoff (ADR-003 rule 2) and calls
 * {@link handoff} with the matched reason.
 */
export interface HandoffManager {
	/**
	 * Hand a Lead off to a human consultant (Req 13). The steps are ordered so
	 * the silencing invariant (Req 13.4) holds even against a cadence/nurture job
	 * that is already in flight when the handoff fires:
	 *
	 *   1. Transition the Lead to `REPLIED` via the injected
	 *      {@link LifecycleManager} (ADR-003). The table accepts this only from
	 *      `IN_CADENCE` and `COMPLETED`; from anywhere else it is rejected and
	 *      the state is left untouched. `REPLIED` is a send-guard stop state (see
	 *      `evaluateSendGuard`), so persisting it is the primary silencing signal
	 *      (Req 13.4). Every rejection case is benign — an already engaged Lead
	 *      (`REPLIED`), one the consultant already closed (`WON`/`LOST`), or an
	 *      opted-out one (terminal, must not be resurrected) — and each one
	 *      correctly suppresses the alert in step 4. The unknown-lead case
	 *      surfaces as a thrown `UnknownLeadError`.
	 *   2. Persist the handoff event recording the triggering `reason`
	 *      (Req 13.2). Together with the `REPLIED` state this makes the Lead and its
	 *      already-persisted qualification data + message history discoverable in
	 *      the CRM_UI handoff view (Req 13.3).
	 *   3. Cancel all pending cadence/nurture jobs via
	 *      `ScheduledJobRepository.cancelAllForLead` (Req 13.4) — defense in depth
	 *      that removes the queued outreach so it never wakes a worker. Done last
	 *      so the `REPLIED` silencing signal (step 1) is already persisted: any
	 *      in-flight job re-reading fresh state is stopped by the send guard.
	 *
	 * Idempotent: handing off an already-engaged Lead appends another handoff
	 * event and re-cancels already-cancelled jobs (a no-op); the redundant
	 * transition is rejected by the lifecycle manager, so no second alert fires.
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
 * to `REPLIED` — not on a redundant handoff of an already-engaged Lead — so a
 * Lead that keeps replying does not re-alert the consultant on every message.
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
	/** Lifecycle manager used to move the Lead to `REPLIED` (ADR-003). */
	lifecycle: LifecycleManager;
	/** Append-only persistence boundary for handoff events (Req 13.2). */
	handoffEvents: HandoffRepository;
	/** Persistence boundary for cancelling the Lead's pending outreach (Req 13.4). */
	scheduledJobs: ScheduledJobRepository;
	/**
	 * Optional consultant alert, fired best-effort when a Lead newly becomes
	 * `REPLIED`. Omitted in tests and when no consultant numbers are configured.
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
		// 1. Transition to `REPLIED` (ADR-003). It is a send-guard stop state, so
		//    persisting it is the primary silencing signal (Req 13.4). The result
		//    drives the notification decision below: the table only accepts this
		//    move from `IN_CADENCE` and `COMPLETED`, so a lead already `REPLIED`
		//    (or closed as `WON`/`LOST`) is rejected here and the consultant is not
		//    re-alerted — which is what stops a chatty lead from pinging them on
		//    every message. An unknown lead throws `UnknownLeadError`.
		const transition = await this.lifecycle.apply(leadId, "REPLIED");

		// 2. Record the handoff event with its triggering reason (Req 13.2). With
		//    the `REPLIED` state this makes the Lead and its already-persisted
		//    qualification data + message history surface in the CRM_UI handoff
		//    view for the consultant (Req 13.3).
		await this.handoffEvents.appendEvent(leadId, reason, new Date());

		// 3. Cancel all pending cadence jobs (Req 13.4) — defense in depth that
		//    removes the queued outreach so it never wakes a worker. Done last so
		//    the `REPLIED` silencing signal (step 1) is already persisted and
		//    any in-flight job re-reading state is stopped by the send guard.
		await this.scheduledJobs.cancelAllForLead(leadId);

		// 4. Alert the consultant, best-effort, only when the Lead *newly* became
		//    `REPLIED` (`transition.ok`). A handoff of an already-engaged Lead is
		//    rejected by the lifecycle manager, so a Lead that keeps replying never
		//    re-alerts (ADR-003 rule 2). A notification failure must never fail the
		//    handoff itself, so it is swallowed.
		if (transition.ok && this.notifier) {
			try {
				await this.notifier.notify(leadId, reason);
			} catch (err) {
				logger.error(
					{ event: "handoff.notify_failed", leadId, err },
					"consultant notification failed",
				);
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
