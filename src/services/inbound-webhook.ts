// Inbound WAHA webhook orchestration (I/O boundary — the entry-point seam).
//
// Implements the design's "Inbound webhook (WAHA → system)" error-handling
// contract as a thin, testable function the Next.js route (`/api/waha/webhook`,
// task 21.4) delegates to. The HTTP entry point stays a thin adapter; the
// verify → validate → idempotency → persist → enqueue logic lives here in the
// services layer so it can be unit/integration-tested without spinning up Next
// (task 21.5).
//
// Responsibilities (Req 7.1, 7.4):
//   1. Verify the `X-Webhook-Hmac` (HMAC SHA-512 over the RAW request body,
//      keyed by the configured shared secret) with a timing-safe comparison;
//      reject an invalid/missing signature with `401` and process nothing.
//   2. Validate the untrusted body against {@link WahaMessageWebhookSchema};
//      acknowledge a malformed body with `200 "ignored"` and a warn log — it is
//      permanently un-processable, and a `4xx` would only make WAHA retry it 15
//      times and then discard it (ADR-005).
//   3. Enforce idempotency by `wa_message_id`: WAHA retries deliveries, so a
//      message whose id was already persisted is acknowledged with a fast `2xx`
//      and NOT re-processed (no double persist, no double enqueue).
//   4. Persist the raw inbound message (the persisted record is also the
//      idempotency key for step 3).
//   5. Enqueue processing onto the durable inbound queue and return a fast `2xx`
//      acknowledgement — the heavy Inbound_Handler pipeline (sendSeen, opt-out,
//      cancellation, lifecycle advance, scoring, the LLM qualification turn)
//      runs in the worker, NOT inline here, so WAHA does not retry on timeout.
//
// Side-effect boundary: all persistence/orchestration flows through injected
// INTERFACE dependencies only (never concrete Drizzle/DB or pg-boss code):
//   - `LeadRepository`            — attribute the sender by normalized E.164,
//     creating a Lead on an unknown sender, so the persisted message has a
//     `lead_id` (the `messages.lead_id` FK is NOT NULL) (Req 7.1, 7.5);
//   - `MessageRepository`         — idempotency lookup by `wa_message_id` and
//     raw inbound persistence (Req 7.4);
//   - `InboundProcessingQueue`    — the durable enqueue seam (the pg-boss
//     boundary, injected) onto which processing is handed off (Req 7.1).
//
// Phone attribution reuses the pure `normalizePhone` from `@/core`; the HMAC
// check is the only crypto here and is performed over the exact raw bytes the
// caller read before JSON parsing, so the signature matches WAHA's.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { normalizePhone } from "@/core";
import { logger } from "@/logger";
import type { AntiBanController } from "@/services/anti-ban-controller";
import type {
	LeadRepository,
	MessageRepository,
} from "@/services/repositories";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The header WAHA signs each webhook delivery with: the hex-encoded HMAC
 * SHA-512 digest of the raw request body, keyed by the configured shared secret
 * (design "WAHA integration facts"; Req 7.1).
 */
export const WAHA_HMAC_HEADER = "x-webhook-hmac";

/** The HMAC digest algorithm WAHA uses for webhook signing (Req 7.1). */
const HMAC_ALGORITHM = "sha512";

/** The WAHA webhook events this route handles (Req 7.1). */
const HANDLED_EVENTS = ["message", "message.any"] as const;

// ---------------------------------------------------------------------------
// Request-body schema (untrusted input — design "treated as untrusted input")
// ---------------------------------------------------------------------------

/**
 * The subset of WAHA's `message` webhook payload this route consumes. WAHA
 * sends many more fields per message; the schema is permissive
 * (`z.looseObject`, extra fields preserved) but REQUIRES the fields we read so
 * a malformed delivery missing them is dropped with a logged `200 "ignored"`
 * (Req 7.1, ADR-005). The sender id (`from`) and message id (`id`) are
 * non-empty; `timestamp` is the WAHA epoch-seconds receipt time.
 */
export const WahaMessagePayloadSchema = z.looseObject({
	/** WAHA message id — the at-least-once idempotency key (`wa_message_id`). */
	id: z.string().min(1),
	/** Raw WhatsApp sender id (e.g. `"5511999999999@c.us"`), normalized later. */
	from: z.string().min(1),
	/**
	 * Raw WhatsApp recipient id. For an outbound echo (`fromMe: true`) `from` is
	 * our own number and the Lead is the recipient here, so it is the attribution
	 * key for ingesting the consultant's WhatsApp Web replies.
	 *
	 * `nullish`, not `optional`: the GOWS engine sends `"to": null` on every
	 * INBOUND message (it only carries a recipient for a `fromMe` echo). Zod's
	 * `.optional()` accepts `undefined` but rejects a present `null`, so declaring
	 * this `.optional()` alone rejected every real inbound delivery. Normalized to
	 * `undefined` here so the `if (!recipient)` guard downstream is unchanged.
	 */
	to: z
		.string()
		.nullish()
		.transform((value) => value ?? undefined),
	/**
	 * The inbound message text. `nullish` for the same reason as `to`: GOWS sends
	 * `"body": null` for a media-only message, and `.default("")` fills only an
	 * ABSENT key, never a present `null`. Normalized to the empty string.
	 */
	body: z
		.string()
		.nullish()
		.transform((value) => value ?? ""),
	/** Receipt time as WAHA epoch SECONDS. */
	timestamp: z.number(),
	/** Whether the message was sent by the session itself (outbound echo). */
	fromMe: z.boolean().optional(),
});

/**
 * The WAHA webhook envelope — the outer shape common to every event WAHA
 * delivers. We validate this first to read `event`/`session` so we can cleanly
 * IGNORE (ack with 200) the many non-message events WAHA fires (`session.status`,
 * `message.ack`, `presence.update`, …) quietly, without the warn log a malformed
 * `message` event earns. Permissive (`z.looseObject`) so extra fields pass.
 */
export const WahaEnvelopeSchema = z.looseObject({
	event: z.string().min(1),
	session: z.string().min(1),
});

/**
 * The WAHA webhook envelope for an inbound `message` event (Req 7.1). `event`
 * accepts both `"message"` and `"message.any"` — WAHA fires `message.any` for
 * all messages including the session's own outbound echoes, while `message`
 * fires only for inbound. We accept both so the webhook works regardless of
 * which event the session's webhook config subscribes to; outbound echoes
 * (`fromMe: true`) are filtered downstream. `session` is the WAHA session that
 * received the message, carried through to the worker so it can resolve the
 * receiving WhatsApp number. Permissive (`z.looseObject`) on the envelope too.
 */
export const WahaMessageWebhookSchema = z.looseObject({
	event: z.enum(HANDLED_EVENTS),
	session: z.string().min(1),
	payload: WahaMessagePayloadSchema,
});

/** A validated WAHA `message` webhook delivery, inferred from the schema. */
export type WahaMessageWebhook = z.infer<typeof WahaMessageWebhookSchema>;

// ---------------------------------------------------------------------------
// Inbound processing queue seam (the pg-boss enqueue boundary)
// ---------------------------------------------------------------------------

/**
 * The durable payload enqueued for asynchronous inbound processing. It carries
 * exactly what the worker (task 23.1) needs to run the full Inbound_Handler
 * pipeline for one message: the attributed Lead, the original WAHA fields
 * needed to send the read receipt and detect opt-out, and the WAHA `session`
 * that received it (the worker resolves that to the receiving `numberId` for
 * `WAHA_Client.sendSeen`, Req 17.3). Nothing time-sensitive beyond `receivedAt`
 * is captured; the worker re-reads fresh Lead state at execution time.
 */
export interface InboundProcessingJob {
	/**
	 * Per-flow trace id generated at the webhook. Bound onto every log line the
	 * downstream pipeline emits (and carried onto the outbound send it triggers)
	 * so one inbound message can be followed end to end across both processes.
	 */
	correlationId: string;
	/** The Lead the message was attributed to (created if the sender was unknown). */
	leadId: string;
	/** The persisted inbound message id (the raw record persisted at the route). */
	messageId: string;
	/** WAHA message id; the at-least-once idempotency key. */
	waMessageId: string;
	/**
	 * Sender chat id, normalized to E.164 by the pipeline. A `@lid` sender is
	 * resolved to its phone-number chat id (`@c.us`) at the webhook before being
	 * enqueued, so this always carries phone digits.
	 */
	from: string;
	/** The inbound message text. */
	text: string;
	/** When the message was received. */
	receivedAt: Date;
	/** The WAHA session that received the message (resolved to a `numberId`). */
	session: string;
}

/**
 * The durable job-queue seam the webhook depends on — the pg-boss enqueue
 * boundary for inbound processing, injected rather than constructed inline so
 * the route never touches pg-boss directly and stays testable against a fake
 * queue (mirroring {@link import("./outbound-worker").OutboundSendQueue} and
 * the cadence/nurture queues). Production wiring (task 23.1) backs this with the
 * real pg-boss instance and registers the worker handler that runs the
 * Inbound_Handler pipeline; tests back it with an in-memory fake.
 */
export interface InboundProcessingQueue {
	/**
	 * Enqueue one inbound message for asynchronous processing through the
	 * Inbound_Handler pipeline, returning the queue's job id.
	 */
	enqueueInbound(job: InboundProcessingJob): Promise<string>;
}

// ---------------------------------------------------------------------------
// Dependencies + result
// ---------------------------------------------------------------------------

/**
 * Which tenant a delivery belongs to, resolved from the WAHA session name.
 *
 * This is the inbound tenancy boundary. A webhook delivery identifies itself
 * only by `session`, so the organization is unknown when the request arrives —
 * the HMAC must be verified and the body parsed before anything can be scoped.
 */
export interface WahaSessionOwner {
	/** The organization that registered the delivering WAHA session. */
	organizationId: string;
	/** The domain `numberId` of the registered number that received the message. */
	numberId: string;
}

/**
 * The persistence handles for one delivery, bound to its tenant. Supplied by
 * {@link WahaWebhookDeps.withScope}, which is also where the RLS transaction
 * context is established — hence the callback shape rather than plain fields:
 * the repositories are only valid for the duration of that unit of work.
 */
export interface WahaScopedRepositories {
	/** Attribute the sender by normalized E.164, creating a Lead if unknown (Req 7.1, 7.5). */
	leads: LeadRepository;
	/** Idempotency lookup by `wa_message_id` + raw inbound persistence (Req 7.4). */
	messages: MessageRepository;
	/**
	 * Count a consultant's manual outbound (an ingested `fromMe` echo) against the
	 * sending number's daily anti-ban cap, so the controller's count includes
	 * human sends made from a WhatsApp Web linked device. Optional: when absent
	 * (e.g. in webhook tests), the echo is still recorded in history but the
	 * counter is not touched.
	 */
	antiBan?: Pick<AntiBanController, "recordSend">;
}

/** Construction dependencies for {@link processWahaWebhook}. */
export interface WahaWebhookDeps {
	/**
	 * The shared HMAC secret the `X-Webhook-Hmac` signature is verified against
	 * (Req 7.1). Sourced from the `WAHA_WEBHOOK_HMAC_SECRET` env var by the route;
	 * never hard-coded. Process-wide, not per tenant: it authenticates the WAHA
	 * instance, which is shared.
	 */
	secret: string;
	/**
	 * Map the delivering WAHA `session` to the organization that registered it.
	 * Backed in production by `app.resolve_session_org()` — a `SECURITY DEFINER`
	 * function over `whatsapp_numbers.session_name` (globally unique, so it
	 * yields at most one organization), which is the one read allowed to happen
	 * before a tenant context exists (ADR-004).
	 *
	 * Returns `null` when no registered number claims the session — the delivery
	 * is then acknowledged with `200` and dropped, never `5xx`: WAHA retries on
	 * error, and a session nobody owns would be retried forever.
	 */
	resolveSession: (session: string) => Promise<WahaSessionOwner | null>;
	/**
	 * Run one unit of persistence work as `owner`, with repositories bound to
	 * that organization. In production this opens the RLS transaction
	 * (`withOrg`), so the callback must stay short and free of network I/O — the
	 * connection it holds is a pooled PgBouncer slot. Every HTTP call the webhook
	 * makes (the `@lid` lookup) is deliberately performed BEFORE this is entered.
	 */
	withScope: <T>(
		owner: WahaSessionOwner,
		fn: (scope: WahaScopedRepositories) => Promise<T>,
	) => Promise<T>;
	/** Durable enqueue seam for the tenant, used after the write commits (Req 7.1). */
	queue: (organizationId: string) => InboundProcessingQueue;
	/**
	 * Resolve a WhatsApp hidden Linked ID (`@lid`) sender to its phone-number
	 * chat id (`@c.us`) — WAHA's WEBJS/GOWS engines now deliver `from` as a
	 * `@lid` for many senders (WhatsApp's LID privacy migration), which carries
	 * no phone digits. When the sender is a `@lid`, the webhook resolves it here
	 * before normalizing to E.164. Injected (not the concrete WAHA client) so the
	 * service stays testable; it needs only the session name, so it is not
	 * tenant-bound. Optional: when absent, a `@lid` sender is unattributable.
	 */
	lids?: LidResolver;
	/**
	 * Source recorded on a Lead created from an unknown inbound sender (Req 7.5).
	 * Defaults to {@link DEFAULT_INBOUND_WEBHOOK_SOURCE}.
	 */
	inboundSource?: string;
}

/** Seam resolving a WhatsApp `@lid` to a phone-number chat id (`@c.us`). */
export interface LidResolver {
	/**
	 * Resolve `lid` (within `session`) to a phone-number chat id, or `null` when
	 * WAHA has no mapping (sender unknown to the session).
	 */
	resolveLidToPhone(session: string, lid: string): Promise<string | null>;
}

/** WhatsApp hidden Linked-ID chat-id suffix (e.g. `"96817169588265@lid"`). */
const LID_SUFFIX = "@lid";

/** Default `source` for a Lead first seen via the inbound webhook (Req 7.5). */
export const DEFAULT_INBOUND_WEBHOOK_SOURCE = "whatsapp_inbound";

/**
 * The outcome of handling one webhook delivery — a plain value the HTTP adapter
 * maps to a `Response`. `status` is the HTTP status to return; `body` is the
 * JSON acknowledgement payload.
 */
export interface WebhookResult {
	/**
	 * HTTP status: `401` (bad signature), `400` (body is not JSON), or `200`
	 * (accepted / duplicate / ignored).
	 *
	 * Note what is NOT a 4xx (ADR-005): a well-formed WAHA delivery this system
	 * cannot process — malformed payload, unresolvable `@lid`, invalid sender,
	 * unowned session — is acknowledged with `200 "ignored"` and logged. WAHA
	 * retries any non-2xx 15 times and then DISCARDS the event, so rejecting an
	 * un-retryable delivery loses the message instead of surfacing the problem.
	 */
	status: 401 | 400 | 200;
	/** JSON acknowledgement body. */
	body: {
		ok: boolean;
		status: "accepted" | "duplicate" | "rejected" | "ignored";
		reason?: string;
	};
}

// ---------------------------------------------------------------------------
// HMAC verification (Req 7.1)
// ---------------------------------------------------------------------------

/**
 * Verify a webhook's `X-Webhook-Hmac` signature against the raw request body
 * (Req 7.1).
 *
 * Computes the hex-encoded HMAC SHA-512 of the EXACT raw body bytes keyed by
 * `secret` and compares it to `signature` with a constant-time comparison
 * (`crypto.timingSafeEqual`) so a wrong signature cannot be discovered by
 * timing. A missing/empty signature, or one whose byte length differs from the
 * expected digest (a fast, non-secret-dependent reject), returns `false`.
 *
 * Pure apart from the cryptographic hashing of its inputs; performs no I/O.
 *
 * @param rawBody - The exact raw request body the signature was computed over.
 * @param signature - The `X-Webhook-Hmac` header value (hex), or `null` when absent.
 * @param secret - The configured shared HMAC secret.
 * @returns `true` only when the signature is present and matches.
 */
export function verifyWebhookSignature(
	rawBody: string,
	signature: string | null | undefined,
	secret: string,
): boolean {
	if (!signature) {
		return false;
	}
	const expected = createHmac(HMAC_ALGORITHM, secret)
		.update(rawBody, "utf8")
		.digest("hex");
	const expectedBuf = Buffer.from(expected, "utf8");
	const providedBuf = Buffer.from(signature, "utf8");
	// timingSafeEqual requires equal-length buffers; a length mismatch is itself
	// a mismatch and is safe to reveal (it does not depend on the secret).
	if (expectedBuf.length !== providedBuf.length) {
		return false;
	}
	return timingSafeEqual(expectedBuf, providedBuf);
}

// ---------------------------------------------------------------------------
// Webhook handler (verify → validate → idempotency → persist → enqueue)
// ---------------------------------------------------------------------------

/**
 * Handle one WAHA `message` webhook delivery end-to-end (Req 7.1, 7.4), the
 * testable core the Next.js route delegates to.
 *
 * Order matters and mirrors the design's inbound-webhook contract:
 *
 *   1. **Verify** the HMAC signature over the raw body; on failure return `401`
 *      and process NOTHING (no parse, no persist, no enqueue).
 *   2. **Validate** the parsed body against {@link WahaMessageWebhookSchema};
 *      on failure log the failing field paths and return `200 "ignored"`
 *      (ADR-005). An outbound echo (`fromMe: true`) is routed to
 *      {@link handleOutboundEcho} here — it is ingested as outbound history and
 *      counted against the sending number's anti-ban cap rather than processed
 *      as inbound (beta WhatsApp-Web consultant-reply flow).
 *   3. **Idempotency**: if a message with this `wa_message_id` was already
 *      persisted, return a fast `200` `"duplicate"` without re-processing — so a
 *      WAHA retry neither double-persists nor double-enqueues (Req 7.4).
 *   4. **Attribute + persist**: normalize the sender to E.164, find or create
 *      the Lead (Req 7.1, 7.5), and persist the raw inbound message — the
 *      persisted row is the idempotency key future retries hit in step 3.
 *   5. **Enqueue**: hand the message to the durable inbound queue and return a
 *      fast `200` `"accepted"`. The heavy pipeline runs in the worker, not here.
 *
 * @param deps - The injected secret, repositories, and queue.
 * @param rawBody - The exact raw request body text (read BEFORE JSON parsing so
 *   the HMAC is computed over the same bytes WAHA signed).
 * @param signature - The `X-Webhook-Hmac` header value, or `null` when absent.
 * @returns A {@link WebhookResult} the HTTP adapter maps to a `Response`.
 */
export async function processWahaWebhook(
	deps: WahaWebhookDeps,
	rawBody: string,
	signature: string | null | undefined,
): Promise<WebhookResult> {
	// 1. Verify the signature over the RAW body before doing anything else
	//    (Req 7.1). An invalid/missing signature is rejected with 401 and the
	//    body is never parsed or acted upon.
	if (!verifyWebhookSignature(rawBody, signature, deps.secret)) {
		return {
			status: 401,
			body: { ok: false, status: "rejected", reason: "invalid_signature" },
		};
	}

	// 2. Parse + validate the untrusted body (Req 7.1). A body that is not JSON
	//    at all → 400; one that parses but does not match the `message` schema →
	//    logged 200 (ADR-005).
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		// The one remaining 4xx besides the signature check (ADR-005). A body that
		// is not even JSON did not come from WAHA's WebhookSender, so there is no
		// retry storm to avoid and no message to lose — and a 400 is the honest
		// answer to whatever misconfigured client is posting here.
		logger.warn(
			{ event: "inbound.invalid_json" },
			"webhook body is not JSON; rejecting",
		);
		return {
			status: 400,
			body: { ok: false, status: "rejected", reason: "invalid_json" },
		};
	}
	const result = WahaMessageWebhookSchema.safeParse(parsed);
	if (!result.success) {
		// The body parsed as JSON but is not a `message`/`message.any` event we
		// handle. Distinguish two cases:
		//   - A non-message event (`session.status`, `message.ack`, presence, …):
		//     WAHA legitimately fires many event types at this URL. ACK with 200
		//     `"ignored"` so WAHA does not retry and the logs stay quiet.
		//   - A genuinely malformed `message` event (right event, bad payload):
		//     ACK with 200 too, but LOG it (ADR-005) — the delivery is permanently
		//     un-processable, so a retry cannot help, and a 4xx would only make
		//     WAHA burn 15 redeliveries before discarding the message anyway.
		const envelope = WahaEnvelopeSchema.safeParse(parsed);
		if (
			envelope.success &&
			!(HANDLED_EVENTS as readonly string[]).includes(envelope.data.event)
		) {
			return { status: 200, body: { ok: true, status: "ignored" } };
		}
		// Log the failing FIELD PATHS only — never the values. The payload carries
		// lead message text and phone numbers; the paths alone are what diagnose a
		// WAHA schema drift (this is exactly how the GOWS `to: null` outage went
		// unnoticed: the old code rejected silently).
		logger.warn(
			{
				event: "inbound.invalid_body",
				session: envelope.success ? envelope.data.session : undefined,
				issues: result.error.issues.map((issue) => issue.path.join(".")),
			},
			"malformed message webhook payload; acknowledged and dropped",
		);
		return {
			status: 200,
			body: { ok: true, status: "ignored", reason: "invalid_body" },
		};
	}
	const { session, payload } = result.data;
	const waMessageId = payload.id;

	// 2a. Resolve the tenant. Everything below acts through repositories bound to
	//     the organization that registered this WAHA session; until this point
	//     nothing has been read or written. A session no registered number claims
	//     is acknowledged with 200 and dropped — returning 5xx would make WAHA
	//     redeliver it forever.
	const owner = await deps.resolveSession(session);
	if (!owner) {
		logger.warn(
			{ event: "inbound.unknown_session", session, waMessageId },
			"no registered WhatsApp number owns this WAHA session; dropping delivery",
		);
		return {
			status: 200,
			body: { ok: true, status: "ignored", reason: "unknown_session" },
		};
	}

	// 2b. Outbound echo ingestion. WAHA delivers the session's own sends as
	//     `fromMe: true` — including a consultant's replies typed on a WhatsApp Web
	//     linked device connected to the same number (beta flow). Rather than
	//     dropping them, ingest them so the consultant's side of the conversation
	//     lands in the Lead's CRM history and counts against the number's anti-ban
	//     cap. Our OWN automated sends are already recorded by the outbound
	//     committer with the same `wa_message_id`, so they dedup to a no-op here.
	if (payload.fromMe) {
		return handleOutboundEcho(deps, owner, session, payload);
	}

	// 3. Attribute the sender to an E.164 number — BEFORE opening any
	//    transaction, because this step can make a network call.
	//
	//    WhatsApp's LID migration: WAHA may deliver `from` as a hidden Linked ID
	//    (`<digits>@lid`) that carries no phone digits. Resolve it to a real
	//    phone-number chat id via the injected Lids resolver before normalizing;
	//    an unresolvable `@lid` (sender unknown to the session) is unattributable.
	//    A sender that cannot be normalized is unattributable → logged 200.
	//
	//    Both failures below are PERMANENT — WAHA has no mapping for the `@lid`, or
	//    the sender is not a valid Brazilian number — so they are acknowledged with
	//    200 and logged rather than rejected (ADR-005).
	const senderChatId = await resolveChatId(deps, session, payload.from);
	if (senderChatId === null) {
		logger.warn(
			{ event: "inbound.unresolved_lid", session, waMessageId },
			"WAHA has no phone mapping for this @lid sender; dropping delivery",
		);
		return {
			status: 200,
			body: { ok: true, status: "ignored", reason: "unresolved_lid" },
		};
	}
	const phoneE164 = normalizePhone(senderChatId, "BR");
	if (phoneE164 === null) {
		logger.warn(
			{ event: "inbound.invalid_sender", session, waMessageId },
			"inbound sender is not a valid phone number; dropping delivery",
		);
		return {
			status: 200,
			body: { ok: true, status: "ignored", reason: "invalid_sender" },
		};
	}

	// WAHA `timestamp` is epoch SECONDS; convert to a `Date` for persistence.
	const receivedAt = new Date(payload.timestamp * 1000);

	// 4. The persistence unit of work, scoped to the tenant (and, in production,
	//    inside its RLS transaction). Kept deliberately tight — no network calls
	//    inside — because it holds a pooled connection:
	//      - idempotency by `wa_message_id` (Req 7.4): WAHA retries deliveries, so
	//        a message already persisted is acknowledged and NOT re-processed;
	//      - find-or-create the Lead (Req 7.1, 7.5) — the `messages.lead_id` FK is
	//        NOT NULL, so the Lead must exist before the message is recorded;
	//      - persist the raw inbound, which becomes the idempotency key above.
	const persisted = await deps.withScope(owner, async (scope) => {
		const existing = await scope.messages.findByWaMessageId(waMessageId);
		if (existing) {
			return null;
		}
		const existingLead = await scope.leads.findByPhone(phoneE164);
		const lead =
			existingLead ??
			(await scope.leads.create({
				phoneE164,
				source: deps.inboundSource ?? DEFAULT_INBOUND_WEBHOOK_SOURCE,
			}));
		const message = await scope.messages.append({
			leadId: lead.id,
			direction: "inbound",
			content: payload.body,
			waMessageId,
			createdAt: receivedAt,
		});
		return { leadId: lead.id, messageId: message.id };
	});
	if (persisted === null) {
		return { status: 200, body: { ok: true, status: "duplicate" } };
	}

	// 5. Enqueue processing and acknowledge fast (Req 7.1). Outside the
	//    transaction: pg-boss holds its own pool, so enqueuing inside would not
	//    be atomic with the write anyway, and would hold the connection longer.
	//    The full Inbound_Handler pipeline (sendSeen, opt-out, cancellation, and
	//    the handoff to a consultant) runs in the worker, NOT inline. The
	//    worker's message append is idempotent on `wa_message_id`, so the raw
	//    inbound recorded here is not written twice.
	const correlationId = randomUUID();
	logger.info(
		{
			event: "inbound.received",
			correlationId,
			leadId: persisted.leadId,
			session,
			organizationId: owner.organizationId,
		},
		"inbound message accepted",
	);
	await deps.queue(owner.organizationId).enqueueInbound({
		correlationId,
		leadId: persisted.leadId,
		messageId: persisted.messageId,
		waMessageId,
		from: senderChatId,
		text: payload.body,
		receivedAt,
		session,
	});

	return { status: 200, body: { ok: true, status: "accepted" } };
}

/**
 * Ingest an outbound echo (`fromMe: true`) — a message the WAHA session itself
 * sent, including a consultant's reply typed from a WhatsApp Web linked device
 * on the same number (beta flow). The goal is to close the two gaps the
 * WhatsApp-Web reply model would otherwise open:
 *
 *   - **History**: record the message as `outbound` in the recipient Lead's
 *     history so the consultant's side of the conversation is visible in the CRM.
 *   - **Anti-ban accuracy**: count the manual send against the sending number's
 *     daily cap so the controller's count is not blind to human sends.
 *
 * Dedup by `wa_message_id` is the load-bearing safeguard: our OWN automated
 * sends are already recorded by the outbound committer with the same id, so they
 * resolve to a fast `"duplicate"` here and are never double-recorded or
 * double-counted; only a genuinely new id is a manual consultant reply. (Like
 * the inbound path, dedup is by lookup, not a DB constraint, so a rare
 * echo-vs-committer race could still double-insert; acceptable for the beta.)
 *
 * Attribution uses the echo's `to` (the recipient), since for a `fromMe` message
 * `from` is our own number. An echo with no `to`, an unresolvable `@lid`, a
 * non-normalizable number, or a recipient that is not a known Lead (e.g. a
 * consultant alert) is acknowledged and ignored — there is nothing to record.
 * Always returns `200` so WAHA does not retry.
 */
async function handleOutboundEcho(
	deps: WahaWebhookDeps,
	owner: WahaSessionOwner,
	session: string,
	payload: WahaMessageWebhook["payload"],
): Promise<WebhookResult> {
	const waMessageId = payload.id;

	// Attribute by the recipient (`to`): for a `fromMe` echo WE are the sender.
	// Resolved before the transaction, since a `@lid` costs a WAHA round trip.
	const recipient = payload.to;
	if (!recipient) {
		return { status: 200, body: { ok: true, status: "ignored" } };
	}
	const recipientChatId = await resolveChatId(deps, session, recipient);
	if (recipientChatId === null) {
		return { status: 200, body: { ok: true, status: "ignored" } };
	}
	const phoneE164 = normalizePhone(recipientChatId, "BR");
	if (phoneE164 === null) {
		return { status: 200, body: { ok: true, status: "ignored" } };
	}

	const outcome = await deps.withScope(owner, async (scope) => {
		// Dedup: our own automated sends (recorded by the committer) and WAHA
		// retries both already exist under this id — a no-op, so anti-ban is never
		// double-counted.
		const existing = await scope.messages.findByWaMessageId(waMessageId);
		if (existing) {
			return "duplicate" as const;
		}
		const lead = await scope.leads.findByPhone(phoneE164);
		if (!lead) {
			// Outbound to a non-lead (e.g. a consultant alert recipient): nothing to
			// record.
			return "ignored" as const;
		}

		// Record the manual send as outbound history (Req 19.3).
		await scope.messages.append({
			leadId: lead.id,
			direction: "outbound",
			content: payload.body,
			waMessageId,
			createdAt: new Date(payload.timestamp * 1000),
		});

		// Audit (best-effort): a manual send to an opted-out Lead cannot be blocked
		// (the human typed it directly), but it should be visible.
		if (lead.optInStatus === "opt_out") {
			logger.warn(
				{ event: "inbound.echo_opt_out", leadId: lead.id },
				"manual outbound to an opted-out lead",
			);
		}

		// Count the manual send against the sending number's daily cap so the
		// anti-ban controller stays accurate. Best-effort: skipped when the seam is
		// absent (tests).
		if (scope.antiBan) {
			await scope.antiBan.recordSend(owner.numberId);
		}
		return "accepted" as const;
	});

	return { status: 200, body: { ok: true, status: outcome } };
}

/**
 * Resolve a raw WhatsApp chat id to one carrying phone digits, resolving a
 * hidden Linked ID (`<digits>@lid`) through WAHA when needed. Returns `null`
 * when the `@lid` has no mapping (sender unknown to the session), which makes
 * the message unattributable.
 *
 * Called before any transaction is opened: it is the only network I/O on the
 * webhook path, and the RLS transaction must not be held across it.
 */
async function resolveChatId(
	deps: WahaWebhookDeps,
	session: string,
	chatId: string,
): Promise<string | null> {
	if (!chatId.endsWith(LID_SUFFIX)) {
		return chatId;
	}
	return deps.lids ? deps.lids.resolveLidToPhone(session, chatId) : null;
}
