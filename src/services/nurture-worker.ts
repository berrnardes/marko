// Nurture worker (I/O boundary — executes one scheduled monthly nurture job).
//
// Implements the design's `Nurture_Worker`: the worker that handles each
// `NurtureJob` the `Nurture_Scheduler` enqueued. Like the cadence touch jobs,
// nurture jobs are scheduled a calendar month ahead, so by the time one fires
// the lead may have replied, opted out, or been blocked. The worker therefore
// re-checks fresh state before sending anything, then enqueues the nurture
// outbound send and schedules the following month's job to perpetuate the
// monthly chain (Req 6.3).
//
// On every nurture job, in order:
//   1. Re-read the lead's FRESH lifecycle state + block flag from the CRM (the
//      State Guard's input, Req 5.1) — nothing time-sensitive is trusted from
//      the job payload.
//   2. Run the pure `evaluateSendGuard` over that snapshot. On
//      `"skip_and_cancel"` the nurture is skipped and the lead's remaining
//      nurture jobs are cancelled (Req 5.2–5.4, 6.4); the worker stops there and
//      does NOT schedule another month (the chain ends when the lead leaves
//      `MONTHLY_NURTURE`).
//   3. On `"send"` (the lead is still in `MONTHLY_NURTURE`), render the nurture
//      text via the pure `Message_Generator` and enqueue an outbound send
//      through the Outbound_Worker choke point — never sent inline (design
//      "Outbound choke point").
//   4. Schedule the NEXT monthly nurture job via the `Nurture_Scheduler` so the
//      one-calendar-month recurrence continues (Req 6.3).
//
// Side-effect boundary: all I/O flows through injected INTERFACE dependencies
// only — never concrete Drizzle/DB or pg-boss code:
//   - `LeadRepository`     — re-read the fresh lead snapshot (Req 5.1);
//   - `MessageGenerator`   — PURE nurture rendering, no I/O;
//   - `OutboundSendQueue`  — enqueue the rendered send onto the choke point;
//   - `NurtureScheduler`   — cancel the lead's pending nurture on a stop
//                            condition (Req 6.4) and schedule next month (Req 6.3).
// The send-guard decision and the nurture template are pure (`@/core`); none of
// that logic is reimplemented here.

import { messageGenerator, type MessageGenerator } from "@/core/messages";
import { evaluateSendGuard } from "@/core/send-guard";
import type { LeadView } from "@/core/types";
import { UnknownLeadError } from "@/services/lifecycle-manager";
import type {
	NurtureJob,
	NurtureScheduler,
} from "@/services/nurture-scheduler";
import type { OutboundSendQueue } from "@/services/outbound-worker";
import type { LeadRepository } from "@/services/repositories";

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/**
 * The outcome of executing one monthly nurture job — a discriminated union over
 * the State Guard decision, returned for observability and to make the worker
 * unit-testable without inspecting its collaborators:
 *
 *   - `"skipped"` — the guard hit a stop condition (the lead replied, opted
 *     out, or was blocked); the nurture was not sent, the lead's remaining
 *     nurture jobs were cancelled (Req 6.4), and the monthly chain ends.
 *     `cancelledJobs` is the count cancelled.
 *   - `"sent"`    — the nurture was rendered and enqueued onto the outbound
 *     choke point (`sendJobId`), and the following month's nurture was
 *     scheduled (`nextJobId`) to continue the one-month recurrence (Req 6.3).
 */
export type NurtureOutcome =
	| { status: "skipped"; leadId: string; cancelledJobs: number }
	| { status: "sent"; leadId: string; sendJobId: string; nextJobId: string };

// ---------------------------------------------------------------------------
// Worker interface
// ---------------------------------------------------------------------------

/**
 * The I/O-bound nurture worker (design "Nurture_Worker"). Stateless beyond its
 * injected dependencies; every call re-reads the lead's current state, so a
 * nurture decision is always made against fresh data.
 */
export interface NurtureWorker {
	/**
	 * Execute one scheduled monthly nurture job along the State-Guard path
	 * (Req 5.1–5.4, 6.3, 6.4) and return its {@link NurtureOutcome}.
	 *
	 * @param job - The `{ leadId }` payload the scheduler enqueued.
	 * @throws {UnknownLeadError} when the job's `leadId` has no persisted lead —
	 *   a nurture cannot be evaluated without a lead to read, so this is a hard
	 *   error rather than a silent skip.
	 */
	process(job: NurtureJob): Promise<NurtureOutcome>;
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link NurtureWorkerService}. */
export interface NurtureWorkerConfig {
	/** Persistence boundary used to re-read the fresh lead snapshot (Req 5.1). */
	leads: LeadRepository;
	/** Enqueue boundary onto the outbound choke point (never send inline). */
	outbound: OutboundSendQueue;
	/**
	 * Nurture scheduler used to cancel the lead's pending nurture on a stop
	 * condition (Req 6.4) and to schedule the following month's job (Req 6.3).
	 */
	nurture: NurtureScheduler;
	/**
	 * Pure message generator for the nurture template. Defaults to the shared
	 * pure {@link messageGenerator}; injectable so tests may supply a fake
	 * renderer.
	 */
	messages?: MessageGenerator;
}

// ---------------------------------------------------------------------------
// NurtureWorkerService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link NurtureWorker}. Wires the fresh-state read (`LeadRepository`),
 * the pure State Guard (`evaluateSendGuard`), the pure nurture rendering
 * (`MessageGenerator`), the outbound enqueue seam (`OutboundSendQueue`), and the
 * cancel/reschedule paths (`NurtureScheduler`) into the design's monthly nurture
 * flow. Holds no state beyond its dependencies.
 */
export class NurtureWorkerService implements NurtureWorker {
	private readonly leads: LeadRepository;
	private readonly outbound: OutboundSendQueue;
	private readonly nurture: NurtureScheduler;
	private readonly messages: MessageGenerator;

	constructor(deps: NurtureWorkerConfig) {
		this.leads = deps.leads;
		this.outbound = deps.outbound;
		this.nurture = deps.nurture;
		this.messages = deps.messages ?? messageGenerator;
	}

	/** @inheritdoc */
	async process(job: NurtureJob): Promise<NurtureOutcome> {
		const { leadId } = job;

		// 1. Re-read the FRESH lead state + block flag (Req 5.1). The job payload
		//    is scheduled a month ahead, so nothing time-sensitive is trusted from
		//    it: the lead may have replied, opted out, or been blocked since the
		//    nurture was scheduled.
		const lead = await this.leads.findById(leadId);
		if (!lead) {
			throw new UnknownLeadError(leadId);
		}

		// 2. Pure State Guard over the fresh snapshot (Req 5.2–5.4). On any stop
		//    condition — an engaged/terminal state, the block flag, or an opt-out —
		//    skip the nurture and cancel the lead's remaining nurture jobs so no
		//    later month fires either (Req 6.4). The monthly chain ends here; no
		//    next job is scheduled.
		if (evaluateSendGuard(lead) === "skip_and_cancel") {
			const cancelledJobs = await this.nurture.cancel(leadId);
			return { status: "skipped", leadId, cancelledJobs };
		}

		// 3. Send path: render the nurture text (PURE) and enqueue an outbound send
		//    through the choke point — outbound never goes out inline. The template
		//    personalizes `{nome}` from the lead's captured name when present and
		//    falls back to its name-less greeting otherwise.
		const view: LeadView = {
			displayName: lead.displayName,
			qualification: lead.qualification,
		};
		const content = this.messages.renderNurture(view);
		const sendJobId = await this.outbound.enqueueSend({
			leadId,
			content,
			kind: "nurture",
		});

		// 4. Perpetuate the one-calendar-month recurrence: schedule the following
		//    month's nurture job now that this month's send is enqueued (Req 6.3).
		const nextJobId = await this.nurture.scheduleNext(leadId);

		return { status: "sent", leadId, sendJobId, nextJobId };
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct a {@link NurtureWorker} from {@link NurtureWorkerConfig}. */
export function createNurtureWorker(
	config: NurtureWorkerConfig,
): NurtureWorker {
	return new NurtureWorkerService(config);
}
