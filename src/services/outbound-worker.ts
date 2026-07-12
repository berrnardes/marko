// Outbound worker (I/O boundary — the single outbound send choke point).
//
// Implements the design's `Outbound_Worker` and "Outbound choke point": every
// outbound message — a cadence touch, a nurture message, or a qualification
// reply — is enqueued as an *outbound send job* and processed here. This is the
// ONLY code path that calls `WAHA_Client.sendText`, so the per-lead and
// per-number invariants hold regardless of which feature requested the send.
//
// The send path follows the design's choke-point flowchart, in order:
//   1. Lead opt_out?            → drop the send, never go outbound (Req 15.3).
//   1b. Lead in a send-guard stop state (replied/handed-off/blocked, …)? → drop
//                                 the send. The touch/nurture jobs are scheduled
//                                 (and the rendered message enqueued here) ahead
//                                 of time, so a lead that replies after a touch
//                                 fired but before this job is drained must not
//                                 still receive the queued message (Req 5.2, 13.4).
//   2. Number block flag set?   → stop; perform no send from a blocked number
//                                 (Req 18.2, 18.3).
//   3. Within the Send_Window?  → if not, defer to the window reopening
//                                 (Req 17.4).
//   4. daily_count < cap?       → if not, defer to the next day (Req 16.2).
//   5. Wait a randomized delay within the configured range (Req 17.1).
//   6. Simulate typing presence before sending (Req 17.2).
//   7. `WAHA_Client.sendText` — the single send.
//   8. Increment the per-number daily counter AND record the message in the
//      same transaction (Req 16.2; design "Outbound send" error handling).
//
// Steps 2–4 reuse the pure anti-ban accounting (`canSend`) through the
// `Anti_Ban_Controller` (`evaluate`), and step 5 reuses its randomized pacing
// (`nextDelayMs`); none of that math is reimplemented here. The atomic commit
// of step 8 is delegated to an injected `OutboundSendCommitter` so the
// transaction boundary lives in the data layer (task 23.1), keeping this
// service dependent on interfaces, never concrete DB code.
//
// Side-effect boundary: this module performs all I/O through injected interface
// dependencies only — the `LeadRepository` (opt-out gate + chat-id source via
// the lead's E.164), the `AntiBanController` (block/window/cap decision +
// pacing), the `WahaClient` (typing presence + the send), and the
// `OutboundSendCommitter` (the confirmed-send transaction). Time enters through
// the injected `Clock` seam (never `Date.now()`) and the pacing wait through an
// injectable `sleep` seam (never a bare `setTimeout` in the logic), so the
// worker is deterministic and unit-testable without a live WAHA/DB.
//
// Scheduling note: deferral/parking outcomes (`deferred_window`,
// `deferred_cap`, `blocked`) are returned to the caller rather than acted on
// here. Rescheduling a pg-boss job to the next window/day, and reassigning or
// parking a job for a blocked number, are entry-point concerns wired when the
// pg-boss handlers are registered (task 23.1); this service yields the decision
// and stays free of the queue.

import type { SendDecision } from "@/core/anti-ban";
import { evaluateSendGuard } from "@/core/send-guard";
import type { Clock, LeadSnapshot } from "@/core/types";
import type { AntiBanController } from "@/services/anti-ban-controller";
import { UnknownLeadError } from "@/services/lifecycle-manager";
import type {
	LeadRepository,
	MessageRecord,
	MessageRepository,
} from "@/services/repositories";
import type { WahaClient } from "@/services/waha-client";

// ---------------------------------------------------------------------------
// Job, outcome, and confirmed-send shapes
// ---------------------------------------------------------------------------

/**
 * Which feature requested an outbound send. Carried on the job for observability
 * and auditing; the choke-point logic is identical for every kind, because all
 * outbound flows through this one path (design "Outbound choke point").
 */
export type OutboundKind = "cadence" | "nurture" | "qualification";

/**
 * The payload of an enqueued outbound send job (design "Enqueue outbound send
 * job"). It carries everything the choke point needs to gate and perform the
 * send: the target lead (the opt-out gate and the E.164 source for chat-id
 * resolution), the sending number (the anti-ban gate and message attribution),
 * and the fully-rendered message text. The canonical WhatsApp `chatId` is
 * resolved at send time from the lead's E.164 rather than carried here, so a
 * stale chat id can never be sent.
 */
export interface OutboundSendJob {
	/** The lead the message is for (opt-out gate + chat-id source). */
	leadId: string;
	/** The WhatsApp number that should send the message (anti-ban gate). */
	numberId: string;
	/** The fully-rendered message text to send. */
	content: string;
	/** Which feature requested the send (cadence / nurture / qualification). */
	kind: OutboundKind;
}

/**
 * A requesting feature's intent to send a fully-rendered outbound message,
 * handed to the {@link OutboundSendQueue} (design "Enqueue outbound send job").
 * It carries only what a feature knows — the target lead, the rendered text,
 * and which feature asked — but deliberately NOT the physical sending number:
 * assigning an available number (and reassigning it when one is blocked) is an
 * anti-ban/outbound concern resolved when the job is dequeued, not something a
 * cadence touch, nurture message, or qualification reply decides. The queue
 * turns this request into the {@link OutboundSendJob} the worker processes.
 */
export interface OutboundSendRequest {
	/**
	 * Optional per-flow trace id carried from the inbound flow that caused this
	 * send, so the reply can be correlated back to the message that triggered it.
	 * Absent for sends originated by cadence/nurture timers rather than a reply.
	 */
	correlationId?: string;
	/** The lead the message is for. */
	leadId: string;
	/** The fully-rendered message text to send. */
	content: string;
	/** Which feature requested the send (cadence / nurture / qualification). */
	kind: OutboundKind;
}

/**
 * The enqueue boundary onto the outbound choke point — the durable-queue seam
 * the sending features depend on (the `Cadence_Worker`, the `Nurture_Worker`,
 * and the qualification reply path). It is the enqueue counterpart to
 * {@link OutboundWorker.process}: this puts an outbound send on the queue, and
 * the worker later takes it off and performs the single guarded send.
 *
 * Injected rather than constructed inline so those features never touch pg-boss
 * directly and stay unit-testable against a fake queue (mirroring how the
 * cadence scheduler depends on its `CadenceJobQueue`). Production wiring (task
 * 23.1) backs this with the real pg-boss instance — assigning an available
 * number (via the `NumberRepository` / `Anti_Ban_Controller`) to form the
 * {@link OutboundSendJob} the {@link OutboundWorker} processes; tests back it
 * with an in-memory fake.
 */
export interface OutboundSendQueue {
	/**
	 * Enqueue a fully-rendered outbound send for delivery through the choke
	 * point, returning the queue's job id.
	 */
	enqueueSend(request: OutboundSendRequest): Promise<string>;
}

/**
 * The outcome of processing one outbound send job — a discriminated union over
 * the choke-point decision:
 *
 *   - `"sent"`            — the message went out; carries the WAHA message id and
 *     the number's new daily count (Req 16.2, 17.2).
 *   - `"dropped_opt_out"` — the lead has opted out; the send is dropped and no
 *     outbound is ever made (Req 15.3). Terminal: the job must not be retried.
 *   - `"dropped_stopped"` — the lead reached a send-guard stop condition after
 *     this send was enqueued (it replied / was handed off to a consultant / was
 *     blocked, e.g. `REPLIED`/`HOT`/`WARM`/`DISQUALIFIED`/`OPTED_OUT` or the
 *     block flag). The queued message is dropped so no automated outbound is
 *     sent to an already-engaged lead (Req 5.2, 13.4). Terminal: do not retry.
 *   - `"blocked"`         — the sending number's block flag is set; no send is
 *     performed (Req 18.2). The caller stops using this number for the job
 *     (reassign/park is an entry-point concern, Req 18.3).
 *   - `"deferred_window"` — the current time is outside the Send_Window; the
 *     caller reschedules the job to the window reopening (Req 17.4).
 *   - `"deferred_cap"`    — the number reached its current daily cap; the caller
 *     reschedules the job to the next day (Req 16.2).
 *   - `"dropped_unreachable"` — WAHA confirmed the lead's number does not exist
 *     on WhatsApp, so nothing is sent. The caller marks the lead unreachable and
 *     cancels its pending outreach. Terminal: the job must not be retried, and
 *     the daily cap is NOT incremented (no send occurred).
 */
export type OutboundSendOutcome =
	| {
			status: "sent";
			leadId: string;
			numberId: string;
			waMessageId: string;
			dailyCount: number;
	  }
	| { status: "dropped_opt_out"; leadId: string }
	| { status: "dropped_stopped"; leadId: string }
	| { status: "dropped_unreachable"; leadId: string }
	| { status: "blocked"; leadId: string; numberId: string }
	| { status: "deferred_window"; leadId: string; numberId: string }
	| { status: "deferred_cap"; leadId: string; numberId: string };

/**
 * A confirmed outbound send awaiting its atomic accounting commit. Passed to the
 * {@link OutboundSendCommitter} after `WAHA_Client.sendText` succeeds.
 */
export interface ConfirmedSend {
	/** The lead the message was sent to (message attribution). */
	leadId: string;
	/** The number the message was sent from (counter increment + attribution). */
	numberId: string;
	/** The exact text that was sent. */
	content: string;
	/** The WAHA message id returned by the send. */
	waMessageId: string;
	/** When the send was confirmed. */
	sentAt: Date;
}

/** The result of an atomic confirmed-send commit. */
export interface ConfirmedSendResult {
	/** The sending number's new daily counter value after the increment. */
	dailyCount: number;
	/** The persisted outbound message record. */
	message: MessageRecord;
}

/**
 * The transaction boundary for a confirmed send (design "Outbound send"): it
 * increments the sending number's daily counter AND records the outbound
 * message in the SAME transaction, so a single logical send can never
 * double-count the cap nor record a message without counting it — even when the
 * job is retried after a transient failure (Req 16.2).
 *
 * It is an injected seam so the atomic transaction lives in the data layer
 * (task 23.1); this service depends only on the interface. Use
 * {@link createSequentialOutboundSendCommitter} for a best-effort, NON-atomic
 * fallback in contexts without a database transaction (e.g. tests).
 */
export interface OutboundSendCommitter {
	/**
	 * Atomically increment the number's daily counter and append the outbound
	 * message to the lead's history, returning the new daily count and the
	 * persisted message.
	 */
	commit(send: ConfirmedSend): Promise<ConfirmedSendResult>;
}

// ---------------------------------------------------------------------------
// Worker interface
// ---------------------------------------------------------------------------

/**
 * The I/O-bound outbound worker — the single choke point through which every
 * outbound message is sent (design "Outbound choke point"). Stateless beyond
 * its injected dependencies; each call re-reads the lead and number state.
 */
export interface OutboundWorker {
	/**
	 * Process one outbound send job along the choke-point path (Req 15.3, 16.2,
	 * 17.1, 17.2, 17.4, 18.2, 18.3) and return the {@link OutboundSendOutcome}.
	 *
	 * @throws {UnknownLeadError} when the job's `leadId` has no persisted lead.
	 * @throws when `WAHA_Client.sendText` fails — the error propagates so the
	 *   pg-boss retry policy applies (design "Outbound send"); the daily counter
	 *   is incremented only on a confirmed send, so a failed/retried send never
	 *   over-counts the cap.
	 */
	process(job: OutboundSendJob): Promise<OutboundSendOutcome>;
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link OutboundWorkerService}. */
export interface OutboundWorkerConfig {
	/** Persistence boundary for the lead (opt-out gate + E.164 for chat id). */
	leads: LeadRepository;
	/** Per-number anti-ban gate (block/window/cap) and randomized pacing. */
	antiBan: AntiBanController;
	/** WAHA transport: typing presence and the single send (Req 17.2). */
	waha: WahaClient;
	/** Atomic confirmed-send commit: counter increment + message record (Req 16.2). */
	commit: OutboundSendCommitter;
	/** Injected time source; the confirmed-send timestamp goes through this seam. */
	clock: Clock;
	/**
	 * Injected async wait used for the randomized inter-send pacing delay
	 * (Req 17.1). Defaults to a `setTimeout`-based sleep; inject a no-op/fake in
	 * tests so pacing introduces no real delay.
	 */
	sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Real wall-clock sleep used when no `sleep` seam is injected. */
function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms > 0 ? ms : 0);
	});
}

// ---------------------------------------------------------------------------
// OutboundWorkerService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link OutboundWorker}. Wires the opt-out gate (`LeadRepository`),
 * the per-number anti-ban decision and pacing (`AntiBanController`, reusing the
 * pure `canSend`/`nextDelayMs`), the WAHA transport (`WahaClient`), and the
 * confirmed-send transaction (`OutboundSendCommitter`) into the design's
 * choke-point path. Holds no state beyond its dependencies.
 */
export class OutboundWorkerService implements OutboundWorker {
	private readonly leads: LeadRepository;
	private readonly antiBan: AntiBanController;
	private readonly waha: WahaClient;
	private readonly commit: OutboundSendCommitter;
	private readonly clock: Clock;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(deps: OutboundWorkerConfig) {
		this.leads = deps.leads;
		this.antiBan = deps.antiBan;
		this.waha = deps.waha;
		this.commit = deps.commit;
		this.clock = deps.clock;
		this.sleep = deps.sleep ?? defaultSleep;
	}

	/**
	 * The terminal stop gate run against a freshly-read lead snapshot: returns the
	 * drop outcome when the lead must not receive this queued automated message,
	 * or `null` when the send may proceed. An opt-out yields the distinct
	 * `dropped_opt_out` outcome (Req 15.3); any other send-guard stop condition —
	 * the lead replied / was handed off (`HOT`) / blocked / classified out, per
	 * `evaluateSendGuard` — yields `dropped_stopped` (Req 5.2, 13.4). Both are
	 * terminal: the job must not be retried.
	 */
	private stopGate(
		lead: LeadSnapshot,
		leadId: string,
	): OutboundSendOutcome | null {
		if (lead.optInStatus === "opt_out") {
			return { status: "dropped_opt_out", leadId };
		}
		if (evaluateSendGuard(lead) === "skip_and_cancel") {
			return { status: "dropped_stopped", leadId };
		}
		return null;
	}

	/** @inheritdoc */
	async process(job: OutboundSendJob): Promise<OutboundSendOutcome> {
		const { leadId, numberId, content } = job;

		// 1/1b. Opt-out + send-guard stop gate (Req 15.3, 5.2, 13.4). Outbound
		//       sends are enqueued ahead of time — a cadence touch or nurture
		//       message is rendered and queued, then drained later behind the
		//       anti-ban pacing — so the lead may have opted out, replied (→ handed
		//       off to a consultant, `HOT`), or otherwise reached a stop state
		//       *after* this job was enqueued. Drop early to avoid needless work
		//       (re-checked after the pacing wait below, where the real race is).
		const lead = await this.leads.findById(leadId);
		if (!lead) {
			throw new UnknownLeadError(leadId);
		}
		const earlyStop = this.stopGate(lead, leadId);
		if (earlyStop) {
			return earlyStop;
		}

		// 2–4. Per-number gate via the pure `canSend` decision, evaluated in the
		//      design's priority order: block flag → send window → daily cap. A
		//      blocked number sends nothing (Req 18.2); outside the window the
		//      send waits for the window to reopen (Req 17.4); at the cap the send
		//      waits for the next day (Req 16.2). The controller rolls the daily
		//      counter over a day boundary before deciding, so a stale counter
		//      never spuriously defers.
		const decision: SendDecision = await this.antiBan.evaluate(numberId);
		switch (decision) {
			case "blocked":
				// Req 18.2/18.3: perform no send; the caller stops using this number.
				return { status: "blocked", leadId, numberId };
			case "defer_window":
				return { status: "deferred_window", leadId, numberId };
			case "defer_cap":
				return { status: "deferred_cap", leadId, numberId };
			case "allow":
				break;
		}

		// 5. Randomized inter-send pacing within the configured range (Req 17.1),
		//    drawn from the controller's pure `nextDelayMs` and awaited through the
		//    injectable sleep seam.
		await this.sleep(this.antiBan.nextDelayMs());

		// 5b. Re-check the stop gate against FRESH lead state after the pacing wait
		//     (Req 5.2, 13.4). The randomized delay above is a real window (seconds)
		//     during which the lead can reply and be handed off, so the gate checked
		//     before the wait is stale by the time we are about to send. Re-read and
		//     re-evaluate immediately before the single WAHA send so a lead that
		//     became engaged *during* the pacing wait does not still receive this
		//     queued automated message. Terminal: dropped, not deferred.
		const freshLead = await this.leads.findById(leadId);
		if (!freshLead) {
			throw new UnknownLeadError(leadId);
		}
		const lateStop = this.stopGate(freshLead, leadId);
		if (lateStop) {
			return lateStop;
		}

		// Existence gate: resolve the lead's E.164 to a send target at send time
		// (handles the Brazilian pre-2012 ambiguity inside the client). When WAHA
		// confirms the number does not exist on WhatsApp, drop the send as terminal
		// `dropped_unreachable` — the caller marks the lead unreachable and cancels
		// its outreach, and the daily cap is never touched (no send occurs). Any
		// other case (existing, non-checkable, or a check failure) is reachable.
		const target = await this.waha.resolveSendTarget(
			numberId,
			freshLead.phoneE164,
		);
		if (!target.reachable) {
			return { status: "dropped_unreachable", leadId };
		}
		const chatId = target.chatId;

		// 6–7. Simulate typing presence before sending (Req 17.2), then perform
		//      the single WAHA send. Typing presence is a best-effort human-like
		//      nicety: some WAHA engines (e.g. WEBJS CORE) do not support the
		//      presence endpoint and return 500, so a failure to start/stop typing
		//      must never block the actual send. The typing indicator is always
		//      stopped, even if the send throws, without masking the send error.
		await this.waha.startTyping(numberId, chatId).catch(() => undefined);
		let sent: { waMessageId: string };
		try {
			sent = await this.waha.sendText(numberId, chatId, content);
		} finally {
			await this.waha.stopTyping(numberId, chatId).catch(() => undefined);
		}

		// 8. Confirmed send: increment the per-number daily counter AND record the
		//    message in the SAME transaction (Req 16.2; design "Outbound send").
		//    Because the increment happens only here, on a confirmed send, a
		//    retried job never over-counts the cap for one logical send.
		const { dailyCount } = await this.commit.commit({
			leadId,
			numberId,
			content,
			waMessageId: sent.waMessageId,
			sentAt: this.clock.now(),
		});

		return {
			status: "sent",
			leadId,
			numberId,
			waMessageId: sent.waMessageId,
			dailyCount,
		};
	}
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/** Construct an {@link OutboundWorker} from {@link OutboundWorkerConfig}. */
export function createOutboundWorker(
	config: OutboundWorkerConfig,
): OutboundWorker {
	return new OutboundWorkerService(config);
}

/**
 * Build a best-effort, NON-atomic {@link OutboundSendCommitter} from the
 * existing {@link AntiBanController} and {@link MessageRepository}: it increments
 * the number's daily counter (reusing the controller's date-rollover logic) and
 * then appends the outbound message.
 *
 * This is a fallback for contexts without a database transaction (such as
 * tests). It does NOT provide the single-transaction atomicity the design
 * requires for production (Req 16.2): a crash between the two writes could
 * count a send without recording its message, or vice-versa. Production wiring
 * (task 23.1) supplies a transaction-backed committer that performs both writes
 * inside one transaction.
 */
export function createSequentialOutboundSendCommitter(deps: {
	antiBan: AntiBanController;
	messages: MessageRepository;
}): OutboundSendCommitter {
	const { antiBan, messages } = deps;
	return {
		async commit(send: ConfirmedSend): Promise<ConfirmedSendResult> {
			const dailyCount = await antiBan.recordSend(send.numberId);
			const message = await messages.append({
				leadId: send.leadId,
				direction: "outbound",
				content: send.content,
				waMessageId: send.waMessageId,
				numberId: send.numberId,
				createdAt: send.sentAt,
			});
			return { dailyCount, message };
		},
	};
}
