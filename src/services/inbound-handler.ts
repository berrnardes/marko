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
// consultant — `Handoff_Manager` moves the Lead to `REPLIED`, records a
// `replied` handoff event, and silences further automation. The consultant then
// continues the conversation on the same WhatsApp number (via a WhatsApp Web
// linked device); those replies are ingested back as outbound echoes in the
// webhook.
//
// Not every inbound message is a reply-to-the-cadence, though. ADR-003 rule 2
// restricts the transition to Leads in `IN_CADENCE` or `COMPLETED`: once a Lead
// is with its consultant, the messages that follow are part of THAT
// conversation and must not re-alert anyone. The pure `stateAfterReply` encodes
// that rule; this handler is where it is applied.
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
//   - `CadenceScheduler`   — cancel pending outreach when the Lead replies
//     (Req 7.2);
//   - `HandoffManager`     — hand the replying Lead off to a consultant (Req 13).
//
// Opt-out *detection* is the pure `detectOptOut` predicate in `@/core`; phone
// attribution is the pure `normalizePhone` in `@/core`. This handler only wires
// those pure checks to their persisted consequences.

import { detectOptOut, normalizePhone } from "@/core";
import { stateAfterReply } from "@/core/lifecycle";
import { logger } from "@/logger";
import type { CadenceScheduler } from "@/services/cadence-scheduler";
import type { ComplianceManager } from "@/services/compliance-manager";
import type { HandoffManager } from "@/services/handoff-manager";
import type {
	LeadRepository,
	MessageRepository,
} from "@/services/repositories";
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
	 *   5. Stop unless the reply should transition the Lead (`stateAfterReply`,
	 *      ADR-003 rule 2): only `IN_CADENCE` and `COMPLETED` react. A Lead
	 *      already with its consultant records the message and nothing else.
	 *   6. Cancel all pending cadence jobs for the Lead, so a reply silences the
	 *      outreach it was receiving (Req 7.2).
	 *   7. Hand the Lead off to a human consultant with reason `replied`: the
	 *      `Handoff_Manager` moves the Lead to `REPLIED`, records the handoff
	 *      event, cancels any remaining outreach, and alerts the consultant
	 *      (Req 13).
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
 * scheduler, and handoff dependencies. Stateless beyond its dependencies; every
 * call runs the ordered pipeline through the interfaces it was constructed with
 * and performs no other I/O.
 */
export class InboundHandlerService implements InboundHandler {
	private readonly leads: LeadRepository;
	private readonly messages: MessageRepository;
	private readonly waha: WahaClient;
	private readonly compliance: ComplianceManager;
	private readonly cadence: CadenceScheduler;
	private readonly handoff: HandoffManager;
	private readonly inboundSource: string;

	constructor(deps: InboundHandlerConfig) {
		this.leads = deps.leads;
		this.messages = deps.messages;
		this.waha = deps.waha;
		this.compliance = deps.compliance;
		this.cadence = deps.cadence;
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

		// 5. Decide whether THIS message is a handoff at all (ADR-003 rule 2). Only
		//    a Lead in `IN_CADENCE` or `COMPLETED` transitions on a reply; one
		//    already in `REPLIED`, `WON`, or `LOST` is mid-conversation with its
		//    consultant, and every further message it sends must change nothing and
		//    alert nobody. Note this asks `stateAfterReply`, NOT the transition
		//    table: `WON → REPLIED` is a lawful *manual* correction, so the table
		//    would accept it and an inbound message would silently reopen a closed
		//    Lead.
		//
		//    The Lead read in step 1 is fresh — this handler runs off the inbound
		//    queue and re-read it at the top — so the state is current.
		if (stateAfterReply(lead.lifecycleState) === null) {
			logger.info(
				{
					event: "inbound.no_transition",
					leadId: lead.id,
					state: lead.lifecycleState,
				},
				"reply from a lead already with the consultant; recorded without " +
					"changing state or alerting",
			);
			return;
		}

		// 6. Cancel pending outreach the Lead was receiving (Req 7.2). A no-op when
		//    there is nothing pending — which is exactly the late-reply case, where
		//    the Lead is `COMPLETED` and its five touches are already spent.
		await this.cadence.cancelAll(lead.id);

		// 7. Hand the Lead off to a human consultant (Req 13, ADR-003 rule 3). The
		//    `Handoff_Manager` moves the Lead to `REPLIED`, records the `replied`
		//    handoff event, cancels any remaining automated outreach, and alerts the
		//    consultant on WhatsApp. The consultant then continues the conversation
		//    on the same number from a WhatsApp Web linked device.
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
			const chatId = await this.waha.resolveChatId(msg.numberId, msg.from);
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
