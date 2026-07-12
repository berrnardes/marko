// Cadence worker (I/O boundary — executes one scheduled cadence touch job).
//
// Implements the design's `Cadence_Worker`: the worker that handles each
// `CadenceTouchJob` (T1–T5) the `Cadence_Scheduler` enqueued. It is the State
// Guard's enforcement point — the durable touch jobs are scheduled days ahead,
// so by the time one fires the lead may have replied, opted out, been blocked,
// or been handed off, and the worker must re-check before sending anything.
//
// On every touch, in order:
//   1. Re-read the lead's FRESH lifecycle state + block flag from the CRM (the
//      State Guard's input, Req 5.1) — nothing time-sensitive is trusted from
//      the job payload.
//   2. Run the pure `evaluateSendGuard` over that snapshot. On
//      `"skip_and_cancel"` the touch is skipped and the lead's remaining
//      cadence jobs are cancelled (Req 5.2–5.4); the worker stops there.
//   3. On `"send"`, render the touch text via the pure `Message_Generator`
//      (Req 4.1–4.5) and enqueue an outbound send through the Outbound_Worker
//      choke point — never sent inline (design "Outbound choke point").
//   4. T5 special case (Req 4.6, 6.1): when T5 fires for a lead the guard let
//      through (i.e. it reached T5 without an earlier reply, opt-out, or
//      block), after enqueuing the breakup send the worker transitions the lead
//      to `CADENCE_EXHAUSTED` (Req 6.1) and triggers the monthly nurture flow
//      (the Nurture_Scheduler's `MONTHLY_NURTURE` transition + scheduling of
//      Req 6.2 is reached through the injected `NurtureTrigger` seam).
//
// Side-effect boundary: all I/O flows through injected INTERFACE dependencies
// only — never concrete Drizzle/DB or pg-boss code:
//   - `LeadRepository`    — re-read the fresh lead snapshot (Req 5.1);
//   - `MessageGenerator`  — PURE touch rendering (Req 4.1–4.5), no I/O;
//   - `OutboundSendQueue` — enqueue the rendered send onto the choke point;
//   - `CadenceScheduler`  — cancel the lead's remaining touches on a stop
//                           condition (Req 5.2);
//   - `LifecycleManager`  — set `CADENCE_EXHAUSTED` after T5 (Req 6.1);
//   - `NurtureTrigger`    — trigger the monthly nurture flow (Req 6.2), a seam
//                           the future Nurture_Scheduler (task 17) satisfies, so
//                           this worker depends on an interface rather than the
//                           concrete scheduler.
// The send-guard decision and the touch templates are pure (`@/core`); none of
// that logic is reimplemented here.

import { messageGenerator, type MessageGenerator } from "@/core/messages";
import { evaluateSendGuard } from "@/core/send-guard";
import type { LeadView, Touch } from "@/core/types";
import type {
	CadenceScheduler,
	CadenceTouchJob,
} from "@/services/cadence-scheduler";
import {
	UnknownLeadError,
	type LifecycleManager,
} from "@/services/lifecycle-manager";
import type { OutboundSendQueue } from "@/services/outbound-worker";
import type {
	LeadRepository,
	ScheduledJobRepository,
} from "@/services/repositories";

// ---------------------------------------------------------------------------
// Nurture trigger seam
// ---------------------------------------------------------------------------

/**
 * The minimal seam the Cadence_Worker needs to hand a lead that exhausted the
 * cadence to the monthly nurture flow (Req 6.1 → 6.2). It is intentionally a
 * narrow interface — just the start call — so the worker depends on an
 * interface rather than the concrete `Nurture_Scheduler` (task 17), which does
 * not exist yet.
 *
 * Its `startMonthly` signature matches the design's
 * `NurtureScheduler.startMonthly(leadId)`, so when the `Nurture_Scheduler` is
 * implemented it satisfies this seam directly with no adapter.
 */
export interface NurtureTrigger {
	/**
	 * Begin the monthly nurture flow for a lead that has entered
	 * `CADENCE_EXHAUSTED`: the implementation transitions the lead to
	 * `MONTHLY_NURTURE` and schedules recurring monthly outreach (Req 6.2).
	 */
	startMonthly(leadId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/**
 * The outcome of executing one cadence touch — a discriminated union over the
 * State Guard decision and the T5 special case, returned for observability and
 * to make the worker unit-testable without inspecting its collaborators:
 *
 *   - `"skipped"`   — the guard hit a stop condition (the lead replied, opted
 *     out, was blocked, or was handed off); the touch was not sent and the
 *     lead's remaining cadence jobs were cancelled, with `cancelledJobs` the
 *     count cancelled (Req 5.2–5.4).
 *   - `"sent"`      — the touch was rendered and enqueued onto the outbound
 *     choke point; `jobId` is the enqueued send's queue id (Req 4.1–4.5).
 *   - `"exhausted"` — the T5 breakup was enqueued and, the lead having reached
 *     T5 without an earlier reply/opt-out/block, the lead was moved to
 *     `CADENCE_EXHAUSTED` and the monthly nurture flow was triggered (Req 4.6,
 *     6.1, 6.2). `jobId` is the breakup send's queue id.
 */
export type CadenceTouchOutcome =
	| { status: "skipped"; leadId: string; touch: Touch; cancelledJobs: number }
	| { status: "sent"; leadId: string; touch: Touch; jobId: string }
	| { status: "exhausted"; leadId: string; touch: "T5"; jobId: string };

// ---------------------------------------------------------------------------
// Worker interface
// ---------------------------------------------------------------------------

/**
 * The I/O-bound cadence worker (design "Cadence_Scheduler / Cadence_Worker").
 * Stateless beyond its injected dependencies; every call re-reads the lead's
 * current state, so a touch decision is always made against fresh data.
 */
export interface CadenceWorker {
	/**
	 * Execute one scheduled cadence touch job along the State-Guard path
	 * (Req 5.1–5.4, 4.1–4.6, 6.1) and return its {@link CadenceTouchOutcome}.
	 *
	 * @param job - The `{ leadId, touch }` payload the scheduler enqueued.
	 * @throws {UnknownLeadError} when the job's `leadId` has no persisted lead —
	 *   a touch cannot be evaluated without a lead to read, so this is a hard
	 *   error rather than a silent skip.
	 */
	process(job: CadenceTouchJob): Promise<CadenceTouchOutcome>;
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link CadenceWorkerService}. */
export interface CadenceWorkerConfig {
	/** Persistence boundary used to re-read the fresh lead snapshot (Req 5.1). */
	leads: LeadRepository;
	/** Cadence scheduler used to cancel the lead's remaining touches (Req 5.2). */
	cadence: CadenceScheduler;
	/** Enqueue boundary onto the outbound choke point (never send inline). */
	outbound: OutboundSendQueue;
	/** Lifecycle manager used to set `CADENCE_EXHAUSTED` after T5 (Req 6.1). */
	lifecycle: LifecycleManager;
	/** Seam that hands an exhausted lead to the monthly nurture flow (Req 6.2). */
	nurture: NurtureTrigger;
	/**
	 * Mirror table for the lead's scheduled-job rows. When provided, the worker
	 * advances the firing touch's mirror row out of `pending` after acting —
	 * `done` on a send/exhaust, `skipped` when the State Guard stops the touch —
	 * so the `scheduled_jobs` mirror reflects reality instead of leaving every
	 * fired touch stuck at `pending` (which otherwise both misleads observability
	 * and makes `cancelAll` reconsider already-fired touches). Optional: when
	 * omitted (e.g. focused unit tests), the mirror is simply not updated.
	 */
	scheduledJobs?: ScheduledJobRepository;
	/**
	 * Pure message generator for the touch templates (Req 4.1–4.5). Defaults to
	 * the shared pure {@link messageGenerator}; injectable so tests may supply a
	 * fake renderer.
	 */
	messages?: MessageGenerator;
}

// ---------------------------------------------------------------------------
// CadenceWorkerService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link CadenceWorker}. Wires the fresh-state read (`LeadRepository`),
 * the pure State Guard (`evaluateSendGuard`), the pure touch rendering
 * (`MessageGenerator`), the outbound enqueue seam (`OutboundSendQueue`), the
 * remaining-touch cancellation (`CadenceScheduler`), and the T5 exhaustion path
 * (`LifecycleManager` + `NurtureTrigger`) into the design's State-Guard flow.
 * Holds no state beyond its dependencies.
 */
export class CadenceWorkerService implements CadenceWorker {
	private readonly leads: LeadRepository;
	private readonly cadence: CadenceScheduler;
	private readonly outbound: OutboundSendQueue;
	private readonly lifecycle: LifecycleManager;
	private readonly nurture: NurtureTrigger;
	private readonly messages: MessageGenerator;
	private readonly scheduledJobs?: ScheduledJobRepository;

	constructor(deps: CadenceWorkerConfig) {
		this.leads = deps.leads;
		this.cadence = deps.cadence;
		this.outbound = deps.outbound;
		this.lifecycle = deps.lifecycle;
		this.nurture = deps.nurture;
		this.messages = deps.messages ?? messageGenerator;
		this.scheduledJobs = deps.scheduledJobs;
	}

	/** @inheritdoc */
	async process(job: CadenceTouchJob): Promise<CadenceTouchOutcome> {
		const { leadId, touch } = job;

		// 1. Re-read the FRESH lead state + block flag (Req 5.1). The job payload
		//    is scheduled days ahead, so nothing time-sensitive is trusted from it:
		//    the lead may have replied, opted out, been blocked, or been handed off
		//    since the touch was created.
		const lead = await this.leads.findById(leadId);
		if (!lead) {
			throw new UnknownLeadError(leadId);
		}

		// 2. Pure State Guard over the fresh snapshot (Req 5.2–5.4). On any stop
		//    condition — an engaged/terminal state, the block flag, or an opt-out —
		//    skip the touch and cancel the lead's remaining cadence jobs so no later
		//    touch fires either.
		if (evaluateSendGuard(lead) === "skip_and_cancel") {
			// Mark THIS touch's mirror row skipped before cancelling the rest, so it
			// reads `skipped` (not `cancelled`) and is no longer `pending` when
			// `cancelAll` sweeps the remaining touches.
			await this.markTouch(leadId, touch, "skipped");
			const cancelledJobs = await this.cadence.cancelAll(leadId);
			return { status: "skipped", leadId, touch, cancelledJobs };
		}

		// 3. Send path: render the touch text (PURE, Req 4.1–4.5) and enqueue an
		//    outbound send through the choke point — outbound never goes out inline.
		//    The templates personalize `{nome}` from the lead's captured name (when
		//    an import supplied one) and fall back to a name-less greeting otherwise;
		//    T1 also personalizes from the collected qualification data (Req 4.1, 4.7).
		const view: LeadView = {
			displayName: lead.displayName,
			qualification: lead.qualification,
		};
		const content = this.messages.renderTouch(touch, view);
		const jobId = await this.outbound.enqueueSend({
			leadId,
			content,
			kind: "cadence",
		});

		// The touch has fired: advance its mirror row out of `pending` to `done`
		// so the `scheduled_jobs` mirror reflects that this touch is no longer
		// pending (Req 3.4 observability + accurate cancel-by-lead).
		await this.markTouch(leadId, touch, "done");

		// 4. T5 reached without an earlier reply/opt-out/block (the guard let it
		//    through, Req 4.6): the breakup message is now enqueued; exhaust the
		//    cadence (Req 6.1) and hand the lead to the monthly nurture flow
		//    (Req 6.2, via the injected seam). Nurture is triggered only once the
		//    lead has actually entered `CADENCE_EXHAUSTED`, so a rejected
		//    transition (e.g. a concurrent move) never spuriously starts nurture.
		if (touch === "T5") {
			const result = await this.lifecycle.apply(leadId, "CADENCE_EXHAUSTED");
			if (result.ok) {
				await this.nurture.startMonthly(leadId);
				return { status: "exhausted", leadId, touch, jobId };
			}
		}

		return { status: "sent", leadId, touch, jobId };
	}

	/**
	 * Advance the firing touch's mirror row(s) out of `pending` to `status`
	 * (`done` after a send, `skipped` when the guard stops the touch). A no-op
	 * when no {@link ScheduledJobRepository} was injected. Matches the lead's
	 * pending `cadence` rows for this `touch`; tolerant of there being none (e.g.
	 * a job whose mirror row was already swept), so it never throws on the hot
	 * path.
	 */
	private async markTouch(
		leadId: string,
		touch: Touch,
		status: "done" | "skipped",
	): Promise<void> {
		if (!this.scheduledJobs) {
			return;
		}
		const pending = await this.scheduledJobs.listByLead(leadId, "pending");
		for (const row of pending) {
			if (row.jobKind === "cadence" && row.touch === touch) {
				await this.scheduledJobs.updateStatus(row.id, status);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct a {@link CadenceWorker} from {@link CadenceWorkerConfig}. */
export function createCadenceWorker(
	config: CadenceWorkerConfig,
): CadenceWorker {
	return new CadenceWorkerService(config);
}
