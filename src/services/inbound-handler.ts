// Inbound_Handler (I/O boundary — the ordered inbound-reply pipeline).
//
// Implements the design's `Inbound_Handler` as the orchestration seam that
// turns a single inbound WhatsApp message into the system's reaction: attribute
// it to a Lead (creating one on an unknown sender), record it, acknowledge it,
// honor an opt-out, otherwise stop the outreach the Lead was receiving,
// recompute its Score, and hand the Lead off to a human consultant. It is the
// single component that wires inbound delivery to the rest of the domain, so the
// ordered reply behavior (Req 6.4, 7, 11.1, 13, 15.1, 17.3) is expressed in
// exactly one place.
//
// Beta flow (no AI qualification): the conversational qualification agent has
// been removed. A Lead that replies to the cadence is handed straight to a human
// consultant — `Handoff_Manager` moves the Lead to `HOT`, records a `replied`
// handoff event, and silences further automation. The consultant then continues
// the conversation on the same WhatsApp number (via a WhatsApp Web linked
// device); those replies are ingested back as outbound echoes in the webhook.
//
// Side-effect boundary: this module performs all persistence/orchestration I/O
// through injected INTERFACE dependencies only (never concrete Drizzle/DB code):
//   - `LeadRepository`     — attribute by normalized number, create on unknown
//     sender, re-read fresh state (Req 7.1, 7.5);
//   - `MessageRepository`  — append the inbound message to the Lead's history
//     (Req 7.4);
//   - `WahaClient`         — resolve the chat id and send the read receipt
//     (`sendSeen`, Req 17.3);
//   - `ComplianceManager`  — apply an opt-out when detected (Req 15.1);
//   - `CadenceScheduler` / `NurtureScheduler` — cancel pending outreach when the
//     Lead replies (Req 7.2, 6.4);
//   - `ScoringEngine`      — recompute the Lead's Score on the inbound (Req 11.1);
//   - `HandoffManager`     — hand the replying Lead off to a consultant (Req 13).
//
// Opt-out *detection* is the pure `detectOptOut` predicate in `@/core`; phone
// attribution is the pure `normalizePhone` in `@/core`. This handler only wires
// those pure checks to their persisted consequences.

import { detectOptOut, normalizePhone } from "@/core";
import type { CadenceScheduler } from "@/services/cadence-scheduler";
import type { ComplianceManager } from "@/services/compliance-manager";
import type { HandoffManager } from "@/services/handoff-manager";
import type { NurtureScheduler } from "@/services/nurture-scheduler";
import type {
	LeadRepository,
	MessageRepository,
} from "@/services/repositories";
import type { ScoringEngine } from "@/services/scoring-engine";
import type { WahaClient } from "@/services/waha-client";

// ---------------------------------------------------------------------------
// Inbound message
// ---------------------------------------------------------------------------

/**
 * An inbound WhatsApp message handed to the inbound pipeline (Req 7). The
 * `from` sender id is normalized to E.164 internally; `waMessageId` supports
 * at-least-once inbound idempotency. This is the value the worker forwards to
 * {@link InboundHandler.handle}.
 */
export interface InboundMessage {
	/** Raw WhatsApp sender id, normalized to E.164 internally. */
	from: string;
	/** The inbound message text. */
	text: string;
	/** When the message was received. */
	receivedAt: Date;
	/** WAHA message id, used for inbound idempotency. */
	waMessageId: string;
	/**
	 * The domain `numberId` of the WhatsApp number/session that *received* this
	 * inbound message, when known. Used to send the read receipt
	 * (`WAHA_Client.sendSeen`, Req 17.3) from the same number the Lead is
	 * conversing with. Optional because not every caller (e.g. a replayed turn in
	 * tests) needs to drive a read receipt.
	 */
	numberId?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when an inbound message's sender id cannot be normalized to a valid
 * E.164 number, so it cannot be attributed to (or used to create) a Lead
 * (Req 7.1, 7.5). The webhook route validates the body before enqueuing, so a
 * malformed sender reaching the handler is exceptional; surfacing it lets the
 * delivery be retried/inspected rather than silently dropped.
 */
export class InvalidInboundSenderError extends Error {
	/** The raw sender id that failed normalization. */
	readonly from: string;

	constructor(from: string) {
		super(`Inbound sender "${from}" is not a valid phone number`);
		this.name = "InvalidInboundSenderError";
		this.from = from;
	}
}

// ---------------------------------------------------------------------------
// Handler interface (design `InboundHandler`)
// ---------------------------------------------------------------------------

/**
 * The inbound-reply orchestration boundary. Mirrors the design's
 * `InboundHandler` interface exactly: a single `handle(msg)` that runs the
 * ordered pipeline for one inbound message.
 */
export interface InboundHandler {
	/**
	 * Process one inbound WhatsApp message through the ordered pipeline
	 * (Req 6.4, 7, 11.1, 13, 15.1, 17.3):
	 *
	 *   1. Attribute the message to the Lead whose normalized E.164 number
	 *      matches the sender, creating a new Lead when none matches (Req 7.1,
	 *      7.5).
	 *   2. Append the inbound message to that Lead's history with its content and
	 *      receipt timestamp (Req 7.4).
	 *   3. Mark the inbound message as seen via `WAHA_Client.sendSeen` (Req 17.3).
	 *   4. Detect an opt-out request (`detectOptOut`); when present, apply the
	 *      opt-out (set `opt_out`, transition to `OPTED_OUT`, cancel all
	 *      outreach) and STOP — no handoff for an opted-out Lead (Req 15.1).
	 *   5. Otherwise cancel all pending cadence and nurture jobs for the Lead, so
	 *      a reply silences the outreach it was receiving (Req 7.2, 6.4).
	 *   6. Recompute the Lead's Score on the inbound signal (Req 11.1).
	 *   7. Hand the Lead off to a human consultant with reason `replied`: the
	 *      `Handoff_Manager` moves the Lead to `HOT`, records the handoff event,
	 *      and cancels any remaining automated outreach (Req 13).
	 *
	 * @param msg - The inbound message to process.
	 * @throws {InvalidInboundSenderError} when the sender id cannot be normalized.
	 */
	handle(msg: InboundMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link InboundHandlerService}. */
export interface InboundHandlerConfig {
	/** Lead attribution/creation and fresh-state reads (Req 7.1, 7.5). */
	leads: LeadRepository;
	/** Append the inbound message to the Lead's history (Req 7.4). */
	messages: MessageRepository;
	/** Resolve the chat id and send the read receipt (Req 17.3). */
	waha: WahaClient;
	/** Apply an opt-out when one is detected on the inbound (Req 15.1). */
	compliance: ComplianceManager;
	/** Cancel the Lead's pending cadence touches on reply (Req 7.2). */
	cadence: CadenceScheduler;
	/** Cancel the Lead's pending monthly nurture on reply (Req 6.4). */
	nurture: NurtureScheduler;
	/** Recompute the Lead's Score on the inbound (Req 11.1). */
	scoring: ScoringEngine;
	/** Hand the replying Lead off to a human consultant (Req 13). */
	handoff: HandoffManager;
	/**
	 * Source recorded on a Lead created from an unknown inbound sender (Req 7.5,
	 * 2.1). Defaults to {@link DEFAULT_INBOUND_SOURCE}.
	 */
	inboundSource?: string;
}

/** Default `source` for a Lead created from an unknown inbound sender (Req 7.5). */
export const DEFAULT_INBOUND_SOURCE = "whatsapp_inbound";

// ---------------------------------------------------------------------------
// InboundHandlerService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link InboundHandler} backed by the injected repository, manager,
 * scheduler, scoring, and handoff dependencies. Stateless beyond its
 * dependencies; every call runs the ordered pipeline through the interfaces it
 * was constructed with and performs no other I/O.
 */
export class InboundHandlerService implements InboundHandler {
	private readonly leads: LeadRepository;
	private readonly messages: MessageRepository;
	private readonly waha: WahaClient;
	private readonly compliance: ComplianceManager;
	private readonly cadence: CadenceScheduler;
	private readonly nurture: NurtureScheduler;
	private readonly scoring: ScoringEngine;
	private readonly handoff: HandoffManager;
	private readonly inboundSource: string;

	constructor(deps: InboundHandlerConfig) {
		this.leads = deps.leads;
		this.messages = deps.messages;
		this.waha = deps.waha;
		this.compliance = deps.compliance;
		this.cadence = deps.cadence;
		this.nurture = deps.nurture;
		this.scoring = deps.scoring;
		this.handoff = deps.handoff;
		this.inboundSource = deps.inboundSource ?? DEFAULT_INBOUND_SOURCE;
	}

	/** @inheritdoc */
	async handle(msg: InboundMessage): Promise<void> {
		// 1. Attribute by normalized E.164, creating a Lead on an unknown sender
		//    (Req 7.1, 7.5). Normalization is the same pure rule the importer uses
		//    so the dedup key matches; a sender that cannot be normalized has no
		//    valid identity to attribute or create against.
		const phoneE164 = normalizePhone(msg.from, "BR");
		if (phoneE164 === null) {
			throw new InvalidInboundSenderError(msg.from);
		}
		const existing = await this.leads.findByPhone(phoneE164);
		const lead =
			existing ??
			(await this.leads.create({
				phoneE164,
				source: this.inboundSource,
			}));

		// 2. Persist the inbound message with its content and receipt timestamp so
		//    it is never lost and round-trips in the Lead's history (Req 7.4).
		await this.messages.append({
			leadId: lead.id,
			direction: "inbound",
			content: msg.text,
			waMessageId: msg.waMessageId,
			createdAt: msg.receivedAt,
		});

		// 3. Acknowledge the inbound with a read receipt from the receiving number
		//    (Req 17.3). Best-effort: a courtesy receipt must never block honoring
		//    an opt-out or qualifying a hot Lead, so a transient WAHA failure (or a
		//    delivery with no known receiving number) is swallowed here.
		await this.markSeen(msg);

		// 4. Opt-out short-circuit (Req 15.1). Detection is the pure `detectOptOut`
		//    predicate; on a match the Compliance_Manager sets `opt_out`,
		//    transitions the Lead to the terminal `OPTED_OUT`, and cancels all
		//    scheduled outreach. No handoff runs for an opted-out Lead.
		if (detectOptOut(msg.text)) {
			await this.compliance.applyOptOut(lead.id, msg.receivedAt);
			return;
		}

		// 5. Cancel pending outreach the Lead was receiving (Req 7.2, 6.4). Both
		//    cancels are no-ops when there is nothing pending (e.g. a brand-new
		//    Lead), so they are safe to run unconditionally. The handoff below also
		//    cancels the Lead's scheduled jobs; running these first stops the
		//    scheduler-level outreach immediately and is idempotent.
		await this.cadence.cancelAll(lead.id);
		await this.nurture.cancel(lead.id);

		// 6. Recompute the Lead's Score on the inbound signal so the CRM reflects
		//    the reply's effect on the Lead's band before the consultant sees it
		//    (Req 11.1).
		await this.scoring.recompute(lead.id);

		// 7. Hand the Lead off to a human consultant (Req 13). In the beta flow any
		//    reply hands the Lead straight to a consultant: the `Handoff_Manager`
		//    moves the Lead to `HOT` regardless of its current funnel stage, records
		//    a `replied` handoff event, and cancels any remaining automated outreach
		//    so no further automated message is sent (Req 13.1–13.4). The consultant
		//    continues the conversation on the same number from a WhatsApp Web linked
		//    device.
		await this.handoff.handoff(lead.id, "replied");
	}

	/**
	 * Send the read receipt for an inbound message (Req 17.3), best-effort.
	 *
	 * Resolves the canonical WhatsApp chat id from the sender's E.164 (handling
	 * the Brazilian pre-2012 ambiguity inside the client) and marks the message
	 * seen from the receiving number. A read receipt is a courtesy and must not
	 * block the rest of the pipeline, so a missing receiving number or a WAHA
	 * failure is swallowed rather than propagated.
	 */
	private async markSeen(msg: InboundMessage): Promise<void> {
		if (!msg.numberId) {
			return;
		}
		try {
			const chatId = await this.waha.resolveChatId(msg.from);
			await this.waha.sendSeen(msg.numberId, chatId, [msg.waMessageId]);
		} catch {
			// Swallow: the receipt is non-essential (Req 17.3 is a courtesy ack).
		}
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct an {@link InboundHandler} from {@link InboundHandlerConfig}. */
export function createInboundHandler(
	config: InboundHandlerConfig,
): InboundHandler {
	return new InboundHandlerService(config);
}
